/**
 * s05 — TodoWrite
 *
 * 关键理念：todo_write 不增加执行能力，而是把多步计划变成模型可以持续
 * 更新的显式状态；harness 在计划长期未更新时提醒模型回到目标。
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
const systemPrompt =
  `You are a coding agent at ${workdir}. ` +
  'Before starting any multi-step task, use todo_write to plan your steps. ' +
  'Update status as you go.';

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

const todoStatuses = ['pending', 'in_progress', 'completed'] as const;
type TodoStatus = (typeof todoStatuses)[number];

interface TodoItem {
  content: string;
  status: TodoStatus;
}

interface ToolOutcome {
  content: string;
  succeeded: boolean;
}

class TodoManager {
  private items: TodoItem[] = [];

  update(todos: TodoItem[]): ToolOutcome {
    if (todos.length > 20) {
      return { content: 'Error: Max 20 todos allowed', succeeded: false };
    }

    const normalized = todos.map(({ content, status }) => ({
      content: content.trim(),
      status,
    }));
    if (normalized.some(({ content }) => content.length === 0)) {
      return {
        content: 'Error: Every todo requires content',
        succeeded: false,
      };
    }
    if (normalized.some(({ status }) => !todoStatuses.includes(status))) {
      return { content: 'Error: Invalid todo status', succeeded: false };
    }
    if (
      normalized.filter(({ status }) => status === 'in_progress').length > 1
    ) {
      return {
        content: 'Error: Only one todo can be in_progress at a time',
        succeeded: false,
      };
    }

    this.items = normalized;
    return { content: this.render(), succeeded: true };
  }

  private render(): string {
    if (this.items.length === 0) {
      return 'No todos.';
    }

    const markers: Record<TodoStatus, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
    };
    const lines = this.items.map(
      ({ content, status }) => `${markers[status]} ${content}`,
    );
    const completed = this.items.filter(
      ({ status }) => status === 'completed',
    ).length;

    lines.push(
      `\n(${String(completed)}/${String(this.items.length)} completed)`,
    );
    return lines.join('\n');
  }
}

const todoManager = new TodoManager();

function runTodoWrite(todos: TodoItem[]): ToolOutcome {
  const outcome = todoManager.update(todos);
  console.log(`\n\u001B[33m## Current Tasks\u001B[0m\n${outcome.content}`);
  return outcome;
}

interface RegisteredTool {
  definition: Anthropic.Tool;
  run: (input: unknown) => Promise<ToolOutcome>;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function defineTool<Input>(
  definition: Anthropic.Tool,
  handler: (
    input: Input,
  ) => string | ToolOutcome | Promise<string | ToolOutcome>,
): RegisteredTool {
  return {
    definition,
    run: async (input) => {
      const result = await handler(input as Input);
      return typeof result === 'string'
        ? { content: result, succeeded: true }
        : result;
    },
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
  defineTool<{ todos: TodoItem[] }>(
    {
      name: 'todo_write',
      description: 'Create and update the task list for this coding session.',
      input_schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', minLength: 1 },
                status: {
                  type: 'string',
                  enum: [...todoStatuses],
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
    ({ todos }) => runTodoWrite(todos),
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
    !isInsideWorkspace(resolve(workdir, input.path ?? ''))
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

async function agentLoop(
  messages: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<Anthropic.ContentBlock[]> {
  let roundsSinceTodo = 0;

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

    const results: (
      Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam
    )[] = [];
    let usedTodo = false;

    for (const toolCall of toolCalls) {
      const blocked = await triggerHooks('PreToolUse', toolCall, readline);
      if (blocked !== undefined) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: blocked,
        });
        continue;
      }

      const handler = toolHandlers.get(toolCall.name);
      const outcome = handler
        ? await handler(toolCall.input)
        : { content: `Unknown tool: ${toolCall.name}`, succeeded: false };

      await triggerHooks('PostToolUse', toolCall, outcome.content);
      if (toolCall.name === 'todo_write' && outcome.succeeded) {
        usedTodo = true;
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: outcome.content,
      });
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.push({
        type: 'text',
        text: '<reminder>Update your todos.</reminder>',
      });
      roundsSinceTodo = 0;
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

  console.log('s05: TodoWrite');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms05 >> \u001B[0m');
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
