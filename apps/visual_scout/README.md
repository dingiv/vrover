# @vrover/visual-scout

The standalone **Visual Scout server** — runs the UI-operation + grounding service (`@vrover/scout`)
as its own process. Each connecting client handshakes and gets an isolated session with its own
backend terminal (a `Platform` = screen capture + keyboard/mouse). Needs **no API key**: it only
exposes UI operations over the custom TCP protocol. See [`docs/scout-server.md`](../../docs/scout-server.md).

## Run

```bash
pnpm scout:app                                  # defaults: multi-screen backend on 127.0.0.1:7878
pnpm scout:app -- --host 0.0.0.0 --port 9000    # bind publicly on 9000
pnpm scout:app -- --backend mock                # single-screen mock backend
pnpm scout:app -- --help                        # usage
```

### Options

| Flag | Default | Notes |
|---|---|---|
| `--host <host>` | `$SCOUT_HOST` or `127.0.0.1` | Bind host |
| `--port <port>` | `$SCOUT_PORT` or `7878` | Bind port; `0` = OS-assigned |
| `--backend <name>` | `multi-screen` | `multi-screen` \| `mock` \| `desktop` |
| `-h, --help` | | Show usage |

### Backends

- `multi-screen` (default) — in-memory two-screen app (login → home).
- `mock` — single-screen in-memory mock.
- `desktop` — reserved Rust seam; fails fast until the napi-rs native module is built.

A client may also hint a backend in its handshake (`backend` field); when it names a known
backend it overrides the CLI default for that session.
