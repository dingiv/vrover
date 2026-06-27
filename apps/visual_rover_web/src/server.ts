/**
 * visual-rover-web — the VRover GUI agent (brain) with a Vue 3 web frontend.
 *
 * One koa process serves BOTH the API (`/api/*`) and the SPA. In dev (NODE_ENV != production)
 * it mounts Vite's dev middleware (HMR); in prod it serves the built `web-dist/` statically
 * with an SPA fallback.
 *
 *   NODE_ENV=development tsx src/server.ts        # dev (Vite middleware + HMR)
 *   NODE_ENV=production  tsx src/server.ts        # prod (serve web-dist/, run `vite build` first)
 *
 * The dev/prod switch on the SERVER is `process.env.NODE_ENV`. The CLIENT distinguishes dev/prod
 * via Vite's `import.meta.env.DEV` / `.MODE` (statically replaced at build time — server-side code
 * can't read it). `NODE_ENV` is the single switch both Vite and koa honour.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import Koa from 'koa';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { runAgentTask } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const WEB_DIST = path.join(APP_DIR, 'web-dist');
const VITE_CONFIG = path.join(APP_DIR, 'vite.config.ts');

/** Server dev/prod switch. `import.meta.env` is client-only; NODE_ENV is the shared signal. */
const isDev = process.env.NODE_ENV !== 'production';

const MAX_BODY_BYTES = 1 << 16; // 64 KiB — well above any plausible natural-language task.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const USAGE = `\
visual-rover-web — VRover GUI agent (brain) + Vue 3 web UI

Usage:
  NODE_ENV=development tsx src/server.ts [options]   # dev (Vite middleware + HMR)
  NODE_ENV=production  tsx src/server.ts [options]   # prod (serve web-dist/)

Options:
  --host <host>     Listen host (default: 127.0.0.1)
  --port <port>     Listen port (default: 8080)
  --max-steps <n>   Max agent steps per task (default: from config)
  -h, --help        Show this help and exit`;

interface ServerOptions {
  host: string;
  port: number;
  maxSteps?: number;
  log: (line: string) => void;
}

interface WebHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

async function startServer(opts: ServerOptions): Promise<WebHandle> {
  const app = new Koa();

  // ── API (manual routing — just two endpoints) ───────────────────────────
  app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && ctx.path === '/api/health') {
      ctx.body = { ok: true, mode: isDev ? 'development' : 'production' };
      return;
    }
    if (ctx.method === 'POST' && ctx.path === '/api/run') {
      let body: unknown;
      try {
        body = await readJsonBody(ctx.req);
      } catch (err) {
        ctx.status = 400;
        ctx.body = { error: `invalid request body: ${errMsg(err)}` };
        return;
      }
      const task =
        body && typeof body === 'object' && typeof (body as { task?: unknown }).task === 'string'
          ? (body as { task: string }).task.trim()
          : '';
      if (!task) {
        ctx.status = 400;
        ctx.body = { error: 'request body must be { task: string }' };
        return;
      }
      try {
        const outcome = await runAgentTask({ task, maxSteps: opts.maxSteps });
        ctx.body = { result: outcome.result, log: outcome.log };
      } catch (err) {
        ctx.status = 500;
        ctx.body = { error: errMsg(err) };
      }
      return;
    }
    await next();
  });

  // ── SPA: dev = Vite middleware (HMR); prod = static + SPA fallback ──────
  // Registered before `listen()` so it is in the composed middleware stack; the closure reads
  // `vite` (assigned right after the server starts listening).
  let vite: ViteDevServer | undefined;
  if (isDev) {
    app.use(async (ctx) => {
      if (!vite) {
        ctx.status = 503;
        ctx.body = 'dev server is starting…';
        return;
      }
      // Delegate to Vite's connect middleware — it serves index.html, transforms modules on
      // demand, and (via hmr.server) the HMR websocket. It writes straight to ctx.res; koa's
      // responder sees `res.writableEnded` and bails, so nothing double-writes.
      await new Promise<void>((resolve, reject) => {
        vite!.middlewares(ctx.req, ctx.res, (err: unknown) =>
          err instanceof Error ? reject(err) : resolve(),
        );
      });
    });
  } else {
    app.use(async (ctx) => {
      await serveStatic(ctx, WEB_DIST);
    });
  }

  const httpServer: http.Server = app.listen(opts.port, opts.host);

  if (isDev) {
    vite = await createViteServer({
      root: APP_DIR,
      configFile: VITE_CONFIG,
      // Bind Vite's HMR websocket to our koa http server (otherwise the client ws can't connect
      // in middleware mode). `appType` defaults to 'spa' → Vite serves index.html + fallback.
      server: { middlewareMode: true, hmr: { server: httpServer } },
    });
  }

  opts.log(`VRover web server listening on http://${opts.host}:${opts.port} (${isDev ? 'dev' : 'prod'})`);
  if (isDev) opts.log(`  Vite middleware + HMR (root: ${APP_DIR})`);
  else opts.log(`  serving ${WEB_DIST}`);

  return {
    host: opts.host,
    port: opts.port,
    close: async () => {
      if (vite) await vite.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Serve a static file from `root`, falling back to the SPA's index.html (client-side routing). */
async function serveStatic(ctx: Koa.Context, root: string): Promise<void> {
  const rel = decodeURIComponent(ctx.path);
  const filePath = path.resolve(root, '.' + rel); // rel starts with '/'
  if (!filePath.startsWith(root)) {
    ctx.status = 403;
    return;
  }
  try {
    const s = await stat(filePath);
    const target = s.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    ctx.body = await readFile(target);
    ctx.type = MIME[path.extname(target)] ?? 'application/octet-stream';
  } catch {
    // Not a file → SPA shell.
    ctx.type = 'html';
    ctx.body = await readFile(path.join(root, 'index.html'));
  }
}

/** Read + JSON-parse a request body, capped at MAX_BODY_BYTES. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
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

// ── entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'max-steps': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    args: forwardedArgs(),
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const host = values.host ?? '127.0.0.1';
  const port = parsePort(values.port ?? '8080');
  const maxSteps = values['max-steps'] ? parseUint(values['max-steps'], '--max-steps') : undefined;

  if (!isDev) {
    try {
      await readFile(path.join(WEB_DIST, 'index.html'));
    } catch {
      console.error(`No built SPA at ${WEB_DIST}. Run \`pnpm rover:web:build\` (vite build) first.`);
      process.exit(1);
    }
  }

  const server = await startServer({
    host,
    port,
    maxSteps,
    log: (line) => console.log(line),
  });

  console.log('\n  open  http://%s:%d', server.host, server.port);
  console.log('  POST /api/run  { task: string }   → { result, log }');
  console.log('  GET  /api/health                  → liveness probe');
  console.log('\nPress Ctrl+C to stop.');

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received, shutting down…`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`Invalid --port "${raw}" — expected an integer in 0..65535.`);
    process.exit(2);
  }
  return n;
}

function parseUint(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid ${flag} "${raw}" — expected a positive integer.`);
    process.exit(2);
  }
  return n;
}

function forwardedArgs(): string[] {
  const args = process.argv.slice(2);
  // pnpm forwards a literal `--` separator before the user args.
  const sepIdx = args.indexOf('--');
  if (sepIdx >= 0) {
    return [...args.slice(0, sepIdx), ...args.slice(sepIdx + 1)];
  }
  return args;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void main();
