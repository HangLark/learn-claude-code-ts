/**
 * s07 — Skill Loading
 *
 * 关键理念：system prompt 只放技能名称和简介；完整 SKILL.md 由模型在
 * 确实需要时通过 load_skill 加载，避免无关知识长期占据上下文。
 */

import { exec } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import { parse } from 'yaml';

loadEnv({ override: true, quiet: true });

const workdir = process.cwd();
const skillsDirectory = resolve(workdir, 'skills');
const client = new Anthropic();
const { MODEL_ID: model } = process.env as { MODEL_ID: string };

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

interface Skill {
  name: string;
  description: string;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match?.[1] === undefined) {
    return { metadata: {}, body: content };
  }

  const parsed: unknown = parse(match[1]);
  return {
    metadata: isRecord(parsed) ? parsed : {},
    body: content.slice(match[0].length).trim(),
  };
}

class SkillLoader {
  private readonly skills = new Map<string, Skill>();

  constructor(private readonly directory: string) {
    this.scan();
  }

  catalog(): string {
    if (this.skills.size === 0) {
      return '(no skills found)';
    }
    return [...this.skills.values()]
      .map(({ name, description }) => `- ${name}: ${description}`)
      .join('\n');
  }

  load(name: string): string {
    const skill = this.skills.get(name);
    if (skill !== undefined) {
      return skill.content;
    }
    const available = [...this.skills.keys()].join(', ') || 'none';
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }

  private scan(): void {
    if (!existsSync(this.directory)) {
      return;
    }

    const manifests = globSync('*/SKILL.md', { cwd: this.directory }).sort();
    for (const manifest of manifests) {
      const manifestPath = resolve(this.directory, manifest);
      if (!isInside(this.directory, manifestPath)) {
        continue;
      }

      const content = readFileSync(manifestPath, 'utf8');
      const { metadata, body } = parseFrontmatter(content);
      const rawName =
        typeof metadata.name === 'string' ? metadata.name.trim() : '';
      const name =
        rawName.length > 0 ? rawName : basename(dirname(manifestPath));

      const rawDescription =
        typeof metadata.description === 'string'
          ? metadata.description.trim()
          : '';
      const firstBodyLine = body.split(/\r?\n/u)[0] ?? '';
      const description = (rawDescription || firstBodyLine)
        .replace(/^#+\s*/u, '')
        .replace(/\s+/gu, ' ')
        .trim();

      this.skills.set(name, { name, description, content });
    }
  }
}

const skillLoader = new SkillLoader(skillsDirectory);
const systemPrompt =
  `You are a coding agent at ${workdir}. Use tools to solve tasks. ` +
  `Act, don't explain.\n\nSkills available:\n${skillLoader.catalog()}\n\n` +
  'Use load_skill to read the full instructions when a skill applies.';

function runBash(command: string): Promise<string> {
  return new Promise((resolveOutput) => {
    exec(command, { cwd: workdir }, (_error, stdout, stderr) => {
      resolveOutput(`${stdout}${stderr}`.trim() || '(no output)');
    });
  });
}

async function runRead(path: string, limit?: number): Promise<string> {
  const lines = (await readFile(resolve(workdir, path), 'utf8')).split(
    /\r?\n/u,
  );

  if (limit !== undefined && lines.length > limit) {
    return [
      ...lines.slice(0, limit),
      `... (${String(lines.length - limit)} more lines)`,
    ].join('\n');
  }
  return lines.join('\n');
}

async function runWrite(path: string, content: string): Promise<string> {
  const filePath = resolve(workdir, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${path}`;
}

async function runEdit(
  path: string,
  oldText: string,
  newText: string,
): Promise<string> {
  const filePath = resolve(workdir, path);
  const text = await readFile(filePath, 'utf8');
  const start = text.indexOf(oldText);

  if (start === -1) {
    return `Error: text not found in ${path}`;
  }

  const edited = `${text.slice(0, start)}${newText}${text.slice(start + oldText.length)}`;
  await writeFile(filePath, edited, 'utf8');
  return `Edited ${path}`;
}

async function runGlob(pattern: string): Promise<string> {
  const matches: string[] = [];
  for await (const path of glob(pattern, { cwd: workdir })) {
    if (isInside(workdir, resolve(workdir, path))) {
      matches.push(path);
    }
  }

  const output = matches.sort().join('\n');
  return output.length > 0 ? output : '(no matches)';
}

interface RegisteredTool {
  definition: Anthropic.Tool;
  run: (input: unknown) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function defineTool<Input>(
  definition: Anthropic.Tool,
  handler: (input: Input) => string | Promise<string>,
): RegisteredTool {
  return {
    definition,
    run: (input) => Promise.resolve(handler(input as Input)),
  };
}

const registeredTools = [
  defineTool<{ command: string }>(
    {
      name: 'bash',
      description: 'Run a shell command.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    ({ command }) => runBash(command),
  ),
  defineTool<{ path: string; limit?: number }>(
    {
      name: 'read_file',
      description: 'Read file contents.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['path'],
      },
    },
    ({ path, limit }) => runRead(path, limit),
  ),
  defineTool<{ path: string; content: string }>(
    {
      name: 'write_file',
      description: 'Write content to a file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    ({ path, content }) => runWrite(path, content),
  ),
  defineTool<{ path: string; old_text: string; new_text: string }>(
    {
      name: 'edit_file',
      description: 'Replace exact text in a file once.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    ({ path, old_text: oldText, new_text: newText }) =>
      runEdit(path, oldText, newText),
  ),
  defineTool<{ pattern: string }>(
    {
      name: 'glob',
      description:
        'Find files matching a glob pattern; ** matches recursively.',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
    ({ pattern }) => runGlob(pattern),
  ),
  defineTool<{ name: string }>(
    {
      name: 'load_skill',
      description: 'Load the full SKILL.md content by skill name.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    ({ name }) => skillLoader.load(name),
  ),
];

const tools = registeredTools.map(({ definition }) => definition);
const toolHandlers = new Map(
  registeredTools.map(({ definition, run }) => [definition.name, run]),
);

interface HookArguments {
  UserPromptSubmit: [query: string];
  PreToolUse: [toolCall: Anthropic.ToolUseBlock, readline: ReadlineInterface];
  PostToolUse: [toolCall: Anthropic.ToolUseBlock, output: string];
  Stop: [messages: Anthropic.MessageParam[]];
}

type HookEvent = keyof HookArguments;
type Hook<Event extends HookEvent> = (
  ...args: HookArguments[Event]
) => string | undefined | Promise<string | undefined>;
type HookRegistry = { [Event in HookEvent]: Hook<Event>[] };

const hooks: HookRegistry = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook<Event extends HookEvent>(
  event: Event,
  hook: Hook<Event>,
): void {
  (hooks[event] as Hook<Event>[]).push(hook);
}

async function triggerHooks<Event extends HookEvent>(
  event: Event,
  ...args: HookArguments[Event]
): Promise<string | undefined> {
  for (const hook of hooks[event] as Hook<Event>[]) {
    const result = await hook(...args);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

const denyList = [
  'rm -rf /',
  'sudo',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
  '> /dev/sda',
];
const destructiveCommand = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/iu;

interface PermissionInput {
  command?: string;
  path?: string;
}

async function permissionHook(
  toolCall: Anthropic.ToolUseBlock,
  readline: ReadlineInterface,
): Promise<string | undefined> {
  const input = toolCall.input as PermissionInput;
  const command = input.command ?? '';

  if (toolCall.name === 'bash') {
    const denied = denyList.find((pattern) => command.includes(pattern));
    if (denied !== undefined) {
      console.log(`\n\u001B[31m[blocked] '${denied}'\u001B[0m`);
      return 'Permission denied by deny list';
    }

    const needsApproval =
      destructiveCommand.test(command) ||
      ['rm ', '> /etc/', 'chmod 777'].some((text) => command.includes(text));
    if (needsApproval) {
      console.log(
        '\n\u001B[33m[permission] Potentially destructive command\u001B[0m',
      );
      console.log(
        `   Tool: ${toolCall.name}(${JSON.stringify(toolCall.input)})`,
      );
      const answer = await readline.question('   Allow? [y/N] ');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        return 'Permission denied by user';
      }
    }
  }

  if (
    ['read_file', 'write_file', 'edit_file'].includes(toolCall.name) &&
    !isInside(workdir, resolve(workdir, input.path ?? ''))
  ) {
    console.log('\n\u001B[33m[permission] Access outside workspace\u001B[0m');
    console.log(`   Tool: ${toolCall.name}(${JSON.stringify(toolCall.input)})`);
    const answer = await readline.question('   Allow? [y/N] ');
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      return 'Permission denied by user';
    }
  }

  return undefined;
}

function logHook(toolCall: Anthropic.ToolUseBlock): undefined {
  console.log(
    `\u001B[90m[hook] ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 60)})\u001B[0m`,
  );
}

function largeOutputHook(
  toolCall: Anthropic.ToolUseBlock,
  output: string,
): undefined {
  if (output.length > 100_000) {
    console.log(
      `\u001B[33m[hook] Large output from ${toolCall.name}: ${String(output.length)} chars\u001B[0m`,
    );
  }
}

function contextHook(): undefined {
  console.log(
    `\u001B[90m[hook] UserPromptSubmit: working in ${workdir}\u001B[0m`,
  );
}

function summaryHook(messages: Anthropic.MessageParam[]): undefined {
  const toolCount = messages.reduce((count, message) => {
    if (typeof message.content === 'string') {
      return count;
    }
    return (
      count +
      message.content.filter((block) => block.type === 'tool_result').length
    );
  }, 0);

  console.log(
    `\u001B[90m[hook] Stop: session used ${String(toolCount)} tool calls\u001B[0m`,
  );
}

registerHook('UserPromptSubmit', contextHook);
registerHook('PreToolUse', permissionHook);
registerHook('PreToolUse', logHook);
registerHook('PostToolUse', largeOutputHook);
registerHook('Stop', summaryHook);

async function executeTool(
  toolCall: Anthropic.ToolUseBlock,
  readline: ReadlineInterface,
): Promise<string> {
  const blocked = await triggerHooks('PreToolUse', toolCall, readline);
  if (blocked !== undefined) {
    return blocked;
  }

  const handler = toolHandlers.get(toolCall.name);
  const output = handler
    ? await handler(toolCall.input)
    : `Unknown tool: ${toolCall.name}`;

  await triggerHooks('PostToolUse', toolCall, output);
  return output;
}

async function agentLoop(
  messages: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<Anthropic.ContentBlock[]> {
  while (true) {
    const response = await client.messages.create({
      model,
      system: systemPrompt,
      messages,
      tools,
      max_tokens: 8_000,
    });
    messages.push({ role: 'assistant', content: response.content });

    const toolCalls = response.content.filter(
      (block) => block.type === 'tool_use',
    );
    if (toolCalls.length === 0) {
      const continuation = await triggerHooks('Stop', messages);
      if (continuation !== undefined) {
        messages.push({ role: 'user', content: continuation });
        continue;
      }
      return response.content;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolCall of toolCalls) {
      const output = await executeTool(toolCall, readline);
      results.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: output,
      });
    }
    messages.push({ role: 'user', content: results });
  }
}

async function main(): Promise<void> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const history: Anthropic.MessageParam[] = [];

  console.log('s07: Skill Loading');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms07 >> \u001B[0m');
  readline.prompt();

  for await (const query of readline) {
    await triggerHooks('UserPromptSubmit', query);
    history.push({ role: 'user', content: query });
    const finalContent = await agentLoop(history, readline);

    for (const block of finalContent) {
      if (block.type === 'text') {
        console.log(block.text);
      }
    }
    console.log();
    readline.prompt();
  }
}

await main();
