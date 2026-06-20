import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startScoutServer } from '../src/scout/server.js';
import type { ScoutServer } from '../src/scout/server.js';
import { RemotePlatform } from '../src/platform/remote.js';
import { MultiScreenPlatform } from '../src/platform/multi-screen.js';
import { centerOf } from '../src/platform/types.js';
import { FrameDecoder, MsgType, encodeJsonFrame, type Frame } from '../src/scout/protocol.js';

/**
 * Integration tests for the Scout TCP server: the protocol-level handshake rules
 * (raw sockets) plus session behaviour (via RemotePlatform). Each test gets a
 * fresh server on an ephemeral port (port 0) backed by per-session
 * MultiScreenPlatform backends. No LLM, no API key.
 */

let scout: ScoutServer | undefined;
afterEach(async () => {
  if (scout) {
    await scout.close();
    scout = undefined;
  }
});

async function fresh(): Promise<ScoutServer> {
  const s = await startScoutServer({
    backendFactory: () => new MultiScreenPlatform(),
    backendName: 'multi-screen',
    port: 0,
    log: () => {},
  });
  scout = s;
  return s;
}

/** A minimal raw frame client for testing protocol-level rules (handshake, errors). */
function openSocket(host: string, port: number): {
  send: (buf: Buffer) => void;
  read: () => Promise<Frame>;
  close: () => void;
} {
  const socket = net.createConnection({ host, port });
  const decoder = new FrameDecoder();
  const queue: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  socket.on('data', (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else queue.push(frame);
      }
    } catch {
      socket.destroy();
    }
  });
  return {
    send: (buf: Buffer) => void socket.write(buf),
    read: () =>
      new Promise<Frame>((resolve) => {
        const next = queue.shift();
        if (next) resolve(next);
        else waiters.push(resolve);
      }),
    close: () => socket.destroy(),
  };
}

function json(frame: Frame): unknown {
  return JSON.parse(frame.payload.toString('utf8'));
}

describe('Scout TCP server', () => {
  it('handshakes a new client and assigns a session id', async () => {
    const server = await fresh();
    const platform = new RemotePlatform(server.host, server.port);
    const health = await platform.health();
    expect(health).toEqual({ ok: true, backend: 'multi-screen', sessionId: expect.any(String) });
    platform.close();
  });

  it('rejects a non-handshake first frame with ERROR(id=0)', async () => {
    const server = await fresh();
    const c = openSocket(server.host, server.port);
    c.send(encodeJsonFrame(MsgType.REQUEST, 1, { method: 'capture' }));
    const frame = await c.read();
    expect(frame.type).toBe(MsgType.ERROR);
    expect(frame.id).toBe(0);
    expect((json(frame) as { error: string }).error).toMatch(/HAND_SHAKE/i);
    c.close();
  });

  it('replies with an in-band ERROR (same id) on a malformed request', async () => {
    const server = await fresh();
    const c = openSocket(server.host, server.port);
    c.send(encodeJsonFrame(MsgType.HAND_SHAKE, 0, {}));
    const ack = await c.read();
    expect(ack.type).toBe(MsgType.HAND_SHAKE_ACK);

    c.send(encodeJsonFrame(MsgType.REQUEST, 5, { method: 'click' })); // no x/y
    const err = await c.read();
    expect(err.type).toBe(MsgType.ERROR);
    expect(err.id).toBe(5);
    expect((json(err) as { error: string }).error).toMatch(/x, y/i);
    c.close();
  });

  it('counts open sessions', async () => {
    const server = await fresh();
    const a = new RemotePlatform(server.host, server.port);
    const b = new RemotePlatform(server.host, server.port);
    await Promise.all([a.ready, b.ready]);
    expect(server.sessionCount).toBe(2);
    a.close();
    b.close();
    await untilEqual(() => server.sessionCount, 0);
  });

  it('gives each client an isolated backend terminal (per-session factory)', async () => {
    const server = await fresh();
    const a = new RemotePlatform(server.host, server.port);
    const b = new RemotePlatform(server.host, server.port);
    await Promise.all([a.ready, b.ready]);

    // Log in on A.
    const els = await a.getElements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);
    await a.performClick(at('username').x, at('username').y);
    await a.performType('admin');
    await a.performClick(at('password').x, at('password').y);
    await a.performType('hunter2');
    await a.performClick(at('login').x, at('login').y);

    // A reached home; B is untouched, still on the login screen.
    expect((await a.getElements()).map((e) => e.id)).toEqual(['articles', 'profile', 'logout']);
    expect((await b.getElements()).map((e) => e.id)).toEqual(['username', 'password', 'login', 'forgot']);
    a.close();
    b.close();
  });
});

/** Poll until `get()` equals `want`, or time out (avoids sleep-flakiness on teardown). */
async function untilEqual<T>(get: () => T, want: T, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (get() !== want) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(want)} (got ${String(get())})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
