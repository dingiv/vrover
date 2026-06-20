/**
 * @vrover/agent — the VRover brain. The observe → think → act `runAgent` loop (drives any
 * `Platform` with any `CompleteFn`), its types, and `RemotePlatform` — the brain-side adapter
 * that drives a remote Scout server through the standalone `@vrover/scout-client` SDK.
 */
export { runAgent } from './loop.js';
export type { AgentOptions, TaskResult, TaskStatus, AgentStep, StepAction } from './types.js';
export { RemotePlatform } from './remote.js';
