/**
 * s01 — Agent Loop
 *
 * 关键理念：模型调用工具就执行并回填结果；模型不再调用工具就停止。
 * 后续章节会扩展 harness，但不会改变这个循环。
 */

import { exec } from 'node:child_process';
import { createInterface } from 'node:readline';

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true, quiet: true });

const client = new Anthropic();
const { MODEL_ID: model } = process.env as { MODEL_ID: string };
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

function runBash(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd: process.cwd() }, (_error, stdout, stderr) => {
      resolve(`${stdout}${stderr}`.trim() || '(no output)');
    });
  });
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
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const history: Anthropic.MessageParam[] = [];

  console.log('s01: Agent Loop');
  console.log('Enter a question, press Enter to send. Press Ctrl+C to quit.\n');

  readline.setPrompt('\u001B[36ms01 >> \u001B[0m');
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
