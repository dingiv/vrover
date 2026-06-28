import { describe, expect, it } from 'vitest';
import { MockPlatform } from '@vrover/platform';
import { runAgent, type DispatchFn } from '@vrover/agent';
import type { CompleteFn, Message } from '@vrover/llm';

/**
 * Integration test for the agent loop. A scripted fake LLM plays the model: it emits a fixed
 * sequence of tool calls (mark 1 = username, 2 = password, 3 = login on MockPlatform), so the
 * whole observe→think→act path runs end-to-end with no API key and no network.
 */
function scriptedComplete(script: Array<{ name: string; input: Record<string, unknown> }>): CompleteFn {
  let i = 0;
  return async () => {
    const action = script[i++] ?? { name: 'done', input: { summary: 'fallback' } };
    const id = `tu_${i}`;
    return {
      text: null,
      toolUses: [{ id, name: action.name, input: action.input }],
      raw: [{ type: 'tool_use', id, name: action.name, input: action.input }],
      stopReason: 'tool_use',
    };
  };
}

describe('runAgent loop', () => {
  it('drives the mock to a successful login via scripted tool calls', async () => {
    const platform = new MockPlatform();
    const result = await runAgent({
      platform,
      complete: scriptedComplete([
        { name: 'click', input: { mark: 1 } },
        { name: 'type', input: { mark: 1, text: 'admin' } },
        { name: 'click', input: { mark: 2 } },
        { name: 'type', input: { mark: 2, text: 'hunter2' } },
        { name: 'click', input: { mark: 3 } },
        { name: 'done', input: { summary: 'logged in' } },
      ]),
      task: 'log in',
      maxSteps: 10,
    });

    expect(result.status).toBe('success');
    expect(platform.isLoggedIn).toBe(true);
    expect(result.steps).toHaveLength(6);
  });

  it('reports max_steps when the script never calls done', async () => {
    const platform = new MockPlatform();
    const result = await runAgent({
      platform,
      // keeps clicking the username field every step; never calls done
      complete: scriptedComplete([
        { name: 'click', input: { mark: 1 } },
        { name: 'click', input: { mark: 1 } },
        { name: 'click', input: { mark: 1 } },
      ]),
      task: 'log in',
      maxSteps: 3,
    });
    expect(result.status).toBe('max_steps');
    expect(result.steps).toHaveLength(3);
  });

  it('surfaces an LLM error as status error', async () => {
    const platform = new MockPlatform();
    const result = await runAgent({
      platform,
      complete: async () => {
        throw new Error('boom');
      },
      task: 'log in',
      maxSteps: 5,
    });
    expect(result.status).toBe('error');
    expect(result.error).toBe('boom');
  });

  it('uses injected tools + dispatch instead of the defaults (D8)', async () => {
    const platform = new MockPlatform();
    const seenTools: string[][] = [];
    const dispatchCalls: string[] = [];
    const complete: CompleteFn = async (req) => {
      seenTools.push(req.tools.map((t) => t.name));
      return {
        text: null,
        toolUses: [{ id: 'tu_1', name: 'ping', input: {} }],
        raw: [{ type: 'tool_use', id: 'tu_1', name: 'ping', input: {} }],
        stopReason: 'tool_use',
      };
    };
    const dispatch: DispatchFn = async (name) => {
      dispatchCalls.push(name);
      return { message: `pong:${name}`, finished: false };
    };
    const result = await runAgent({
      platform,
      complete,
      task: 'x',
      maxSteps: 1,
      tools: [{ name: 'ping', description: 'd', input_schema: { type: 'object', properties: {} } }],
      dispatch,
    });
    expect(seenTools[0]).toEqual(['ping']); // custom tools reached the model
    expect(dispatchCalls).toEqual(['ping']); // custom dispatch ran, not the default
    expect(result.status).toBe('max_steps'); // never called done within 1 step
  });

  it('bounds context: ≤ keepScreenshots images + a compacted summary over many steps', async () => {
    const platform = new MockPlatform();
    const captured: Message[][] = [];
    const script = [
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
      { name: 'done', input: { summary: 'done' } },
    ];
    let i = 0;
    const complete: CompleteFn = async (req) => {
      captured.push(req.messages);
      const a = script[i++] ?? { name: 'done', input: { summary: 'fallback' } };
      const id = `tu_${i}`;
      return {
        text: null,
        toolUses: [{ id, name: a.name, input: a.input }],
        raw: [{ type: 'tool_use', id, name: a.name, input: a.input }],
        stopReason: 'tool_use',
      };
    };
    const result = await runAgent({
      platform,
      complete,
      task: 'do stuff',
      maxSteps: 10,
      contextWindow: 2,
      keepScreenshots: 2,
    });
    expect(result.status).toBe('success');

    const last = captured[captured.length - 1]!;
    const images = last.reduce(
      (n, m) => n + m.content.filter((b) => b.type === 'image').length,
      0,
    );
    expect(images).toBeLessThanOrEqual(2);
    const hasCompacted = last.some((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('compacted')),
    );
    expect(hasCompacted).toBe(true);
  });
});
