import { afterEach, describe, expect, it } from 'vitest';
import { startScoutServer, type ScoutServer } from '@vrover/scout';
import { MultiScreenPlatform } from '@vrover/platform';
import type { CompleteFn } from '@vrover/llm';
import { runTask } from '../apps/visual_rover/src/agent.js';

/**
 * End-to-end test for the visual-rover app's `runTask` agent service: it wires
 * `RemotePlatform` (brain ⇄ Scout over TCP) to the unmodified `runAgent` loop. A scripted
 * fake LLM plays the model (mark 1 = username, 2 = password, 3 = login), so the whole path
 * runs against the Scout server's per-session backend with no API key. Mirrors
 * `test/scout-loop.test.ts`.
 */
let scout: ScoutServer | undefined;
afterEach(async () => {
  if (scout) {
    await scout.close();
    scout = undefined;
  }
});

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

describe('visual-rover runTask (brain ⇄ Scout ⇄ backend, over TCP)', () => {
  it('drives the Scout backend to the home screen and returns the log', async () => {
    const s = await startScoutServer({
      backendFactory: () => new MultiScreenPlatform(),
      port: 0,
      log: () => {},
    });
    scout = s;

    const outcome = await runTask({
      scoutHost: s.host,
      scoutPort: s.port,
      task: 'log in',
      maxSteps: 10,
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

  it('reports a clear error when the Scout server is unreachable', async () => {
    await expect(
      runTask({
        scoutHost: '127.0.0.1',
        scoutPort: 1,
        task: 'anything',
        complete: scriptedComplete([]),
      }),
    ).rejects.toThrow(/Cannot reach Visual Scout/);
  });
});
