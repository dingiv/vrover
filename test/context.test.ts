import { describe, expect, it } from 'vitest';
import { pruneForModel } from '@vrover/agent';
import type { ContentBlock, Message } from '@vrover/llm';

// ── message builders ────────────────────────────────────────────────────────
const img = (): ContentBlock => ({ type: 'image', mediaType: 'image/png', data: Buffer.from([1]) });
const txt = (text: string): ContentBlock => ({ type: 'text', text });
const user = (...content: ContentBlock[]): Message => ({ role: 'user', content });
const asst = (...content: ContentBlock[]): Message => ({ role: 'assistant', content });
const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolRes = (id: string, content: string): ContentBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});

/** One full turn: observe(image+table) → assistant(tool_use) → user(tool_result). */
function turn(
  step: number,
  name: string,
  input: Record<string, unknown>,
  result: string,
): Message[] {
  const id = `tu_${step}`;
  return [
    user(img(), txt(`Current screen (step ${step}). Interactive elements:\n1: [input] Field`)),
    asst(toolUse(id, name, input)),
    user(toolRes(id, result)),
  ];
}

function countImages(msgs: Message[]): number {
  return msgs.reduce((n, m) => n + m.content.filter((b) => b.type === 'image').length, 0);
}

/** Concatenate every text block across the messages, for substring assertions. */
function allText(msgs: Message[]): string {
  return msgs
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

describe('pruneForModel', () => {
  it('leaves a small history unchanged when within window and image cap', () => {
    const history: Message[] = [user(txt('log in')), ...turn(1, 'click', { mark: 1 }, 'ok')];
    const out = pruneForModel(history, { contextWindow: 4, keepScreenshots: 2 });
    expect(out).toEqual(history);
  });

  it('caps images to keepScreenshots, replacing older ones with an omission note', () => {
    const history: Message[] = [
      user(txt('log in')),
      ...turn(1, 'click', { mark: 1 }, 'ok'),
      ...turn(2, 'click', { mark: 2 }, 'ok'),
      ...turn(3, 'click', { mark: 3 }, 'ok'),
      ...turn(4, 'click', { mark: 4 }, 'ok'),
    ];
    const out = pruneForModel(history, { contextWindow: 10, keepScreenshots: 2 });
    expect(countImages(out)).toBe(2); // only the two most recent survive
    const text = allText(out);
    expect(text).toContain('[screenshot from step 1 omitted]');
    expect(text).toContain('[screenshot from step 2 omitted]');
    expect(text).not.toContain('[screenshot from step 3 omitted]');
  });

  it('drops all images when keepScreenshots is 0', () => {
    const history: Message[] = [user(txt('log in')), ...turn(1, 'click', { mark: 1 }, 'ok')];
    const out = pruneForModel(history, { contextWindow: 4, keepScreenshots: 0 });
    expect(countImages(out)).toBe(0);
  });

  it('compacts turns beyond the window, keeps preamble + recent verbatim', () => {
    const history: Message[] = [
      user(txt('log in')),
      ...turn(1, 'click', { mark: 1 }, 'ok'),
      ...turn(2, 'type', { mark: 1, text: 'admin' }, 'typed'),
      ...turn(3, 'click', { mark: 2 }, 'ok'),
      ...turn(4, 'click', { mark: 3 }, 'ok'),
    ];
    const out = pruneForModel(history, { contextWindow: 2, keepScreenshots: 10 });

    expect(out[0]).toEqual(user(txt('log in'))); // task preamble preserved
    const summary = allText([out[1]!]); // one compacted message for steps 1–2
    expect(summary).toContain('compacted');
    expect(summary).toContain('step 1: click(mark=1) → ok');
    expect(summary).toContain("step 2: type(mark=1, text='admin') → typed");
    // recent turns 3–4 kept verbatim (their screenshots survive)
    expect(countImages(out)).toBe(2);
    expect(allText(out)).toContain('Current screen (step 3)');
    expect(allText(out)).toContain('Current screen (step 4)');
  });

  it('compacts a multi-tool turn to one line, and a no-tool turn to "said:"', () => {
    const history: Message[] = [
      user(txt('task')),
      // multi-tool turn (two tool calls + two results)
      user(img(), txt('Current screen (step 1).\n1: a')),
      asst(toolUse('a', 'click', { mark: 1 }), toolUse('b', 'type', { mark: 1, text: 'x' })),
      user(toolRes('a', 'clicked'), toolRes('b', 'typed')),
      // no-tool turn (model only talked → nudge)
      user(img(), txt('Current screen (step 2).\n1: a')),
      asst(txt('thinking about it')),
      user(txt('Call one of the tools to continue, or call done.')),
    ];
    const out = pruneForModel(history, { contextWindow: 0, keepScreenshots: 10 });
    const summary = allText([out[1]!]);
    expect(summary).toContain('step 1: click(mark=1) → clicked; type(mark=1, text=\'x\') → typed');
    expect(summary).toContain('step 2: said: thinking about it');
  });

  it('never mutates the input history', () => {
    const history: Message[] = [user(txt('log in')), ...turn(1, 'click', { mark: 1 }, 'ok')];
    const snapshot = JSON.stringify(history);
    pruneForModel(history, { contextWindow: 0, keepScreenshots: 0 });
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});
