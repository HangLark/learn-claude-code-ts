/**
 * s12 — Cron Scheduler
 *
 * 关键理念：Harness 持久化“何时执行什么 prompt”，到期后先入队，
 * 等 Agent 空闲再交付；模型成功接收后才确认，形成至少一次交付。
 */

import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  glob,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const workdir = process.cwd();
const client = new Anthropic();
const { MODEL_ID: model } = process.env as { MODEL_ID: string };
const systemPrompt = `You are a coding agent at ${workdir}. Use tools to solve tasks. Use schedule_cron for work that should start at a future local time.`;

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

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
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

const cronJobIdPatternSource = '^cron_[0-9a-f]{8}$';
const cronJobIdPattern = new RegExp(cronJobIdPatternSource, 'u');

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  pendingDelivery: boolean;
  lastFired: string | null;
}

interface CronFieldRule {
  name: string;
  minimum: number;
  maximum: number;
}

const cronFieldRules: CronFieldRule[] = [
  { name: 'minute', minimum: 0, maximum: 59 },
  { name: 'hour', minimum: 0, maximum: 23 },
  { name: 'day-of-month', minimum: 1, maximum: 31 },
  { name: 'month', minimum: 1, maximum: 12 },
  { name: 'day-of-week', minimum: 0, maximum: 6 },
];

type ParsedCronField =
  | { kind: 'any' }
  | { kind: 'step'; step: number }
  | { kind: 'list'; fields: ParsedCronField[] }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'value'; value: number };

function parseCronField(
  field: string,
  { minimum, maximum }: CronFieldRule,
): ParsedCronField | string {
  if (field === '*') {
    return { kind: 'any' };
  }
  if (field.startsWith('*/')) {
    const step = field.slice(2);
    return /^\d+$/u.test(step) && Number(step) > 0
      ? { kind: 'step', step: Number(step) }
      : `Invalid step: ${field}`;
  }
  if (field.includes(',')) {
    const fields: ParsedCronField[] = [];
    for (const part of field.split(',')) {
      const parsed = parseCronField(part.trim(), {
        name: '',
        minimum,
        maximum,
      });
      if (typeof parsed === 'string') {
        return parsed;
      }
      fields.push(parsed);
    }
    return { kind: 'list', fields };
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const [startText, endText] = parts;
    if (
      parts.length !== 2 ||
      startText === undefined ||
      endText === undefined ||
      !/^\d+$/u.test(startText) ||
      !/^\d+$/u.test(endText)
    ) {
      return `Invalid range: ${field}`;
    }
    const start = Number(startText);
    const end = Number(endText);
    if (start > end) {
      return `Range start is greater than end: ${field}`;
    }
    return start < minimum || end > maximum
      ? `Range ${field} is outside [${String(minimum)}-${String(maximum)}]`
      : { kind: 'range', start, end };
  }
  if (!/^\d+$/u.test(field)) {
    return `Invalid field: ${field}`;
  }
  const value = Number(field);
  return value < minimum || value > maximum
    ? `Value ${field} is outside [${String(minimum)}-${String(maximum)}]`
    : { kind: 'value', value };
}

function parseCron(expression: string): ParsedCronField[] | string {
  const rawFields = expression.trim().split(/\s+/u);
  if (rawFields.length !== cronFieldRules.length) {
    return `Expected 5 fields, got ${String(rawFields.length)}`;
  }
  const parsedFields: ParsedCronField[] = [];
  for (const [index, rule] of cronFieldRules.entries()) {
    const field = rawFields[index];
    if (field === undefined) {
      return `Missing ${rule.name}`;
    }
    const parsed = parseCronField(field, rule);
    if (typeof parsed === 'string') {
      return `${rule.name}: ${parsed}`;
    }
    parsedFields.push(parsed);
  }
  return parsedFields;
}

function cronFieldMatches(field: ParsedCronField, value: number): boolean {
  switch (field.kind) {
    case 'any':
      return true;
    case 'step':
      return value % field.step === 0;
    case 'list':
      return field.fields.some((part) => cronFieldMatches(part, value));
    case 'range':
      return field.start <= value && value <= field.end;
    case 'value':
      return field.value === value;
  }
}

function validateCron(expression: string): string | undefined {
  const parsed = parseCron(expression);
  return typeof parsed === 'string' ? parsed : undefined;
}

function cronMatches(expression: string, moment: Date): boolean {
  const parsed = parseCron(expression);
  if (typeof parsed === 'string') {
    return false;
  }
  const [minute, hour, day, month, weekday] = parsed;
  if (
    minute === undefined ||
    hour === undefined ||
    day === undefined ||
    month === undefined ||
    weekday === undefined
  ) {
    return false;
  }
  if (
    !cronFieldMatches(minute, moment.getMinutes()) ||
    !cronFieldMatches(hour, moment.getHours()) ||
    !cronFieldMatches(month, moment.getMonth() + 1)
  ) {
    return false;
  }

  const dayMatches = cronFieldMatches(day, moment.getDate());
  const weekdayMatches = cronFieldMatches(weekday, moment.getDay());
  if (day.kind === 'any' && weekday.kind === 'any') {
    return true;
  }
  if (day.kind === 'any') {
    return weekdayMatches;
  }
  if (weekday.kind === 'any') {
    return dayMatches;
  }
  return dayMatches || weekdayMatches;
}

function minuteMarker(moment: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

function parseCronJob(value: unknown): CronJob {
  if (!isRecord(value)) {
    throw new Error('expected an object');
  }
  const { id, cron, prompt, recurring, durable, pendingDelivery, lastFired } =
    value;
  if (
    typeof id !== 'string' ||
    !cronJobIdPattern.test(id) ||
    typeof cron !== 'string' ||
    validateCron(cron) !== undefined ||
    typeof prompt !== 'string' ||
    prompt.trim().length === 0 ||
    typeof recurring !== 'boolean' ||
    typeof durable !== 'boolean' ||
    typeof pendingDelivery !== 'boolean' ||
    (lastFired !== null && typeof lastFired !== 'string')
  ) {
    throw new Error('invalid cron job');
  }
  return {
    id,
    cron,
    prompt,
    recurring,
    durable,
    pendingDelivery,
    lastFired,
  };
}

class CronScheduler {
  private readonly jobs = new Map<string, CronJob>();
  private readonly queue: CronJob[] = [];
  private transition = Promise.resolve();

  load(): Promise<void> {
    return this.runExclusive(async () => {
      let content: string;
      try {
        const root = await realpath(workdir);
        const path = await realpath(resolve(root, '.scheduled_tasks.json'));
        if (!isInside(root, path)) {
          throw new Error('Scheduled task file escapes the workspace');
        }
        content = await readFile(path, 'utf8');
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return;
        }
        console.log(
          `  [cron] could not load scheduled tasks: ${String(error)}`,
        );
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(content);
        if (!Array.isArray(payload)) {
          throw new Error('expected a JSON list');
        }
      } catch (error) {
        console.log(
          `  [cron] could not load scheduled tasks: ${String(error)}`,
        );
        return;
      }

      let loaded = 0;
      for (const item of payload) {
        try {
          const job = parseCronJob(item);
          this.jobs.set(job.id, job);
          if (job.pendingDelivery) {
            this.queue.push(job);
          }
          loaded += 1;
        } catch (error) {
          console.log(`  [cron] skipped invalid saved job: ${String(error)}`);
        }
      }
      if (loaded > 0) {
        console.log(`  [cron] loaded ${String(loaded)} durable job(s)`);
      }
    });
  }

  schedule(
    cron: string,
    prompt: string,
    recurring = true,
    durable = true,
  ): Promise<string> {
    return this.runExclusive(async () => {
      const cronError = validateCron(cron);
      if (cronError !== undefined) {
        return `Error: ${cronError}`;
      }
      if (prompt.trim().length === 0) {
        return 'Error: Prompt cannot be empty';
      }

      const job: CronJob = {
        id: this.newId(),
        cron,
        prompt,
        recurring,
        durable,
        pendingDelivery: false,
        lastFired: null,
      };
      this.jobs.set(job.id, job);
      try {
        if (durable) {
          await this.save();
        }
      } catch (error) {
        this.jobs.delete(job.id);
        throw error;
      }
      console.log(
        `  [cron] scheduled ${job.id}: ${cron} -> ${prompt.slice(0, 60)}`,
      );
      return `Scheduled ${job.id}: ${cron} -> ${prompt}`;
    });
  }

  list(): Promise<string> {
    return this.runExclusive(() => {
      if (this.jobs.size === 0) {
        return 'No cron jobs.';
      }
      return [...this.jobs.values()]
        .map((job) => {
          const frequency = job.recurring ? 'recurring' : 'one-shot';
          const storage = job.durable ? 'durable' : 'session';
          return `${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)} [${frequency}, ${storage}]`;
        })
        .join('\n');
    });
  }

  cancel(jobId: string): Promise<string> {
    return this.runExclusive(async () => {
      const job = this.jobs.get(jobId);
      if (job === undefined) {
        return `Job ${jobId} not found`;
      }
      const previousQueue = [...this.queue];
      this.jobs.delete(jobId);
      this.queue.splice(
        0,
        this.queue.length,
        ...this.queue.filter((queued) => queued.id !== jobId),
      );
      try {
        if (job.durable) {
          await this.save();
        }
      } catch (error) {
        this.jobs.set(jobId, job);
        this.queue.splice(0, this.queue.length, ...previousQueue);
        throw error;
      }
      console.log(`  [cron] cancelled ${jobId}`);
      return `Cancelled ${jobId}`;
    });
  }

  poll(moment: Date): Promise<void> {
    return this.runExclusive(async () => {
      const marker = minuteMarker(moment);
      for (const job of [...this.jobs.values()]) {
        if (
          job.pendingDelivery ||
          job.lastFired === marker ||
          !cronMatches(job.cron, moment)
        ) {
          continue;
        }

        const previousPending = job.pendingDelivery;
        const previousLastFired = job.lastFired;
        job.pendingDelivery = true;
        job.lastFired = marker;
        try {
          if (job.durable) {
            await this.save();
          }
        } catch (error) {
          job.pendingDelivery = previousPending;
          job.lastFired = previousLastFired;
          console.log(`  [cron] could not enqueue ${job.id}: ${String(error)}`);
          continue;
        }
        this.queue.push(job);
        console.log(`  [cron] due ${job.id}: ${job.prompt.slice(0, 60)}`);
      }
    });
  }

  consume(): Promise<CronJob[]> {
    return this.runExclusive(() => this.queue.splice(0));
  }

  acknowledge(delivered: CronJob[]): Promise<void> {
    return this.runExclusive(async () => {
      const snapshot = new Map<string, CronJob>();
      let durableChanged = false;
      for (const job of delivered) {
        const current = this.jobs.get(job.id);
        if (current === undefined) {
          continue;
        }
        snapshot.set(current.id, { ...current });
        durableChanged ||= current.durable;
        if (current.recurring) {
          current.pendingDelivery = false;
        } else {
          this.jobs.delete(current.id);
        }
      }

      try {
        if (durableChanged) {
          await this.save();
        }
      } catch (error) {
        for (const [id, job] of snapshot) {
          this.jobs.set(id, job);
        }
        this.restoreUnlocked([...snapshot.values()]);
        throw error;
      }
    });
  }

  restore(delivered: CronJob[]): Promise<void> {
    return this.runExclusive(() => {
      this.restoreUnlocked(delivered);
    });
  }

  hasQueuedJobs(): Promise<boolean> {
    return this.runExclusive(() => this.queue.length > 0);
  }

  private restoreUnlocked(delivered: CronJob[]): void {
    const queuedIds = new Set(this.queue.map((job) => job.id));
    for (const job of delivered) {
      const current = this.jobs.get(job.id);
      if (current === undefined) {
        continue;
      }
      current.pendingDelivery = true;
      if (!queuedIds.has(current.id)) {
        this.queue.push(current);
        queuedIds.add(current.id);
      }
    }
  }

  private runExclusive<Result>(
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    const result = this.transition.then(operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private newId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = `cron_${randomBytes(4).toString('hex')}`;
      if (!this.jobs.has(id)) {
        return id;
      }
    }
    throw new Error('Could not allocate a cron job ID');
  }

  private async save(): Promise<void> {
    const root = await realpath(workdir);
    const path = resolve(root, '.scheduled_tasks.json');
    const temporary = resolve(
      root,
      `.scheduled_tasks.json.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`,
    );
    const payload = [...this.jobs.values()].filter((job) => job.durable);
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporary, path);
    } finally {
      await removeFileIfExists(temporary);
    }
  }
}

const scheduler = new CronScheduler();

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
  defineTool<{
    cron: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
  }>(
    {
      name: 'schedule_cron',
      description: 'Schedule a prompt with a 5-field cron expression.',
      input_schema: {
        type: 'object',
        properties: {
          cron: { type: 'string' },
          prompt: { type: 'string' },
          recurring: { type: 'boolean' },
          durable: { type: 'boolean' },
        },
        required: ['cron', 'prompt'],
      },
    },
    ({ cron, prompt, recurring, durable }) =>
      scheduler.schedule(cron, prompt, recurring, durable),
  ),
  defineTool<Record<string, never>>(
    {
      name: 'list_crons',
      description: 'List scheduled cron jobs.',
      input_schema: { type: 'object', properties: {} },
    },
    () => scheduler.list(),
  ),
  defineTool<{ job_id: string }>(
    {
      name: 'cancel_cron',
      description: 'Cancel a cron job by ID.',
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', pattern: cronJobIdPatternSource },
        },
        required: ['job_id'],
      },
    },
    ({ job_id: jobId }) => scheduler.cancel(jobId),
  ),
];

const tools = registeredTools.map(({ definition }) => definition);
const toolHandlers = new Map(
  registeredTools.map(({ definition, run }) => [definition.name, run]),
);

interface ToolContext {
  readline: ReadlineInterface;
  interactiveApproval: boolean;
}

interface HookArguments {
  UserPromptSubmit: [query: string];
  PreToolUse: [toolCall: Anthropic.ToolUseBlock, context: ToolContext];
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

async function requestPermission(
  context: ToolContext,
  reason: string,
): Promise<string | undefined> {
  if (!context.interactiveApproval) {
    return 'Permission denied: scheduled turns cannot request interactive approval';
  }
  console.log(`\n\u001B[33m[permission] ${reason}\u001B[0m`);
  const answer = await context.readline.question('   Allow? [y/N] ');
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
    ? undefined
    : 'Permission denied by user';
}

async function permissionHook(
  toolCall: Anthropic.ToolUseBlock,
  context: ToolContext,
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
      return requestPermission(context, 'Potentially destructive command');
    }
  }
  if (
    ['read_file', 'write_file', 'edit_file'].includes(toolCall.name) &&
    !isInside(workdir, resolve(workdir, path))
  ) {
    return requestPermission(context, 'Access outside workspace');
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
  context: ToolContext,
): Promise<string> {
  const blocked = await triggerHooks('PreToolUse', toolCall, context);
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
  context: ToolContext,
): Promise<Anthropic.ContentBlock[] | undefined> {
  const fired = await scheduler.consume();
  const scheduledStart = messages.length;
  for (const job of fired) {
    messages.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
    console.log(`  [cron] delivered ${job.id}: ${job.prompt.slice(0, 60)}`);
  }

  let waitingForAcknowledgement = fired;
  while (true) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        system: systemPrompt,
        messages,
        tools,
        max_tokens: 8_000,
      });
    } catch (error) {
      if (waitingForAcknowledgement.length > 0) {
        messages.splice(scheduledStart);
        await scheduler.restore(waitingForAcknowledgement);
      }
      console.log(`  [error] ${String(error)}`);
      return undefined;
    }

    messages.push({ role: 'assistant', content: response.content });
    if (waitingForAcknowledgement.length > 0) {
      try {
        await scheduler.acknowledge(waitingForAcknowledgement);
      } catch (error) {
        console.log(`  [cron] acknowledgement failed: ${String(error)}`);
      }
      waitingForAcknowledgement = [];
    }

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
        content: await executeTool(toolCall, context),
      });
    }
    messages.push({ role: 'user', content: results });
  }
}

let agentBusy = false;
let queueProcessorBusy = false;
const idleWaiters: (() => void)[] = [];

async function acquireAgent(): Promise<void> {
  while (agentBusy) {
    await new Promise<void>((resolveIdle) => idleWaiters.push(resolveIdle));
  }
  agentBusy = true;
}

function releaseAgent(): void {
  agentBusy = false;
  idleWaiters.shift()?.();
}

async function runAgentTurn(
  history: Anthropic.MessageParam[],
  context: ToolContext,
  query?: string,
): Promise<void> {
  await acquireAgent();
  try {
    if (query !== undefined) {
      await triggerHooks('UserPromptSubmit', query);
      history.push({ role: 'user', content: query });
    }
    const finalContent = await agentLoop(history, context);
    for (const block of finalContent ?? []) {
      if (block.type === 'text') {
        console.log(block.text);
      }
    }
    console.log();
  } finally {
    releaseAgent();
  }
}

function startRuntime(
  history: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): () => void {
  const pollTimer = setInterval(() => {
    void scheduler.poll(new Date());
  }, 1_000);
  const queueTimer = setInterval(() => {
    void runQueuedTurn(history, readline);
  }, 200);
  return () => {
    clearInterval(pollTimer);
    clearInterval(queueTimer);
  };
}

async function runQueuedTurn(
  history: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<void> {
  if (queueProcessorBusy) {
    return;
  }
  queueProcessorBusy = true;
  try {
    const hasQueuedJobs = await scheduler.hasQueuedJobs();
    if (agentBusy || !hasQueuedJobs) {
      return;
    }
    await runAgentTurn(history, {
      readline,
      interactiveApproval: false,
    });
  } finally {
    queueProcessorBusy = false;
  }
}

async function main(): Promise<void> {
  const history: Anthropic.MessageParam[] = [];

  console.log('s12: Cron Scheduler');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  await scheduler.load();
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const stopRuntime = startRuntime(history, readline);
  readline.setPrompt('\u001B[36ms12 >> \u001B[0m');
  readline.prompt();

  try {
    for await (const query of readline) {
      await runAgentTurn(
        history,
        { readline, interactiveApproval: true },
        query,
      );
      readline.prompt();
    }
  } finally {
    stopRuntime();
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main();
}
