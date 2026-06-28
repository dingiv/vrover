/**
 * @vrover/agent — the VRover brain. The observe → think → act `runAgent` loop (drives any
 * `Platform` with any `CompleteFn`, with injectable tools + prompts), its types, the prompt
 * management registry, and `RemotePlatform` — the brain-side adapter that drives a remote Scout
 * server through the standalone `@vrover/scout-client` SDK.
 */
export { runAgent } from './loop.js';
export { createAgent, getAgentLogger } from './agent.js';
export { FileMemoryManager } from './memory.js';
export { pruneForModel, turnBoundaries } from './context.js';
export type { PruneOptions } from './context.js';
export type {
  Agent,
  AgentDeps,
  AgentOptions,
  AgentStatus,
  MemoryManager,
  Task,
  TaskEvent,
  TaskEventType,
  TaskListener,
  TaskResult,
  TaskSnapshot,
  TaskStatus,
  AgentStep,
  StepAction,
  DispatchFn,
} from './types.js';
export { RemotePlatform } from './remote.js';
export { PromptRegistry, prompts, render } from './prompts/index.js';
export type { PromptName, PromptVars } from './prompts/index.js';
