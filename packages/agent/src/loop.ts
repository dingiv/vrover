import { createAgent } from './agent.js';
import type { AgentOptions, TaskResult } from './types.js';

/**
 * The observe → think → act loop, run to completion. A thin wrapper over the stateful {@link Agent}
 * — `createAgent(opts).run(task)` — so there is a single implementation of a step (in `./agent.js`,
 * which composes the injected Platform / CompleteFn / dispatcher / parser / tools / prompts).
 *
 * Runs until the model calls `done`, until `maxSteps`, or until an LLM error. For step-by-step
 * control (single-step, pause, rewind via `goto`), use `createAgent()` directly.
 */
export async function runAgent(opts: AgentOptions): Promise<TaskResult> {
  return createAgent(opts).run(opts.task, { maxSteps: opts.maxSteps });
}
