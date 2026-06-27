import { describe, expect, it } from 'vitest';
import type { CompleteFn } from '@vrover/llm';
import { MultiScreenPlatform } from '@vrover/platform';
import { runAgentTask } from '../apps/visual_rover_web/src/agent.js';

/**
 * End-to-end test for the visual-rover-web app's `runAgentTask` agent service: it wires a
 * Platform **directly** to the unmodified `runAgent` loop — self-contained, no Visual Scout
 * server. A scripted fake LLM plays the model (mark 1 = username, 2 = password, 3 = login), so
 * the whole observe→think→act path runs against the in-memory MultiScreenPlatform with no API key.
 */
function scriptedComplete(
  script: Array<{ name: string; input: Record<string, unknown> }>,
): CompleteFn {
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

describe('visual-rover-web runAgentTask (loop ⇄ mock platform, in-process)', () => {
  it('drives the mock platform to the home screen and returns the log', async () => {
    const outcome = await runAgentTask({
      task: 'log in',
      maxSteps: 10,
      platform: new MultiScreenPlatform(),
      complete: scriptedComplete([
        { name: 'click', input: { mark: 1 } },
        { name: 'type', input: { mark: 1, text: 'admin' } },
        { name: 'click', input: { mark: 2 } },
        { name: 'type', input: { mark: 2, text: 'hunter2' } },
        { name: 'click', input: { mark: 3 } },
        { name: 'done', input: { summary: 'logged in' } },
      ]),
    });

    expect(outcome.result.status).toBe('success');
    expect(outcome.result.summary).toBe('logged in');
    expect(outcome.log.length).toBeGreaterThan(0);
  });

  it('returns an error result when the LLM throws', async () => {
    const boom: CompleteFn = async () => {
      throw new Error('model down');
    };
    const outcome = await runAgentTask({
      task: 'anything',
      platform: new MultiScreenPlatform(),
      complete: boom,
    });

    expect(outcome.result.status).toBe('error');
    expect(outcome.result.error).toMatch(/model down/);
  });
});
