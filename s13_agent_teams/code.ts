/**
 * s13 — Agent Teams
 *
 * 关键理念：Lead 与持久队友各有独立上下文，通过共享任务板和文件收件箱
 * 协作；Harness 负责认领原子性、WORK/IDLE 生命周期和类型化控制协议。
 */

import { exec, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFile,
  glob,
  lstat,
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
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const workdir = process.cwd();
const tasksDirectory = resolve(workdir, '.tasks');
const mailboxesDirectory = resolve(workdir, '.mailboxes');
const worktreesDirectory = resolve(workdir, '.worktrees');
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

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

class SerialQueue {
  private tail = Promise.resolve();

  run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function runBash(command: string, cwd: string): Promise<string> {
  return new Promise((resolveOutput) => {
    exec(command, { cwd }, (_error, stdout, stderr) => {
      resolveOutput(`${stdout}${stderr}`.trim() || '(no output)');
    });
  });
}

function runGit(
  arguments_: string[],
  cwd = workdir,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveResult) => {
    execFile('git', arguments_, { cwd }, (error, stdout, stderr) => {
      resolveResult({
        ok: error === null,
        output: `${stdout}${stderr}`.trim() || '(no output)',
      });
    });
  });
}

async function safePath(
  path: string,
  cwd: string,
  allowMissing = false,
): Promise<string> {
  const root = await realpath(cwd);
  const target = resolve(root, path);
  if (!isInside(root, target)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  let candidate = target;
  while (true) {
    try {
      const canonicalPath = await realpath(candidate);
      if (!isInside(root, canonicalPath)) {
        throw new Error(`Path escapes workspace through a symlink: ${path}`);
      }
      return candidate === target ? canonicalPath : target;
    } catch (error) {
      if (!allowMissing || !isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      if (await pathEntryExists(candidate)) {
        throw new Error(`Path is a dangling symlink: ${path}`, {
          cause: error,
        });
      }
      candidate = dirname(candidate);
    }
  }
}

async function runRead(
  path: string,
  cwd: string,
  limit?: number,
): Promise<string> {
  const lines = (await readFile(await safePath(path, cwd), 'utf8')).split(
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

async function runWrite(
  path: string,
  content: string,
  cwd: string,
): Promise<string> {
  const target = await safePath(path, cwd, true);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${path}`;
}

async function runEdit(
  path: string,
  oldText: string,
  newText: string,
  cwd: string,
): Promise<string> {
  const target = await safePath(path, cwd);
  const content = await readFile(target, 'utf8');
  const start = content.indexOf(oldText);
  if (start === -1) {
    return `Error: text not found in ${path}`;
  }
  await writeFile(
    target,
    `${content.slice(0, start)}${newText}${content.slice(start + oldText.length)}`,
    'utf8',
  );
  return `Edited ${path}`;
}

async function runGlob(pattern: string, cwd: string): Promise<string> {
  const matches: string[] = [];
  for await (const path of glob(pattern, { cwd })) {
    if (isInside(cwd, resolve(cwd, path))) {
      matches.push(path);
    }
  }
  const output = matches.sort().join('\n');
  return output.length > 0 ? output : '(no matches)';
}

const taskIdPatternSource = '^task_[0-9a-f]{8}$';
const taskIdPattern = new RegExp(taskIdPatternSource, 'u');
const agentNamePatternSource = '^[A-Za-z0-9_-]{1,64}$';
const agentNamePattern = new RegExp(agentNamePatternSource, 'u');
const worktreeNamePatternSource =
  '^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const worktreeNamePattern = new RegExp(worktreeNamePatternSource, 'u');
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
  worktree: string | null;
}

type ClaimResult = { ok: true; task: Task } | { ok: false; message: string };

function parseTask(content: string, expectedId: string): Task {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value) || value.id !== expectedId) {
    throw new Error(`Invalid task record: ${expectedId}`);
  }
  const { subject, description, status, owner, blockedBy, worktree } = value;
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
    !validDependencies ||
    (worktree !== undefined &&
      worktree !== null &&
      typeof worktree !== 'string')
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
    worktree: typeof worktree === 'string' ? worktree : null,
  };
}

class TaskStore {
  private readonly serial = new SerialQueue();
  private readonly assignments = new Map<string, string>();

  create(subject: string, description = ''): Promise<Task> {
    return this.serial.run(async () => {
      const normalizedSubject = subject.trim();
      if (normalizedSubject.length === 0) {
        throw new Error('Task subject cannot be empty');
      }
      const task: Task = {
        id: `task_${randomBytes(4).toString('hex')}`,
        subject: normalizedSubject,
        description,
        status: 'pending',
        owner: null,
        blockedBy: [],
        worktree: null,
      };
      await writeFile(
        await this.taskPath(task.id, false),
        this.serialize(task),
        { encoding: 'utf8', flag: 'wx' },
      );
      return task;
    });
  }

  updateDependencies(taskId: string, added: string[]): Promise<Task> {
    return this.serial.run(async () => {
      const tasks = await this.taskMapUnlocked();
      const task = tasks.get(taskId);
      if (task === undefined) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (task.status !== 'pending' || task.owner !== null) {
        throw new Error(
          `Task ${taskId} dependencies can only be updated while pending and unowned`,
        );
      }
      const dependencies = [...new Set(added)];
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
      await this.saveUnlocked(task);
      return task;
    });
  }

  load(taskId: string): Promise<Task> {
    return this.serial.run(() => this.loadUnlocked(taskId));
  }

  list(): Promise<Task[]> {
    return this.serial.run(() => this.listUnlocked());
  }

  claim(taskId: string, owner: string): Promise<ClaimResult> {
    return this.serial.run(async () => {
      const tasks = await this.taskMapUnlocked();
      return this.claimUnlocked(taskId, owner, tasks);
    });
  }

  claimNext(owner: string): Promise<Task | undefined> {
    return this.serial.run(async () => {
      const tasks = await this.taskMapUnlocked();
      if (
        this.assignments.has(owner) ||
        this.ownerTask(owner, tasks) !== undefined
      ) {
        return undefined;
      }
      const candidate = [...tasks.values()].find(
        (task) =>
          task.status === 'pending' &&
          task.owner === null &&
          this.incompleteDependencies(task, tasks).length === 0,
      );
      if (candidate === undefined) {
        return undefined;
      }
      const result = await this.claimUnlocked(candidate.id, owner, tasks);
      return result.ok ? result.task : undefined;
    });
  }

  complete(taskId: string, owner: string): Promise<string> {
    return this.serial.run(async () => {
      const tasks = await this.taskMapUnlocked();
      const task = tasks.get(taskId);
      if (task === undefined) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (task.status !== 'in_progress') {
        return `Task ${taskId} is ${task.status}, cannot complete`;
      }
      if (task.owner !== owner) {
        return `Task ${taskId} is owned by ${task.owner ?? 'nobody'}, not ${owner}`;
      }
      if (!this.assignments.has(owner)) {
        await this.taskCwd(task);
        this.assignments.set(owner, taskId);
      }
      task.status = 'completed';
      await this.saveUnlocked(task);
      tasks.set(task.id, task);
      const unblocked = [...tasks.values()]
        .filter(
          (candidate) =>
            candidate.status === 'pending' &&
            candidate.blockedBy.length > 0 &&
            this.incompleteDependencies(candidate, tasks).length === 0,
        )
        .map((candidate) => candidate.subject);
      return [
        `Completed ${task.id} (${task.subject})`,
        ...(unblocked.length > 0 ? [`Unblocked: ${unblocked.join(', ')}`] : []),
      ].join('\n');
    });
  }

  workspace(owner: string, requireAssignment: boolean): Promise<string> {
    return this.serial.run(async () => {
      const tasks = await this.taskMapUnlocked();
      const assignedTaskId = this.assignments.get(owner);
      if (assignedTaskId !== undefined) {
        const assignedTask = tasks.get(assignedTaskId);
        if (
          assignedTask?.owner === owner &&
          ['in_progress', 'completed'].includes(assignedTask.status)
        ) {
          return this.taskCwd(assignedTask);
        }
        this.assignments.delete(owner);
      }
      const task = this.ownerTask(owner, tasks);
      if (task === undefined) {
        if (requireAssignment) {
          throw new Error('Claim a Task before using workspace tools.');
        }
        return workdir;
      }
      this.assignments.set(owner, task.id);
      return this.taskCwd(task);
    });
  }

  assignmentTaskId(owner: string): Promise<string | null> {
    return this.serial.run(async () => {
      const assignedTaskId = this.assignments.get(owner);
      if (assignedTaskId !== undefined) {
        return assignedTaskId;
      }
      return this.ownerTask(owner, await this.taskMapUnlocked())?.id ?? null;
    });
  }

  releaseCompleted(owner: string): Promise<boolean> {
    return this.serial.run(async () => {
      const assignedTaskId = this.assignments.get(owner);
      if (assignedTaskId === undefined) {
        return false;
      }
      const task = await this.loadUnlocked(assignedTaskId);
      if (task.status !== 'completed' || task.owner !== owner) {
        return false;
      }
      this.assignments.delete(owner);
      return true;
    });
  }

  releaseAbandoned(owner: string): Promise<void> {
    return this.serial.run(async () => {
      const tasks = await this.listUnlocked();
      const task = tasks.find(
        (candidate) =>
          candidate.status === 'in_progress' && candidate.owner === owner,
      );
      if (task !== undefined) {
        task.status = 'pending';
        task.owner = null;
        await this.saveUnlocked(task);
      }
      this.assignments.delete(owner);
    });
  }

  createWorktree(name: string, taskId: string): Promise<string> {
    return this.serial.run(async () => {
      if (!worktreeNamePattern.test(name)) {
        return 'Error: invalid worktree name';
      }
      const tasks = await this.taskMapUnlocked();
      const task = tasks.get(taskId);
      if (task === undefined) {
        return `Error: Task ${taskId} not found`;
      }
      if (task.status !== 'pending' || task.owner !== null) {
        return `Error: Task ${taskId} must be pending and unowned`;
      }
      if (task.worktree !== null) {
        return `Error: Task ${taskId} already uses worktree '${task.worktree}'`;
      }
      if ([...tasks.values()].some((other) => other.worktree === name)) {
        return `Error: Worktree '${name}' is already bound to another task`;
      }

      const repository = await runGit(['rev-parse', '--show-toplevel']);
      if (
        !repository.ok ||
        (await realpath(repository.output)) !== (await realpath(workdir))
      ) {
        return 'Error: Working directory must be the root of a Git repository';
      }
      await mkdir(worktreesDirectory, { recursive: true });
      const root = await realpath(worktreesDirectory);
      if (!isInside(await realpath(workdir), root)) {
        throw new Error('Worktree directory escapes the workspace');
      }
      const path = resolve(root, name);
      const branch = `wt/${name}`;
      const created = await runGit(
        ['worktree', 'add', '-b', branch, path, 'HEAD'],
        workdir,
      );
      if (!created.ok) {
        return `Git error: ${created.output}`;
      }
      task.worktree = name;
      await this.saveUnlocked(task);
      return `Worktree '${name}' created at ${path} for task ${taskId}`;
    });
  }

  private async claimUnlocked(
    taskId: string,
    owner: string,
    tasks: Map<string, Task>,
  ): Promise<ClaimResult> {
    const task = tasks.get(taskId);
    if (task === undefined) {
      return { ok: false, message: `Task not found: ${taskId}` };
    }
    if (task.status !== 'pending' || task.owner !== null) {
      return { ok: false, message: `Task ${taskId} is no longer available` };
    }
    const current = this.ownerTask(owner, tasks);
    if (this.assignments.has(owner) || current !== undefined) {
      return {
        ok: false,
        message: `Owner ${owner} must complete its current task first`,
      };
    }
    const incomplete = this.incompleteDependencies(task, tasks);
    if (incomplete.length > 0) {
      return { ok: false, message: `Blocked by: ${incomplete.join(', ')}` };
    }
    await this.taskCwd(task);
    task.owner = owner;
    task.status = 'in_progress';
    await this.saveUnlocked(task);
    this.assignments.set(owner, task.id);
    return { ok: true, task };
  }

  private ownerTask(
    owner: string,
    tasks: ReadonlyMap<string, Task>,
  ): Task | undefined {
    return [...tasks.values()].find(
      (task) => task.status === 'in_progress' && task.owner === owner,
    );
  }

  private incompleteDependencies(
    task: Task,
    tasks: ReadonlyMap<string, Task>,
  ): string[] {
    return task.blockedBy.filter(
      (dependency) => tasks.get(dependency)?.status !== 'completed',
    );
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
      if (!visited.has(current)) {
        visited.add(current);
        pending.push(...(tasks.get(current)?.blockedBy ?? []));
      }
    }
    return false;
  }

  private async taskCwd(task: Task): Promise<string> {
    if (task.worktree === null) {
      return workdir;
    }
    const root = await realpath(worktreesDirectory);
    const path = await realpath(resolve(root, task.worktree));
    if (!isInside(root, path)) {
      throw new Error(`Worktree '${task.worktree}' escapes its directory`);
    }
    const repository = await runGit(['rev-parse', '--show-toplevel'], path);
    if (!repository.ok || (await realpath(repository.output)) !== path) {
      throw new Error(`Worktree '${task.worktree}' is not a Git worktree`);
    }
    return path;
  }

  private async root(): Promise<string> {
    await mkdir(tasksDirectory, { recursive: true });
    const [workspaceRoot, root] = await Promise.all([
      realpath(workdir),
      realpath(tasksDirectory),
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
    if (!existing) {
      return path;
    }
    const canonicalPath = await realpath(path);
    if (!isInside(root, canonicalPath)) {
      throw new Error(`Task file escapes the store: ${taskId}`);
    }
    return canonicalPath;
  }

  private async loadUnlocked(taskId: string): Promise<Task> {
    return parseTask(
      await readFile(await this.taskPath(taskId, true), 'utf8'),
      taskId,
    );
  }

  private async listUnlocked(): Promise<Task[]> {
    const root = await this.root();
    const ids: string[] = [];
    for await (const filename of glob('task_*.json', { cwd: root })) {
      const id = filename.replace(/\.json$/u, '');
      if (taskIdPattern.test(id)) {
        ids.push(id);
      }
    }
    ids.sort();
    return Promise.all(ids.map((id) => this.loadUnlocked(id)));
  }

  private async taskMapUnlocked(): Promise<Map<string, Task>> {
    const tasks = await this.listUnlocked();
    return new Map(tasks.map((task) => [task.id, task]));
  }

  private async saveUnlocked(task: Task): Promise<void> {
    const path = await this.taskPath(task.id, true);
    const temporary = resolve(
      await this.root(),
      `.${task.id}.${randomBytes(8).toString('hex')}.tmp`,
    );
    try {
      await writeFile(temporary, this.serialize(task), {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporary, path);
    } finally {
      await removeFileIfExists(temporary);
    }
  }

  private serialize(task: Task): string {
    return `${JSON.stringify(task, null, 2)}\n`;
  }
}

const taskStore = new TaskStore();

interface MailEnvelope {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

type MailEvent =
  | {
      type:
        'message' | 'plan_request' | 'error' | 'result' | 'idle_notification';
    }
  | { type: 'shutdown_request'; requestId: string }
  | { type: 'shutdown_response'; requestId: string; approve: true }
  | { type: 'plan_approval_request'; requestId: string }
  | { type: 'plan_approval_response'; requestId: string; approve: boolean };

type MailMessage = MailEnvelope & MailEvent;

function parseMailMessage(value: unknown): MailMessage {
  if (!isRecord(value)) {
    throw new Error('Invalid mailbox message');
  }
  const { from, to, content, type, timestamp } = value;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof content !== 'string' ||
    typeof type !== 'string' ||
    typeof timestamp !== 'number'
  ) {
    throw new Error('Invalid mailbox message');
  }
  const envelope = { from, to, content, timestamp };
  switch (type) {
    case 'message':
    case 'plan_request':
    case 'error':
    case 'result':
    case 'idle_notification':
      return { ...envelope, type };
    case 'shutdown_request':
    case 'plan_approval_request':
      if (typeof value.requestId === 'string') {
        return { ...envelope, type, requestId: value.requestId };
      }
      break;
    case 'shutdown_response':
      if (typeof value.requestId === 'string' && value.approve === true) {
        return { ...envelope, type, requestId: value.requestId, approve: true };
      }
      break;
    case 'plan_approval_response':
      if (
        typeof value.requestId === 'string' &&
        typeof value.approve === 'boolean'
      ) {
        return {
          ...envelope,
          type,
          requestId: value.requestId,
          approve: value.approve,
        };
      }
      break;
  }
  throw new Error(`Invalid mailbox message type: ${type}`);
}

class MessageBus {
  private readonly serial = new SerialQueue();

  send(
    from: string,
    to: string,
    content: string,
    event: MailEvent = { type: 'message' },
  ): Promise<void> {
    return this.serial.run(async () => {
      const path = await this.mailboxPath(to, false);
      await appendFile(
        path,
        `${JSON.stringify({ from, to, content, timestamp: Date.now(), ...event })}\n`,
        'utf8',
      );
      console.log(
        `  [bus] ${from} -> ${to}: (${event.type}) ${content.slice(0, 50)}`,
      );
    });
  }

  read(agent: string): Promise<MailMessage[]> {
    return this.serial.run(async () => {
      let path: string;
      try {
        path = await this.mailboxPath(agent, true);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return [];
        }
        throw error;
      }
      const messages = (await readFile(path, 'utf8'))
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => parseMailMessage(JSON.parse(line)));
      await unlink(path);
      return messages;
    });
  }

  private async root(): Promise<string> {
    await mkdir(mailboxesDirectory, { recursive: true });
    const [workspaceRoot, root] = await Promise.all([
      realpath(workdir),
      realpath(mailboxesDirectory),
    ]);
    if (!isInside(workspaceRoot, root)) {
      throw new Error('Mailbox directory escapes the workspace');
    }
    return root;
  }

  private async mailboxPath(agent: string, existing: boolean): Promise<string> {
    if (!agentNamePattern.test(agent)) {
      throw new Error(`Invalid mailbox recipient: ${agent}`);
    }
    const root = await this.root();
    const path = resolve(root, `${agent}.jsonl`);
    if (!existing) {
      try {
        const canonicalPath = await realpath(path);
        if (!isInside(root, canonicalPath)) {
          throw new Error(`Mailbox file escapes the store: ${agent}`);
        }
        return canonicalPath;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return path;
        }
        throw error;
      }
    }
    const canonicalPath = await realpath(path);
    if (!isInside(root, canonicalPath)) {
      throw new Error(`Mailbox file escapes the store: ${agent}`);
    }
    return canonicalPath;
  }
}

const bus = new MessageBus();

// -- Team Runtime --

type TeammateStatus = 'working' | 'waiting_approval' | 'idle' | 'stopping';
type PlanGate =
  'not_required' | 'required' | 'pending' | 'approved' | 'rejected';

interface ShutdownProtocol {
  id: string;
  type: 'shutdown';
  sender: 'lead';
  target: string;
  status: 'pending' | 'approved';
}

interface PlanApprovalProtocol {
  id: string;
  type: 'plan_approval';
  sender: string;
  target: 'lead';
  status: 'pending' | 'approved' | 'rejected';
  workVersion: number;
  taskId: string | null;
}

type ProtocolState = ShutdownProtocol | PlanApprovalProtocol;

interface TeammateMember {
  runtime: TeammateRuntime;
  status: TeammateStatus;
  planGate: PlanGate;
  workVersion: number;
  currentPlanRequest: string | null;
}

class TeamRuntime {
  private readonly members = new Map<string, TeammateMember>();
  private readonly requests = new Map<string, ProtocolState>();
  private closed = false;

  async spawn(
    name: string,
    role: string,
    prompt: string,
    taskId?: string,
    requirePlan = false,
  ): Promise<string> {
    if (
      !agentNamePattern.test(name) ||
      ['lead', 'agent'].includes(name.toLowerCase())
    ) {
      return `Invalid teammate name: '${name}'`;
    }
    if (
      [...this.members.keys()].some(
        (existing) => existing.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return `Teammate '${name}' already exists`;
    }

    let initialPrompt = prompt;
    if (taskId !== undefined) {
      const claimed = await taskStore.claim(taskId, name);
      if (!claimed.ok) {
        return `Cannot spawn teammate '${name}': ${claimed.message}`;
      }
      try {
        const cwd = await taskStore.workspace(name, true);
        initialPrompt += `\n\n[Assigned task ${claimed.task.id}] ${claimed.task.subject}\n${claimed.task.description}\nWork directory: ${cwd}`;
      } catch (error) {
        await taskStore.releaseAbandoned(name);
        throw error;
      }
    }
    if (requirePlan) {
      initialPrompt +=
        '\n\n[Plan required] Submit a plan and wait for Lead approval before changing files or using bash.';
    }

    const runtime = new TeammateRuntime(name, role, initialPrompt);
    this.members.set(name, {
      runtime,
      status: 'working',
      planGate: requirePlan ? 'required' : 'not_required',
      workVersion: 0,
      currentPlanRequest: null,
    });
    void runtime.run();
    const assignment =
      taskId === undefined ? ' without an initial Task' : ` for ${taskId}`;
    return `Teammate '${name}' spawned as ${role}${assignment}. End this turn; the runtime will deliver its events.`;
  }

  list(): string {
    if (this.members.size === 0) {
      return 'No active teammates.';
    }
    return [...this.members.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, member]) => `${name}: ${member.status}`)
      .join('\n');
  }

  async sendFromLead(to: string, content: string): Promise<string> {
    if (!this.members.has(to)) {
      return `Teammate '${to}' is not active`;
    }
    await bus.send('lead', to, content);
    return `Sent to ${to}`;
  }

  async sendFrom(from: string, to: string, content: string): Promise<string> {
    if (to !== 'lead' && !this.members.has(to)) {
      return `Agent '${to}' is not active`;
    }
    await bus.send(from, to, content);
    return `Sent to ${to}`;
  }

  async requestShutdown(name: string): Promise<string> {
    if (!this.members.has(name)) {
      return `Teammate '${name}' is not active`;
    }
    const id = this.newRequestId();
    this.requests.set(id, {
      id,
      type: 'shutdown',
      sender: 'lead',
      target: name,
      status: 'pending',
    });
    await bus.send('lead', name, 'Finish the current step and shut down.', {
      type: 'shutdown_request',
      requestId: id,
    });
    return `Shutdown requested from ${name} (${id})`;
  }

  async requestPlan(name: string, task: string): Promise<string> {
    const member = this.members.get(name);
    if (member === undefined) {
      return `Teammate '${name}' is not active`;
    }
    member.planGate = 'required';
    member.currentPlanRequest = null;
    await bus.send('lead', name, task, { type: 'plan_request' });
    return `Plan requested from ${name}`;
  }

  async submitPlan(name: string, plan: string): Promise<string> {
    const member = this.members.get(name);
    if (member === undefined) {
      return `Teammate '${name}' is not active`;
    }
    if (member.planGate === 'pending') {
      return 'A plan is already waiting for review.';
    }
    const id = this.newRequestId();
    const taskId = await taskStore.assignmentTaskId(name);
    this.requests.set(id, {
      id,
      type: 'plan_approval',
      sender: name,
      target: 'lead',
      status: 'pending',
      workVersion: member.workVersion,
      taskId,
    });
    member.planGate = 'pending';
    member.currentPlanRequest = id;
    member.status = 'waiting_approval';
    await bus.send(name, 'lead', plan, {
      type: 'plan_approval_request',
      requestId: id,
    });
    return `Plan submitted (${id}). Wait for Lead's decision.`;
  }

  async reviewPlan(
    requestId: string,
    approve: boolean,
    feedback = '',
  ): Promise<string> {
    const request = this.requests.get(requestId);
    if (request === undefined) {
      return `Request ${requestId} not found`;
    }
    if (request.type !== 'plan_approval') {
      return `Request ${requestId} is not a plan`;
    }
    if (request.status !== 'pending') {
      return `Request ${requestId} already ${request.status}`;
    }
    const member = this.members.get(request.sender);
    const taskId = await taskStore.assignmentTaskId(request.sender);
    if (
      member?.currentPlanRequest !== requestId ||
      member.workVersion !== request.workVersion ||
      taskId !== request.taskId
    ) {
      return `Request ${requestId} belongs to an earlier assignment`;
    }
    request.status = approve ? 'approved' : 'rejected';
    const content =
      feedback ||
      (approve ? 'Plan approved.' : 'Revise the plan and submit it again.');
    await bus.send('lead', request.sender, content, {
      type: 'plan_approval_response',
      requestId,
      approve,
    });
    return `Plan ${request.status} (${requestId})`;
  }

  async consumeLeadInbox(): Promise<MailMessage[]> {
    const messages = await bus.read('lead');
    for (const message of messages) {
      if (message.type !== 'shutdown_response') {
        continue;
      }
      const request = this.requests.get(message.requestId);
      if (
        request?.type === 'shutdown' &&
        request.status === 'pending' &&
        request.target === message.from &&
        message.to === request.sender
      ) {
        request.status = 'approved';
      }
    }
    return messages;
  }

  async applyInbox(name: string, message: MailMessage): Promise<string> {
    if (message.type === 'plan_approval_response') {
      const request = this.requests.get(message.requestId);
      const member = this.members.get(name);
      const taskId = await taskStore.assignmentTaskId(name);
      if (member === undefined) {
        return '[Ignored plan response: request mismatch]';
      }
      const valid =
        message.from === 'lead' &&
        message.to === name &&
        request?.type === 'plan_approval' &&
        request.sender === name &&
        request.status !== 'pending' &&
        request.workVersion === member.workVersion &&
        request.taskId === taskId &&
        member.currentPlanRequest === message.requestId &&
        message.approve === (request.status === 'approved');
      if (!valid) {
        return '[Ignored plan response: request mismatch]';
      }
      member.planGate = request.status;
      member.status = 'working';
      member.currentPlanRequest = null;
      return `[Plan ${request.status}] ${message.content}`;
    }
    if (message.type === 'plan_request') {
      return `[Plan required] ${message.content}`;
    }
    return `[Message from ${message.from}] ${message.content}`;
  }

  async acceptShutdown(name: string, message: MailMessage): Promise<boolean> {
    if (message.type !== 'shutdown_request') {
      return false;
    }
    const request = this.requests.get(message.requestId);
    const member = this.members.get(name);
    if (
      request?.type !== 'shutdown' ||
      request.status !== 'pending' ||
      request.target !== name ||
      message.from !== 'lead' ||
      message.to !== name ||
      member === undefined
    ) {
      return false;
    }
    member.status = 'stopping';
    await bus.send(name, 'lead', 'Shutdown acknowledged.', {
      type: 'shutdown_response',
      requestId: message.requestId,
      approve: true,
    });
    return true;
  }

  planGate(name: string): PlanGate {
    return this.members.get(name)?.planGate ?? 'not_required';
  }

  setStatus(name: string, status: TeammateStatus): void {
    const member = this.members.get(name);
    if (member !== undefined) {
      member.status = status;
    }
  }

  assignmentChanged(name: string): void {
    const member = this.members.get(name);
    if (member === undefined) {
      return;
    }
    member.workVersion += 1;
    member.currentPlanRequest = null;
    if (member.planGate !== 'not_required') {
      member.planGate = 'required';
    }
  }

  async finishTurn(name: string): Promise<void> {
    if (await taskStore.releaseCompleted(name)) {
      this.assignmentChanged(name);
      const member = this.members.get(name);
      if (member !== undefined) {
        member.planGate = 'not_required';
      }
    }
  }

  async teammateFinished(name: string): Promise<void> {
    await taskStore.releaseAbandoned(name);
    this.members.delete(name);
  }

  isClosed(): boolean {
    return this.closed;
  }

  stop(): void {
    this.closed = true;
  }

  private newRequestId(): string {
    while (true) {
      const id = `req_${randomBytes(3).toString('hex')}`;
      if (!this.requests.has(id)) {
        return id;
      }
    }
  }
}

const team = new TeamRuntime();

function lastAssistantText(content: Anthropic.ContentBlock[]): string {
  return content.find((block) => block.type === 'text')?.text.trim() ?? '';
}

type WorkState = 'continue' | 'idle' | 'stop';

class TeammateRuntime {
  private readonly system: string;
  private readonly messages: Anthropic.MessageParam[];
  private readonly registeredTools: RegisteredTool[];

  constructor(
    readonly name: string,
    role: string,
    initialPrompt: string,
  ) {
    this.system = `You are '${name}', a ${role}. Use tools to complete the assigned Task, then call complete_task and report a concise result. If the first user message contains [Assigned task], that Task is already claimed. When asked for a plan, call submit_plan and wait for approval before bash or file changes. File and shell tools use the Task working directory. Use send_message only for intermediate coordination and address the coordinator as 'lead'.`;
    this.messages = [{ role: 'user', content: initialPrompt }];
    this.registeredTools = createTeammateTools(this);
  }

  async run(): Promise<void> {
    try {
      let state: WorkState = 'continue';
      while (state !== 'stop' && !team.isClosed()) {
        if (state === 'idle' && !(await this.waitForWork())) {
          break;
        }
        state = await this.work();
      }
    } catch (error) {
      await bus.send(this.name, 'lead', String(error), { type: 'error' });
    } finally {
      await team.teammateFinished(this.name);
      console.log(`  [teammate] ${this.name} finished`);
    }
  }

  private async work(): Promise<WorkState> {
    const inboxState = await this.handleInbox(await bus.read(this.name));
    if (inboxState.stop) {
      return 'stop';
    }
    team.setStatus(this.name, 'working');

    const response = await client.messages.create({
      model,
      system: this.system,
      messages: this.messages,
      tools: this.registeredTools.map(({ definition }) => definition),
      max_tokens: 8_000,
    });
    this.messages.push({ role: 'assistant', content: response.content });

    const toolCalls = response.content.filter(
      (block) => block.type === 'tool_use',
    );
    if (toolCalls.length > 0) {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const toolCall of toolCalls) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: await executeTeammateTool(
            this.name,
            toolCall,
            this.registeredTools,
          ),
        });
      }
      this.messages.push({ role: 'user', content: results });
      return 'continue';
    }

    const summary = lastAssistantText(response.content);
    if (team.planGate(this.name) === 'pending') {
      team.setStatus(this.name, 'waiting_approval');
      return 'idle';
    }
    if (summary.length > 0) {
      await bus.send(this.name, 'lead', summary, { type: 'result' });
    }
    await team.finishTurn(this.name);
    team.setStatus(this.name, 'idle');
    await bus.send(this.name, 'lead', 'Waiting for more work.', {
      type: 'idle_notification',
    });
    return 'idle';
  }

  private async waitForWork(): Promise<boolean> {
    while (!team.isClosed()) {
      const inbox = await bus.read(this.name);
      if (inbox.length > 0) {
        const before = this.messages.length;
        const state = await this.handleInbox(inbox);
        if (state.stop) {
          return false;
        }
        if (this.messages.length > before) {
          return true;
        }
      } else {
        const task = await taskStore.claimNext(this.name);
        if (task !== undefined) {
          team.assignmentChanged(this.name);
          const cwd = await taskStore.workspace(this.name, true);
          this.messages.push({
            role: 'user',
            content: `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`,
          });
          return true;
        }
      }
      await delay(500, undefined, { ref: false });
    }
    return false;
  }

  private async handleInbox(inbox: MailMessage[]): Promise<{ stop: boolean }> {
    const workMessages: string[] = [];
    for (const message of inbox) {
      if (await team.acceptShutdown(this.name, message)) {
        return { stop: true };
      }
      workMessages.push(await team.applyInbox(this.name, message));
    }
    if (workMessages.length > 0) {
      this.messages.push({ role: 'user', content: workMessages.join('\n') });
    }
    return { stop: false };
  }
}

// -- Tools and Hooks --

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

function baseTools(
  owner: string,
  requireAssignment: boolean,
): RegisteredTool[] {
  return [
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
      async ({ command }) =>
        runBash(command, await taskStore.workspace(owner, requireAssignment)),
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
      async ({ path, limit }) =>
        runRead(
          path,
          await taskStore.workspace(owner, requireAssignment),
          limit,
        ),
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
      async ({ path, content }) =>
        runWrite(
          path,
          content,
          await taskStore.workspace(owner, requireAssignment),
        ),
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
      async ({ path, old_text: oldText, new_text: newText }) =>
        runEdit(
          path,
          oldText,
          newText,
          await taskStore.workspace(owner, requireAssignment),
        ),
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
      async ({ pattern }) =>
        runGlob(pattern, await taskStore.workspace(owner, requireAssignment)),
    ),
  ];
}

function renderTasks(tasks: Task[]): string {
  if (tasks.length === 0) {
    return 'No tasks. Use create_task to add some.';
  }
  return tasks
    .map((task) => {
      const marker = {
        pending: '[ ]',
        in_progress: '[~]',
        completed: '[x]',
      }[task.status];
      const owner = task.owner === null ? '' : ` [${task.owner}]`;
      const dependencies =
        task.blockedBy.length === 0
          ? ''
          : ` (blockedBy: ${task.blockedBy.join(', ')})`;
      const worktree =
        task.worktree === null ? '' : ` (worktree: ${task.worktree})`;
      return `${marker} ${task.id}: ${task.subject} [${task.status}]${owner}${dependencies}${worktree}`;
    })
    .join('\n');
}

function sharedTaskTools(owner: string): RegisteredTool[] {
  return [
    defineTool<Record<string, never>>(
      {
        name: 'list_tasks',
        description: 'List shared tasks.',
        input_schema: { type: 'object', properties: {} },
      },
      async () => renderTasks(await taskStore.list()),
    ),
    defineTool<{ task_id: string }>(
      {
        name: 'claim_task',
        description: 'Claim a ready task.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', pattern: taskIdPatternSource },
          },
          required: ['task_id'],
        },
      },
      async ({ task_id: taskId }) => {
        const result = await taskStore.claim(taskId, owner);
        if (result.ok) {
          team.assignmentChanged(owner);
          return `Claimed ${result.task.id} (${result.task.subject})`;
        }
        return result.message;
      },
    ),
    defineTool<{ task_id: string }>(
      {
        name: 'complete_task',
        description: 'Complete an owned task.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', pattern: taskIdPatternSource },
          },
          required: ['task_id'],
        },
      },
      async ({ task_id: taskId }) => {
        const gate = team.planGate(owner);
        if (['required', 'pending', 'rejected'].includes(gate)) {
          return `Task ${taskId} cannot complete while plan status is ${gate}`;
        }
        return taskStore.complete(taskId, owner);
      },
    ),
  ];
}

function createLeadTools(): RegisteredTool[] {
  return [
    ...baseTools('agent', false),
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
    ...sharedTaskTools('agent'),
    defineTool<{ task_id: string }>(
      {
        name: 'get_task',
        description: 'Get one task by ID.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', pattern: taskIdPatternSource },
          },
          required: ['task_id'],
        },
      },
      async ({ task_id: taskId }) =>
        JSON.stringify(await taskStore.load(taskId), null, 2),
    ),
    defineTool<{
      name: string;
      role: string;
      prompt: string;
      task_id?: string;
      require_plan?: boolean;
    }>(
      {
        name: 'spawn_teammate',
        description: 'Spawn a persistent teammate.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: agentNamePatternSource },
            role: { type: 'string' },
            prompt: { type: 'string' },
            task_id: { type: 'string', pattern: taskIdPatternSource },
            require_plan: { type: 'boolean' },
          },
          required: ['name', 'role', 'prompt'],
        },
      },
      ({ name, role, prompt, task_id: taskId, require_plan: requirePlan }) =>
        team.spawn(name, role, prompt, taskId, requirePlan),
    ),
    defineTool<Record<string, never>>(
      {
        name: 'list_teammates',
        description: 'List active teammates.',
        input_schema: { type: 'object', properties: {} },
      },
      () => team.list(),
    ),
    defineTool<{ to: string; content: string }>(
      {
        name: 'send_message',
        description: 'Message a teammate.',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['to', 'content'],
        },
      },
      ({ to, content }) => team.sendFromLead(to, content),
    ),
    defineTool<{ teammate: string }>(
      {
        name: 'request_shutdown',
        description: 'Ask a teammate to shut down.',
        input_schema: {
          type: 'object',
          properties: { teammate: { type: 'string' } },
          required: ['teammate'],
        },
      },
      ({ teammate }) => team.requestShutdown(teammate),
    ),
    defineTool<{ teammate: string; task: string }>(
      {
        name: 'request_plan',
        description: 'Require a teammate plan before workspace changes.',
        input_schema: {
          type: 'object',
          properties: {
            teammate: { type: 'string' },
            task: { type: 'string' },
          },
          required: ['teammate', 'task'],
        },
      },
      ({ teammate, task }) => team.requestPlan(teammate, task),
    ),
    defineTool<{
      request_id: string;
      approve: boolean;
      feedback?: string;
    }>(
      {
        name: 'review_plan',
        description: 'Approve or reject a plan.',
        input_schema: {
          type: 'object',
          properties: {
            request_id: { type: 'string' },
            approve: { type: 'boolean' },
            feedback: { type: 'string' },
          },
          required: ['request_id', 'approve'],
        },
      },
      ({ request_id: requestId, approve, feedback }) =>
        team.reviewPlan(requestId, approve, feedback),
    ),
    defineTool<{ name: string; task_id: string }>(
      {
        name: 'create_worktree',
        description: 'Create and bind a task worktree.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              pattern: worktreeNamePatternSource,
            },
            task_id: { type: 'string', pattern: taskIdPatternSource },
          },
          required: ['name', 'task_id'],
          additionalProperties: false,
        },
      },
      ({ name, task_id: taskId }) => taskStore.createWorktree(name, taskId),
    ),
  ];
}

function createTeammateTools(runtime: TeammateRuntime): RegisteredTool[] {
  return [
    ...baseTools(runtime.name, true),
    defineTool<{ to: string; content: string }>(
      {
        name: 'send_message',
        description:
          "Send an intermediate message to 'lead' or an active teammate.",
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['to', 'content'],
        },
      },
      ({ to, content }) => team.sendFrom(runtime.name, to, content),
    ),
    defineTool<{ plan: string }>(
      {
        name: 'submit_plan',
        description: 'Submit a work plan for Lead approval.',
        input_schema: {
          type: 'object',
          properties: { plan: { type: 'string' } },
          required: ['plan'],
        },
      },
      ({ plan }) => team.submitPlan(runtime.name, plan),
    ),
    ...sharedTaskTools(runtime.name),
  ];
}

interface ToolContext {
  readline?: ReadlineInterface;
  interactiveApproval: boolean;
  cwd: string;
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

async function permissionHook(
  toolCall: Anthropic.ToolUseBlock,
  context: ToolContext,
): Promise<string | undefined> {
  const input: Record<string, unknown> = isRecord(toolCall.input)
    ? toolCall.input
    : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const path = typeof input.path === 'string' ? input.path : '';

  let reason: string | undefined;
  if (toolCall.name === 'bash') {
    const denied = denyList.find((pattern) => command.includes(pattern));
    if (denied !== undefined) {
      return `Permission denied by deny list: ${denied}`;
    }
    if (
      destructiveCommand.test(command) ||
      ['rm ', '> /etc/', 'chmod 777'].some((text) => command.includes(text))
    ) {
      reason = 'Potentially destructive command';
    }
  }
  if (
    ['read_file', 'write_file', 'edit_file'].includes(toolCall.name) &&
    !isInside(context.cwd, resolve(context.cwd, path))
  ) {
    reason = 'Access outside task workspace';
  }
  if (reason === undefined) {
    return undefined;
  }
  if (!context.interactiveApproval || context.readline === undefined) {
    return `Permission required: ask Lead. ${reason}`;
  }
  console.log(`\n\u001B[33m[permission] ${reason}\u001B[0m`);
  const answer = await context.readline.question('   Allow? [y/N] ');
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
    ? undefined
    : 'Permission denied by user';
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

function handlerFor(
  registeredTools: RegisteredTool[],
  name: string,
): RegisteredTool['run'] | undefined {
  return registeredTools.find((tool) => tool.definition.name === name)?.run;
}

async function executeTool(
  toolCall: Anthropic.ToolUseBlock,
  registeredTools: RegisteredTool[],
  context: ToolContext,
): Promise<string> {
  const blocked = await triggerHooks('PreToolUse', toolCall, context);
  if (blocked !== undefined) {
    return blocked;
  }
  const handler = handlerFor(registeredTools, toolCall.name);
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

async function executeLeadTool(
  toolCall: Anthropic.ToolUseBlock,
  registeredTools: RegisteredTool[],
  readline: ReadlineInterface,
): Promise<string> {
  return executeTool(toolCall, registeredTools, {
    readline,
    interactiveApproval: true,
    cwd: await taskStore.workspace('agent', false),
  });
}

async function executeTeammateTool(
  name: string,
  toolCall: Anthropic.ToolUseBlock,
  registeredTools: RegisteredTool[],
): Promise<string> {
  const gate = team.planGate(name);
  if (
    ['bash', 'write_file', 'edit_file'].includes(toolCall.name) &&
    !['not_required', 'approved'].includes(gate)
  ) {
    return `Blocked: plan status is ${gate}. Submit or revise the plan and wait for approval.`;
  }
  const assignment = await taskStore.assignmentTaskId(name);
  const cwd =
    assignment === null ? workdir : await taskStore.workspace(name, true);
  return executeTool(toolCall, registeredTools, {
    interactiveApproval: false,
    cwd,
  });
}

// -- Lead Loop and CLI --

const leadSystem = [
  "You are the Lead coding agent. Act, don't explain.",
  'Create all task nodes first, then add dependencies using the returned IDs.',
  'Only the Lead changes task dependencies.',
  'When parallel work would help, first propose a small team with clear responsibilities and wait for user confirmation. Do not call spawn_teammate before confirmation.',
  'After spawning, end the turn instead of polling; the runtime will deliver team events and wake you.',
  'Use a task-bound worktree only when separate directories prevent conflicting edits. Shut teammates down when coordination is complete.',
  `Working directory: ${workdir}`,
].join('\n\n');

const leadTools = createLeadTools();

async function leadAgentLoop(
  messages: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<Anthropic.ContentBlock[]> {
  while (true) {
    const response = await client.messages.create({
      model,
      system: leadSystem,
      messages,
      tools: leadTools.map(({ definition }) => definition),
      max_tokens: 8_000,
    });

    messages.push({ role: 'assistant', content: response.content });
    const toolCalls = response.content.filter(
      (block) => block.type === 'tool_use',
    );
    if (toolCalls.length === 0) {
      await taskStore.releaseCompleted('agent');
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
        content: await executeLeadTool(toolCall, leadTools, readline),
      });
    }
    messages.push({ role: 'user', content: results });
  }
}

function formatTeamEvents(messages: MailMessage[]): string {
  const lines = messages.map((message) => {
    const requestId =
      'requestId' in message ? ` request_id=${message.requestId}` : '';
    return `[${message.type}${requestId}] ${message.from}: ${message.content}`;
  });
  return `[Team events]\n${lines.join('\n')}`;
}

const leadTurns = new SerialQueue();
let leadEventProcessorBusy = false;

function runLeadTurn(
  history: Anthropic.MessageParam[],
  readline: ReadlineInterface,
  content: string,
  userSubmitted: boolean,
): Promise<void> {
  return leadTurns.run(async () => {
    if (userSubmitted) {
      await triggerHooks('UserPromptSubmit', content);
    }
    history.push({ role: 'user', content });
    const finalContent = await leadAgentLoop(history, readline);
    for (const block of finalContent) {
      if (block.type === 'text') {
        console.log(block.text);
      }
    }
    console.log();
  });
}

async function processLeadEvents(
  history: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<void> {
  if (leadEventProcessorBusy) {
    return;
  }
  leadEventProcessorBusy = true;
  try {
    const messages = await team.consumeLeadInbox();
    if (messages.length > 0) {
      console.log(`[wake: ${String(messages.length)} team event(s)]`);
      await runLeadTurn(history, readline, formatTeamEvents(messages), false);
    }
  } finally {
    leadEventProcessorBusy = false;
  }
}

async function main(): Promise<void> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const history: Anthropic.MessageParam[] = [];

  console.log('s13: Agent Teams');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  const eventTimer = setInterval(() => {
    void processLeadEvents(history, readline).catch((error: unknown) => {
      console.log(`  [team error] ${String(error)}`);
    });
  }, 250);

  readline.setPrompt('\u001B[36ms13 >> \u001B[0m');
  readline.prompt();
  try {
    for await (const query of readline) {
      await runLeadTurn(history, readline, query, true);
      readline.prompt();
    }
  } finally {
    clearInterval(eventTimer);
    team.stop();
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main();
}
