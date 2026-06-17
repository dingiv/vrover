/**
 * VRover — a visual GUI agent with Set-of-Mark grounding.
 *
 * Public surface. Wire a {@link Platform} + a {@link CompleteFn} (e.g. the Anthropic adapter) and
 * call {@link runAgent}.
 */
export { runAgent } from './agent/loop.js';
export type { AgentOptions, TaskResult, TaskStatus, AgentStep, StepAction } from './agent/types.js';

export { annotate, formatTable } from './som/index.js';
export type { SoMResult, SoMElement } from './som/types.js';

export type { Platform, UiElement, Bounds, Screenshot, Action, ActionResult, GroundingSource } from './platform/types.js';
export { centerOf, contains } from './platform/types.js';
export { MockPlatform } from './platform/mock.js';

export { complete as completeAnthropic } from './llm/anthropic.js';
export type { CompleteFn, CompleteRequest, LLMResponse, Message, ContentBlock, ToolDef, Role } from './llm/types.js';

export { TOOL_DEFS, DEFAULT_SYSTEM_PROMPT } from './tools/definitions.js';
export { loadConfig } from './config.js';
