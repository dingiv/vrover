import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, FileMemoryManager } from '@vrover/agent';
import type { TaskSnapshot } from '@vrover/agent';
import type { CompleteFn } from '@vrover/llm';
import { MockPlatform } from '@vrover/platform';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vrover-mem-'));
}

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

describe('FileMemoryManager', () => {
  it('save / load / list / remove round-trips a snapshot, including an image Buffer', async () => {
    const dir = await tmpDir();
    try {
      const mm = new FileMemoryManager(dir);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const snap: TaskSnapshot = {
        id: 't1',
        goal: 'log in',
        history: [
          {
            role: 'user',
            content: [
              { type: 'image', mediaType: 'image/png', data: png },
              { type: 'text', text: 'Current screen (step 1).' },
            ],
          },
        ],
        steps: [{ index: 1, elements: 3, actions: [{ name: 'click', input: { mark: 1 }, result: 'ok' }] }],
        status: 'done',
        result: { status: 'success', summary: 'ok', steps: [] },
      };

      await mm.save(snap);
      expect(await mm.list()).toEqual(['t1']);

      const loaded = await mm.load('t1');
      expect(loaded).not.toBeNull();
      expect(loaded!.goal).toBe('log in');
      expect(loaded!.status).toBe('done');

      const img = loaded!.history[0]!.content.find((b) => b.type === 'image') as
        | { type: 'image'; mediaType: 'image/png'; data: Buffer }
        | undefined;
      expect(img).toBeDefined();
      expect(Buffer.isBuffer(img!.data)).toBe(true);
      expect(img!.data.equals(png)).toBe(true); // exact byte round-trip

      expect(await mm.load('nope')).toBeNull();

      await mm.remove('t1');
      expect(await mm.list()).toEqual([]);
      expect(await mm.load('t1')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list() returns [] when the directory does not exist yet', async () => {
    const mm = new FileMemoryManager(join(tmpdir(), `vrover-absent-${process.pid}-${Math.random()}`));
    expect(await mm.list()).toEqual([]);
  });
});

describe('Task persistence (save → loadTask)', () => {
  it('a saved task restores id/goal/history/steps/status on a fresh agent', async () => {
    const dir = await tmpDir();
    try {
      const memory = new FileMemoryManager(dir);
      const agent = createAgent({
        platform: new MockPlatform(),
        complete: scriptedComplete([
          { name: 'click', input: { mark: 1 } },
          { name: 'done', input: { summary: 'ok' } },
        ]),
        memory,
      });
      const task = agent.createTask('log in', { id: 'abc' });
      await task.run();
      await task.save();

      // a brand-new agent sharing the same memory restores it
      const agent2 = createAgent({
        platform: new MockPlatform(),
        complete: scriptedComplete([]),
        memory,
      });
      const restored = await agent2.loadTask('abc');
      expect(restored).not.toBeNull();
      expect(restored!.id).toBe('abc');
      expect(restored!.goal).toBe('log in');
      expect(restored!.steps).toHaveLength(2);
      expect(restored!.status).toBe('done');

      // the restored task can keep going from where it left off
      expect(await restored!.exec()).toBeNull(); // already 'done'
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('save() throws when the agent has no MemoryManager', async () => {
    const agent = createAgent({ platform: new MockPlatform(), complete: scriptedComplete([]) });
    const task = agent.createTask('x');
    await expect(task.save()).rejects.toThrow(/MemoryManager/);
  });

  it('loadTask returns null for an unknown id', async () => {
    const dir = await tmpDir();
    try {
      const agent = createAgent({
        platform: new MockPlatform(),
        complete: scriptedComplete([]),
        memory: new FileMemoryManager(dir),
      });
      expect(await agent.loadTask('never-saved')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
