import { RemotePlatform, runAgent } from '@vrover/agent';
import type { TaskResult } from '@vrover/agent';
import { complete as completeAnthropic, loadConfig } from '@vrover/llm';
import type { CompleteFn } from '@vrover/llm';

/**
 * The VRover agent service — the shared core behind both frontends (CLI + web). Wires
 * the brain-side {@link RemotePlatform} (a TCP client for a Visual Scout server) to the
 * unmodified {@link runAgent} observe→think→act loop, then returns the result plus the
 * progress log.
 *
 * The LLM exit point (`complete`) defaults to the real Anthropic adapter but is
 * **injectable**, so tests drive the whole path with a scripted fake LLM and no API key.
 * The default path reads the config lazily — a missing `ANTHROPIC_API_KEY` surfaces as a
 * clear error *when a task runs*, not when the server boots.
 */
export interface RunTaskOptions {
  /** Visual Scout server the brain drives over TCP. */
  scoutHost: string;
  scoutPort: number;
  /** The user's natural-language goal. */
  task: string;
  /** Max agent steps; `runAgent`'s default (15) when omitted. */
  maxSteps?: number;
  /**
   * LLM exit point. Defaults to the real Anthropic adapter (needs `ANTHROPIC_API_KEY`).
   * Injectable for tests.
   */
  complete?: CompleteFn;
  /** Live progress sink (e.g. `console.log` for the CLI, or a collector for tests). */
  log?: (line: string) => void;
}

/** Outcome of {@link runTask}: the agent's result plus the aggregated progress lines. */
export interface RunTaskOutcome {
  result: TaskResult;
  /** Every progress line emitted by the loop, in order. */
  log: string[];
}

export async function runTask(opts: RunTaskOptions): Promise<RunTaskOutcome> {
  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(line);
    opts.log?.(line);
  };

  const platform = new RemotePlatform(opts.scoutHost, opts.scoutPort);
  try {
    await platform.ready;
  } catch (err) {
    throw new Error(
      `Cannot reach Visual Scout server at ${opts.scoutHost}:${opts.scoutPort}: ${errMsg(err)}`,
    );
  }

  try {
    const result = await runAgent({
      platform,
      complete: opts.complete ?? defaultComplete(),
      task: opts.task,
      maxSteps: opts.maxSteps,
      log,
    });
    return { result, log: logLines };
  } finally {
    platform.close();
  }
}

/**
 * The real Anthropic adapter. `loadConfig()` is read here (not at startup) so the
 * `ANTHROPIC_API_KEY` requirement is enforced per task, letting the server boot key-free.
 */
function defaultComplete(): CompleteFn {
  loadConfig();
  return completeAnthropic;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
