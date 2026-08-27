/**
 * s11 — Background Tasks
 *
 * 关键理念：耗时且独立的 Bash 命令先返回后台任务 ID；Harness 在后续
 * 模型调用前收集完成结果，并把它作为新事件注入对话。
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
const systemPrompt = `You are a coding agent at ${workdir}. Use tools to solve tasks. Set run_in_background to true only for independent Bash commands.`;

function isInsideWorkspace(path: string): boolean {
  const relativePath = relative(workdir, path);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface BashSuccess {
  status: 'completed';
  output: string;
}

interface BashFailure {
  status: 'failed';
  output: string;
  reason: string;
}

type BashResult = BashSuccess | BashFailure;

function runBashProcess(command: string): Promise<BashResult> {
  return new Promise((resolveResult) => {
    try {
      exec(command, { cwd: workdir }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim() || '(no output)';
        if (error === null) {
          resolveResult({ status: 'completed', output });
          return;
        }
        const reason =
          typeof error.code === 'number'
            ? `command exited with status ${String(error.code)}`
            : error.signal === undefined
              ? error.message
              : `command terminated by signal ${error.signal}`;
        resolveResult({ status: 'failed', output, reason });
      });
    } catch (error) {
      resolveResult({
        status: 'failed',
        output: '(no output)',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function formatBashResult(result: BashResult): string {
  return result.status === 'completed'
    ? result.output
    : `Error: ${result.reason}\n${result.output}`;
}

async function runBash(command: string): Promise<string> {
  return formatBashResult(await runBashProcess(command));
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
  const content = await readFile(filePath, 'utf8');
  const start = content.indexOf(oldText);
  if (start === -1) {
    return `Error: text not found in ${path}`;
  }
  const edited = `${content.slice(0, start)}${newText}${content.slice(start + oldText.length)}`;
  await writeFile(filePath, edited, 'utf8');
  return `Edited ${path}`;
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
  defineTool<{ command: string; run_in_background?: boolean }>(
    {
      name: 'bash',
      description: 'Run a shell command.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          run_in_background: { type: 'boolean' },
        },
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

async function permissionHook(
  toolCall: Anthropic.ToolUseBlock,
  readline: ReadlineInterface,
): Promise<string | undefined> {
  const input: Record<string, unknown> = isRecord(toolCall.input)
    ? toolCall.input
    : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const path = typeof input.path === 'string' ? input.path : '';

  if (toolCall.name === 'bash') {
    const denied = denyList.find((pattern) => command.includes(pattern));
    if (denied !== undefined) {
      return `Permission denied by deny list: ${denied}`;
    }
    const needsApproval =
      destructiveCommand.test(command) ||
      ['rm ', '> /etc/', 'chmod 777'].some((text) => command.includes(text));
    if (needsApproval) {
      console.log(
        '\n\u001B[33m[permission] Potentially destructive command\u001B[0m',
      );
      const answer = await readline.question('   Allow? [y/N] ');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        return 'Permission denied by user';
      }
    }
  }

  if (
    ['read_file', 'write_file', 'edit_file'].includes(toolCall.name) &&
    !isInsideWorkspace(resolve(workdir, path))
  ) {
    console.log('\n\u001B[33m[permission] Access outside workspace\u001B[0m');
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

interface RunningTask {
  id: string;
  command: string;
  status: 'running';
}

interface FinishedTask {
  id: string;
  command: string;
  status: 'completed' | 'failed';
  result: string;
}

type BackgroundTask = RunningTask | FinishedTask;

class BackgroundManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly ready: FinishedTask[] = [];
  private counter = 0;

  start(command: string): string {
    if (command.trim().length === 0) {
      throw new Error('Bash command cannot be empty');
    }

    this.counter += 1;
    const id = `bg_${String(this.counter).padStart(4, '0')}`;
    this.tasks.set(id, { id, command, status: 'running' });
    void this.run(id, command);
    console.log(`  [background] started ${id}: ${command.slice(0, 60)}`);
    return id;
  }

  collect(): string[] {
    const notifications: string[] = [];
    for (const task of this.ready.splice(0)) {
      this.tasks.delete(task.id);
      notifications.push(
        [
          '<task_notification>',
          `  <task_id>${task.id}</task_id>`,
          `  <status>${task.status}</status>`,
          `  <command>${task.command}</command>`,
          `  <summary>${task.result.slice(0, 500)}</summary>`,
          '</task_notification>',
        ].join('\n'),
      );
      console.log(`  [background] collected ${task.id}: ${task.status}`);
    }
    return notifications;
  }

  private async run(id: string, command: string): Promise<void> {
    const result = await runBashProcess(command);
    const task: FinishedTask = {
      id,
      command,
      status: result.status,
      result: formatBashResult(result),
    };
    this.tasks.set(id, task);
    this.ready.push(task);
  }
}

const background = new BackgroundManager();

function shouldRunInBackground(toolCall: Anthropic.ToolUseBlock): boolean {
  return (
    toolCall.name === 'bash' &&
    isRecord(toolCall.input) &&
    toolCall.input.run_in_background === true
  );
}

function backgroundCommand(toolCall: Anthropic.ToolUseBlock): string {
  if (!isRecord(toolCall.input) || typeof toolCall.input.command !== 'string') {
    throw new Error('Bash command cannot be empty');
  }
  return toolCall.input.command;
}

function injectBackgroundResults(messages: Anthropic.MessageParam[]): void {
  const notifications = background.collect();
  if (notifications.length === 0) {
    return;
  }

  const blocks: Anthropic.TextBlockParam[] = notifications.map((text) => ({
    type: 'text',
    text,
  }));
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === 'user') {
    lastMessage.content =
      typeof lastMessage.content === 'string'
        ? [{ type: 'text', text: lastMessage.content }, ...blocks]
        : [...lastMessage.content, ...blocks];
  } else {
    messages.push({ role: 'user', content: blocks });
  }
}

async function executeTool(
  toolCall: Anthropic.ToolUseBlock,
  readline: ReadlineInterface,
): Promise<string> {
  const blocked = await triggerHooks('PreToolUse', toolCall, readline);
  if (blocked !== undefined) {
    return blocked;
  }

  let output: string;
  try {
    if (shouldRunInBackground(toolCall)) {
      const id = background.start(backgroundCommand(toolCall));
      output = `[Background task ${id} started] The result will be collected on a later turn.`;
    } else {
      const handler = toolHandlers.get(toolCall.name);
      output = handler
        ? await handler(toolCall.input)
        : `Unknown tool: ${toolCall.name}`;
    }
  } catch (error) {
    output = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  await triggerHooks('PostToolUse', toolCall, output);
  return output;
}

async function agentLoop(
  messages: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<Anthropic.ContentBlock[]> {
  while (true) {
    injectBackgroundResults(messages);
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
      results.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: await executeTool(toolCall, readline),
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

  console.log('s11: Background Tasks');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms11 >> \u001B[0m');
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
