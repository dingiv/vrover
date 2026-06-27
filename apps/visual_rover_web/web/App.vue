<script setup lang="ts">
import { ref } from 'vue';

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

const task = ref('');
const running = ref(false);
const status = ref('');
const statusCls = ref('');
const log = ref<string[]>([]);
const result = ref<TaskResult | null>(null);
const errorMsg = ref('');

// Vite statically replaces `import.meta.env` at build time, so the SPA can tell dev
// (Vite dev middleware, HMR) from prod (the built bundle koa serves). Server code can't
// read this — it uses NODE_ENV — but here, in the browser, it's the source of truth.
const mode = import.meta.env.MODE as string;
const isDev = Boolean(import.meta.env.DEV);

function setStatus(text: string, cls = ''): void {
  status.value = text;
  statusCls.value = cls;
}

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

async function run(): Promise<void> {
  const t = task.value.trim();
  if (!t) {
    setStatus('enter a task first', 'bad');
    return;
  }
  running.value = true;
  log.value = [];
  result.value = null;
  errorMsg.value = '';
  setStatus('running…');
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: t }),
    });
    const body = (await res.json()) as { result: TaskResult; log?: string[]; error?: string };
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    log.value = body.log ?? [];
    result.value = body.result;
    setStatus(
      body.result.status === 'success' ? 'done ✓' : 'finished',
      body.result.status === 'success' ? 'ok' : 'bad',
    );
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
    setStatus('error', 'bad');
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <header>
    <h1>VRover GUI Agent</h1>
    <span class="badge" :class="isDev ? 'dev' : 'prod'" :title="`import.meta.env.MODE = ${mode}`">
      {{ mode }}
    </span>
  </header>

  <p class="meta">A visual agent loop — observe → think → act against an in-memory mock platform.</p>

  <textarea
    v-model="task"
    placeholder="Describe the task, e.g.&#10;Log in with username 'admin' and password 'hunter2', then submit."
    :disabled="running"
  ></textarea>
  <div class="row">
    <button :disabled="running" @click="run">{{ running ? 'Running…' : 'Run' }}</button>
    <span class="status" :class="statusCls">{{ status }}</span>
  </div>

  <section>
    <h2>Progress log</h2>
    <pre>{{ log.join('\n') }}</pre>
  </section>

  <section v-if="result">
    <h2>Result</h2>
    <pre :class="result.status === 'success' ? 'ok' : 'bad'">{{ formatResult(result) }}</pre>
  </section>
  <section v-if="errorMsg">
    <h2>Error</h2>
    <pre class="bad">{{ errorMsg }}</pre>
  </section>
</template>

<style scoped>
:root { color-scheme: light dark; }
header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
h1 { font-size: 20px; margin: 0; }
.badge {
  font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 4px; color: #fff;
}
.badge.dev { background: #1f6feb; }
.badge.prod { background: #6e7781; }
.meta { color: #57606a; font-size: 12px; margin: 0 0 20px; }
textarea {
  width: 100%; box-sizing: border-box; min-height: 84px; padding: 10px;
  border: 1px solid #d0d7de; border-radius: 6px; font: inherit; resize: vertical;
}
.row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
button {
  padding: 8px 16px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff;
  font: inherit; cursor: pointer;
}
button:disabled { background: #8c959f; cursor: default; }
.status { margin-left: auto; font-size: 13px; color: #57606a; }
.status.ok { color: #1a7f37; }
.status.bad { color: #cf222e; }
section { margin-top: 20px; }
h2 { font-size: 14px; margin: 0 0 8px; color: #57606a; text-transform: uppercase; letter-spacing: .04em; }
pre {
  background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px;
  white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 420px; overflow: auto;
}
pre.ok { border-color: #1a7f37; }
pre.bad { border-color: #cf222e; }
</style>
