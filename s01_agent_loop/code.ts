/**
 * s01 — Agent Loop
 *
 * 关键理念：模型调用工具就执行并回填结果；模型不再调用工具就停止。
 * 后续章节会扩展 harness，但不会改变这个循环。
 */

import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const baseURL = process.env.ANTHROPIC_BASE_URL;
if (baseURL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic(baseURL ? { baseURL } : {});

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Copy .env.example to .env first.`);
  }
  return value;
}

const model = requireEnvironmentVariable('MODEL_ID');
const systemPrompt = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// s01 故意只给模型一个 Bash 工具：一个工具已经足以展示完整 agent loop。
const tools = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
] satisfies Anthropic.Tool[];

const exec = promisify(execCallback);
const dangerousCommands = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];

async function runBash(command: string): Promise<string> {
  if (dangerousCommands.some((dangerous) => command.includes(dangerous))) {
    return 'Error: Dangerous command blocked';
  }

  try {
    const { stdout, stderr } = await exec(command, {
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 1_000_000,
    });
    const output = `${stdout}${stderr}`.trim();
    return output ? output.slice(0, 50_000) : '(no output)';
  } catch (caught: unknown) {
    const error = caught as Error & {
      killed?: boolean;
      stderr?: string;
      stdout?: string;
    };

    if (error.killed) {
      return 'Error: Timeout (120s)';
    }

    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    return output ? output.slice(0, 50_000) : `Error: ${error.message}`;
  }
}

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
      const { command } = toolCall.input as { command: string };
      console.log(`\u001B[33m$ ${command}\u001B[0m`);

      const output = await runBash(command);
      console.log(output.slice(0, 200));
      results.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: output,
      });
    }

    // 工具结果成为新的 user 消息，模型因此能观察环境并决定下一步。
    messages.push({ role: 'user', content: results });
  }
}

async function main(): Promise<void> {
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const history: Anthropic.MessageParam[] = [];

  console.log('s01: Agent Loop');
  console.log('Enter a question, press Enter to send. Type q to quit.\n');

  try {
    while (true) {
      const query = await readline.question('\u001B[36ms01 >> \u001B[0m');
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }

      history.push({ role: 'user', content: query });
      const finalContent = await agentLoop(history);

      for (const block of finalContent) {
        if (block.type === 'text') {
          console.log(block.text);
        }
      }
      console.log();
    }
  } finally {
    readline.close();
  }
}

await main();
