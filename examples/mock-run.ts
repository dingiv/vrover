/**
 * End-to-end demo against MockPlatform. The agent looks at a synthetic login screen, grounds its
 * actions via Set-of-Mark, and completes a login — all on the real code path (real screenshot,
 * real SoM annotation, real LLM call).
 *
 *   cp .env.example .env   # then put your ANTHROPIC_API_KEY in .env
 *   pnpm dev
 */
import { MockPlatform } from '../src/platform/mock.js';
import { runAgent } from '../src/agent/loop.js';
import { complete as completeAnthropic } from '../src/llm/anthropic.js';

const platform = new MockPlatform();

const result = await runAgent({
  platform,
  complete: completeAnthropic,
  task: "Log in to the application. Enter username 'admin' and password 'hunter2', then submit.",
  log: (m) => console.log(m),
});

console.log('\n=== RESULT ===');
console.log('status:', result.status, '| steps:', result.steps.length);
console.log('mock reached "logged in":', platform.isLoggedIn);

if (result.status === 'success' && platform.isLoggedIn) {
  console.log('\n✓ Agent completed the login task.');
} else {
  console.log('\n✗ Agent did not complete the login task.');
  process.exitCode = 1;
}
