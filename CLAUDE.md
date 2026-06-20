# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a pnpm monorepo (Node ≥20, pnpm v11). Dev uses `tsx` + `vitest`, which read TS directly — **no build step is needed to run or test**.

```bash
pnpm install              # link workspace packages (local only; no new external deps)
pnpm typecheck            # tsc --noEmit over the whole graph
pnpm test                 # vitest run (all tests, no API key needed)
pnpm test:watch           # vitest watch
pnpm build                # tsc --build (project references) → emits each package's dist/

# Run a subset of tests:
pnpm test -- test/scout-server.test.ts          # one file (pnpm forwards args to vitest)
pnpm exec vitest run -t "handshakes a new client"  # by test name
```

Runnable entry points (all via `tsx`, so `pnpm <script>`):
- Examples (thin demos, env-var configured): `pnpm dev`, `pnpm scout`, `pnpm scout:run`, `pnpm scout:client`.
- Standalone apps (CLI-arg configured, see `apps/`): `pnpm scout:app`, `pnpm rover:app`, `pnpm rover:cli`, `pnpm devtools`. Pass args with `pnpm <script> -- <args>` (e.g. `pnpm scout:app -- --port 9000`).

API keys: only the real LLM path needs `ANTHROPIC_API_KEY` (copy `.env.example` → `.env`). The Scout server, the apps' boot, and all tests run **without** a key.

## Architecture

VRover is a visual GUI agent built around an **observe → think → act** loop where the model references UI elements by **Set-of-Mark number, never raw coordinates** (the tool executor resolves mark → element bounds → center → `Platform` primitive).

**Two-component split (`docs/decisions.md` D10) — the central architectural fact:**
- **VRover (the brain)** — `@vrover/agent` (the loop) + `@vrover/llm` (Anthropic adapter). Plans, calls the multimodal LLM, acts.
- **Visual Scout (the "fat tool")** — `@vrover/scout` (+ `-protocol`/`-client`) + `@vrover/platform` + `@vrover/som`. A standalone process that owns the real UI target.

The brain never touches the OS directly. It drives Scout over a **custom binary TCP protocol** via `RemotePlatform` (a thin adapter over the `@vrover/scout-client` SDK). The existing `runAgent`/SoM/tools are identical whether the platform is in-process (`MockPlatform`) or remote (`RemotePlatform`) — swapping the `Platform` is the only change.

**Scout protocol** (`@vrover/scout-protocol`): 12-byte big-endian header `[magic 'SC'][ver][type][id u32][len u32]` + JSON or raw-BLOB payload. A client sends `HAND_SHAKE` first; the server mints a per-connection **session**, each with its own `Platform` backend (capture + keyboard/mouse), and replies `HAND_SHAKE_ACK`. Screenshots cross the wire as raw PNG BLOBs (no base64). `UiElement`/`Bounds` are JSON-serializable and pass through as-is.

**Scout devtools service** (`@vrover/scout` `devtools.ts`; opt-in via `startScoutServer({devtoolsPort})` or `scout:app -- --devtools-port`): a second, **browser-friendly HTTP+SSE** port on the scout process. Browsers can't speak the raw TCP protocol, so this service is **in-process** — it builds plain `Request` objects and calls `Session.dispatch` (the *identical* path TCP clients take; captures decoded via `decodeCaptureBlob`), exposing REST (`/api/sessions`, `/:id/capture` (image/png), `/elements`, `/click|type|scroll|keypress`, `/config`) + SSE (`/:id/stream`) with permissive CORS. The web UI is `apps/visual_scout_devtools` (`pnpm devtools`). The TCP protocol stays untouched — devtools is an additive control plane sharing the session registry.

**Package dependency graph (acyclic):**
```
@vrover/scout-protocol (leaf)  ← { scout-client, platform }
platform                        ← { som, tools, scout, agent }
@vrover/agent                   ← consumes scout-client (the project's ONLY internal consumer of the standalone SDK, keeping it third-party-independent)
@vrover/llm (leaf)
apps/{visual_scout,visual_rover,visual_scout_devtools}  ← consumers (apps, not libraries; the devtools app has no @vrover deps — pure HTTP client)
```

**Key seams (where to plug things in):**
- `Platform` (`@vrover/platform`) — adding a target (desktop/browser) = adding one implementation. `DesktopPlatform` is a reserved Rust (napi-rs) stub that throws until a `NativeLayer` is supplied.
- `CompleteFn` (`@vrover/llm`) — the single LLM exit point, dependency-injected into the loop. A new provider = a sibling module exporting a same-signature function. Tests inject a scripted fake LLM (see `scriptedComplete` in `test/scout-loop.test.ts`) — this is how the whole loop runs key-free.
- `GroundingSource` (`@vrover/platform`) — reserved seam for element detection (accessibility tree / CV+OCR / ML vision); today `Platform.getElements` stands in for it.

**Authoritative docs (in Chinese, "代码为准" = code is source of truth):** `docs/architecture.md` (as-built), `docs/design.md` (long-term vision: UI-graph walker), `docs/decisions.md` (open decisions D1–D11), `docs/scout-server.md` (Scout protocol/server), `docs/som.md`. The graph-walker/graph-map (`Walker`/`GraphMap` in `@vrover/scout`) are deliberate empty placeholders pending D1/D2.

## Conventions & gotchas

- **ESM + NodeNext:** every relative import needs a `.js` extension (e.g. `import { runAgent } from './loop.js'`), even for `.ts` files. tsx/vitest resolve these to the TS source.
- **Source-resolving exports:** each `packages/*` has `exports["."] → ./src/index.ts`, so consumers import TS directly in dev. `pnpm build` emits `dist/` via composite project references. Do not change a package's `exports` to point at `dist` — that breaks the no-build dev loop.
- **`noUncheckedIndexedAccess` is ON** (`tsconfig.base.json`): `record[key]` is typed `T | undefined`. Narrow with a truthiness check or use `!`.
- **Composite project references:** every `packages/*` and `apps/*` `tsconfig.json` is `composite` with `references` to its direct `@vrover/*` deps, and must be listed in `tsconfig.build.json`. Both live one level under the root (`packages/<pkg>/`, `apps/<app>/`), so their `extends` and `references` paths use `../../`.
- **pnpm forwards a literal `--`:** `pnpm <script> -- <args>` passes `--` *and* the args to the script, so CLI entry points that use `node:util` `parseArgs` must strip a leading `--` before parsing (see `forwardedArgs()` in the apps' `main.ts`).
- **`loadConfig()` (`@vrover/llm`) throws if `ANTHROPIC_API_KEY` is unset** and caches on first call. Call it lazily (only on the real-LLM path), never at server boot — the Scout server and the rover app must boot key-free.
- **Apps under `apps/*` are workspace packages**, not examples: they get their own `package.json` declaring `@vrover/*` deps and follow the same composite-tsconfig convention as `packages/*`.
