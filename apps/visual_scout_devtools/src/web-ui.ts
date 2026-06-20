/**
 * The Scout DevTools web UI — a single self-contained page (inline CSS/JS, no external
 * assets) served at `GET /`. It drives the scout **devtools service** over HTTP + SSE:
 *
 *   - sessions: list / create (pick backend) / select / delete
 *   - viewport: render the captured screenshot on a <canvas> with a numbered Set-of-Mark
 *     overlay; click the canvas to send a raw-coordinate click
 *   - actions: type / keypress / scroll / refresh
 *   - live: an EventSource on `/api/sessions/:id/stream` pushes frames in real time
 *   - config: GET/PUT `/api/config` (SSE capture interval, active session)
 *
 * Client JS uses string concatenation (not template literals) so this file's own template
 * literal doesn't try to interpolate it; the API base URL is injected as `API` once.
 */
export function webUiHtml(api: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Scout DevTools</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; display: flex; flex-direction: column; height: 100vh; color: #1f2328; background: #f6f8fa; }
  header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #24292f; color: #fff; }
  header input { flex: 1; min-width: 160px; padding: 5px 8px; border: 0; border-radius: 5px; }
  header button { padding: 5px 12px; border: 0; border-radius: 5px; background: #1f6feb; color: #fff; cursor: pointer; }
  header button:disabled { background: #6e7681; cursor: default; }
  .cols { flex: 1; display: grid; grid-template-columns: 260px 1fr 280px; min-height: 0; }
  aside { padding: 10px; overflow: auto; border-right: 1px solid #d0d7de; background: #fff; }
  aside.right { border-right: 0; border-left: 1px solid #d0d7de; }
  h3 { font-size: 11px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: #57606a; }
  h3:first-child { margin-top: 0; }
  .session { display: flex; align-items: center; gap: 6px; padding: 5px 7px; border-radius: 5px; cursor: pointer; }
  .session:hover { background: #eaeef2; }
  .session.active { background: #ddf4ff; }
  .session small { color: #57606a; margin-left: auto; }
  .session .del { border: 0; background: transparent; color: #cf222e; cursor: pointer; padding: 0 2px; }
  label { display: block; color: #57606a; margin: 6px 0 2px; }
  input, select { width: 100%; box-sizing: border-box; padding: 4px 6px; border: 1px solid #d0d7de; border-radius: 5px; font: inherit; }
  .row { display: flex; gap: 6px; }
  .row > * { flex: 1; }
  button.act { padding: 4px 10px; border: 1px solid #d0d7de; border-radius: 5px; background: #fff; cursor: pointer; }
  button.act.primary { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  #viewport-wrap { display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 12px; }
  #viewport { max-width: 100%; height: auto; background: #000; box-shadow: 0 1px 4px rgba(0,0,0,.2); cursor: crosshair; image-rendering: pixelated; }
  #status { color: #57606a; font-size: 12px; padding: 4px 12px; border-top: 1px solid #d0d7de; background: #fff; }
  .el-row { display: flex; gap: 6px; padding: 3px 5px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .el-row:hover { background: #eaeef2; }
  .el-row .n { display: inline-block; width: 18px; height: 18px; line-height: 18px; text-align: center; background: #1f6feb; color: #fff; border-radius: 4px; font-size: 11px; }
  .err { color: #cf222e; }
</style>
</head>
<body>
<header>
  <strong>Scout DevTools</strong>
  <label style="color:#8b949e;margin:0">API</label>
  <input id="api-url" />
  <button id="connect">Connect</button>
</header>

<div class="cols">
  <aside>
    <h3>Sessions</h3>
    <div class="row" style="margin-bottom:8px">
      <select id="new-backend">
        <option value="">(default backend)</option>
        <option value="multi-screen">multi-screen</option>
        <option value="mock">mock</option>
        <option value="desktop">desktop</option>
      </select>
      <button class="act primary" id="new-session">New</button>
    </div>
    <div id="session-list"></div>

    <h3>Live</h3>
    <button class="act" id="live-btn" disabled>Start live</button>
    <label>Capture interval (ms)</label>
    <div class="row">
      <input id="interval" type="number" min="50" step="50" />
      <button class="act" id="set-interval">Set</button>
    </div>
  </aside>

  <main id="viewport-wrap">
    <canvas id="viewport" width="640" height="400"></canvas>
  </main>

  <aside class="right">
    <h3>Actions</h3>
    <label>Type text</label>
    <div class="row" style="margin-bottom:6px">
      <input id="type-text" placeholder="text" />
      <button class="act" id="do-type">Type</button>
    </div>
    <label>Keypress</label>
    <div class="row" style="margin-bottom:6px">
      <input id="keys" placeholder="e.g. Return" />
      <button class="act" id="do-keypress">Send</button>
    </div>
    <div class="row" style="margin-bottom:6px">
      <button class="act" id="do-scroll-up">Scroll up</button>
      <button class="act" id="do-scroll-down">Scroll down</button>
    </div>
    <button class="act primary" id="refresh" style="width:100%">Refresh capture</button>

    <h3>Elements <span id="el-count" style="color:#57606a;font-weight:normal"></span></h3>
    <div id="el-list"></div>
  </aside>
</div>

<div id="status">disconnected</div>

<script>
var API = ${JSON.stringify(api)};
var state = { active: null, sessions: [], elements: [], img: null, es: null, live: false };

function $(id) { return document.getElementById(id); }
function setStatus(t, cls) { var s = $('status'); s.textContent = t; s.className = cls || ''; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }

async function jget(path) { var r = await fetch(API + path); var t = await r.text(); var j = t ? JSON.parse(t) : {}; if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
async function jpost(path, body) { return jreq(path, 'POST', body); }
async function jput(path, body) { return jreq(path, 'PUT', body); }
async function jreq(path, method, body) {
  var r = await fetch(API + path, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  var t = await r.text(); var j = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j;
}

function apiBase(u) { return u.replace(/\\/$+$/, ''); }

async function connect() {
  API = apiBase($('api-url').value || API);
  try {
    var h = await jget('/api/health');
    setStatus('connected · ' + h.sessions + ' session(s)');
    await refreshSessions();
    var cfg = await jget('/api/config');
    $('interval').value = cfg.captureIntervalMs;
  } catch (e) { setStatus('error: ' + e.message, 'err'); }
}

async function refreshSessions() {
  var data = await jget('/api/sessions');
  state.sessions = data.sessions || [];
  renderSessions();
}

function renderSessions() {
  var html = '';
  if (!state.sessions.length) html = '<div style="color:#57606a">No sessions. Create one.</div>';
  state.sessions.forEach(function (s) {
    var on = s.id === state.active;
    html += '<div class="session' + (on ? ' active' : '') + '" data-id="' + esc(s.id) + '">'
      + '<span>' + esc(s.id) + '</span><small>' + esc(s.backend) + '</small>'
      + '<button class="del" data-del="' + esc(s.id) + '" title="delete">×</button></div>';
  });
  var list = $('session-list');
  list.innerHTML = html;
  Array.prototype.forEach.call(list.querySelectorAll('.session'), function (node) {
    node.addEventListener('click', function (e) {
      if (e.target.hasAttribute('data-del')) return;
      void selectSession(node.getAttribute('data-id'));
    });
  });
  Array.prototype.forEach.call(list.querySelectorAll('.del'), function (btn) {
    btn.addEventListener('click', function (e) { e.stopPropagation(); void deleteSession(btn.getAttribute('data-del')); });
  });
}

async function createSession() {
  var backend = $('new-backend').value || undefined;
  var data = await jpost('/api/sessions', { backend: backend });
  state.active = data.id;
  await refreshSessions();
  await selectSession(data.id);
}

async function selectSession(id) {
  state.active = id;
  stopLive();
  renderSessions();
  $('live-btn').disabled = false;
  await drawCapture();
  await jput('/api/config', { activeSessionId: id });
}

async function deleteSession(id) {
  await jreq('/api/sessions/' + id, 'DELETE');
  if (state.active === id) { state.active = null; stopLive(); clearViewport(); $('live-btn').disabled = true; }
  await refreshSessions();
}

function clearViewport() {
  var c = $('viewport'); var ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height); state.img = null; state.elements = [];
  $('el-list').innerHTML = ''; $('el-count').textContent = '';
}

async function drawCapture() {
  if (!state.active) return;
  var r = await fetch(API + '/api/sessions/' + state.active + '/capture');
  if (!r.ok) throw new Error('capture HTTP ' + r.status);
  var bmp = await createImageBitmap(await r.blob());
  state.img = bmp;
  var data = await jget('/api/sessions/' + state.active + '/elements');
  state.elements = data.elements || [];
  drawFrame(bmp.width, bmp.height);
  setStatus('session ' + state.active + ' · ' + state.elements.length + ' elements');
}

function drawFrame(w, h) {
  var c = $('viewport'); c.width = w; c.height = h;
  var ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (state.img) ctx.drawImage(state.img, 0, 0);
  ctx.font = 'bold 13px sans-serif'; ctx.lineWidth = 2;
  state.elements.forEach(function (e, i) {
    var b = e.bounds; if (!b) return;
    ctx.strokeStyle = '#1f6feb'; ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.fillStyle = '#1f6feb'; ctx.fillRect(b.x, Math.max(0, b.y - 17), 22, 17);
    ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), b.x + 4, Math.max(12, b.y - 4));
  });
  renderElements();
}

function renderElements() {
  $('el-count').textContent = '(' + state.elements.length + ')';
  var html = '';
  state.elements.forEach(function (e, i) {
    html += '<div class="el-row" data-i="' + i + '"><span class="n">' + (i + 1) + '</span>'
      + '<span><b>' + esc(e.role) + '</b> ' + esc(e.label) + '</span></div>';
  });
  var list = $('el-list'); list.innerHTML = html;
  Array.prototype.forEach.call(list.querySelectorAll('.el-row'), function (row) {
    row.addEventListener('click', function () {
      var e = state.elements[+row.getAttribute('data-i')]; if (!e || !e.bounds) return;
      var b = e.bounds;
      void jpost('/api/sessions/' + state.active + '/click', { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })
        .then(function () { if (!state.live) void drawCapture(); });
    });
  });
}

// canvas click → raw-coordinate click
$('viewport').addEventListener('click', function (e) {
  if (!state.active) return;
  var c = $('viewport'); var rect = c.getBoundingClientRect();
  var x = Math.round((e.clientX - rect.left) * (c.width / rect.width));
  var y = Math.round((e.clientY - rect.top) * (c.height / rect.height));
  void jpost('/api/sessions/' + state.active + '/click', { x: x, y: y }).then(function () {
    if (!state.live) void drawCapture();
  });
});

function toggleLive() { state.live ? stopLive() : startLive(); }
function startLive() {
  if (!state.active) return;
  state.live = true; $('live-btn').textContent = 'Stop live';
  state.es = new EventSource(API + '/api/sessions/' + state.active + '/stream');
  state.es.onmessage = function (ev) {
    var f = JSON.parse(ev.data);
    var bin = atob(f.png); var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    createImageBitmap(new Blob([bytes], { type: 'image/png' })).then(function (bmp) {
      state.img = bmp; state.elements = f.elements || []; drawFrame(f.width, f.height);
    });
  };
}
function stopLive() {
  if (state.es) { state.es.close(); state.es = null; }
  state.live = false; $('live-btn').textContent = 'Start live';
}

async function scrollAct(dir) {
  var c = $('viewport');
  await jpost('/api/sessions/' + state.active + '/scroll', { x: Math.round(c.width / 2), y: Math.round(c.height / 2), direction: dir });
  if (!state.live) await drawCapture();
}

$('connect').addEventListener('click', connect);
$('new-session').addEventListener('click', function () { void createSession().catch(function (e) { setStatus(e.message, 'err'); }); });
$('live-btn').addEventListener('click', toggleLive);
$('refresh').addEventListener('click', function () { void drawCapture().catch(function (e) { setStatus(e.message, 'err'); }); });
$('do-type').addEventListener('click', function () { void jpost('/api/sessions/' + state.active + '/type', { text: $('type-text').value }).then(function () { if (!state.live) drawCapture(); }); });
$('do-keypress').addEventListener('click', function () { void jpost('/api/sessions/' + state.active + '/keypress', { keys: $('keys').value }).then(function () { if (!state.live) drawCapture(); }); });
$('do-scroll-up').addEventListener('click', function () { void scrollAct('up'); });
$('do-scroll-down').addEventListener('click', function () { void scrollAct('down'); });
$('set-interval').addEventListener('click', function () { void jput('/api/config', { captureIntervalMs: +$('interval').value }).then(function () { setStatus('interval updated'); }); });

$('api-url').value = API;
void connect().catch(function (e) { setStatus('error: ' + e.message, 'err'); });
</script>
</body>
</html>`;
}
