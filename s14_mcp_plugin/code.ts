/**
 * s14 — MCP Tools
 *
 * 关键理念：Harness 连接外部 server、发现工具，并在每个 agent cycle 动态
 * 组装工具池；server 的注解只描述工具，真正的授权始终由宿主决定。
 */

import { exec } from 'node:child_process';
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const baseSystem = `You are a coding agent at ${workdir}. Use built-in and connected MCP tools to solve tasks. Call connect_mcp before using a server.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
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
  const target = resolve(workdir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${path}`;
}

async function runEdit(
  path: string,
  oldText: string,
  newText: string,
): Promise<string> {
  const target = resolve(workdir, path);
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
  handler: (input: Input) => string | Promise<string>,
): RegisteredTool {
  return {
    definition,
    run: (input) => Promise.resolve(handler(input as Input)),
  };
}

function createBaseTools(): RegisteredTool[] {
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
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

interface RegisteredMcpTool {
  definition: McpToolDefinition;
  run: (input: unknown) => Promise<string>;
}

function defineMcpTool(
  definition: McpToolDefinition,
  handler: (input: Record<string, unknown>) => string | Promise<string>,
): RegisteredMcpTool {
  return {
    definition,
    run: async (input) => {
      if (!isRecord(input)) {
        throw new TypeError('MCP tool input must be an object');
      }
      return handler(input);
    },
  };
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new TypeError(`Expected string input '${key}'`);
  }
  return value;
}

class MCPClient {
  private readonly tools = new Map<string, RegisteredMcpTool>();

  constructor(readonly name: string) {}

  register(tools: RegisteredMcpTool[]): void {
    for (const tool of tools) {
      if (this.tools.has(tool.definition.name)) {
        throw new Error(
          `Duplicate MCP tool '${tool.definition.name}' on server '${this.name}'`,
        );
      }
      this.tools.set(tool.definition.name, tool);
    }
  }

  listTools(): McpToolDefinition[] {
    return [...this.tools.values()].map(({ definition }) => definition);
  }

  async callTool(name: string, input: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return `MCP error: unknown tool '${name}'`;
    }
    try {
      return await tool.run(input);
    } catch (error) {
      return `MCP error: ${errorText(error)}`;
    }
  }
}

function createDocsServer(): MCPClient {
  const server = new MCPClient('docs');
  server.register([
    defineMcpTool(
      {
        name: 'search',
        description: 'Search the documentation.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        annotations: { readOnlyHint: true },
      },
      (input) => `[docs] Found 3 results for '${stringInput(input, 'query')}'`,
    ),
    defineMcpTool(
      {
        name: 'get_version',
        description: 'Get the documentation API version.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      () => '[docs] API v2.1.0',
    ),
  ]);
  return server;
}

function createDeployServer(): MCPClient {
  const server = new MCPClient('deploy');
  server.register([
    defineMcpTool(
      {
        name: 'trigger',
        description: 'Trigger a deployment.',
        inputSchema: {
          type: 'object',
          properties: { service: { type: 'string' } },
          required: ['service'],
        },
        annotations: { destructiveHint: true },
      },
      (input) => `[deploy] Triggered: ${stringInput(input, 'service')}`,
    ),
    defineMcpTool(
      {
        name: 'status',
        description: 'Check deployment status.',
        inputSchema: {
          type: 'object',
          properties: { service: { type: 'string' } },
          required: ['service'],
        },
        annotations: { readOnlyHint: true },
      },
      (input) => `[deploy] ${stringInput(input, 'service')}: running (v1.4.2)`,
    ),
  ]);
  return server;
}

const mockServers = new Map<string, () => MCPClient>([
  ['docs', createDocsServer],
  ['deploy', createDeployServer],
]);
const mcpClients = new Map<string, MCPClient>();

function connectMcp(name: string): string {
  if (mcpClients.has(name)) {
    return `MCP server '${name}' already connected`;
  }
  const createServer = mockServers.get(name);
  if (createServer === undefined) {
    return `Unknown server '${name}'. Available: ${[...mockServers.keys()].join(', ')}`;
  }
  const server = createServer();
  mcpClients.set(name, server);
  const names = server.listTools().map((tool) => tool.name);
  console.log(`  [mcp] connected: ${name} -> ${names.join(', ')}`);
  return `Connected to MCP server '${name}'. Discovered ${String(names.length)} tools: ${names.join(', ')}`;
}

const connectTool = defineTool<{ name: string }>(
  {
    name: 'connect_mcp',
    description: 'Connect to an MCP server and discover its tools.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: [...mockServers.keys()] },
      },
      required: ['name'],
    },
  },
  ({ name }) => connectMcp(name),
);

type McpPolicy = 'allow' | 'confirm';

// Annotations are untrusted; only this host-owned table grants permission.
const mcpHostPolicy = new Map<string, McpPolicy>([
  ['docs/search', 'allow'],
  ['docs/get_version', 'allow'],
  ['deploy/status', 'allow'],
  ['deploy/trigger', 'confirm'],
]);

function normalizeMcpName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
  if (normalized.length === 0) {
    throw new Error('MCP names cannot normalize to an empty string');
  }
  return normalized;
}

interface ToolPool {
  definitions: Anthropic.Tool[];
  handlers: ReadonlyMap<string, RegisteredTool['run']>;
  policies: ReadonlyMap<string, McpPolicy>;
}

function assembleToolPool(): ToolPool {
  const registered = [...createBaseTools(), connectTool];
  const origins = new Map(
    registered.map(({ definition }) => [
      definition.name,
      `built-in tool '${definition.name}'`,
    ]),
  );
  const policies = new Map<string, McpPolicy>();

  for (const [serverName, client] of mcpClients) {
    const safeServer = normalizeMcpName(serverName);
    for (const discovered of client.listTools()) {
      const safeTool = normalizeMcpName(discovered.name);
      const name = `mcp__${safeServer}__${safeTool}`;
      if (name.length > 64) {
        throw new Error(`MCP tool name is longer than 64 characters: ${name}`);
      }
      const origin = `MCP tool '${serverName}/${discovered.name}'`;
      const existing = origins.get(name);
      if (existing !== undefined) {
        throw new Error(
          `MCP tool name collision after normalization: '${name}' maps both ${existing} and ${origin}`,
        );
      }
      origins.set(name, origin);
      registered.push({
        definition: {
          name,
          description: discovered.description,
          input_schema: discovered.inputSchema,
        },
        run: (input) => client.callTool(discovered.name, input),
      });
      policies.set(
        name,
        mcpHostPolicy.get(`${serverName}/${discovered.name}`) ?? 'confirm',
      );
    }
  }

  return {
    definitions: registered.map(({ definition }) => definition),
    handlers: new Map(
      registered.map(({ definition, run }) => [definition.name, run]),
    ),
    policies,
  };
}

function assembleSystemPrompt(): string {
  return mcpClients.size === 0
    ? baseSystem
    : `${baseSystem}\n\nConnected MCP servers: ${[...mcpClients.keys()].join(', ')}`;
}

interface ToolContext {
  readline: ReadlineInterface;
  mcpPolicies: ReadonlyMap<string, McpPolicy>;
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
  // TypeScript 无法保留索引访问中 event 与 callback 的关联，接缝集中在这里。
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
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const command = typeof input.command === 'string' ? input.command : '';

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
      const answer = await context.readline.question('   Allow? [y/N] ');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        return 'Permission denied by user';
      }
    }
  }

  const path = typeof input.path === 'string' ? input.path : '';
  if (
    ['read_file', 'write_file', 'edit_file'].includes(toolCall.name) &&
    !isInsideWorkspace(resolve(workdir, path))
  ) {
    console.log('\n\u001B[33m[permission] Access outside workspace\u001B[0m');
    const answer = await context.readline.question('   Allow? [y/N] ');
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      return 'Permission denied by user';
    }
  }

  if (
    toolCall.name.startsWith('mcp__') &&
    context.mcpPolicies.get(toolCall.name) !== 'allow'
  ) {
    console.log(
      `\n\u001B[33m[permission] External tool ${toolCall.name}\u001B[0m`,
    );
    const answer = await context.readline.question('   Allow? [y/N] ');
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
  pool: ToolPool,
  readline: ReadlineInterface,
): Promise<string> {
  const blocked = await triggerHooks('PreToolUse', toolCall, {
    readline,
    mcpPolicies: pool.policies,
  });
  if (blocked !== undefined) {
    return blocked;
  }
  const handler = pool.handlers.get(toolCall.name);
  let output: string;
  try {
    output = handler
      ? await handler(toolCall.input)
      : `Unknown tool: ${toolCall.name}`;
  } catch (error) {
    output = `Error: ${errorText(error)}`;
  }
  await triggerHooks('PostToolUse', toolCall, output);
  return output;
}

async function agentLoop(
  messages: Anthropic.MessageParam[],
  readline: ReadlineInterface,
): Promise<Anthropic.ContentBlock[]> {
  while (true) {
    const pool = assembleToolPool();
    const response = await client.messages.create({
      model,
      system: assembleSystemPrompt(),
      messages,
      tools: pool.definitions,
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
        content: await executeTool(toolCall, pool, readline),
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

  console.log('s14: MCP Tools');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');
  readline.setPrompt('\u001B[36ms14 >> \u001B[0m');
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

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main();
}
