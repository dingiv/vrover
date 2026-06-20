/**
 * visual-rover — the standalone VRover GUI agent (the "brain").
 *
 * Runs as a server that exposes the **agent service** over HTTP (`POST /api/run`) and ships
 * two provisional frontends: a one-shot **CLI** mode (`--mode cli`) and a **web** UI
 * (`--mode serve`, the default). The brain drives a remote Visual Scout server over the
 * custom TCP protocol via {@link RemotePlatform}; the real LLM path needs
 * `ANTHROPIC_API_KEY`, but the server boots key-free (the key is only checked when a task
 * runs).
 *
 *   pnpm rover:app                                       # serve (web UI + agent service) on :8080
 *   pnpm rover:app -- --mode cli --task "log in"         # one-shot CLI run, then exit
 *   pnpm rover:app -- --scout-port 9000 --web-port 8080  # point at a scout on 9000
 *
 * Scout host/port default to `SCOUT_HOST`/`SCOUT_PORT` (then `127.0.0.1` / `7878`).
 */
import { parseArgs } from 'node:util';
import { runCli } from './cli.js';
import { startWebServer } from './web.js';

const USAGE = `\
visual-rover — VRover GUI agent (brain) server

Usage:
  visual-rover [options]

Modes (default: serve):
  --mode cli     Run a single task (--task or stdin), print the result, exit.
  --mode serve   Start the HTTP agent service + web UI and keep running.

Options:
  --scout-host <host>   Visual Scout host (default: $SCOUT_HOST or 127.0.0.1)
  --scout-port <port>   Visual Scout port (default: $SCOUT_PORT or 7878)
  --task <text>         Task text (cli mode; otherwise read from stdin/prompt)
  --max-steps <n>       Max agent steps (default: 15)
  --web-host <host>     Web server host (serve mode; default 127.0.0.1)
  --web-port <port>     Web server port (serve mode; default 8080; 0 = OS-assigned)
  -h, --help            Show this help and exit

The real LLM path needs ANTHROPIC_API_KEY; the server boots without it.`;

function main(): void {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      'scout-host': { type: 'string' },
      'scout-port': { type: 'string' },
      task: { type: 'string' },
      'max-steps': { type: 'string' },
      'web-host': { type: 'string' },
      'web-port': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    args: forwardedArgs(),
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const mode = values.mode ?? 'serve';
  if (mode !== 'cli' && mode !== 'serve') {
    console.error(`Invalid --mode "${mode}". Use 'cli' or 'serve'.`);
    process.exit(2);
  }

  const scoutHost = values['scout-host'] ?? process.env.SCOUT_HOST ?? '127.0.0.1';
  const scoutPort = parsePort(values['scout-port'] ?? process.env.SCOUT_PORT ?? '7878', '--scout-port');
  const maxSteps = values['max-steps'] === undefined ? undefined : parseUint(values['max-steps'], '--max-steps');

  if (mode === 'cli') {
    void runCli({ scoutHost, scoutPort, task: values.task, maxSteps });
    return;
  }

  const webHost = values['web-host'] ?? '127.0.0.1';
  const webPort = parsePort(values['web-port'] ?? '8080', '--web-port');
  void serve({ scoutHost, scoutPort, maxSteps, webHost, webPort });
}

/** serve mode: boot the web server and keep it running until interrupted. */
async function serve(opts: {
  scoutHost: string;
  scoutPort: number;
  maxSteps?: number;
  webHost: string;
  webPort: number;
}): Promise<void> {
  const server = await startWebServer({
    scoutHost: opts.scoutHost,
    scoutPort: opts.scoutPort,
    host: opts.webHost,
    port: opts.webPort,
    maxSteps: opts.maxSteps,
    log: (m) => console.log(m),
  });

  console.log(`\n  open  http://${server.host}:${server.port}`);
  console.log('  POST /api/run  { task: string }   → { result, log }');
  console.log('  GET  /health                       → liveness probe');
  console.log('\nPress Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    console.log('\nShutting down…');
    await server.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}

function parsePort(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`Invalid ${flag} "${raw}" — expected an integer in 0..65535.`);
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

/** `pnpm rover:app -- <args>` forwards a literal `--`; drop a leading one so flags parse. */
function forwardedArgs(): string[] {
  const args = process.argv.slice(2);
  return args.length > 0 && args[0] === '--' ? args.slice(1) : args;
}

main();
