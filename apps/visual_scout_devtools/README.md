# @vrover/visual-scout-devtools

The **browser DevTools UI** for the Visual Scout server. A self-contained web page that drives
scout's in-process **devtools service** (HTTP/SSE) — inspect sessions, render the screenshot with a
Set-of-Mark overlay, drive actions, and configure server state. Browsers can't speak scout's raw TCP
protocol, so the scout process bridges: **browser ⇄ HTTP/SSE ⇄ scout devtools service ⇄ Session.dispatch**.

## Run

```bash
# 1. start scout with the devtools service on an extra port
pnpm scout:app -- --devtools-port 7881

# 2. serve the devtools UI
pnpm devtools                                              # http://127.0.0.1:9090  →  api 127.0.0.1:7881
pnpm devtools -- --api http://127.0.0.1:7881 --port 9090
```

Open the printed URL. No API key is needed — the devtools drives scout backends directly.

### Options

| Flag | Default | Notes |
|---|---|---|
| `--api <url>` | `$SCOUT_DEVTOOLS_API` or `http://127.0.0.1:7881` | Scout devtools API URL |
| `--host <host>` | `127.0.0.1` | UI bind host |
| `--port <port>` | `9090` | UI bind port (`0` = OS-assigned) |
| `-h, --help` | | Show usage |

### What the UI does

- **Sessions** — list (incl. live TCP-client sessions, so you can watch the brain drive a backend), create (pick a backend), select, delete.
- **Viewport** — the captured screenshot on a `<canvas>` with numbered SoM boxes; click the canvas to send a raw-coordinate click, or click an element in the list to click its center.
- **Actions** — type / keypress / scroll / refresh.
- **Live** — an `EventSource` on `/api/sessions/:id/stream` streams frames in real time.
- **Config** — GET/PUT `/api/config` (SSE capture interval, active session) — the "configure server state" surface.

### Scout devtools HTTP/SSE API (`/api`)

`GET /api/health` · `GET|POST /api/sessions` · `DELETE /api/sessions/:id` ·
`GET /api/sessions/:id/capture` (image/png) · `GET /api/sessions/:id/elements` ·
`POST /api/sessions/:id/{click|type|scroll|keypress}` · `GET /api/sessions/:id/stream` (SSE) ·
`GET|PUT /api/config`. Permissive CORS is enabled so a browser at another origin can call it.
