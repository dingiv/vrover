/**
 * @vrover/llm — provider-agnostic LLM protocol types + the Anthropic adapter + runtime config.
 *
 * `complete` is the single LLM exit point (dependency-injected into the agent loop); the types
 * are a thin mirror of the wire format so nothing else imports the SDK. `loadConfig` (env-driven
 * runtime config) lives here — it's the only consumer.
 */
export { complete } from './anthropic.js';
export { loadConfig } from './config.js';
export type { Config } from './config.js';
export type {
  Role,
  ContentBlock,
  Message,
  ToolDef,
  LLMResponse,
  CompleteRequest,
  CompleteFn,
} from './types.js';
