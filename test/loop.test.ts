import { describe, expect, it } from 'vitest';
import { MockPlatform } from '../src/platform/mock.js';
import { runAgent } from '../src/agent/loop.js';
import type { CompleteFn } from '../src/llm/types.js';

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
});
