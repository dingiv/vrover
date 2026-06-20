/**
 * End-to-end demo of the component split: start the Visual Scout server, then run the
 * UNMODIFIED agent loop against it through RemotePlatform — the brain talks to Scout
 * purely over the custom TCP protocol. Same task as mock-run.ts, but the platform is
 * now a network client.
 *
 *   cp .env.example .env   # put your ANTHROPIC_API_KEY in .env (the brain needs it)
 *   pnpm scout:run
 *
 * The server mints a fresh MultiScreenPlatform for our session; after the run we
 * read the screen back over TCP and assert we reached the home (logged-in) screen —
 * proving the agent drove the server-side backend across the network boundary.
 */
import { MultiScreenPlatform } from '../src/platform/multi-screen.js';
import { startScoutServer } from '../src/scout/server.js';
import { RemotePlatform } from '../src/platform/remote.js';
import { runAgent } from '../src/agent/loop.js';
import { complete as completeAnthropic } from '../src/llm/anthropic.js';

const server = await startScoutServer({
  backendFactory: () => new MultiScreenPlatform(),
  backendName: 'multi-screen',
  log: (m) => console.log(m),
});

const platform = new RemotePlatform(server.host, server.port);
await platform.ready;

try {
  const result = await runAgent({
    platform,
    complete: completeAnthropic,
    task: "Log in to the application. Enter username 'admin' and password 'hunter2', then submit.",
    log: (m) => console.log(m),
  });

  console.log('\n=== RESULT ===');
  console.log('status:', result.status, '| steps:', result.steps.length);
  console.log('session id:', (await platform.health()).sessionId);

  // Verify end state over the wire: the home screen exposes a Logout button.
  const homeElements = (await platform.getElements()).map((e) => e.id);
  const loggedIn = homeElements.includes('logout');

  if (result.status === 'success' && loggedIn) {
    console.log('\n✓ Agent completed the login task via the Scout server (over TCP).');
  } else {
    console.log('\n✗ Agent did not complete the login task.');
    process.exitCode = 1;
  }
} finally {
  platform.close();
  await server.close();
}
