import { describe, expect, it } from 'vitest';
import {
  createAgent,
  createAgentTeam,
  createDesktopTool,
  createGUIAgent,
  createGroundingAgent,
  createGroundingModel,
  createLeaderAgent,
} from '@vrover/agent';
import type { AgentProfile, GroundFn } from '@vrover/agent';
import { MockPlatform } from '@vrover/platform';
import type { Platform } from '@vrover/platform';
import type { CompleteFn, ContentBlock, LLMResponse } from '@vrover/llm';

/**
 * End-to-end exercise of the execution model (docs/execution-model.md), key-free: a scripted leader
 * delegates via `deliver_task`, suspends; a scripted GUI worker (the existing observe→think→act
 * loop, bridged as a tick) runs the subtask; mechanical completion feeds the result back; the
 * leader finishes. The team loop's write-lock + suspend/resume are exercised implicitly.
 */

/** A scripted CompleteFn: returns the given tool_uses in order, then an empty (end-turn) turn. */
function script(steps: Array<{ name: string; input: Record<string, unknown> }>): CompleteFn {
  let i = 0;
  return async (): Promise<LLMResponse> => {
    const s = steps[i++];
    if (!s) {
      return { text: '', toolUses: [], raw: [{ type: 'text', text: '' }], stopReason: 'end_turn' };
    }
    const id = `tu_${i}`;
    return {
      text: null,
      toolUses: [{ id, name: s.name, input: s.input }],
      raw: [{ type: 'tool_use', id, name: s.name, input: s.input }],
      stopReason: 'tool_use',
    };
  };
}

/** Wraps a platform so `captureScreen` takes ~ms and reports the most captures ever in flight at once. */
function slowCapturePlatform(inner: Platform, ms = 8): Platform & { maxConcurrent: number } {
  let active = 0;
  let maxConcurrent = 0;
  const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    captureScreen: async () => {
      active += 1;
      if (active > maxConcurrent) maxConcurrent = active;
      try {
        await sleep();
        return await inner.captureScreen();
      } finally {
        active -= 1;
      }
    },
    getElements: () => inner.getElements(),
    performClick: (x, y) => inner.performClick(x, y),
    performType: (text) => inner.performType(text),
    performScroll: (x, y, direction) => inner.performScroll(x, y, direction),
    performKeypress: (keys) => inner.performKeypress(keys),
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

describe('AgentTeam / TeamLoop', () => {
  it('leader delegates → suspends → worker runs → result fed back → leader finishes', async () => {
    const workerProfile: AgentProfile = {
      id: 'gui',
      role: 'worker',
      specialties: ['gui-operate'],
      bio: 'operates the GUI: clicks, types, navigates.',
    };
    const leaderProfile: AgentProfile = {
      id: 'leader',
      role: 'leader',
      specialties: ['planning'],
      bio: 'decomposes the goal and delegates to workers.',
    };

    // GUI worker = the existing core GUI loop, bridged as a tick. It clicks once then calls done.
    const workerCore = createAgent({
      platform: new MockPlatform(),
      complete: script([
        { name: 'click', input: { mark: 1 } },
        { name: 'done', input: { summary: 'clicked the login button' } },
      ]),
    });
    const worker = createGUIAgent({ profile: workerProfile, core: workerCore });

    // Leader: delegate the GUI step, then finish once it returns.
    const leader = createLeaderAgent({
      profile: leaderProfile,
      roster: { workers: [workerProfile] },
      complete: script([
        { name: 'deliver_task', input: { to: 'gui', goal: 'click the login button' } },
        { name: 'finish', input: { summary: 'logged in' } },
      ]),
    });

    const team = createAgentTeam({ leader, workers: [worker] });
    const root = team.createTask('log in');
    const result = await team.run(root, { maxRounds: 20 });

    // The leader finished with its summary.
    expect(result.status).toBe('success');
    expect(result.summary).toBe('logged in');
    expect(root.status).toBe('done');

    // A delegated worker subtask existed, was owned by the GUI worker, and reached done.
    const subtasks = [...team.tasks.values()].filter((t) => t.ownerId === 'gui');
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]!.status).toBe('done');
    expect(subtasks[0]!.result?.status).toBe('success');
    expect(subtasks[0]!.result?.summary).toBe('clicked the login button');
    // The worker actually performed GUI steps (observe→think→act), not zero.
    expect(subtasks[0]!.steps.length).toBeGreaterThan(0);

    // The leader's history carries the delegation round-trip: the deliver_task tool_use and the
    // tool_result the team loop injected after the worker finished (mechanical completion).
    const leaderBlocks = root.history.flatMap((m) => m.content);
    expect(leaderBlocks.some((b) => b.type === 'tool_use' && b.name === 'deliver_task')).toBe(true);
    expect(
      leaderBlocks.some(
        (b) =>
          b.type === 'tool_result' &&
          b.content.includes('clicked the login button'),
      ),
    ).toBe(true);
  });

  it('propagates a worker error back to the leader as the deliver_task result', async () => {
    const workerProfile: AgentProfile = {
      id: 'gui',
      role: 'worker',
      specialties: ['gui-operate'],
      bio: 'operates the GUI.',
    };
    const workerCore = createAgent({
      platform: new MockPlatform(),
      // throw → exec sets status 'error'
      complete: async () => {
        throw new Error('worker blew up');
      },
    });
    const worker = createGUIAgent({ profile: workerProfile, core: workerCore });

    const leader = createLeaderAgent({
      profile: { id: 'leader', role: 'leader', specialties: ['planning'], bio: 'plans.' },
      roster: { workers: [workerProfile] },
      complete: script([
        { name: 'deliver_task', input: { to: 'gui', goal: 'do thing' } },
        { name: 'finish', input: { summary: 'done anyway' } },
      ]),
    });

    const team = createAgentTeam({ leader, workers: [worker] });
    const root = team.createTask('do thing');
    const result = await team.run(root, { maxRounds: 20 });

    // Worker subtask errored; its (error) result was fed back to the leader, which still finished.
    const sub = [...team.tasks.values()].find((t) => t.ownerId === 'gui')!;
    expect(sub.status).toBe('error');
    expect(sub.result?.status).toBe('error');
    expect(result.status).toBe('success');
    expect(root.status).toBe('done');
  });

  it('fans out multiple deliver_task in one tick; resumes (wait-for-all) when every worker finishes', async () => {
    const workerProfile = (id: string): AgentProfile => ({
      id,
      role: 'worker',
      specialties: ['gui-operate'],
      bio: `${id} operates the GUI.`,
    });
    const guiP = workerProfile('gui');
    const gui2P = workerProfile('gui2');
    const gui = createGUIAgent({
      profile: guiP,
      core: createAgent({
        platform: new MockPlatform(),
        complete: script([
          { name: 'click', input: { mark: 1 } },
          { name: 'done', input: { summary: 'login clicked' } },
        ]),
      }),
    });
    const gui2 = createGUIAgent({
      profile: gui2P,
      core: createAgent({
        platform: new MockPlatform(),
        complete: script([
          { name: 'click', input: { mark: 1 } },
          { name: 'done', input: { summary: 'signup clicked' } },
        ]),
      }),
    });

    // Leader fans out TWO delegations in its first turn, then finishes once both return.
    let call = 0;
    const leaderComplete: CompleteFn = async (): Promise<LLMResponse> => {
      call += 1;
      if (call === 1) {
        const a = { id: 'd1', name: 'deliver_task', input: { to: 'gui', goal: 'click login' } };
        const b = { id: 'd2', name: 'deliver_task', input: { to: 'gui2', goal: 'click signup' } };
        return {
          text: null,
          toolUses: [a, b],
          raw: [
            { type: 'tool_use', ...a },
            { type: 'tool_use', ...b },
          ],
          stopReason: 'tool_use',
        };
      }
      const f = { id: 'f1', name: 'finish', input: { summary: 'both done' } };
      return { text: null, toolUses: [f], raw: [{ type: 'tool_use', ...f }], stopReason: 'tool_use' };
    };

    const leader = createLeaderAgent({
      profile: { id: 'leader', role: 'leader', specialties: ['planning'], bio: 'plans.' },
      roster: { workers: [guiP, gui2P] },
      complete: leaderComplete,
    });
    const team = createAgentTeam({ leader, workers: [gui, gui2] });
    const root = team.createTask('do both');
    const result = await team.run(root, { maxRounds: 30 });

    expect(result.status).toBe('success');
    expect(result.summary).toBe('both done');

    // Both worker subtasks ran and finished.
    const subs = [...team.tasks.values()].filter((t) => t.ownerId === 'gui' || t.ownerId === 'gui2');
    expect(subs).toHaveLength(2);
    expect(subs.every((t) => t.status === 'done')).toBe(true);

    // The leader received both results (wait-for-all) before finishing — one tool_result each.
    const toolResults = root.history
      .flatMap((m) => m.content)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      .map((b) => b.content);
    expect(toolResults).toEqual(expect.arrayContaining(['login clicked', 'signup clicked']));
  });

  it('serializes two GUI workers sharing one exclusive desktop via lease', async () => {
    const slow = slowCapturePlatform(new MockPlatform());
    const desktop = createDesktopTool('desktop-1', slow);

    const mkWorker = (id: string): ReturnType<typeof createGUIAgent> => {
      const profile: AgentProfile = {
        id,
        role: 'worker',
        specialties: ['gui-operate'],
        bio: `${id} operates the shared GUI.`,
        requires: [desktop.resource.id],
      };
      const core = createAgent({
        platform: desktop, // both workers inject the SAME desktop tool (Platform is tool-internal)
        complete: script([
          { name: 'click', input: { mark: 1 } },
          { name: 'done', input: { summary: `${id} done` } },
        ]),
      });
      return createGUIAgent({ profile, core });
    };
    const gui = mkWorker('gui');
    const gui2 = mkWorker('gui2');

    let call = 0;
    const leaderComplete: CompleteFn = async (): Promise<LLMResponse> => {
      call += 1;
      if (call === 1) {
        const a = { id: 'd1', name: 'deliver_task', input: { to: 'gui', goal: 'step 1' } };
        const b = { id: 'd2', name: 'deliver_task', input: { to: 'gui2', goal: 'step 2' } };
        return {
          text: null,
          toolUses: [a, b],
          raw: [{ type: 'tool_use', ...a }, { type: 'tool_use', ...b }],
          stopReason: 'tool_use',
        };
      }
      const f = { id: 'f1', name: 'finish', input: { summary: 'both done' } };
      return { text: null, toolUses: [f], raw: [{ type: 'tool_use', ...f }], stopReason: 'tool_use' };
    };
    const leader = createLeaderAgent({
      profile: { id: 'leader', role: 'leader', specialties: ['planning'], bio: 'plans.' },
      roster: { workers: [gui.profile, gui2.profile] },
      complete: leaderComplete,
    });

    const team = createAgentTeam({
      leader,
      workers: [gui, gui2],
      resources: [desktop.resource],
    });
    const root = team.createTask('do both on one desktop');
    const result = await team.run(root, { maxRounds: 40 });

    expect(result.status).toBe('success');
    const subs = [...team.tasks.values()].filter((t) => t.ownerId === 'gui' || t.ownerId === 'gui2');
    expect(subs).toHaveLength(2);
    expect(subs.every((t) => t.status === 'done')).toBe(true);
    // The exclusive desktop was never captured concurrently — the lease serialized the two workers.
    expect(slow.maxConcurrent).toBe(1);
    // And the lease was released once the workers finished.
    expect(team.resources.holder(desktop.resource.id)).toBeUndefined();
  });

  it('grounds a GUI worker on pixels via a Grounds model (GUI-TARS path, no SoM/mark)', async () => {
    let groundCalls = 0;
    const ground: GroundFn = async (_obs, _hint) => {
      groundCalls += 1;
      // Click once, then declare done — exercises capture → ground → act, twice.
      return groundCalls === 1
        ? { kind: 'click', x: 10, y: 20 }
        : { kind: 'done', summary: 'grounded' };
    };
    const tars = createGroundingModel({ id: 'gui-tars', ground });
    const operator = createGroundingAgent({
      profile: {
        id: 'operator',
        role: 'worker',
        specialties: ['gui-ground'],
        bio: 'grounds on pixels directly (no SoM).',
      },
      model: tars,
      platform: new MockPlatform(),
    });

    const leader = createLeaderAgent({
      profile: { id: 'leader', role: 'leader', specialties: ['planning'], bio: 'plans.' },
      roster: { workers: [operator.profile] },
      complete: script([
        { name: 'deliver_task', input: { to: 'operator', goal: 'click the login button' } },
        { name: 'finish', input: { summary: 'done' } },
      ]),
    });

    const team = createAgentTeam({ leader, workers: [operator] });
    const root = team.createTask('log in');
    const result = await team.run(root, { maxRounds: 20 });

    expect(result.status).toBe('success');
    expect(groundCalls).toBe(2); // click, then done
    const sub = [...team.tasks.values()].find((t) => t.ownerId === 'operator')!;
    expect(sub.status).toBe('done');
    expect(sub.result?.summary).toBe('grounded');
  });
});
