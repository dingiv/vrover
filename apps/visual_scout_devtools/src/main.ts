/**
 * visual-scout-devtools — the browser DevTools UI for the Visual Scout server.
 *
 * Serves a self-contained web page that talks to the scout **devtools service**
 * (an in-process HTTP/SSE surface exposed by the scout server on an extra port).
 * The browser cannot speak scout's raw TCP protocol, so the scout process bridges:
 * browser ⇄ HTTP/SSE ⇄ scout devtools service ⇄ Session.dispatch. This app is just the
 * UI host — it serves the page and the page points at the scout devtools API.
 *
 *   pnpm scout:app -- --devtools-port 7881   # scout runs the devtools service
 *   pnpm devtools                              # this app: serves the UI at http://127.0.0.1:9090
 *   pnpm devtools -- --api http://127.0.0.1:7881 --port 9090
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { webUiHtml } from './web-ui.js';

const USAGE = `\
visual-scout-devtools — browser DevTools UI for the Visual Scout server

Usage:
  visual-scout-devtools [options]

Options:
  --api <url>    Scout devtools API URL (default: $SCOUT_DEVTOOLS_API or http://127.0.0.1:7881)
  --host <host>  UI bind host (default: 127.0.0.1)
  --port <port>  UI bind port (default: 9090; 0 = OS-assigned)
  -h, --help     Show this help and exit

First start scout with a devtools port:
  pnpm scout:app -- --devtools-port 7881
then run this app and open the printed URL.`;

function main(): void {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    args: forwardedArgs(),
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const api = values.api ?? process.env.SCOUT_DEVTOOLS_API ?? 'http://127.0.0.1:7881';
  const host = values.host ?? '127.0.0.1';
  const port = parsePort(values.port ?? '9090');
  void serve({ api, host, port });
}

async function serve(opts: { api: string; host: string; port: number }): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' && req.method === 'GET') {
      const html = webUiHtml(opts.api);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(opts.port, opts.host, () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
    console.log(`\nScout DevTools UI ready at http://${opts.host}:${actualPort}`);
    console.log(`  pointing at ${opts.api}`);
    console.log('\nPress Ctrl+C to stop.');
  });

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`Invalid port "${raw}" — expected an integer in 0..65535.`);
    process.exit(2);
  }
  return n;
}

/** `pnpm devtools -- <args>` forwards a literal `--`; drop a leading one so flags parse. */
function forwardedArgs(): string[] {
  const args = process.argv.slice(2);
  return args.length > 0 && args[0] === '--' ? args.slice(1) : args;
}

main();
