/**
 * CLI entry — wires config → provider → platform → native parser → agent loop.
 *
 *   pnpm rover:app -- --mode cli --task "click the login button"
 *   pnpm rover:app -- --mode cli --platform mock --provider glm --task "log in"
 *   pnpm rover:app -- --mode cli --platform remote --scout-port 9000
 *   pnpm rover:app -- --mode cli --platform desktop --yolo-path weights/icon_detect.onnx
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runAgent, RemotePlatform } from '@vrover/agent';
import type { TaskResult } from '@vrover/agent';
import { loadConfig } from '@vrover/config';
import type { VroverConfig } from '@vrover/config';
import { complete as completeAnthropic } from '@vrover/llm';
import type { CompleteFn } from '@vrover/llm';
import { createParser } from '@vrover/native';
import type { NativeParser } from '@vrover/native';
import type { Platform } from '@vrover/platform';
import { MockPlatform, DesktopPlatform } from '@vrover/platform';
import { createProviderFromEnv } from '@vrover/providers';

// ── types ──────────────────────────────────────────────────────────────────

export interface CliOptions {
  platform: 'mock' | 'remote' | 'desktop';
  /** Scout host (remote platform only). */
  scoutHost: string;
  /** Scout port (remote platform only). */
  scoutPort: number;
  /** LLM provider override. Default: from config (`llm.provider`). */
  provider?: string;
  task?: string;
  maxSteps?: number;
  /** Path to icon_detect.onnx (desktop platform). */
  yoloPath?: string;
}

// ── entry ──────────────────────────────────────────────────────────────────

export async function runCli(opts: CliOptions): Promise<void> {
  const cfg = loadConfig();
  const task = await resolveTask(opts.task);
  if (!task) {
    console.error('No task provided. Pass --task, type one at the prompt, or pipe it on stdin.');
    process.exitCode = 2;
    return;
  }

  console.log(`VRover agent (platform: ${opts.platform}, provider: ${opts.provider ?? cfg.llm.provider})`);
  console.log(`Task: ${task}\n`);

  // 1. pick the LLM
  const complete = pickProvider(opts.provider);

  // 2. pick the platform
  const platform = pickPlatform(opts, cfg);

  // 3. optionally wire the native OmniParser
  const nativeParser = pickNativeParser(opts.yoloPath ?? cfg.agent.yoloPath);

  // 4. run the agent loop
  let result: TaskResult;
  try {
    result = await runAgent({
      platform,
      complete,
      task,
      maxSteps: opts.maxSteps,
      nativeParser,
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`\n✗ ${errMsg(err)}`);
    process.exitCode = 1;
    return;
  }

  // 5. print outcome
  console.log('\n=== RESULT ===');
  console.log('status:', result.status, '| steps:', result.steps.length);
  if (result.summary) console.log('summary:', result.summary);
  if (result.error) console.log('error:', result.error);
  console.log(result.status === 'success' ? '\n✓ Task completed.' : '\n✗ Task did not complete.');
  process.exitCode = result.status === 'success' ? 0 : 1;
}

// ── provider ───────────────────────────────────────────────────────────────

function pickProvider(override?: string): CompleteFn {
  const name = (override ?? process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  switch (name) {
    case 'anthropic':
      return completeAnthropic;
    case 'glm':
    case 'openai':
    case 'vllm':
    case 'custom':
      return createProviderFromEnv();
    default:
      console.error(`Unknown provider "${name}". Using anthropic.`);
      return completeAnthropic;
  }
}

// ── platform ───────────────────────────────────────────────────────────────

function pickPlatform(opts: CliOptions, _cfg: VroverConfig): Platform {
  switch (opts.platform) {
    case 'mock':
      return new MockPlatform();
    case 'remote':
      return new RemotePlatform(opts.scoutHost, opts.scoutPort);
    case 'desktop':
      return new DesktopPlatform();
    default:
      throw new Error(`Unknown platform "${opts.platform}".`);
  }
}

// ── native parser ──────────────────────────────────────────────────────────

function pickNativeParser(yoloPath?: string): NativeParser | undefined {
  if (!yoloPath) return undefined;
  try {
    return createParser({ yoloPath });
  } catch (err) {
    console.error(`Native OmniParser not available: ${errMsg(err)}`);
    return undefined;
  }
}

// ── task resolution ────────────────────────────────────────────────────────

async function resolveTask(task?: string): Promise<string | undefined> {
  const fromFlag = task?.trim();
  if (fromFlag) return fromFlag;
  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question('Describe the task: ')).trim() || undefined;
    } finally {
      rl.close();
    }
  }
  return (await readAllStdin()).trim() || undefined;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
