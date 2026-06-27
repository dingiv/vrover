import { runAgent } from '@vrover/agent';
import type { TaskResult } from '@vrover/agent';
import { complete as completeAnthropic, loadConfig } from '@vrover/llm';
import type { CompleteFn } from '@vrover/llm';
import { MockPlatform } from '@vrover/platform';
import type { Platform } from '@vrover/platform';

/**
 * The VRover web agent service — a self-contained observe→think→act loop with a visual
 * frontend. Wires the unmodified {@link runAgent} loop to an in-memory {@link MockPlatform}
 * (no Visual Scout server, no `/dev/uinput`, no API key to boot) and returns the result plus
 * the aggregated progress log.
 *
 * `complete` and `platform` are **injectable**, so tests drive the whole loop with a scripted
 * fake LLM and a richer mock platform. The default `complete` reads config lazily — a missing
 * `ANTHROPIC_API_KEY` surfaces as a clear error *when a task runs*, not when the server boots.
 */
export interface RunAgentTaskOptions {
  /** The user's natural-language goal. */
  task: string;
  /** Max agent steps; `runAgent`'s default (from config) when omitted. */
  maxSteps?: number;
  /**
   * LLM exit point. Defaults to the real Anthropic adapter (needs `ANTHROPIC_API_KEY`).
   * Injectable for tests.
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
 * The real Anthropic adapter. `loadConfig()` is read here (not at startup) so the
 * `ANTHROPIC_API_KEY` requirement is enforced per task, letting the server boot key-free.
 */
function defaultComplete(): CompleteFn {
  loadConfig();
  return completeAnthropic;
}
