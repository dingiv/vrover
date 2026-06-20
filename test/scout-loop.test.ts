import { afterEach, describe, expect, it } from 'vitest';
import { startScoutServer } from '../src/scout/server.js';
import type { ScoutServer } from '../src/scout/server.js';
import { MultiScreenPlatform } from '../src/platform/multi-screen.js';
import { RemotePlatform } from '../src/platform/remote.js';
import { runAgent } from '../src/agent/loop.js';
import type { CompleteFn } from '../src/llm/types.js';

/**
 * End-to-end component-split test: the UNMODIFIED agent loop drives a Visual Scout
 * server through RemotePlatform over the custom TCP protocol. A scripted fake LLM
 * plays the model (mark 1 = username, 2 = password, 3 = login), so the whole
 * observe→think→act path runs over TCP against the server's per-session backend —
 * no API key, no network beyond localhost.
 *
 * This is the D10 proof: brain and Scout are separate processes that only talk
 * the Scout protocol.
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

describe('runAgent over a RemotePlatform (brain ⇄ Scout ⇄ backend, over TCP)', () => {
  it('logs in through the Scout server via scripted tool calls', async () => {
    const s = await startScoutServer({ backendFactory: () => new MultiScreenPlatform(), port: 0, log: () => {} });
    scout = s;
    const platform = new RemotePlatform(s.host, s.port);
    await platform.ready;

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
    // Verify the server-side backend reached the home screen, read back over TCP.
    const home = await platform.getElements();
    expect(home.map((e) => e.id)).toEqual(['articles', 'profile', 'logout']);
  });
});
