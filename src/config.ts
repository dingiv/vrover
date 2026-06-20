import 'dotenv/config';

/** Runtime configuration, read from environment (see `.env.example`). */
export interface Config {
  anthropicApiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  maxSteps: number;
  /** Where the Visual Scout server listens (brain/client side reads this). */
  scoutHost: string;
  scoutPort: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

function isEffort(v: string | undefined): v is Effort {
  return !!v && (EFFORTS as readonly string[]).includes(v);
}

let cached: Config | undefined;

/** Load and cache config from the environment. Only the real LLM path needs an API key. */
export function loadConfig(): Config {
  if (cached) return cached;
  const effortEnv = process.env.ANTHROPIC_EFFORT;
  cached = {
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    // Opus 4.8 is the default per the Anthropic guidance. Override via env to use a cheaper
    // model for iterative dev (e.g. ANTHROPIC_MODEL=claude-sonnet-4-6).
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
    effort: isEffort(effortEnv) ? effortEnv : 'medium',
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 16000),
    maxSteps: Number(process.env.MAX_STEPS ?? 15),
    scoutHost: process.env.SCOUT_HOST ?? '127.0.0.1',
    scoutPort: Number(process.env.SCOUT_PORT ?? 7878),
  };
  return cached;
}
