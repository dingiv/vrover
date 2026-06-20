import type { ContentBlock, Message } from '@vrover/llm';
import { annotate, formatTable } from '@vrover/som';
import { DEFAULT_SYSTEM_PROMPT, TOOL_DEFS, dispatch } from '@vrover/tools';
import type { AgentOptions, AgentStep, TaskResult } from './types.js';

const DEFAULT_MAX_STEPS = 15;

/**
 * The observe → think → act loop. Identical no matter what Platform or LLM is wired in:
 *
 *   observe: screenshot + elements → SoM (annotated image + element table)
 *   think:   hand the LLM the annotated image, the element table, and the tools
 *   act:     run each returned tool call via the executor; feed results back
 *
 * Runs until the model calls `done`, until `maxSteps`, or until an LLM error.
 */
export async function runAgent(opts: AgentOptions): Promise<TaskResult> {
  const log = opts.log ?? (() => {});
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const system = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: opts.task }] },
  ];
  const steps: AgentStep[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    // ── observe ───────────────────────────────────────────────────────────
    const screenshot = await opts.platform.captureScreen();
    const elements = await opts.platform.getElements();
    const som = annotate(screenshot, elements);
    history.push({
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: som.annotated.png },
        {
          type: 'text',
          text: `Current screen. Interactive elements (refer by mark number):\n${formatTable(som.table)}`,
        },
      ],
    });
    log(`Step ${step}: ${som.table.length} elements visible.`);

    // ── think ─────────────────────────────────────────────────────────────
    let resp;
    try {
      resp = await opts.complete({ system, messages: history, tools: TOOL_DEFS });
    } catch (err) {
      log(`LLM error: ${errMsg(err)}`);
      return { status: 'error', error: errMsg(err), steps };
    }

    if (resp.text) log(`  model: ${resp.text.trim()}`);

    if (resp.toolUses.length === 0) {
      // Model talked but didn't act — record it and nudge.
      history.push({ role: 'assistant', content: resp.raw });
      history.push({
        role: 'user',
        content: [{ type: 'text', text: 'Call one of the tools to continue, or call done.' }],
      });
      steps.push({ index: step, elements: som.table.length, actions: [] });
      continue;
    }

    // Echo the assistant turn verbatim (its tool_use blocks), then attach tool results.
    history.push({ role: 'assistant', content: resp.raw });

    // ── act ───────────────────────────────────────────────────────────────
    const actions: AgentStep['actions'] = [];
    const toolResults: ContentBlock[] = [];
    let finished = false;
    let summary: string | undefined;

    for (const tu of resp.toolUses) {
      try {
        const r = await dispatch(tu.name, tu.input, som.table, opts.platform);
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtInput(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}
