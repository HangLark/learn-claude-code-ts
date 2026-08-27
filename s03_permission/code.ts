/**
 * s03 — Permission
 *
 * 关键理念：工具执行前依次经过硬拒绝、规则匹配和用户审批；
 * 权限属于 harness，模型不能绕过这道执行边界。
 */

import { exec } from 'node:child_process';
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const workdir = process.cwd();
const client = new Anthropic();
const { MODEL_ID: model } = process.env as { MODEL_ID: string };
const systemPrompt = `You are a coding agent at ${workdir}. All destructive operations require user approval.`;

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

function isInsideWorkspace(path: string): boolean {
  const relativePath = relative(workdir, path);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function runGlob(pattern: string): Promise<string> {
  const matches: string[] = [];
  for await (const path of glob(pattern, { cwd: workdir })) {
    if (isInsideWorkspace(resolve(workdir, path))) {
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
  handler: (input: Input) => Promise<string>,
): RegisteredTool {
  return {
    definition,
    run: (input) => handler(input as Input),
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
];

const tools = registeredTools.map(({ definition }) => definition);
const toolHandlers = new Map(
  registeredTools.map(({ definition, run }) => [definition.name, run]),
);

// Gate 1：这些操作永不执行，也不会进入用户审批。
const denyList = [
  'rm -rf /',
  'sudo',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
  '> /dev/sda',
];

function deniedReason(command: string): string | undefined {
  const denied = denyList.find((pattern) => command.includes(pattern));
  return denied === undefined ? undefined : `'${denied}' is on the deny list`;
}

const destructiveCommand = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/iu;

interface PermissionInput {
  command?: string;
  path?: string;
}

interface PermissionRule {
  tools: readonly string[];
  reason: string;
  matches: (input: PermissionInput) => boolean;
}

// Gate 2：规则只判断是否需要问用户，不直接替用户做决定。
const permissionRules: PermissionRule[] = [
  {
    tools: ['read_file', 'write_file', 'edit_file'],
    reason: 'Access outside workspace',
    matches: ({ path = '' }) => !isInsideWorkspace(resolve(workdir, path)),
  },
  {
    tools: ['bash'],
    reason: 'Potentially destructive command',
    matches: ({ command = '' }) =>
      destructiveCommand.test(command) ||
      ['rm ', '> /etc/', 'chmod 777'].some((text) => command.includes(text)),
  },
];

async function checkPermission(
  toolCall: Anthropic.ToolUseBlock,
  readline: ReadlineInterface,
): Promise<boolean> {
  const input = toolCall.input as PermissionInput;

  const hardDeny =
    toolCall.name === 'bash' ? deniedReason(input.command ?? '') : undefined;
  if (hardDeny !== undefined) {
    console.log(`\n\u001B[31m[blocked] ${hardDeny}\u001B[0m`);
    return false;
  }

  const rule = permissionRules.find(
    ({ tools: ruleTools, matches }) =>
      ruleTools.includes(toolCall.name) && matches(input),
  );
  if (rule === undefined) {
    return true;
  }

  // Gate 3：默认拒绝，只有明确输入 y/yes 才放行。
  console.log(`\n\u001B[33m[permission] ${rule.reason}\u001B[0m`);
  console.log(`   Tool: ${toolCall.name}(${JSON.stringify(toolCall.input)})`);
  const answer = await readline.question('   Allow? [y/N] ');
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
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
      return response.content;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolCall of toolCalls) {
      console.log(`\u001B[36m> ${toolCall.name}\u001B[0m`);

      // s03 只在 s02 的 dispatch 之前加入这一道权限管线。
      if (!(await checkPermission(toolCall, readline))) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: 'Permission denied.',
        });
        continue;
      }

      const handler = toolHandlers.get(toolCall.name);
      const output = handler
        ? await handler(toolCall.input)
        : `Unknown tool: ${toolCall.name}`;

      console.log(output.slice(0, 200));
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

  console.log('s03: Permission');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms03 >> \u001B[0m');
  readline.prompt();

  for await (const query of readline) {
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
