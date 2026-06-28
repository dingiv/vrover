# @vrover/visual-rover-web

The **web frontend** for the VRover GUI agent (the "brain"): a React SPA served by a single
**koa** server that also owns the API. The agent loop runs self-contained against an in-memory
`MockPlatform` (no Visual Scout server, no `/dev/uinput`).

## How it works

One koa process, one port, two jobs:

- **API** — `POST /api/run { task }` → `{ result, log }` runs one agent loop; `GET /api/health` is a liveness probe.
- **SPA** — in **dev** (`NODE_ENV != production`) koa mounts Vite's dev middleware (HMR); in **prod** it serves the built `web-dist/` statically with an SPA fallback.

The **server** dev/prod switch is `NODE_ENV`. The **client** (the React app) distinguishes the two
via Vite's `import.meta.env.DEV` / `.MODE` — Vite statically replaces these at build time, so only
client code can read them; `NODE_ENV` is the one switch both sides honour.

## Usage

```bash
pnpm rover:web          # dev: koa + Vite middleware + HMR, http://127.0.0.1:8080
pnpm rover:web:build    # vite build → web-dist/
pnpm rover:web:start    # prod: koa serves web-dist/ + API
```

Flags: `--host`, `--port`, `--max-steps` (see `--help`). The CLI frontend is `@vrover/visual-rover-cli`.
