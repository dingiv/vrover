import { runAgent } from '@vrover/agent';
import type { TaskResult } from '@vrover/agent';
import { complete as completeAnthropic } from '@vrover/llm';
import type { CompleteFn } from '@vrover/llm';
import { createProviderFromEnv } from '@vrover/providers';
import { MockPlatform } from '@vrover/platform';
import type { Platform } from '@vrover/platform';
import { loadConfig as loadVroverConfig } from '@vrover/config';

/**
 * The VRover web agent service — a self-contained observe→think→act loop with a visual
 * frontend. Wires the unmodified {@link runAgent} loop to an in-memory {@link MockPlatform}
 * (no Visual Scout server, no `/dev/uinput`, no API key to boot) and returns the result plus
 * the aggregated progress log.
 *
 * `complete` and `platform` are **injectable**, so tests drive the whole loop with a scripted
 * fake LLM and a richer mock platform. The default `complete` reads config lazily — a missing
 * API key surfaces as a clear error *when a task runs*, not when the server boots.
 */
export interface RunAgentTaskOptions {
  /** The user's natural-language goal. */
  task: string;
  /** Max agent steps; `runAgent`'s default (from config) when omitted. */
  maxSteps?: number;
  /**
   * LLM exit point. Defaults to the provider selected by `vrover.conf`'s `llm.provider`
   * (`glm`→GLM native, `anthropic`→Anthropic adapter). Injectable for tests.
   */
  complete?: CompleteFn;
  /** Target the loop drives. Defaults to the in-memory {@link MockPlatform}. */
  platform?: Platform;
}

/** Outcome of {@link runAgentTask}: the agent's result plus the aggregated progress lines. */
export interface RunAgentTaskOutcome {
  result: TaskResult;
  /** Every progress line emitted by the loop, in order. */
  log: string[];
}

export async function runAgentTask(opts: RunAgentTaskOptions): Promise<RunAgentTaskOutcome> {
  const log: string[] = [];
  const platform = opts.platform ?? new MockPlatform();

  const result = await runAgent({
    platform,
    complete: opts.complete ?? defaultComplete(),
    task: opts.task,
    maxSteps: opts.maxSteps,
    log: (line: string) => {
      log.push(line);
    },
  });

  return { result, log };
}

/**
 * Pick the LLM exit point from `vrover.conf`'s `llm.provider`. GLM/OpenAI/vLLM/custom go through
 * `@vrover/providers` (the native OpenAI-compatible adapter — proven on GLM-5V-Turbo); `anthropic`
 * uses the Anthropic SDK adapter. Read lazily here so the API-key requirement is enforced per
 * task, letting the server boot key-free.
 */
function defaultComplete(): CompleteFn {
  return pickProvider(loadVroverConfig().llm.provider);
}

function pickProvider(name: string): CompleteFn {
  switch (name.toLowerCase()) {
    case 'anthropic':
      return completeAnthropic;
    case 'glm':
    case 'openai':
    case 'vllm':
    case 'custom':
      return createProviderFromEnv();
    default:
      return completeAnthropic;
  }
}
