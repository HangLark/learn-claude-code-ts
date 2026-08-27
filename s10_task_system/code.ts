/**
 * s10 — Task System
 *
 * 关键理念：把工作拆成持久化的任务图；Harness 用依赖关系判断任务是否
 * 可开始，再通过 claim / complete 生命周期协调执行者与进度。
 */

import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { glob, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const workdir = process.cwd();
const tasksDirectory = resolve(workdir, '.tasks');
const client = new Anthropic();
const { MODEL_ID: model } = process.env as { MODEL_ID: string };
const systemPrompt = `You are a coding agent at ${workdir}. Use task tools to track dependencies and progress. Create all task nodes first. After create_task returns runtime-generated IDs, use update_task with those exact IDs to add dependencies.`;

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const taskIdPatternSource = '^task_[0-9a-f]{8}$';
const taskIdPattern = new RegExp(taskIdPatternSource, 'u');
const taskStatuses = ['pending', 'in_progress', 'completed'] as const;
type TaskStatus = (typeof taskStatuses)[number];

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' && taskStatuses.some((status) => status === value)
  );
}

interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
}

function parseTask(content: string, expectedId: string): Task {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value) || value.id !== expectedId) {
    throw new Error(`Invalid task record: ${expectedId}`);
  }

  const { subject, description, status, owner, blockedBy } = value;
  const validDependencies =
    Array.isArray(blockedBy) &&
    blockedBy.every(
      (dependency): dependency is string =>
        typeof dependency === 'string' && taskIdPattern.test(dependency),
    );

  if (
    typeof subject !== 'string' ||
    typeof description !== 'string' ||
    !isTaskStatus(status) ||
    (owner !== null && typeof owner !== 'string') ||
    !validDependencies
  ) {
    throw new Error(`Invalid task record: ${expectedId}`);
  }

  return {
    id: expectedId,
    subject,
    description,
    status,
    owner,
    blockedBy,
  };
}

class TaskStore {
  constructor(private readonly directory: string) {}

  async create(subject: string, description = ''): Promise<Task> {
    const normalizedSubject = subject.trim();
    if (normalizedSubject.length === 0) {
      throw new Error('Task subject cannot be empty');
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task: Task = {
        id: `task_${randomBytes(4).toString('hex')}`,
        subject: normalizedSubject,
        description,
        status: 'pending',
        owner: null,
        blockedBy: [],
      };

      try {
        await writeFile(
          await this.taskPath(task.id, false),
          this.serialize(task),
          { encoding: 'utf8', flag: 'wx' },
        );
        return task;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
    throw new Error('Could not allocate a unique task ID');
  }

  async updateDependencies(
    taskId: string,
    addedDependencies: string[],
  ): Promise<Task> {
    const tasks = await this.taskMap();
    const task = tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== 'pending' || task.owner !== null) {
      throw new Error(
        `Task ${taskId} dependencies can only be updated while pending and unowned`,
      );
    }

    const dependencies = [...new Set(addedDependencies)];
    for (const dependency of dependencies) {
      if (dependency === taskId) {
        throw new Error('Task cannot depend on itself');
      }
      if (!tasks.has(dependency)) {
        throw new Error(`Dependency not found: ${dependency}`);
      }
      if (
        !task.blockedBy.includes(dependency) &&
        this.dependsOn(dependency, taskId, tasks)
      ) {
        throw new Error(
          `Dependency cycle detected: ${taskId} -> ${dependency}`,
        );
      }
    }

    task.blockedBy.push(
      ...dependencies.filter(
        (dependency) => !task.blockedBy.includes(dependency),
      ),
    );
    await this.save(task);
    return task;
  }

  async load(taskId: string): Promise<Task> {
    return parseTask(
      await readFile(await this.taskPath(taskId, true), 'utf8'),
      taskId,
    );
  }

  async list(): Promise<Task[]> {
    const root = await this.root();
    const ids: string[] = [];
    for await (const filename of glob('task_*.json', { cwd: root })) {
      const id = filename.replace(/\.json$/u, '');
      if (taskIdPattern.test(id)) {
        ids.push(id);
      }
    }
    ids.sort();
    return Promise.all(ids.map((id) => this.load(id)));
  }

  async save(task: Task): Promise<void> {
    await writeFile(
      await this.taskPath(task.id, true),
      this.serialize(task),
      'utf8',
    );
  }

  private async root(): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const [workspaceRoot, root] = await Promise.all([
      realpath(workdir),
      realpath(this.directory),
    ]);
    if (!isInside(workspaceRoot, root)) {
      throw new Error('Task store escapes the workspace');
    }
    return root;
  }

  private async taskPath(taskId: string, existing: boolean): Promise<string> {
    if (!taskIdPattern.test(taskId)) {
      throw new Error(`Invalid task ID: ${taskId}`);
    }

    const root = await this.root();
    const path = resolve(root, `${taskId}.json`);
    if (!isInside(root, path)) {
      throw new Error(`Invalid task ID: ${taskId}`);
    }
    if (!existing) {
      return path;
    }

    const canonicalPath = await realpath(path);
    if (!isInside(root, canonicalPath)) {
      throw new Error(`Task file escapes the store: ${taskId}`);
    }
    return canonicalPath;
  }

  private dependsOn(
    taskId: string,
    targetId: string,
    tasks: ReadonlyMap<string, Task>,
  ): boolean {
    const pending = [taskId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        break;
      }
      if (current === targetId) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      pending.push(...(tasks.get(current)?.blockedBy ?? []));
    }
    return false;
  }

  private async taskMap(): Promise<Map<string, Task>> {
    const tasks = await this.list();
    return new Map(tasks.map((task) => [task.id, task]));
  }

  private serialize(task: Task): string {
    return `${JSON.stringify(task, null, 2)}\n`;
  }
}

const taskStore = new TaskStore(tasksDirectory);

function incompleteDependencies(
  task: Task,
  tasks: ReadonlyMap<string, Task>,
): string[] {
  return task.blockedBy.filter(
    (dependency) => tasks.get(dependency)?.status !== 'completed',
  );
}

function isReadyBlockedTask(
  task: Task,
  tasks: ReadonlyMap<string, Task>,
): boolean {
  return (
    task.status === 'pending' &&
    task.blockedBy.length > 0 &&
    incompleteDependencies(task, tasks).length === 0
  );
}

async function claimTask(taskId: string, owner = 'agent'): Promise<string> {
  const tasks = await taskStore.list();
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const task = taskMap.get(taskId);
  if (task === undefined) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== 'pending') {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }

  const blockedBy = incompleteDependencies(task, taskMap);
  if (blockedBy.length > 0) {
    return `Blocked by: ${blockedBy.join(', ')}`;
  }

  task.owner = owner;
  task.status = 'in_progress';
  await taskStore.save(task);
  console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
  return `Claimed ${task.id} (${task.subject})`;
}

async function completeTask(taskId: string, owner = 'agent'): Promise<string> {
  const tasks = await taskStore.list();
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const task = taskMap.get(taskId);
  if (task === undefined) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== 'in_progress') {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  if (task.owner !== owner) {
    return `Task ${taskId} is owned by ${task.owner ?? 'nobody'}, not ${owner}`;
  }

  const readyBefore = new Set(
    tasks
      .filter((candidate) => isReadyBlockedTask(candidate, taskMap))
      .map((candidate) => candidate.id),
  );

  task.status = 'completed';
  await taskStore.save(task);
  taskMap.set(task.id, task);

  const unblocked = tasks
    .filter(
      (candidate) =>
        !readyBefore.has(candidate.id) &&
        isReadyBlockedTask(candidate, taskMap),
    )
    .map((candidate) => candidate.subject);

  console.log(`  [complete] ${task.subject}`);
  if (unblocked.length > 0) {
    console.log(`  [unblocked] ${unblocked.join(', ')}`);
  }
  return [
    `Completed ${task.id} (${task.subject})`,
    ...(unblocked.length > 0 ? [`Unblocked: ${unblocked.join(', ')}`] : []),
  ].join('\n');
}

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
  defineTool<{ subject: string; description?: string }>(
    {
      name: 'create_task',
      description: 'Create a task and return its runtime-generated ID.',
      input_schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['subject'],
        additionalProperties: false,
      },
    },
    async ({ subject, description }) => {
      const task = await taskStore.create(subject, description);
      console.log(`  [create] ${task.subject}`);
      return `Created ${task.id}: ${task.subject}`;
    },
  ),
  defineTool<{ task_id: string; addBlockedBy: string[] }>(
    {
      name: 'update_task',
      description: 'Add dependencies using IDs returned by create_task.',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', pattern: taskIdPatternSource },
          addBlockedBy: {
            type: 'array',
            items: { type: 'string', pattern: taskIdPatternSource },
            minItems: 1,
          },
        },
        required: ['task_id', 'addBlockedBy'],
        additionalProperties: false,
      },
    },
    async ({ task_id: taskId, addBlockedBy }) => {
      const task = await taskStore.updateDependencies(taskId, addBlockedBy);
      return `Updated ${task.id} blockedBy: ${task.blockedBy.join(', ') || '(none)'}`;
    },
  ),
  defineTool<Record<string, never>>(
    {
      name: 'list_tasks',
      description: 'List tasks with status, owner, and dependencies.',
      input_schema: { type: 'object', properties: {} },
    },
    async () => {
      const tasks = await taskStore.list();
      if (tasks.length === 0) {
        return 'No tasks. Use create_task to add some.';
      }
      return tasks
        .map((task) => {
          const marker = {
            pending: '[ ]',
            in_progress: '[>]',
            completed: '[x]',
          }[task.status];
          const owner = task.owner === null ? '' : ` [${task.owner}]`;
          const dependencies =
            task.blockedBy.length === 0
              ? ''
              : ` (blockedBy: ${task.blockedBy.join(', ')})`;
          return `${marker} ${task.id}: ${task.subject} [${task.status}]${owner}${dependencies}`;
        })
        .join('\n');
    },
  ),
  defineTool<{ task_id: string }>(
    {
      name: 'get_task',
      description: 'Get a task by ID.',
      input_schema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    async ({ task_id: taskId }) =>
      JSON.stringify(await taskStore.load(taskId), null, 2),
  ),
  defineTool<{ task_id: string }>(
    {
      name: 'claim_task',
      description: 'Claim a pending task whose dependencies are complete.',
      input_schema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    ({ task_id: taskId }) => claimTask(taskId),
  ),
  defineTool<{ task_id: string }>(
    {
      name: 'complete_task',
      description: 'Complete the task claimed by this agent.',
      input_schema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    ({ task_id: taskId }) => completeTask(taskId),
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
    !isInside(workdir, resolve(workdir, path))
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

async function executeTool(
  toolCall: Anthropic.ToolUseBlock,
  readline: ReadlineInterface,
): Promise<string> {
  const blocked = await triggerHooks('PreToolUse', toolCall, readline);
  if (blocked !== undefined) {
    return blocked;
  }

  const handler = toolHandlers.get(toolCall.name);
  let output: string;
  try {
    output = handler
      ? await handler(toolCall.input)
      : `Unknown tool: ${toolCall.name}`;
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

  console.log('s10: Task System');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms10 >> \u001B[0m');
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
