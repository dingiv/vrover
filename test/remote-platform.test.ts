import { afterEach, describe, expect, it } from 'vitest';
import { startScoutServer } from '../src/scout/server.js';
import type { ScoutServer } from '../src/scout/server.js';
import { MultiScreenPlatform } from '../src/platform/multi-screen.js';
import { RemotePlatform } from '../src/platform/remote.js';
import { centerOf } from '../src/platform/types.js';

/**
 * The brain-side client. Each test spins up a fresh Scout server (per-session
 * MultiScreenPlatform backends) and drives it through RemotePlatform over TCP —
 * proving the agent can operate the Scout server exactly like the in-process mock
 * (mirror of test/mock.test.ts, now over the custom binary protocol).
 */

let scout: ScoutServer | undefined;
afterEach(async () => {
  if (scout) {
    await scout.close();
    scout = undefined;
  }
});

async function fresh(): Promise<RemotePlatform> {
  const s = await startScoutServer({ backendFactory: () => new MultiScreenPlatform(), port: 0, log: () => {} });
  scout = s;
  return new RemotePlatform(s.host, s.port);
}

describe('RemotePlatform (brain ⇄ Scout over TCP)', () => {
  it('handshakes and reports health with a session id', async () => {
    const platform = await fresh();
    const h = await platform.health();
    expect(h.ok).toBe(true);
    expect(h.backend).toBe('MultiScreenPlatform');
    expect(typeof h.sessionId).toBe('string');
  });

  it('captures a real screenshot through the server and decodes the BLOB to a Buffer', async () => {
    const platform = await fresh();
    await platform.ready;
    const s = await platform.captureScreen();
    expect(s.width).toBe(1280);
    expect(s.height).toBe(800);
    expect(Buffer.isBuffer(s.png)).toBe(true);
    expect(s.png.length).toBeGreaterThan(0);
  });

  it('drives a login over TCP exactly like the in-process mock', async () => {
    const platform = await fresh();
    const els = await platform.getElements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);

    await platform.performClick(at('username').x, at('username').y);
    await platform.performType('admin');
    await platform.performClick(at('password').x, at('password').y);
    await platform.performType('hunter2');
    await platform.performClick(at('login').x, at('login').y);

    const home = await platform.getElements();
    expect(home.map((e) => e.id)).toEqual(['articles', 'profile', 'logout']);
  });
});
