/**
 * s02 — Tool Use
 *
 * 关键理念：agent loop 不需要知道每个工具的细节；新增能力只需注册
 * 工具描述和对应 handler，再由统一的 dispatch map 分发。
 */

import { exec } from 'node:child_process';
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const workdir = process.cwd();
const client = new Anthropic();
const { MODEL_ID: model } = process.env as { MODEL_ID: string };
const systemPrompt = `You are a coding agent at ${workdir}. Use tools to solve tasks. Act, don't explain.`;

function runBash(command: string): Promise<string> {
  return new Promise((resolveOutput) => {
    exec(command, { cwd: workdir }, (_error, stdout, stderr) => {
      resolveOutput(`${stdout}${stderr}`.trim() || '(no output)');
    });
  });
}

function isInsideWorkspace(path: string): boolean {
  const relativePath = relative(workdir, path);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function safePath(path: string): string {
  const absolutePath = resolve(workdir, path);
  if (!isInsideWorkspace(absolutePath)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return absolutePath;
}

async function runRead(path: string, limit?: number): Promise<string> {
  const lines = (await readFile(safePath(path), 'utf8')).split(/\r?\n/u);

  if (limit !== undefined && lines.length > limit) {
    return [
      ...lines.slice(0, limit),
      `... (${String(lines.length - limit)} more lines)`,
    ].join('\n');
  }
  return lines.join('\n');
}

async function runWrite(path: string, content: string): Promise<string> {
  const filePath = safePath(path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${path}`;
}

async function runEdit(
  path: string,
  oldText: string,
  newText: string,
): Promise<string> {
  const filePath = safePath(path);
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

// Input 为相邻 handler 提供上下文类型；运行时仍只保留统一的 unknown 接口。
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function defineTool<Input>(
  definition: Anthropic.Tool,
  handler: (input: Input) => Promise<string>,
): RegisteredTool {
  return {
    definition,
    // Anthropic 将 tool input 暴露为 unknown；注册处是类型与 schema 的唯一接缝。
    run: (input) => handler(input as Input),
  };
}

// 每项把模型看到的 schema 与 harness 执行的 handler 放在一起。
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

async function agentLoop(
  messages: Anthropic.MessageParam[],
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
      console.log(`\u001B[33m> ${toolCall.name}\u001B[0m`);

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

  console.log('s02: Tool Use');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms02 >> \u001B[0m');
  readline.prompt();

  for await (const query of readline) {
    history.push({ role: 'user', content: query });
    const finalContent = await agentLoop(history);

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
