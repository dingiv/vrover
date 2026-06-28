import type { Platform } from '@vrover/platform';
import type { CompleteFn, Message, ToolDef } from '@vrover/llm';
import type { NativeParser } from '@vrover/native';
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

export type TaskStatus = 'success' | 'max_steps' | 'error' | 'paused';

export interface TaskResult {
  status: TaskStatus;
  summary?: string;
  steps: AgentStep[];
  /** Set when status === 'error'. */
  error?: string;
}

/** Lifecycle of a {@link Task}. */
export type AgentStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

// ── memory ──────────────────────────────────────────────────────────────────

/** A serializable snapshot of a {@link Task} — what a {@link MemoryManager} persists. */
export interface TaskSnapshot {
  id: string;
  goal: string;
  history: Message[];
  steps: AgentStep[];
  status: AgentStatus;
  result?: TaskResult;
}

/**
 * Persists {@link TaskSnapshot}s so a task's conversation + state survives across processes. The
 * brain owns one (injectable); a task `save()`s itself and an `Agent.loadTask(id)` restores it.
 * Implementations are free to use files, a DB, etc. — the contract is intentionally minimal.
 */
export interface MemoryManager {
  save(snapshot: TaskSnapshot): Promise<void>;
  load(id: string): Promise<TaskSnapshot | null>;
  /** All stored task ids. */
  list(): Promise<string[]>;
  remove(id: string): Promise<void>;
}

// ── task ────────────────────────────────────────────────────────────────────

/**
 * The lifecycle of **one** conversation task — one user goal driven through observe → think → act.
 * Created by an {@link Agent} (`agent.createTask(goal)`), which supplies the shared collaborators
 * (platform, LLM, dispatcher, parser, tools, config). Holding the per-conversation state here (not
 * on the Agent) is what lets one Agent run many independent tasks — the shape a future multi-agent
 * architecture needs.
 *
 *   run()        auto-pilot: loop exec() until the model calls `done`, `maxSteps`, a `pause()`, or error.
 *   exec()       one chat iteration (observe → think → act); the per-turn "new chat message" is the
 *                observe turn (annotated screenshot + element table). Optional `message` steers it.
 *   goto(step)   destructive rewind to the end of step N (1-based; 0 = just the goal), then continue.
 *   pause()      cooperatively stop a running loop at the next step boundary.
 *   save()       persist this task via the agent's {@link MemoryManager} (if any).
 */
export interface Task {
  readonly id: string;
  readonly goal: string;
  readonly status: AgentStatus;
  /** Full verbatim conversation (pruning to fit the model happens only at send time). */
  readonly history: readonly Message[];
  /** Completed steps so far. */
  readonly steps: readonly AgentStep[];
  /** Set once status reaches 'done' / 'error' / 'paused'. */
  readonly result?: TaskResult;

  run(opts?: { maxSteps?: number }): Promise<TaskResult>;
  exec(opts?: { message?: string }): Promise<AgentStep | null>;
  goto(step: number): void;
  pause(): void;
  save(): Promise<void>;
}

// ── agent ───────────────────────────────────────────────────────────────────

/**
 * The collaborators an {@link Agent} **composes** (composition over inheritance — no base class).
 * `task` and `maxSteps` are deliberately absent: they are per-task (`Agent.createTask` / `.run`).
 * `createAgent(deps)` reads the config file and resolves these defaults; the `AgentImpl` constructor
 * receives them already-resolved (pure — no I/O).
 */
export interface AgentDeps {
  platform: Platform;
  /** The LLM exit point (real adapter or a fake for tests). */
  complete: CompleteFn;
  /** Override the default system prompt. */
  systemPrompt?: string;
  /** Tool surface handed to the model. Defaults to `TOOL_DEFS` from `@vrover/tools`. */
  tools?: ToolDef[];
  /** Resolves each tool call. Defaults to `@vrover/tools`' `dispatch`. */
  dispatch?: DispatchFn;
  /** Progress sink; defaults to no-op. */
  log?: (message: string) => void;
  /**
   * Optional native OmniParser (Rust via napi-rs). When set, `observe()` calls
   * `parser.parse(screenshot.png)` — a single Rust pass that does YOLO detection + SoM
   * annotation, skipping {@link Platform.getElements} and the TS `annotate()`.
   */
  nativeParser?: NativeParser;
  /** Recent steps kept verbatim before older turns are compacted (default from config). */
  contextWindow?: number;
  /** Max screenshots carried as image blocks (default from config). */
  keepScreenshots?: number;
  /** Optional persistence for task save/load. Defaults to none. */
  memory?: MemoryManager;
}

/** Options for {@link runAgent} — {@link AgentDeps} plus the per-run `task` / `maxSteps`. */
export interface AgentOptions extends AgentDeps {
  /** The user's natural-language goal. */
  task: string;
  /** Max steps before giving up (default from config). */
  maxSteps?: number;
}

/**
 * A wired-up brain: collaborators + resolved config + (optional) memory. It is a **factory** for
 * {@link Task}s — it holds no per-conversation state itself, so one Agent can drive many independent
 * tasks (and, later, many Agents can coexist).
 *
 *   createTask(goal, {id?})  start a new task (id defaults to a UUID)
 *   loadTask(id)             restore a task previously `save()`d to memory
 *   run(goal, {maxSteps?})   convenience: create a task and run it to a stop
 */
export interface Agent {
  /** The persistence backend, if any. */
  readonly memory: MemoryManager | undefined;
  createTask(goal: string, opts?: { id?: string }): Task;
  loadTask(id: string): Promise<Task | null>;
  run(goal: string, opts?: { maxSteps?: number }): Promise<TaskResult>;
}
