import type { CompleteFn } from '@vrover/llm';
import { createOpenAICompatible } from './openai-compatible.js';
import { createGlm } from './glm.js';
import { createVllm } from './vllm.js';

/**
 * Pick a provider from the environment. `LLM_PROVIDER` selects the preset (default `glm`):
 *
 * - `glm`     — Zhipu GLM native (`GLM_*`)
 * - `openai`  — OpenAI or any OpenAI-cloud (`OPENAI_*`)
 * - `vllm`    — a local vLLM server (`VLLM_*`)
 * - `custom`  — any other OpenAI-compatible server (llama.cpp, LM Studio, …) via `LLM_*`
 *
 * Reads lazily on call, so importing this package never requires a key. See `.env.example`.
 */
export function createProviderFromEnv(): CompleteFn {
  switch ((process.env.LLM_PROVIDER ?? 'glm').toLowerCase()) {
    case 'openai':
      return createOpenAICompatible({
        baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
        apiKey: required('OPENAI_API_KEY'),
        model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      });
    case 'vllm':
      return createVllm();
    case 'custom':
      return createOpenAICompatible({
        baseUrl: required('LLM_BASE_URL').replace(/\/+$/, ''),
        apiKey: process.env.LLM_API_KEY ?? '',
        model: required('LLM_MODEL'),
      });
    case 'glm':
    default:
      return createGlm();
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} for the selected LLM_PROVIDER.`);
  return v;
}
