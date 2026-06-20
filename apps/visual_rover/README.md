# @vrover/visual-rover

The standalone **VRover GUI agent** (the "brain"). Runs as a server exposing the **agent
service** over HTTP, with two provisional frontends: a one-shot **CLI** and a **web** UI. The brain
drives a remote Visual Scout server over the custom TCP protocol (`RemotePlatform`) and uses a
multimodal LLM (Anthropic) to think.

## Run

First start a Visual Scout server (it owns the UI target):

```bash
pnpm scout:app                      # 127.0.0.1:7878
```

Then run the agent:

```bash
pnpm rover:app                                                       # serve (web UI + agent service) on :8080
pnpm rover:app -- --mode cli --task "log in as admin / hunter2"      # one-shot CLI, then exit
echo "log in" | pnpm rover:app -- --mode cli                         # task piped on stdin
pnpm rover:app -- --help                                             # usage
```

The real LLM path needs `ANTHROPIC_API_KEY` (copy `.env.example` → `.env`). The server boots
without it; the key is only checked when a task runs.

### Options

| Flag | Default | Notes |
|---|---|---|
| `--mode <mode>` | `serve` | `cli` (one-shot, then exit) or `serve` (web server) |
| `--scout-host <host>` | `$SCOUT_HOST` or `127.0.0.1` | Visual Scout host |
| `--scout-port <port>` | `$SCOUT_PORT` or `7878` | Visual Scout port |
| `--task <text>` | | Task (cli mode; else stdin/prompt) |
| `--max-steps <n>` | `15` | Max agent steps |
| `--web-host <host>` | `127.0.0.1` | Web server host (serve mode) |
| `--web-port <port>` | `8080` | Web server port (serve mode; `0` = OS-assigned) |
| `-h, --help` | | Show usage |

### HTTP API (serve mode)

- `GET /` — the web UI.
- `POST /api/run` — `{ "task": string }` → `{ result: TaskResult, log: string[] }`.
- `GET /health` — `{ ok: true, scout: { host, port } }`.

The task runs synchronously and the full progress log is returned with the result. Streaming
progress (SSE) and per-step screenshots are future enhancements.
