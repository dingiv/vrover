import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startScoutServer, type ScoutServer } from '@vrover/scout';
import { MultiScreenPlatform, centerOf } from '@vrover/platform';

/**
 * Integration tests for the Scout devtools service: an in-process HTTP/SSE surface on the
 * scout server that reuses `Session.dispatch` (the same path TCP clients take). Starts a
 * scout server with `devtoolsPort:0`, then drives the REST/SSE API with `fetch` — health,
 * session lifecycle, PNG capture, element readback, a full HTTP-driven login, config
 * round-trip, and one SSE frame. No LLM, no API key.
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
    port: 0,
    devtoolsPort: 0,
    backendFactory: () => new MultiScreenPlatform(),
    backendName: 'multi-screen',
    devtoolsCaptureIntervalMs: 50,
    log: () => {},
  });
  scout = s;
  return s;
}

const base = (s: ScoutServer): string => `http://${s.devtools!.host}:${s.devtools!.port}`;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

async function api(s: ScoutServer, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(base(s) + path, init);
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

const post = (s: ScoutServer, path: string, body: unknown): Promise<any> =>
  api(s, path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

const newSession = async (s: ScoutServer): Promise<string> =>
  (await post(s, '/api/sessions', {})).id;

describe('Scout devtools service (HTTP/SSE)', () => {
  it('reports health and creates a devtools session', async () => {
    const s = await fresh();
    expect((await api(s, '/api/health')).sessions).toBe(0);

    const created = await post(s, '/api/sessions', { backend: 'multi-screen' });
    expect(created.id).toMatch(/^d_/);

    const list = await api(s, '/api/sessions');
    expect(list.sessions.map((x: { id: string }) => x.id)).toContain(created.id);
  });

  it('serves a PNG capture and the login elements', async () => {
    const s = await fresh();
    const id = await newSession(s);

    const r = await fetch(`${base(s)}/api/sessions/${id}/capture`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(Array.from(buf.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature

    const els = (await api(s, `/api/sessions/${id}/elements`)).elements;
    expect(els.map((e: { id: string }) => e.id)).toEqual(['username', 'password', 'login', 'forgot']);
  });

  it('drives a login over HTTP and reads back the home screen', async () => {
    const s = await fresh();
    const id = await newSession(s);
    const els = (await api(s, `/api/sessions/${id}/elements`)).elements as Array<{
      id: string;
      bounds: { x: number; y: number; width: number; height: number };
    }>;
    const at = (elemId: string) => centerOf(els.find((e) => e.id === elemId)!.bounds);

    await post(s, `/api/sessions/${id}/click`, { ...at('username') });
    await post(s, `/api/sessions/${id}/type`, { text: 'admin' });
    await post(s, `/api/sessions/${id}/click`, { ...at('password') });
    await post(s, `/api/sessions/${id}/type`, { text: 'hunter2' });
    await post(s, `/api/sessions/${id}/click`, { ...at('login') });

    const home = (await api(s, `/api/sessions/${id}/elements`)).elements;
    expect(home.map((e: { id: string }) => e.id)).toEqual(['articles', 'profile', 'logout']);
  });

  it('round-trips server config via PUT/GET', async () => {
    const s = await fresh();
    await api(s, '/api/config', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ captureIntervalMs: 250 }) });
    const cfg = await api(s, '/api/config');
    expect(cfg.captureIntervalMs).toBe(250);
  });

  it('pushes a frame over the SSE stream', async () => {
    const s = await fresh();
    const id = await newSession(s);
    const frame = await readFirstSseFrame(s.devtools!.host, s.devtools!.port, `/api/sessions/${id}/stream`);
    expect(frame.type).toBe('frame');
    expect(frame.width).toBeGreaterThan(0);
    expect(typeof frame.png).toBe('string'); // base64
    expect(Array.isArray(frame.elements)).toBe(true);
  });
});

/** GET an SSE path and resolve with the first `data:` payload (parsed). */
function readFirstSseFrame(host: string, port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        const m = buf.match(/^data: (.+)$/m);
        if (m) {
          res.destroy();
          resolve(JSON.parse(m[1]!));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timed out waiting for a frame'));
    }, 3000);
  });
}
