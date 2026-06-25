/**
 * End-to-end agent demo with GLM as the brain. Same as `mock-run.ts` but the LLM is GLM's
 * vision model (GLM-5V-Turbo) via `@vrover/providers` instead of the Anthropic adapter —
 * proving the observe→think→act loop runs unchanged against a different provider. MockPlatform
 * supplies the synthetic login screen (no desktop/Scout needed); only the GLM key is required.
 *
 *   # put your GLM_API_KEY in .env.local
 *   pnpm glm:agent
 */
import { config } from 'dotenv';
import { MockPlatform } from '@vrover/platform';
import { runAgent } from '@vrover/agent';
import { createGlm } from '@vrover/providers';

// Local secrets live in .env.local (gitignored) — not the committed .env.example template.
config({ path: '.env.local' });

if (!process.env.GLM_API_KEY) {
  console.error('No GLM_API_KEY set. Put your Zhipu key in .env.local (https://open.bigmodel.cn).');
  process.exit(1);
}

const platform = new MockPlatform();

const result = await runAgent({
  platform,
  complete: createGlm(),
  task: "Log in to the application. Enter username 'admin' and password 'hunter2', then submit.",
  log: (m) => console.log(m),
});

console.log('\n=== RESULT ===');
console.log('status:', result.status, '| steps:', result.steps.length);
console.log('mock reached "logged in":', platform.isLoggedIn);

if (result.status === 'success' && platform.isLoggedIn) {
  console.log('\n✓ Agent completed the login task (brain: GLM).');
} else {
  console.log('\n✗ Agent did not complete the login task.');
  process.exitCode = 1;
}
