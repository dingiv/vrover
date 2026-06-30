/**
 * service.ts — 业务层
 *
 * Orchestrates agent tasks: wires the LLM/platform adapters from `./agent.js`, delegates
 * persistence to a {@link TaskStore}, and exposes one-shot (`execute`) and streaming
 * (`stream`) entry points. Routes calls this — it has zero HTTP knowledge.
 */
import type { TaskEvent, TaskResult } from '@vrover/agent';
import { MockPlatform } from '@vrover/platform';
import type { Platform } from '@vrover/platform';
import { runAgentTask, createStreamingTask } from './agent.js';
import { MemoryTaskStore, newTaskRecord } from './store.js';
import type { TaskRecord, TaskStore } from './store.js';
import { createLogger, Logger } from '@vrover/logger';


export type { TaskRecord, TaskStore } from './store.js';

export class AgentService {


  // TODO: AgentService 需要持有 Agent 对象实例
  // private agent : Agent

  logger: Logger

  /**
   * @param store  persistence layer
   * @param platform  the single target every task drives; defaults to an in-memory
   *   {@link MockPlatform}. Selected at boot (see `createPlatform` in `./agent.js`).
  */
  constructor(
    private readonly store: TaskStore,
    private readonly platform: Platform = new MockPlatform(),
  ) {
    this.logger = createLogger('web/service');
  }

  /** Convenience: new service with an in-memory store + the default mock platform. */
  static create(): AgentService {
    const svc = new AgentService(new MemoryTaskStore());
    return svc
  }

  // ── one-shot ──────────────────────────────────────────────────────────────

  /**
   * Run an agent task to completion, persist the full record, and return it.
   * The caller blocks until the agent finishes (suitable for simple HTTP POST).
   */
  async execute(goal: string, maxSteps?: number): Promise<TaskRecord> {
    const rec = newTaskRecord(goal);
    await this.store.save(rec);

    let result: TaskResult;
    let log: string[];

    try {
      const out = await runAgentTask({ task: goal, maxSteps, platform: this.platform });
      result = out.result;
      log = out.log;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('task failed', { goal, error: msg });
      result = { status: 'error', error: msg, steps: [] };
      log = [`Error: ${msg}`];
    }

    rec.status = result.status;
    rec.steps = result.steps;
    rec.log = log;
    rec.result = result;
    rec.updatedAt = Date.now();
    await this.store.save(rec);
    return rec;
  }

  // ── streaming ─────────────────────────────────────────────────────────────

  /**
   * Run an agent task with streaming progress. Each {@link TaskEvent} is forwarded to
   * `sink` (e.g. an SSE writer) AND persisted to the store incrementally.
   * Returns the final record after the task reaches a terminal state.
   */
  async stream(
    goal: string,
    maxSteps: number | undefined,
    sink: (ev: TaskEvent) => void,
  ): Promise<TaskRecord> {
    const rec = newTaskRecord(goal);
    await this.store.save(rec);
    const task = createStreamingTask({ task: goal, platform: this.platform });

    task.on((ev: TaskEvent) => {
      sink(ev);
      this.applyEvent(rec, ev);   // TODO: 调用这个，然后还要把执行结果返回给前端
    });   // FIXME: 谁来调用 task.off 方法？

    try {
      await task.run({ maxSteps });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('streaming task failed', { goal, error: msg });
      const errorEvent: TaskEvent = {
        type: 'error',
        result: { status: 'error', error: msg, steps: [...task.steps] },
      };
      sink(errorEvent);
      this.applyEvent(rec, errorEvent);   // TODO: 调用这个，然后还要把执行结果返回给前端
    }

    rec.status = rec.result?.status ?? 'error';
    rec.steps = [...task.steps];
    rec.updatedAt = Date.now();
    await this.store.save(rec);
    return rec;
  }

  // ── queries ───────────────────────────────────────────────────────────────

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.store.load(id);
  }

  async listTasks(): Promise<TaskRecord[]> {
    return this.store.list();
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private applyEvent(rec: TaskRecord, ev: TaskEvent): void {
    switch (ev.type) {
      case 'log':
        if (ev.text) rec.log.push(ev.text);
        break;
      case 'step':
        if (ev.step) rec.steps.push(ev.step);
        break;
      case 'done':
      case 'error':
      case 'paused':
        if (ev.result) rec.result = ev.result;
        break;
    }
    rec.updatedAt = Date.now();
    this.store.save(rec); // fire-and-forget (store is in-memory, so no await needed)
  }
}
