import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { runTask } from './agent.js';
import { webUiHtml } from './web-ui.js';

/**
 * The web frontend — an HTTP server that exposes the **agent service** and a minimal web
 * UI. The service is `POST /api/run { task }` → `{ result, log }`; the UI at `GET /` calls
 * it. `GET /health` is a liveness probe. Runs the task synchronously and returns the full
 * progress log with the result (streaming/SSE is a future enhancement).
 *
 * Needs no API key to boot: a missing `ANTHROPIC_API_KEY` or an unreachable Scout server
 * surfaces as a per-task HTTP 500 with a clear message.
 */
export interface WebServerOptions {
  scoutHost: string;
  scoutPort: number;
  host: string;
  port: number;
  maxSteps?: number;
  log?: (line: string) => void;
}

export interface WebServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export function startWebServer(opts: WebServerOptions): Promise<WebServer> {
  const server: Server = http.createServer((req, res) => {
    void handle(req, res, opts);
  });
  return new Promise<WebServer>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      opts.log?.(`VRover agent web server listening on http://${opts.host}:${actualPort}`);
      opts.log?.(`  driving Visual Scout at ${opts.scoutHost}:${opts.scoutPort}`);
      resolve({
        host: opts.host,
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: WebServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    return sendText(res, 200, 'text/html; charset=utf-8', webUiHtml(opts.scoutHost, opts.scoutPort));
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, scout: { host: opts.scoutHost, port: opts.scoutPort } });
  }
  if (req.method === 'POST' && url.pathname === '/api/run') {
    return handleRun(req, res, opts);
  }
  return sendJson(res, 404, { error: 'not found' });
}

async function handleRun(req: IncomingMessage, res: ServerResponse, opts: WebServerOptions): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: `invalid request body: ${errMsg(err)}` });
  }
  const task = typeof body === 'object' && body !== null && typeof (body as { task?: unknown }).task === 'string'
    ? (body as { task: string }).task.trim()
    : '';
  if (!task) return sendJson(res, 400, { error: 'request body must be { task: string }' });

  try {
    const outcome = await runTask({
      scoutHost: opts.scoutHost,
      scoutPort: opts.scoutPort,
      task,
      maxSteps: opts.maxSteps,
    });
    return sendJson(res, 200, { result: outcome.result, log: outcome.log });
  } catch (err) {
    return sendJson(res, 500, { error: errMsg(err) });
  }
}

/** Cap request bodies well above any plausible natural-language task. */
const MAX_BODY_BYTES = 1 << 16; // 64 KiB

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
