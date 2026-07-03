/**
 * desktop demo — create ONE {@link DesktopPlatform}, then capture → act → re-capture
 * (a hand-driven observe→act→observe).
 *
 *   pnpm desktop:demo
 *   pnpm exec tsx packages/platform/src/examples/desktop-demo.ts
 *
 * The same single {@link DesktopPlatform} instance is reused across captures AND input: grab a
 * "before" frame, run a short scripted sequence (open Activities, search, submit), then grab an
 * "after" frame. Both PNGs land in the cwd so you can diff what the injection changed. Real on a
 * graphical desktop with `/dev/uinput`; graceful fallbacks elsewhere.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DesktopPlatform, DesktopNativeLayerAdapter } from '@vrover/platform';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ONE platform, reused for the whole sequence. The PipeWire capture session and the uinput handle
// are both lazy + sticky — negotiated on first use, then cheap to reuse — which is exactly why a
// long-lived DesktopPlatform beats constructing one per operation.
const platform = new DesktopPlatform(new DesktopNativeLayerAdapter());

async function capture(tag: string): Promise<void> {
  const shot = await platform.captureScreen();
  const out = resolve(process.cwd(), `vrover-${tag}.png`);
  writeFileSync(out, shot.png);
  console.log(`[${tag}] ${shot.width}×${shot.height} → ${out}`);
}

await capture('before');

console.log('→ open Activities, search "files", submit');
await platform.performClick(60, 14); // Activities corner (GNOME)
await sleep(600);
await platform.performType('files');
await sleep(400);
await platform.performKeypress('Return');
await sleep(1000);

await capture('after');
console.log('done.');
