/**
 * The provisional web UI — a single self-contained HTML page (inline CSS/JS, no external
 * assets) served at `GET /`. A textarea for the task, a Run button, and panels for the
 * status, progress log, and step summary. Calls `POST /api/run` and renders the response.
 *
 * It is intentionally simple: a placeholder frontend ("暂时提供 web 形态的前端界面") until a
 * richer one (streaming progress, screenshots) is built. The real value lives in the
 * agent-service endpoint (`/api/run`), which any client can call.
 */
export function webUiHtml(scoutHost: string, scoutPort: number): string {
  // NOTE: client-side JS uses string concatenation (not template literals) so this file's
  // own template literal doesn't try to interpolate it.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VRover — GUI Agent</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 880px; margin: 0 auto; padding: 24px; color: #1f2328; background: #f6f8fa; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #57606a; font-size: 12px; margin-bottom: 20px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 84px; padding: 10px;
             border: 1px solid #d0d7de; border-radius: 6px; font: inherit; resize: vertical; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  button { padding: 8px 16px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff;
           font: inherit; cursor: pointer; }
  button:disabled { background: #8c959f; cursor: default; }
  #status { margin-left: auto; font-size: 13px; color: #57606a; }
  section { margin-top: 20px; }
  h2 { font-size: 14px; margin: 0 0 8px; color: #57606a; text-transform: uppercase; letter-spacing: .04em; }
  pre { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px;
        white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 420px; overflow: auto; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; }
  code { background: #eaeef2; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>VRover GUI Agent</h1>
  <div class="meta">Drives Visual Scout at <code>${scoutHost}:${scoutPort}</code> · POST <code>/api/run</code></div>

  <textarea id="task" placeholder="Describe the task, e.g. &#10;Log in with username 'admin' and password 'hunter2', then submit."></textarea>
  <div class="row">
    <button id="run">Run</button>
    <span id="status"></span>
  </div>

  <section>
    <h2>Progress log</h2>
    <pre id="log"></pre>
  </section>
  <section>
    <h2>Result</h2>
    <pre id="result"></pre>
  </section>

<script>
  var runBtn = document.getElementById('run');
  var taskEl = document.getElementById('task');
  var statusEl = document.getElementById('status');
  var logEl = document.getElementById('log');
  var resultEl = document.getElementById('result');

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function renderResult(r) {
    var lines = [];
    lines.push('status: ' + r.status + '  |  steps: ' + r.steps.length);
    if (r.summary) lines.push('summary: ' + r.summary);
    if (r.error) lines.push('error: ' + r.error);
    (r.steps || []).forEach(function (s) {
      var acts = (s.actions || []).map(function (a) { return a.name + ' ' + JSON.stringify(a.input); });
      lines.push('step ' + s.index + ' (' + s.elements + ' elements): ' + (acts.join(' | ') || '(no action)'));
    });
    resultEl.textContent = lines.join('\\n');
    resultEl.className = r.status === 'success' ? 'ok' : 'bad';
  }

  runBtn.addEventListener('click', async function () {
    var task = taskEl.value.trim();
    if (!task) { setStatus('enter a task first', 'bad'); return; }
    runBtn.disabled = true; logEl.textContent = ''; resultEl.textContent = '';
    setStatus('running…');
    try {
      var res = await fetch('/api/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: task })
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      logEl.textContent = (body.log || []).join('\\n');
      renderResult(body.result);
      setStatus(body.result.status === 'success' ? 'done ✓' : 'finished', body.result.status === 'success' ? 'ok' : 'bad');
    } catch (err) {
      resultEl.textContent = String(err && err.message ? err.message : err);
      resultEl.className = 'bad';
      setStatus('error', 'bad');
    } finally {
      runBtn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
