/**
 * GLM vision (VLM) grounding demo over a single Set-of-Mark screenshot.
 *
 * Takes a SoM PNG and ships it to GLM's vision model (GLM-5V-Turbo) through Zhipu's native
 * OpenAI-compatible endpoint via the `@vrover/providers` adapter — no hand-rolled fetch here,
 * the provider owns the wire format. (The same Zhipu key works; this path just speaks OpenAI
 * Chat Completions natively instead of the Anthropic-compatible proxy.)
 *
 *   # put your Zhipu/BigModel key in .env.local (or export it):  GLM_API_KEY=...
 *   pnpm glm:vlm                                          # default SoM image, describe it
 *   pnpm glm:vlm -- path/to/shot_som.png                  # your own SoM image
 *   pnpm glm:vlm -- shot.png --task "click the Sign in button"
 *   pnpm glm:vlm -- shot.png --model GLM-5V-Turbo --out resp.txt
 */
import { config } from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGlm } from '@vrover/providers';

// Local secrets live in .env.local (gitignored) — not the committed .env.example template.
config({ path: '.env.local' });

const here = path.dirname(fileURLToPath(import.meta.url));
// A real SoM image captured + annotated in this workspace (GPU test output).
const DEFAULT_IMAGE = path.resolve(here, '../../OmniParser/imgs/_som_gpu_test.png');

// pnpm forwards a literal `--` to the script; strip it so parseArgs doesn't mis-handle flags.
const rawArgv = process.argv.slice(2);
if (rawArgv[0] === '--') rawArgv.shift();
const { values, positionals } = parseArgs({
  args: rawArgv,
  options: {
    task: { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: true,
});

const imagePath = positionals[0] ?? DEFAULT_IMAGE;
if (!existsSync(imagePath)) {
  console.error(`Image not found: ${imagePath}\nPass a SoM PNG as the first argument.`);
  process.exit(1);
}

if (!process.env.GLM_API_KEY) {
  console.error('No GLM_API_KEY set. Put your Zhipu key in .env.local (https://open.bigmodel.cn).');
  process.exit(1);
}

const task = values.task;
const prompt = task
  ? `This GUI screenshot has numbered Set-of-Mark boxes over its elements (each red number = one actionable element).\nThe user wants to: ${task}.\nReply FIRST with the single mark number to act on and a one-line reason, then list every numbered mark you see and what's under it.`
  : `This GUI screenshot has numbered Set-of-Mark boxes over its elements (each red number = one element).\nIdentify the application/screen, then list every numbered mark and describe the element under each (e.g. "1: Sign in button"). Be concise.`;

const model = values.model ?? process.env.GLM_VISION_MODEL ?? 'GLM-5V-Turbo';
const complete = createGlm(values.model ? { model: values.model } : {});

console.log(`→ GLM (${model})`);
console.log(`  image: ${imagePath}`);
if (task) console.log(`  task:  ${task}`);
console.log('');

const resp = await complete({
  system: 'You are a GUI grounding assistant that reads Set-of-Mark screenshots.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: await readFile(imagePath) },
        { type: 'text', text: prompt },
      ],
    },
  ],
  tools: [],
});

console.log(`✓ stop=${resp.stopReason ?? '?'} · ${resp.toolUses.length} tool call(s)`);
console.log('');
console.log(resp.text ?? '(no text returned)');

if (values.out) {
  await writeFile(values.out, resp.text ?? '');
  console.log(`\n(saved to ${values.out})`);
}
