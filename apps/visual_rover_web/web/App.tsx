import { useState } from 'react';
import './App.css';

interface StepAction {
  name: string;
  input: Record<string, unknown>;
  result: string;
}
interface AgentStep {
  index: number;
  elements: number;
  actions: StepAction[];
}
interface TaskResult {
  status: 'success' | 'max_steps' | 'error';
  summary?: string;
  steps: AgentStep[];
  error?: string;
}

// Vite statically replaces `import.meta.env` at build time, so the SPA can tell dev
// (Vite dev middleware, HMR) from prod (the built bundle koa serves). Server code can't
// read this — it uses NODE_ENV — but here, in the browser, it's the source of truth.
const MODE = import.meta.env.MODE as string;
const IS_DEV = Boolean(import.meta.env.DEV);

function formatResult(r: TaskResult): string {
  const lines: string[] = [];
  lines.push(`status: ${r.status}  |  steps: ${r.steps.length}`);
  if (r.summary) lines.push(`summary: ${r.summary}`);
  if (r.error) lines.push(`error: ${r.error}`);
  for (const s of r.steps) {
    const acts = s.actions.map((a) => `${a.name} ${JSON.stringify(a.input)}`);
    lines.push(`step ${s.index} (${s.elements} elements): ${acts.join(' | ') || '(no action)'}`);
  }
  return lines.join('\n');
}

export function App() {
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [statusCls, setStatusCls] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  function setStatusLine(text: string, cls = ''): void {
    setStatus(text);
    setStatusCls(cls);
  }

  async function run(): Promise<void> {
    const t = task.trim();
    if (!t) {
      setStatusLine('enter a task first', 'bad');
      return;
    }
    setRunning(true);
    setLog([]);
    setResult(null);
    setErrorMsg('');
    setStatusLine('running…');
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: t }),
      });
      const body = (await res.json()) as { result: TaskResult; log?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setLog(body.log ?? []);
      setResult(body.result);
      setStatusLine(
        body.result.status === 'success' ? 'done ✓' : 'finished',
        body.result.status === 'success' ? 'ok' : 'bad',
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusLine('error', 'bad');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <header>
        <h1>VRover GUI Agent</h1>
        <span
          className={`badge ${IS_DEV ? 'dev' : 'prod'}`}
          title={`import.meta.env.MODE = ${MODE}`}
        >
          {MODE}
        </span>
      </header>

      <p className="meta">A visual agent loop — observe → think → act against an in-memory mock platform.</p>

      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="Describe the task, e.g.&#10;Log in with username 'admin' and password 'hunter2', then submit."
        disabled={running}
      />
      <div className="row">
        <button disabled={running} onClick={run}>
          {running ? 'Running…' : 'Run'}
        </button>
        <span className={`status ${statusCls}`}>{status}</span>
      </div>

      <section>
        <h2>Progress log</h2>
        <pre>{log.join('\n')}</pre>
      </section>

      {result && (
        <section>
          <h2>Result</h2>
          <pre className={result.status === 'success' ? 'ok' : 'bad'}>{formatResult(result)}</pre>
        </section>
      )}
      {errorMsg && (
        <section>
          <h2>Error</h2>
          <pre className="bad">{errorMsg}</pre>
        </section>
      )}
    </>
  );
}
