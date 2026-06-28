import type { ContentBlock, Message } from '@vrover/llm';
import { loadConfig } from '@vrover/config';
import type { NativeParser } from '@vrover/native';
import { convertToSoMResult } from '@vrover/native';
import type { Platform } from '@vrover/platform';
import type { SoMElement, SoMResult } from '@vrover/som';
import { annotate, formatTable } from '@vrover/som';
import { TOOL_DEFS, dispatch as defaultDispatch } from '@vrover/tools';
import { pruneForModel } from './context.js';
import { prompts } from './prompts/index.js';
import type { AgentOptions, AgentStep, DispatchFn, StepAction, TaskResult } from './types.js';

/**
 * The observe → think → act loop. Identical no matter what Platform, LLM, tool set, or dispatcher
 * is wired in:
 *
 *   observe: screenshot + elements → SoM (annotated image + element table)
 *   think:   hand the LLM the annotated image, the element table, and the tools
 *   act:     run each returned tool call via the dispatcher; feed results back
 *
 * Runs until the model calls `done`, until `maxSteps`, or until an LLM error.
 *
 * Tools + dispatcher are injectable (`AgentOptions.tools` / `.dispatch`, defaulting to
 * `TOOL_DEFS` + `@vrover/tools` `dispatch`) — the hook a future walker / custom tool set plugs
 * into (open decision D8). Prompts come from the `./prompts` registry.
 */
export async function runAgent(opts: AgentOptions): Promise<TaskResult> {
  const cfg = loadConfig();
  const log = opts.log ?? (() => {});
  const debug = cfg.agent.debug;
  const maxSteps = opts.maxSteps ?? cfg.agent.maxSteps;
  const contextWindow = opts.contextWindow ?? cfg.agent.contextWindow;
  const keepScreenshots = opts.keepScreenshots ?? cfg.agent.keepScreenshots;
  const system = opts.systemPrompt ?? prompts.render('system');
  const tools = opts.tools ?? TOOL_DEFS;
  const runTool: DispatchFn = opts.dispatch ?? defaultDispatch;

  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: opts.task }] }];
  const steps: AgentStep[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const tStep = debug ? performance.now() : 0;

    // ── observe ───────────────────────────────────────────────────────────
    const som = await observe(opts.platform, opts.nativeParser, cfg.agent.captureTimeoutMs);
    history.push({
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: som.annotated.png },
        {
          type: 'text',
          text: prompts.render('step', { step, elementTable: formatTable(som.table) }),
        },
      ],
    });
    if (debug) {
      log(
        `Step ${step}: ${som.table.length} elements (observe ${(performance.now() - tStep).toFixed(0)}ms)`,
      );
    } else {
      log(`Step ${step}: ${som.table.length} elements visible.`);
    }

    // ── think ─────────────────────────────────────────────────────────────
    let resp;
    try {
      resp = await opts.complete({
        system,
        messages: pruneForModel(history, { contextWindow, keepScreenshots }),
        tools,
      });
    } catch (err) {
      log(`LLM error: ${errMsg(err)}`);
      return { status: 'error', error: errMsg(err), steps };
    }

    if (debug) {
      if (resp.text) {
        log(`  ┌─ model text ─────────────────────────────────`);
        for (const line of resp.text.split('\n')) {
          log(`  │ ${line}`);
        }
      }
      if (resp.toolUses.length > 0) {
        const prefix = resp.text ? '  ├─' : '  ┌─';
        log(`${prefix} tool calls (${resp.toolUses.length}) ──────────────────────`);
        for (const tu of resp.toolUses) {
          log(`  │  ${tu.name}(${JSON.stringify(tu.input)})`);
        }
      }
      if (resp.text || resp.toolUses.length > 0) {
        log(`  └──────────────────────────────────────────`);
      }
    } else {
      if (resp.text) log(`  model: ${resp.text.trim()}`);
    }

    if (resp.toolUses.length === 0) {
      // Model talked but didn't act — record it and nudge.
      history.push({ role: 'assistant', content: resp.raw });
      history.push({
        role: 'user',
        content: [{ type: 'text', text: prompts.render('nudge') }],
      });
      steps.push({ index: step, elements: som.table.length, actions: [] });
      continue;
    }

    // Echo the assistant turn verbatim (its tool_use blocks), then attach tool results.
    history.push({ role: 'assistant', content: resp.raw });

    // ── act ───────────────────────────────────────────────────────────────
    const { actions, toolResults, finished, summary } = await act(
      resp.toolUses,
      som.table,
      opts.platform,
      runTool,
      log,
    );
    history.push({ role: 'user', content: toolResults });
    steps.push({ index: step, elements: som.table.length, actions });

    if (finished) {
      log(`Task complete${summary ? `: ${summary}` : ''}.`);
      return { status: 'success', summary, steps };
    }
  }

  log(`Reached max steps (${maxSteps}) without finishing.`);
  return { status: 'max_steps', steps };
}

/**
 * observe: capture → detect + annotate → SoM.
 *
 * Two paths:
 * 1. **Rust** (when `nativeParser` is set): calls `parser.parse(png)` — YOLO
 *    detection + SoM annotation in a single Rust pass. No `getElements()` or
 *    TS `annotate()` needed.
 * 2. **TS** (fallback): `platform.getElements()` + `annotate()` using
 *    `@napi-rs/canvas`. Used when no native parser is wired (tests, mocks,
 *    remote platforms).
 */
async function observe(
  platform: Platform,
  nativeParser?: NativeParser,
  captureTimeoutMs?: number,
): Promise<SoMResult> {
  const screenshot = await withTimeout(
    platform.captureScreen(),
    captureTimeoutMs ?? 0,
    'captureScreen',
  );

  if (nativeParser) {
    const result = nativeParser.parse(screenshot.png);
    return convertToSoMResult(screenshot, result);
  }

  const elements = await platform.getElements();
  return annotate(screenshot, elements);
}

/** act: run each tool call via the dispatcher, collecting actions + tool_result blocks. */
async function act(
  toolUses: { id: string; name: string; input: Record<string, unknown> }[],
  table: SoMElement[],
  platform: Platform,
  runTool: DispatchFn,
  log: (message: string) => void,
): Promise<{ actions: StepAction[]; toolResults: ContentBlock[]; finished: boolean; summary?: string }> {
  const actions: StepAction[] = [];
  const toolResults: ContentBlock[] = [];
  let finished = false;
  let summary: string | undefined;

  for (const tu of toolUses) {
    try {
      const r = await runTool(tu.name, tu.input, table, platform);
      actions.push({ name: tu.name, input: tu.input, result: r.message });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: r.message });
      log(`  → ${tu.name}(${fmtInput(tu.input)}) → ${r.message}`);
      if (r.finished) {
        finished = true;
        summary = r.summary;
      }
    } catch (err) {
      const m = errMsg(err);
      actions.push({ name: tu.name, input: tu.input, result: `error: ${m}` });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: `Error: ${m}`,
        is_error: true,
      });
      log(`  → ${tu.name}(${fmtInput(tu.input)}) → ERROR: ${m}`);
    }
  }

  return { actions, toolResults, finished, summary };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtInput(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

/** Race a promise against a timeout. Returns the promise result or throws. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
