import type { Platform } from '@vrover/platform';
import type { CompleteFn, ToolDef } from '@vrover/llm';
import type { SoMElement } from '@vrover/som';
import type { DispatchResult } from '@vrover/tools';

/**
 * Resolves one model tool call against the current SoM table on a {@link Platform}. Mirrors
 * `@vrover/tools`' `dispatch`; injected so a future walker / custom tool set can override the
 * default mark→element→coordinate execution (open decision D8).
 */
export type DispatchFn = (
  name: string,
  input: Record<string, unknown>,
  table: SoMElement[],
  platform: Platform,
) => Promise<DispatchResult>;

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
  /** Tool surface handed to the model. Defaults to `TOOL_DEFS` from `@vrover/tools`. */
  tools?: ToolDef[];
  /** Resolves each tool call. Defaults to `@vrover/tools`' `dispatch`. */
  dispatch?: DispatchFn;
  /** Max steps before giving up (default from config). */
  maxSteps?: number;
  /** Progress sink; defaults to no-op. The demo passes console.log. */
  log?: (message: string) => void;
}
