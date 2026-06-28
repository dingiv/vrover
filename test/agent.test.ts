import { describe, expect, it } from 'vitest';
import { createAgent } from '@vrover/agent';
import type { Task } from '@vrover/agent';
import { MockPlatform } from '@vrover/platform';
import type { CompleteFn, Message } from '@vrover/llm';

/**
 * Tests for the stateful Task lifecycle (composition over inheritance). An Agent is a factory for
 * Tasks; each Task owns one conversation. A scripted fake LLM plays the model — no API key.
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

describe('Agent / Task', () => {
  it('createTask(goal).run() drives to success and marks done; exec() is null after', async () => {
    const agent = createAgent({
      platform: new MockPlatform(),
      complete: scriptedComplete([
        { name: 'click', input: { mark: 1 } },
        { name: 'done', input: { summary: 'ok' } },
      ]),
    });
    const task = agent.createTask('log in');
    const result = await task.run();

    expect(result.status).toBe('success');
    expect(result.summary).toBe('ok');
    expect(task.status).toBe('done');
    expect(result.steps).toHaveLength(2);
    expect(await task.exec()).toBeNull();
  });

  it('exec() single-steps from idle (goal is set at construction)', async () => {
    const agent = createAgent({
      platform: new MockPlatform(),
      complete: scriptedComplete([
        { name: 'click', input: { mark: 1 } },
        { name: 'done', input: { summary: 'ok' } },
      ]),
    });
    const task = agent.createTask('log in');
    expect(task.status).toBe('idle');

    const s1 = await task.exec();
    expect(s1?.index).toBe(1);
    expect(task.steps).toHaveLength(1);

    const s2 = await task.exec();
    expect(s2?.actions[0]?.name).toBe('done');
    expect(task.status).toBe('done');

    expect(await task.exec()).toBeNull();
  });

  it('one agent runs many independent tasks', async () => {
    const agent = createAgent({
      platform: new MockPlatform(),
      complete: scriptedComplete([{ name: 'done', input: { summary: 'ok' } }]),
    });
    const t1 = agent.createTask('log in');
    const t2 = agent.createTask('open mail');
    expect(t1.id).not.toBe(t2.id);

    await t1.run();
    await t2.run();
    expect(t1.status).toBe('done');
    expect(t2.status).toBe('done');
    expect(t1.steps).toHaveLength(1);
    expect(t2.steps).toHaveLength(1);
    // tasks don't share conversation state
    expect(t1.history).not.toBe(t2.history);
  });

  it('pause() stops the loop cooperatively; run() resumes', async () => {
    const holder: { task?: Task } = {};
    const agent = createAgent({
      platform: new MockPlatform(),
      complete: scriptedComplete([
        { name: 'click', input: { mark: 1 } },
        { name: 'click', input: { mark: 1 } },
        { name: 'done', input: { summary: 'ok' } },
      ]),
      log: (line) => {
        if (line.startsWith('Step 1:')) holder.task?.pause();
      },
    });
    const task = agent.createTask('log in');
    holder.task = task;

    const r1 = await task.run();
    expect(r1.status).toBe('paused');
    expect(task.status).toBe('paused');
    expect(task.steps).toHaveLength(1);

    const r2 = await task.run();
    expect(r2.status).toBe('success');
    expect(task.status).toBe('done');
    expect(task.steps).toHaveLength(3);
  });

  it('goto(n) rewinds history + steps and exec() continues from there', async () => {
    const captured: Message[][] = [];
    const script = [
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
      { name: 'click', input: { mark: 1 } },
    ];
    let i = 0;
    const complete: CompleteFn = async (req) => {
      captured.push(req.messages);
      const a = script[i++] ?? { name: 'click', input: { mark: 1 } };
      const id = `tu_${i}`;
      return {
        text: null,
        toolUses: [{ id, name: a.name, input: a.input }],
        raw: [{ type: 'tool_use', id, name: a.name, input: a.input }],
        stopReason: 'tool_use',
      };
    };
    const agent = createAgent({ platform: new MockPlatform(), complete });
    const task = agent.createTask('do stuff');
    await task.run({ maxSteps: 5 });
    expect(task.steps).toHaveLength(5);

    task.goto(3);
    expect(task.status).toBe('idle');
    expect(task.steps).toHaveLength(3);
    expect(task.steps[2]!.index).toBe(3);

    const step = await task.exec();
    expect(step?.index).toBe(4);
    const last = captured[captured.length - 1]!;
    const text = last
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).not.toContain('Current screen (step 5)');
    expect(text).toContain('Current screen (step 4)');
  });

  it('reports an LLM error as status error (no throw)', async () => {
    const agent = createAgent({
      platform: new MockPlatform(),
      complete: async () => {
        throw new Error('boom');
      },
    });
    const task = agent.createTask('log in');
    const result = await task.run();
    expect(result.status).toBe('error');
    expect(result.error).toBe('boom');
    expect(task.status).toBe('error');
    expect(await task.exec()).toBeNull();
  });
});
