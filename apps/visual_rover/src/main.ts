/**
 * visual-rover — the standalone VRover GUI agent (the "brain").
 *
 *   pnpm rover:app                                                  # serve on :8080
 *   pnpm rover:app -- --mode cli --task "log in"                    # one-shot CLI, remote scout
 *   pnpm rover:app -- --mode cli --platform mock --task "click me"  # in-memory mock
 *   pnpm rover:app -- --scout-port 9000 --web-port 8080             # custom ports
 *
 * Config priority: defaults < /etc/vrover.conf < ~/.vrover/vrover.conf <
 *                  ./vrover.conf < env vars < CLI args
 */
import { parseArgs } from 'node:util';
import type { VroverConfig } from '@vrover/config';
import { runCli } from './cli.js';
import { startWebServer } from './web.js';

const USAGE = `\
visual-rover — VRover GUI agent (brain)

Usage:
  visual-rover [options]

Modes (default: serve):
  --mode cli     Run a single task, print the result, exit.
  --mode serve   Start the HTTP agent service + web UI and keep running.

Options:
  --platform <p>        mock | remote | desktop (default: remote)
  --scout-host <host>   Scout server host (default: from config / env)
  --scout-port <port>   Scout server port (default: from config / env)
  --provider <p>        anthropic | glm | openai | vllm | custom
  --task <text>         Task text (cli mode; otherwise prompt / stdin)
  --max-steps <n>       Max agent steps (default: from config)
  --yolo-path <path>    icon_detect.onnx path for native OmniParser
  --web-host <host>     Web server host (serve mode; default 127.0.0.1)
  --web-port <port>     Web server port (serve mode; default 8080)
  -h, --help            Show this help and exit

Config: vrover.conf (CWD → ~/.vrover → /etc) + env vars.`;

function main(): void {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      platform: { type: 'string' },
      'scout-host': { type: 'string' },
      'scout-port': { type: 'string' },
      provider: { type: 'string' },
      task: { type: 'string' },
      'max-steps': { type: 'string' },
      'yolo-path': { type: 'string' },
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

  const platform = (values.platform ?? 'mock') as 'mock' | 'remote' | 'desktop';
  if (!['mock', 'remote', 'desktop'].includes(platform)) {
    console.error(`Invalid --platform "${platform}". Use 'mock', 'remote', or 'desktop'.`);
    process.exit(2);
  }

  // Build CLI overrides from flags (only set when the flag was provided).
  const cliOverrides = buildCliOverrides(values);

  if (mode === 'cli') {
    void runCli({
      platform,
      task: values.task,
      overrides: cliOverrides,
    });
    return;
  }

  const webHost = values['web-host'] ?? '127.0.0.1';
  const webPort = parsePort(values['web-port'] ?? '8080', '--web-port');
  void serve({ overrides: cliOverrides, webHost, webPort });
}

// ── CLI → config overrides ──────────────────────────────────────────────────

function buildCliOverrides(values: Record<string, unknown>): Partial<VroverConfig> {
  const overrides: Record<string, unknown> = {};

  const provider = values.provider as string | undefined;
  if (provider) setNested(overrides, ['llm', 'provider'], provider);

  const scoutHost = values['scout-host'] as string | undefined;
  if (scoutHost) setNested(overrides, ['scout', 'host'], scoutHost);

  const scoutPort = values['scout-port'] as string | undefined;
  if (scoutPort) setNested(overrides, ['scout', 'port'], parseUint(scoutPort, '--scout-port'));

  const maxSteps = values['max-steps'] as string | undefined;
  if (maxSteps) setNested(overrides, ['agent', 'maxSteps'], parseUint(maxSteps, '--max-steps'));

  const yoloPath = values['yolo-path'] as string | undefined;
  if (yoloPath) setNested(overrides, ['agent', 'yoloPath'], yoloPath);

  return overrides as Partial<VroverConfig>;
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (!cur[k]) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

// ── serve ───────────────────────────────────────────────────────────────────

async function serve(opts: {
  overrides: Partial<VroverConfig>;
  webHost: string;
  webPort: number;
}): Promise<void> {
  const server = await startWebServer({
    scoutHost: '127.0.0.1',  // default; overridden by config/env/CLI inside
    scoutPort: 7878,
    host: opts.webHost,
    port: opts.webPort,
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

// ── helpers ────────────────────────────────────────────────────────────────

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

function forwardedArgs(): string[] {
  const args = process.argv.slice(2);
  return args.length > 0 && args[0] === '--' ? args.slice(1) : args;
}

main();
