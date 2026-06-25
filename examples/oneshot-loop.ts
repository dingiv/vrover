/**
 * One-shot observe→think pipeline — the agent loop capped at a single step.
 *
 *   observe: capture a screenshot → annotate it with OmniParser (SoM) + element table
 *   think:   send the SoM image + table to GLM (GLM-5V-Turbo) and print what it sees / proposes
 *
 * No act step yet (that's the next round) — it thinks once and exits, exactly as asked.
 *
 * The screenshot comes from the Rust PipeWire `capture_one` binary (live desktop via the
 * xdg-desktop-portal ScreenCast API). The first run pops a "select what to share" dialog on the
 * GNOME desktop — approve it. To skip live capture and feed a file instead (handy when no one is
 * at the desktop to approve the dialog), pass --image <path>.
 *
 *   pnpm oneshot                                          # live capture (approve the share dialog)
 *   pnpm oneshot -- --image ../OmniParser/imgs/google_page.png --no-caption   # use a file
 *
 * Env (.env.local): GLM_API_KEY (required). Optional: OMNIPARSER, ONESHOT_STEPS.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGlm } from '@vrover/providers';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const OMNIPARSER = process.env.OMNIPARSER ?? '/workspaces/gui_agent/OmniParser';
const CAPTURE_ONE = path.join(REPO, 'target/debug/examples/capture_one');
const SOM_DEMO = path.join(REPO, 'playground/omniparser/som_demo.py');
const VENV_PY = path.join(OMNIPARSER, '.venv/bin/python');
// GNOME Wayland session bus — capture_one (a portal client) needs it, and dev shells don't
// export it. gnome-shell's own env has it as unix:path=/run/user/1000/bus.
const DBUS = process.env.DBUS_SESSION_BUS_ADDRESS ?? 'unix:path=/run/user/1000/bus';

const MAX_STEPS = Number(process.env.ONESHOT_STEPS ?? 1);

const rawArgv = process.argv.slice(2);
if (rawArgv[0] === '--') rawArgv.shift();
const { values } = parseArgs({
  args: rawArgv,
  options: {
    image: { type: 'string' },
    'no-caption': { type: 'boolean' },
    out: { type: 'string' },
  },
  allowPositionals: true,
});

if (!process.env.GLM_API_KEY) {
  console.error('No GLM_API_KEY set. Put your Zhipu key in .env.local (https://open.bigmodel.cn).');
  process.exit(1);
}

/** Run a subprocess, stream its output, throw on non-zero exit. */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): void {
  const res = spawnSync(cmd, args, {
    env: { ...process.env, ...opts.env },
    encoding: 'utf-8',
    timeout: opts.timeout ?? 120_000,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(`${cmd} exited ${res.status ?? 'killed'}${res.signal ? ` (${res.signal})` : ''}`);
  }
}

async function formatElements(p: string): Promise<string> {
  if (!existsSync(p)) return '';
  const list = JSON.parse(await readFile(p, 'utf-8')) as Array<{ type?: string; content?: string | null }>;
  return list
    .map((el, i) => `${i + 1}: [${el.type ?? '?'}] ${el.content ?? ''}`.trimEnd())
    .join('\n');
}

// ── the loop (runs once) ────────────────────────────────────────────────────────
const work = values.out ?? (await mkdtemp(path.join(tmpdir(), 'vrover-oneshot-')));
await mkdir(work, { recursive: true });

for (let step = 1; step <= MAX_STEPS; step++) {
  console.log(`\n=== step ${step}/${MAX_STEPS} ===`);

  // ── observe: screenshot ──────────────────────────────────────────────────────
  let shotPath: string;
  if (values.image) {
    shotPath = path.resolve(values.image);
    console.log(`[capture] using provided image: ${shotPath}`);
  } else {
    if (!existsSync(CAPTURE_ONE)) {
      throw new Error(
        `capture_one not built at ${CAPTURE_ONE}\n` +
          `Build it: cargo build --example capture_one --features pipewire -p vrover-pipewire`,
      );
    }
    shotPath = path.join(work, 'screen.png');
    console.log('[capture] PipeWire ScreenCast — approve the "select what to share" dialog if it appears…');
    run(CAPTURE_ONE, [shotPath], { env: { DBUS_SESSION_BUS_ADDRESS: DBUS }, timeout: 60_000 });
  }
  if (!existsSync(shotPath)) throw new Error(`screenshot missing: ${shotPath}`);

  // ── observe: OmniParser SoM ──────────────────────────────────────────────────
  const stem = path.basename(shotPath, path.extname(shotPath)) || 'screen';
  console.log('[omniparser] annotating…');
  const omniArgs = [SOM_DEMO, shotPath, '--out', work];
  if (values['no-caption']) omniArgs.push('--no-caption');
  run(VENV_PY, omniArgs, { env: { OMNIPARSER }, timeout: 300_000 });
  const somPath = path.join(work, `${stem}_som.png`);
  const elementsPath = path.join(work, `${stem}_elements.json`);
  if (!existsSync(somPath)) throw new Error(`OmniParser produced no SoM image at ${somPath}`);

  // ── think: GLM ─────────────────────────────────────────────────────────────────
  const table = await formatElements(elementsPath);
  const prompt = [
    'You are looking at a screenshot of a live desktop, annotated with numbered Set-of-Mark boxes.',
    'Each red number labels one element. Element table (mark: [type] content):',
    table || '(no elements parsed)',
    '',
    'Describe what is on screen and list the numbered marks you can identify.',
    'Then, in one line, propose the single most useful next action (reference a mark number if relevant).',
  ].join('\n');

  const complete = createGlm();
  const resp = await complete({
    system: 'You are a visual desktop agent that grounds actions to Set-of-Mark numbers.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', data: await readFile(somPath) },
          { type: 'text', text: prompt },
        ],
      },
    ],
    tools: [],
  });

  console.log(`\n[glm] stop=${resp.stopReason ?? '?'} · ${resp.toolUses.length} tool call(s)\n`);
  console.log(resp.text ?? '(no text returned)');
  console.log(`\n[artifacts] SoM: ${somPath} · elements: ${elementsPath}`);
}
