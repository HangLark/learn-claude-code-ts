/**
 * s16 — Workflow Runtime
 *
 * 关键理念：模型只选择一个已保存的 Workflow；可信脚本用 agent、parallel
 * 和 pipeline 固定编排，并用稳定 journal key 让同一次运行可以续跑。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type Anthropic from '@anthropic-ai/sdk';

import {
  client,
  defineTool,
  model,
  registerIntegratedTool,
  runIntegratedCli,
} from '../s15_integrated_harness/code.js';

const agentCap = 1_000;
const concurrency = 8;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = resolve(moduleDirectory, '.runtime');
const workflowNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const runIdPattern = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/u;

type WorkflowArgs = Record<string, unknown>;
type WorkflowStatus = 'running' | 'completed' | 'failed';
const severities = ['high', 'medium', 'low'] as const;
type Severity = (typeof severities)[number];

function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === 'string' &&
    severities.some((severity) => severity === value)
  );
}

class WorkflowInputError extends Error {
  override readonly name = 'WorkflowInputError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !runIdPattern.test(value)) {
    throw new WorkflowInputError('Invalid workflow runId');
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isRecord(item)) {
      return item;
    }
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function reserveRunId(meta: WorkflowMeta): Promise<string> {
  await mkdir(runtimeDirectory, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const runId = validateRunId(
      `wf_${meta.name}_${randomBytes(8).toString('hex')}`,
    );
    try {
      const reservation = await open(
        resolve(runtimeDirectory, `${runId}.json`),
        'wx',
      );
      await reservation.close();
      return runId;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new WorkflowInputError('Could not allocate a workflow runId');
}

const activeRuns = new Set<string>();

async function withRunLock<Result>(
  runId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  if (activeRuns.has(runId)) {
    throw new WorkflowInputError(`Workflow run ${runId} is already active`);
  }
  activeRuns.add(runId);
  const lockPath = resolve(runtimeDirectory, `${runId}.lock`);
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    try {
      lock = await open(lockPath, 'wx');
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new WorkflowInputError(`Workflow run ${runId} is already active`);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  } finally {
    activeRuns.delete(runId);
  }
}

// -- Metadata and minimal JSON Schema --

interface WorkflowMeta {
  name: string;
  description: string;
  phases?: readonly string[];
}

function validateMeta(meta: WorkflowMeta): WorkflowMeta {
  if (
    !workflowNamePattern.test(meta.name) ||
    meta.description.trim().length === 0
  ) {
    throw new WorkflowInputError(
      'Workflow meta requires a safe name and non-empty description',
    );
  }
  if (meta.phases?.some((phase) => phase.length === 0)) {
    throw new WorkflowInputError(
      'Workflow meta phases must be non-empty strings',
    );
  }
  return meta;
}

type JsonSchemaType =
  'object' | 'array' | 'string' | 'boolean' | 'number' | 'integer';

interface JsonSchema {
  type?: JsonSchemaType;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  items?: JsonSchema;
}

type ValidationResult = { ok: true } | { ok: false; error: string };

function validateSchema(value: unknown, schema: JsonSchema): ValidationResult {
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return { ok: false, error: `expected one of ${stableJson(schema.enum)}` };
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) {
      return { ok: false, error: 'expected object' };
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        return { ok: false, error: `missing required key '${key}'` };
      }
    }
    for (const [key, propertySchema] of Object.entries(
      schema.properties ?? {},
    )) {
      if (key in value) {
        const result = validateSchema(value[key], propertySchema);
        if (!result.ok) {
          return { ok: false, error: `${key}: ${result.error}` };
        }
      }
    }
    return { ok: true };
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return { ok: false, error: 'expected array' };
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const result = validateSchema(item, schema.items);
        if (!result.ok) {
          return { ok: false, error: `[${String(index)}]: ${result.error}` };
        }
      }
    }
    return { ok: true };
  }
  if (schema.type === 'string') {
    return typeof value === 'string'
      ? { ok: true }
      : { ok: false, error: 'expected string' };
  }
  if (schema.type === 'boolean') {
    return typeof value === 'boolean'
      ? { ok: true }
      : { ok: false, error: 'expected boolean' };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value))
      ? { ok: true }
      : { ok: false, error: `expected ${schema.type}` };
  }
  return { ok: true };
}

function numericHash(value: string): number {
  return Number.parseInt(stableHash(value).slice(0, 8), 16);
}

function fillSchema(schema: JsonSchema, seed: string): unknown {
  if (schema.enum?.[0] !== undefined) {
    return schema.enum[numericHash(seed) % schema.enum.length];
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    const keys = schema.required ?? Object.keys(properties);
    return Object.fromEntries(
      keys.map((key) => [
        key,
        fillSchema(properties[key] ?? { type: 'string' }, `${seed}/${key}`),
      ]),
    );
  }
  if (schema.type === 'array') {
    return [fillSchema(schema.items ?? { type: 'string' }, `${seed}/0`)];
  }
  if (schema.type === 'boolean') {
    return numericHash(seed) % 4 !== 0;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return numericHash(seed) % 5;
  }
  return seed.split('/').at(-1) ?? seed;
}

// -- Agent runners --

interface RunnerOutput {
  value: unknown;
  tokens: number;
}

interface AgentRunner {
  run(
    prompt: string,
    schema: JsonSchema | undefined,
    label: string,
  ): Promise<RunnerOutput>;
}

class MockAgentRunner implements AgentRunner {
  run(
    prompt: string,
    schema: JsonSchema | undefined,
    label: string,
  ): Promise<RunnerOutput> {
    let value: unknown;
    if (schema === undefined) {
      value = `[mock] ${(label || prompt).slice(0, 60)}`;
    } else if (schema.properties?.findings !== undefined) {
      const count = 1 + (numericHash(prompt) % 2);
      value = {
        findings: Array.from({ length: count }, (_, index) => ({
          title: `${label || 'audit'} #${String(index + 1)}`,
          severity: severities[numericHash(`${prompt}${String(index)}`) % 3],
        })),
      };
    } else if (schema.properties?.isReal !== undefined) {
      const isReal = numericHash(prompt) % 4 !== 0;
      value = {
        isReal,
        reason: isReal ? 'reproduced' : 'could not reproduce',
      };
    } else {
      value = fillSchema(schema, prompt);
    }
    return Promise.resolve({
      value,
      tokens:
        Math.floor(prompt.length / 4) +
        Math.floor(stableJson(value).length / 4),
    });
  }
}

function responseText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function parseRunnerJson(text: string): unknown {
  let source = text.trim();
  if (source.startsWith('```')) {
    const lines = source.split(/\r?\n/u);
    lines.shift();
    if (lines.at(-1)?.trim() === '```') {
      lines.pop();
    }
    source = lines.join('\n').trim();
  }
  return JSON.parse(source) as unknown;
}

class AnthropicAgentRunner implements AgentRunner {
  async run(
    prompt: string,
    schema: JsonSchema | undefined,
  ): Promise<RunnerOutput> {
    const request =
      schema === undefined
        ? prompt
        : `${prompt}\n\nReturn only one JSON object matching this schema:\n${stableJson(schema)}`;
    const response = await client.messages.create({
      model,
      system:
        'You are a focused workflow agent. Complete only the supplied step. ' +
        'Do not claim access to files or results not included in the prompt.',
      messages: [{ role: 'user', content: request }],
      max_tokens: 2_000,
    });
    const text = responseText(response.content);
    let value: unknown = text;
    if (schema !== undefined) {
      try {
        value = parseRunnerJson(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        // ExecutionState performs the schema-aware retry.
      }
    }
    return {
      value,
      tokens: response.usage.input_tokens + response.usage.output_tokens,
    };
  }
}

let runnerFactory: () => AgentRunner = () => new MockAgentRunner();

// -- Journal and budget --

class WorkflowJournal {
  private readonly cache = new Map<string, unknown>();
  private writeTail = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(runId: string, resume: boolean): Promise<WorkflowJournal> {
    await mkdir(runtimeDirectory, { recursive: true });
    const path = resolve(runtimeDirectory, `${runId}.journal.jsonl`);
    const journal = new WorkflowJournal(path);
    if (!resume) {
      await writeFile(path, '', { encoding: 'utf8', flag: 'wx' });
      return journal;
    }

    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new WorkflowInputError(`Resume journal not found for ${runId}`);
      }
      throw error;
    }
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (line.length === 0) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        throw new WorkflowInputError(
          `Invalid resume journal record at line ${String(index + 1)}`,
        );
      }
      if (
        !isRecord(record) ||
        typeof record.key !== 'string' ||
        !Object.hasOwn(record, 'value')
      ) {
        throw new WorkflowInputError(
          `Invalid resume journal record at line ${String(index + 1)}`,
        );
      }
      journal.cache.set(record.key, record.value);
    }
    return journal;
  }

  key(label: string, prompt: string, schema: JsonSchema | undefined): string {
    const basis = `agent|${label}|${prompt}|${stableJson(schema)}`;
    return `agent-${stableHash(basis).slice(0, 10)}`;
  }

  cached(key: string): { found: true; value: unknown } | { found: false } {
    return this.cache.has(key)
      ? { found: true, value: this.cache.get(key) }
      : { found: false };
  }

  async record(key: string, value: unknown): Promise<void> {
    const line = `${JSON.stringify({ key, value })}\n`;
    const write = this.writeTail.then(() =>
      appendFile(this.path, line, 'utf8'),
    );
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    this.cache.set(key, value);
  }

  async close(): Promise<void> {
    await this.writeTail;
  }
}

class Budget {
  private used = 0;

  constructor(readonly total?: number) {}

  add(tokens: number): void {
    if (this.total !== undefined && this.used + tokens > this.total) {
      throw new WorkflowInputError(
        `Token budget exceeded (${String(this.used + tokens)} > ${String(this.total)})`,
      );
    }
    this.used += tokens;
  }

  remaining(): number {
    return this.total === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.total - this.used);
  }
}

// -- Workflow primitives --

type ProgressEvent =
  | { type: 'workflow_phase'; title: string }
  | { type: 'workflow_log'; message: string }
  | {
      type: 'workflow_agent';
      label: string;
      phase?: string;
      status: 'cached' | 'done';
    };

class LocalWorkflowTask {
  status: WorkflowStatus = 'running';
  readonly usage = { agents: 0, tokens: 0 };
  readonly progress: ProgressEvent[] = [];

  constructor(
    readonly taskId: string,
    readonly runId: string,
    readonly meta: WorkflowMeta,
  ) {}

  event(name: string, data: Record<string, unknown>): void {
    const detail = Object.entries(data)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    console.log(`  event      ${name.padEnd(18)} ${detail}`);
  }

  progressEvent(event: ProgressEvent): void {
    this.progress.push(event);
    const { type, ...data } = event;
    const detail = Object.entries(data)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    console.log(`  progress   ${type.padEnd(16)} ${detail}`);
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolveWaiter) => {
        this.waiters.push(resolveWaiter);
      });
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

class ExecutionLimits {
  private agents = 0;
  readonly semaphore = new Semaphore(concurrency);

  claimAgent(): void {
    this.agents += 1;
    if (this.agents > agentCap) {
      throw new WorkflowInputError(`agent() cap reached (${String(agentCap)})`);
    }
  }
}

async function settleAll<Result>(
  operations: readonly Promise<Result>[],
): Promise<Result[]> {
  const settled = await Promise.allSettled(operations);
  const values: Result[] = [];
  let firstFailure: unknown;
  let failed = false;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      values.push(result.value);
    } else if (!failed) {
      firstFailure = result.reason;
      failed = true;
    }
  }
  if (failed) {
    throw firstFailure;
  }
  return values;
}

interface AgentOptions {
  schema?: JsonSchema;
  label?: string;
  phase?: string;
}

type WorkflowScript<Result = unknown> = (
  context: ExecutionState,
  args: WorkflowArgs,
) => Promise<Result>;

interface WorkflowRegistration {
  meta: WorkflowMeta;
  run: WorkflowScript;
}

const workflows = new Map<string, WorkflowRegistration>();

class ExecutionState {
  private phaseTitle?: string;
  private readonly phasesSeen = new Set<string>();

  constructor(
    private readonly task: LocalWorkflowTask,
    private readonly journal: WorkflowJournal,
    private readonly runner: AgentRunner,
    private readonly budget: Budget,
    private readonly depth = 0,
    private readonly limits = new ExecutionLimits(),
  ) {}

  phase(title: string): void {
    this.phaseTitle = title;
    if (!this.phasesSeen.has(title)) {
      this.phasesSeen.add(title);
      this.task.progressEvent({ type: 'workflow_phase', title });
    }
  }

  log(message: string): void {
    this.task.progressEvent({ type: 'workflow_log', message });
  }

  async agent<Result>(
    prompt: string,
    options: AgentOptions & { schema: JsonSchema },
  ): Promise<Result>;
  async agent(
    prompt: string,
    options?: AgentOptions & { schema?: undefined },
  ): Promise<string>;
  async agent(prompt: string, options: AgentOptions = {}): Promise<unknown> {
    const label = options.label ?? `${prompt.slice(0, 24)}...`;
    const phase = options.phase ?? this.phaseTitle;
    this.limits.claimAgent();
    if (this.budget.remaining() <= 0) {
      throw new WorkflowInputError('Token budget exceeded');
    }

    const key = this.journal.key(label, prompt, options.schema);
    const cached = this.journal.cached(key);
    if (cached.found) {
      if (options.schema !== undefined) {
        const validation = validateSchema(cached.value, options.schema);
        if (!validation.ok) {
          throw new WorkflowInputError(
            `Cached agent output failed schema validation: ${validation.error}`,
          );
        }
      } else if (typeof cached.value !== 'string') {
        throw new WorkflowInputError('Cached agent output must be text');
      }
      this.task.progressEvent({
        type: 'workflow_agent',
        label,
        ...(phase === undefined ? {} : { phase }),
        status: 'cached',
      });
      return cached.value;
    }

    let run = await this.limits.semaphore.run(() =>
      this.runner.run(prompt, options.schema, label),
    );
    let validation =
      options.schema === undefined
        ? ({ ok: true } as const)
        : validateSchema(run.value, options.schema);
    if (!validation.ok && options.schema !== undefined) {
      const retry = await this.limits.semaphore.run(() =>
        this.runner.run(
          `${prompt}\n\nReturn valid JSON.`,
          options.schema,
          label,
        ),
      );
      run = { value: retry.value, tokens: run.tokens + retry.tokens };
      validation = validateSchema(run.value, options.schema);
      if (!validation.ok) {
        throw new WorkflowInputError(
          `agent({schema}) invalid output: ${validation.error}`,
        );
      }
    }

    this.budget.add(run.tokens);
    this.task.usage.agents += 1;
    this.task.usage.tokens += run.tokens;
    await this.journal.record(key, run.value);
    this.task.progressEvent({
      type: 'workflow_agent',
      label,
      ...(phase === undefined ? {} : { phase }),
      status: 'done',
    });
    return run.value;
  }

  parallel<Result>(
    operations: readonly (() => Promise<Result>)[],
  ): Promise<Result[]> {
    return settleAll(
      operations.map((operation) => Promise.resolve().then(operation)),
    );
  }

  pipeline<Item, Intermediate, Result>(
    items: readonly Item[],
    first: (value: Item, item: Item, index: number) => Promise<Intermediate>,
    second: (value: Intermediate, item: Item, index: number) => Promise<Result>,
  ): Promise<Result[]> {
    return settleAll(
      items.map(async (item, index) => {
        const intermediate = await first(item, item, index);
        return second(intermediate, item, index);
      }),
    );
  }

  async workflow(name: string, args: WorkflowArgs = {}): Promise<unknown> {
    if (this.depth >= 1) {
      throw new WorkflowInputError('workflow() nesting is one level only');
    }
    const registration = workflows.get(name);
    if (registration === undefined) {
      throw new WorkflowInputError(`Unknown workflow '${name}'`);
    }
    const child = new ExecutionState(
      this.task,
      this.journal,
      this.runner,
      this.budget,
      this.depth + 1,
      this.limits,
    );
    return registration.run(child, args);
  }
}

// -- Workflow lifecycle and persistence --

interface SerializedTask {
  taskId: string;
  taskType: 'local_workflow';
  runId: string;
  workflowName: string;
  status: WorkflowStatus;
  usage: { agents: number; tokens: number };
  progress: ProgressEvent[];
}

function serializeTask(task: LocalWorkflowTask): SerializedTask {
  return {
    taskId: task.taskId,
    taskType: 'local_workflow',
    runId: task.runId,
    workflowName: task.meta.name,
    status: task.status,
    usage: { ...task.usage },
    progress: [...task.progress],
  };
}

interface WorkflowCallResult {
  launched: {
    status: 'async_launched';
    taskId: string;
    taskType: 'local_workflow';
    runId: string;
    workflowName: string;
  };
  result: unknown;
  task: LocalWorkflowTask;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function readSnapshot(runId: string): Promise<Record<string, unknown>> {
  const path = resolve(runtimeDirectory, `${runId}.json`);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new WorkflowInputError(`Resume snapshot not found for ${runId}`);
    }
    throw error;
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(content) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new WorkflowInputError(`Invalid resume snapshot for ${runId}`);
  }
  if (!isRecord(snapshot)) {
    throw new WorkflowInputError(`Invalid resume snapshot for ${runId}`);
  }
  return snapshot;
}

function readBudget(args: WorkflowArgs): number | undefined {
  const value = args.budget;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new WorkflowInputError('args.budget must be a non-negative number');
  }
  return value;
}

class WorkflowTool {
  constructor(
    private readonly deniedWorkflows: ReadonlySet<string> = new Set(),
  ) {}

  async call(
    meta: WorkflowMeta,
    script: WorkflowScript,
    args: WorkflowArgs | undefined,
    resumeFromRunId?: string,
  ): Promise<WorkflowCallResult> {
    validateMeta(meta);
    if (this.deniedWorkflows.has(meta.name)) {
      throw new WorkflowInputError(
        `Workflow '${meta.name}' denied by settings`,
      );
    }
    const resuming = resumeFromRunId !== undefined;
    const runId = resuming
      ? validateRunId(resumeFromRunId)
      : await reserveRunId(meta);
    return withRunLock(runId, () =>
      this.callLocked(meta, script, args, runId, resuming),
    );
  }

  private async callLocked(
    meta: WorkflowMeta,
    script: WorkflowScript,
    suppliedArgs: WorkflowArgs | undefined,
    runId: string,
    resuming: boolean,
  ): Promise<WorkflowCallResult> {
    let args = suppliedArgs;
    let journal: WorkflowJournal;
    if (resuming) {
      const snapshot = await readSnapshot(runId);
      if (snapshot.workflowName !== meta.name) {
        throw new WorkflowInputError(
          'Resume runId does not match workflow meta',
        );
      }
      let savedArgs: WorkflowArgs;
      if (!Object.hasOwn(snapshot, 'args')) {
        savedArgs = {};
      } else if (isRecord(snapshot.args)) {
        savedArgs = snapshot.args;
      } else {
        throw new WorkflowInputError('Resume snapshot args must be an object');
      }
      if (args === undefined) {
        args = savedArgs;
      } else if (stableJson(args) !== stableJson(savedArgs)) {
        throw new WorkflowInputError(
          'Resume args do not match the original run',
        );
      }
      journal = await WorkflowJournal.open(runId, true);
    } else {
      args ??= {};
      journal = await WorkflowJournal.open(runId, false);
    }

    const taskId = `local_workflow_${runId}`;
    const task = new LocalWorkflowTask(taskId, runId, meta);
    const launched = {
      status: 'async_launched' as const,
      taskId,
      taskType: 'local_workflow' as const,
      runId,
      workflowName: meta.name,
    };
    task.event('async_launched', { runId, taskId });
    const phases = meta.phases?.join(',');
    task.event('task_started', {
      workflow: meta.name,
      phases: phases === undefined || phases.length === 0 ? '-' : phases,
      resume: resuming,
    });
    await writeJson(resolve(runtimeDirectory, `${runId}.json`), {
      runId,
      workflowName: meta.name,
      args,
      task: serializeTask(task),
    });

    let result: unknown;
    try {
      const context = new ExecutionState(
        task,
        journal,
        runnerFactory(),
        new Budget(readBudget(args)),
      );
      result = await script(context, args);
      task.status = 'completed';
    } catch (error) {
      task.status = 'failed';
      result = {
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await journal.close();
    }

    await writeJson(resolve(runtimeDirectory, `${runId}.output.json`), result);
    await writeJson(resolve(runtimeDirectory, `${runId}.json`), {
      runId,
      workflowName: meta.name,
      args,
      task: serializeTask(task),
    });
    await writeFile(resolve(runtimeDirectory, 'last_run.txt'), runId, 'utf8');
    task.event('task_notification', {
      status: task.status,
      agents: task.usage.agents,
      tokens: task.usage.tokens,
      outputFile: `.runtime/${runId}.output.json`,
    });
    return { launched, result, task };
  }
}

// -- Saved sample workflow --

const findingsSchema: JsonSchema = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: severities },
        },
      },
    },
  },
};

const verdictSchema: JsonSchema = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

interface Finding {
  title: string;
  severity: Severity;
}

interface FindingsResult {
  findings: Finding[];
}

interface Verdict {
  isReal: boolean;
  reason: string;
}

interface AuditedDimension {
  dimension: string;
  findings: Finding[];
}

interface VerifiedDimension {
  dimension: string;
  confirmed: Finding[];
}

interface ConfirmedFinding extends Finding {
  dimension: string;
}

interface ReviewResult {
  confirmed: ConfirmedFinding[];
}

const sampleMeta: WorkflowMeta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions and verify findings',
  phases: ['Review', 'Verify'],
};

const dimensions = ['correctness', 'security', 'performance', 'style'] as const;
const demoChanges = [
  'function loadUser(userId: string) {',
  '  return db.query(`SELECT * FROM users WHERE id = ${userId}`);',
  '}',
].join('\n');

async function sampleWorkflow(
  context: ExecutionState,
  args: WorkflowArgs,
): Promise<ReviewResult> {
  context.phase('Review');
  if (args.changes !== undefined && typeof args.changes !== 'string') {
    throw new WorkflowInputError('args.changes must be a string');
  }
  const suppliedChanges = args.changes?.trim();
  const reviewInput =
    suppliedChanges === undefined || suppliedChanges.length === 0
      ? 'No change context was supplied.'
      : suppliedChanges;

  const results = await context.pipeline(
    dimensions,
    async (_value, dimension): Promise<AuditedDimension> => {
      const output = await context.agent<FindingsResult>(
        `Review this change context for ${dimension} issues. Report only issues supported by the supplied text.\n\n${reviewInput}`,
        {
          schema: findingsSchema,
          label: `audit:${dimension}`,
          phase: 'Review',
        },
      );
      return { dimension, findings: output.findings };
    },
    async (audited, dimension): Promise<VerifiedDimension> => {
      context.phase('Verify');
      const verdicts = await context.parallel(
        audited.findings.map(
          (finding) => () =>
            context.agent<Verdict>(
              `Adversarially verify this ${dimension} finding against the supplied change context.\n\nChange context:\n${reviewInput}\n\nFinding:\n${stableJson(finding)}`,
              {
                schema: verdictSchema,
                label: `verify:${dimension}:${finding.title}`,
                phase: 'Verify',
              },
            ),
        ),
      );
      return {
        dimension,
        confirmed: audited.findings.filter(
          (_finding, index) => verdicts[index]?.isReal === true,
        ),
      };
    },
  );

  const confirmed = results.flatMap(({ dimension, confirmed }) =>
    confirmed.map((finding) => ({ dimension, ...finding })),
  );
  const severityRank: Record<Severity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  confirmed.sort(
    (left, right) => severityRank[left.severity] - severityRank[right.severity],
  );
  context.log(`confirmed ${String(confirmed.length)} real finding(s)`);
  return { confirmed };
}

workflows.set(sampleMeta.name, { meta: sampleMeta, run: sampleWorkflow });

interface WorkflowToolInput {
  name: unknown;
  args?: unknown;
  resume_from_run_id?: unknown;
}

interface ModelWorkflowResult {
  launched: WorkflowCallResult['launched'];
  result: unknown;
  task: SerializedTask;
}

const workflowTool = new WorkflowTool();

async function runWorkflow(
  input: WorkflowToolInput,
): Promise<ModelWorkflowResult> {
  if (typeof input.name !== 'string') {
    throw new WorkflowInputError('Workflow name must be a string');
  }
  const registration = workflows.get(input.name);
  if (registration === undefined) {
    throw new WorkflowInputError(`Unknown workflow '${input.name}'`);
  }
  if (input.args !== undefined && !isRecord(input.args)) {
    throw new WorkflowInputError('Workflow args must be an object');
  }
  if (
    input.resume_from_run_id !== undefined &&
    typeof input.resume_from_run_id !== 'string'
  ) {
    throw new WorkflowInputError('resume_from_run_id must be a string');
  }
  const output = await workflowTool.call(
    registration.meta,
    registration.run,
    input.args,
    input.resume_from_run_id,
  );
  return {
    launched: output.launched,
    result: output.result,
    task: serializeTask(output.task),
  };
}

let workflowInstalled = false;

function installWorkflowTool(): void {
  runnerFactory = () => new AnthropicAgentRunner();
  if (workflowInstalled) {
    return;
  }
  registerIntegratedTool(
    defineTool<WorkflowToolInput>(
      {
        name: 'Workflow',
        description: 'Run a saved workflow by name. Pass input in args.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            args: { type: 'object' },
            resume_from_run_id: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      async (input) => JSON.stringify(await runWorkflow(input)),
    ),
  );
  workflowInstalled = true;
}

function confirmedFindings(result: unknown): ConfirmedFinding[] {
  if (!isRecord(result) || !Array.isArray(result.confirmed)) {
    return [];
  }
  return result.confirmed.filter((value): value is ConfirmedFinding => {
    if (!isRecord(value)) {
      return false;
    }
    return (
      typeof value.dimension === 'string' &&
      typeof value.title === 'string' &&
      isSeverity(value.severity)
    );
  });
}

async function readLastRun(): Promise<string | undefined> {
  try {
    return (
      await readFile(resolve(runtimeDirectory, 'last_run.txt'), 'utf8')
    ).trim();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function runDemo(resume: boolean): Promise<void> {
  runnerFactory = () => new MockAgentRunner();
  const resumeFromRunId = resume ? await readLastRun() : undefined;
  if (resume) {
    if (resumeFromRunId === undefined) {
      console.log('Nothing to resume; run `pnpm s16 demo` first.');
      return;
    }
    console.log(
      `Resuming ${resumeFromRunId}; unchanged agent calls use the journal cache.\n`,
    );
  } else {
    console.log('Launching workflow `review-changes`.\n');
  }
  const output = await runWorkflow({
    name: 'review-changes',
    args: { budget: null, changes: demoChanges },
    ...(resumeFromRunId === undefined
      ? {}
      : { resume_from_run_id: resumeFromRunId }),
  });

  console.log('\nresult:');
  for (const finding of confirmedFindings(output.result)) {
    console.log(
      `  [${finding.severity.padEnd(6)}] ${finding.dimension}: ${finding.title}`,
    );
  }
  console.log(
    `\nstatus=${output.task.status}  agents=${String(output.task.usage.agents)}  ` +
      `tokens=${String(output.task.usage.tokens)}  journal=.runtime/${output.task.runId}.journal.jsonl`,
  );
}

async function main(arguments_: string[]): Promise<void> {
  if (arguments_[0] === 'demo' || arguments_[0] === 'resume') {
    await runDemo(arguments_[0] === 'resume');
    return;
  }
  installWorkflowTool();
  await runIntegratedCli({
    title: 's16: Workflow Runtime',
    prompt: '\u001B[36ms16 >> \u001B[0m',
  });
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main(process.argv.slice(2));
}
