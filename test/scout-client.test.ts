import { afterEach, describe, expect, it } from 'vitest';
import { startScoutServer, type ScoutServer } from '@vrover/scout';
import { MultiScreenPlatform, centerOf } from '@vrover/platform';
import { ScoutClient } from '@vrover/scout-client';

/**
 * Tests for the ScoutClient SDK over a real TCP server (port 0, per-session
 * MultiScreenPlatform). Covers the connect factory + session info, capture
 * decoding, and the full click/type/scroll/keypress primitive set driving the
 * login flow.
 */

let scout: ScoutServer | undefined;
afterEach(async () => {
  if (scout) {
    await scout.close();
    scout = undefined;
  }
});

async function fresh(): Promise<ScoutClient> {
  const s = await startScoutServer({ backendFactory: () => new MultiScreenPlatform(), port: 0, log: () => {} });
  scout = s;
  return ScoutClient.connect(s.host, s.port);
}

describe('ScoutClient (SDK over TCP)', () => {
  it('connects via the async factory and exposes session info', async () => {
    const c = await fresh();
    expect(c.sessionId).toEqual(expect.any(String));
    expect(c.backend).toBe('MultiScreenPlatform');
    const h = await c.health();
    expect(h).toEqual({ ok: true, backend: 'MultiScreenPlatform', sessionId: c.sessionId });
    c.close();
  });

  it('captures a screenshot decoded to a Buffer', async () => {
    const c = await fresh();
    const s = await c.capture();
    expect(s.width).toBe(1280);
    expect(s.height).toBe(800);
    expect(Buffer.isBuffer(s.png)).toBe(true);
    expect(s.png.length).toBeGreaterThan(0);
    c.close();
  });

  it('drives a login with click/type/scroll/keypress over the SDK', async () => {
    const c = await fresh();
    const els = await c.elements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);

    await c.click(at('username').x, at('username').y);
    await c.type('admin');
    await c.click(at('password').x, at('password').y);
    await c.type('hunter2');
    await c.click(at('login').x, at('login').y);

    // scroll/keypress are part of the surface; no-ops on the mock, but the
    // REQUEST→RESULT round trip exercises the whole path.
    await c.scroll(640, 400, 'down');
    await c.keypress('Return');

    const home = await c.elements();
    expect(home.map((e) => e.id)).toEqual(['articles', 'profile', 'logout']);
    c.close();
  });
});
