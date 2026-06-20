/**
 * ScoutClient SDK demo (self-contained, no API key): start a Scout server, then
 * drive it through the thin JS client API — capture, read elements, log in by
 * coordinates, read the home screen back. The same transport `RemotePlatform`
 * uses, but as a human-facing scripting interface.
 *
 *   pnpm scout:client
 */
import { MultiScreenPlatform, centerOf } from '@vrover/platform';
import { startScoutServer } from '@vrover/scout';
import { ScoutClient } from '@vrover/scout-client';

const server = await startScoutServer({
  backendFactory: () => new MultiScreenPlatform(),
  backendName: 'multi-screen',
  log: (m) => console.log(m),
});

const client = await ScoutClient.connect(server.host, server.port);
console.log(`connected: session ${client.sessionId} (backend: ${client.backend})`);

try {
  const shot = await client.capture();
  console.log(`captured: ${shot.width}x${shot.height}, ${shot.png.length} PNG bytes`);

  const els = await client.elements();
  console.log('login screen:', els.map((e) => `${e.role}:${e.id}`).join(', '));
  const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);

  await client.click(at('username').x, at('username').y);
  await client.type('admin');
  await client.click(at('password').x, at('password').y);
  await client.type('hunter2');
  await client.click(at('login').x, at('login').y);

  // scroll/keypress are part of the surface; the mock ignores them, but the round
  // trip (REQUEST → RESULT) proves the whole protocol path works.
  await client.scroll(640, 400, 'down');
  await client.keypress('Return');

  const home = await client.elements();
  console.log('home screen:', home.map((e) => e.id).join(', '));

  const ok = home.some((e) => e.id === 'logout');
  console.log(ok ? '\n✓ logged in via the ScoutClient SDK.' : '\n✗ login failed.');
  if (!ok) process.exitCode = 1;
} finally {
  client.close();
  await server.close();
}
