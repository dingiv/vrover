import type { Platform } from '@vrover/platform';
import type { CompleteFn } from '@vrover/llm';

/** One recorded tool call within a step. */
export interface StepAction {
  name: string;
  input: Record<string, unknown>;
  /** Status line returned by the executor (what the LLM saw back). */
  result: string;
}

/** A recorded agent step, for the final {@link TaskResult}. */
export interface AgentStep {
  index: number;
  /** Number of SoM elements visible this step. */
  elements: number;
  actions: StepAction[];
}

export type TaskStatus = 'success' | 'max_steps' | 'error';

export interface TaskResult {
  status: TaskStatus;
  summary?: string;
  steps: AgentStep[];
  /** Set when status === 'error'. */
  error?: string;
}

/** Options for {@link runAgent}. */
export interface AgentOptions {
  platform: Platform;
  /** The LLM exit point (real Anthropic adapter or a fake for tests). */
  complete: CompleteFn;
  /** The user's natural-language goal. */
  task: string;
  /** Override the default system prompt. */
  systemPrompt?: string;
  /** Max steps before giving up (default from config). */
  maxSteps?: number;
  /** Progress sink; defaults to no-op. The demo passes console.log. */
  log?: (message: string) => void;
}
