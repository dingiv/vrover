# `vrover-pipewire` — `CaptureSource` via PipeWire ScreenCast

`CaptureSource` backend that grabs Wayland screen frames through the
**xdg-desktop-portal ScreenCast** API (`ashpd`) and streams them over **PipeWire**
(`pipewire`-rs). Decodes the mmap'd BGRx/BGRA buffer to a `Frame` (raw BGRA).

Behind the `pipewire` cargo feature (off by default). Without it the crate builds
as a `DriverError::NotBuilt` stub, so the workspace stays green without PipeWire
headers. See the top-level [`crates/README.md`](../README.md) for the workspace
overview and trait layout.

> **Verified working 2026-06-24** in the dev container: a full
> portal → PipeWire → mmap'd BGRx frame → PNG capture of the live desktop.
> The rest of this file is the **runtime-dependency / packaging** reference that
> fall-out produced — read it before shipping anything that uses this backend.

---

## TL;DR for packaging

Building this crate and **running** it are two different dependency sets. The
`-dev` packages are build-only. At **runtime** a binary linked against
`libpipewire` additionally needs, on the target system:

| need | Debian/Ubuntu package | provides |
|---|---|---|
| the shared lib you link | `libpipewire-0.3-0t64` | `libpipewire-0.3.so.0` |
| SPA plugins (converters, support) | `libspa-0.2-modules` | `/usr/lib/<arch>/spa-0.2/{audioconvert,videoconvert,support,…}` |
| PipeWire client **modules** | `libpipewire-0.3-modules` | `/usr/lib/<arch>/pipewire-0.3/libpipewire-module-*.so` |
| the **client.conf** runtime config | `pipewire` | `/usr/share/pipewire/client.conf` (+ `client.conf.avail/`) |
| a graphical session (env, not a pkg) | — | running `pipewire` daemon + `xdg-desktop-portal` + a backend |

The last two rows are the non-obvious ones and are what this backend will silently
fail on if missing. Details below.

---

## Build (compile-only)

```bash
sudo apt-get install -y libpipewire-0.3-dev libclang-dev clang pkg-config   # bindgen needs libclang
cargo build -p vrover-pipewire --features pipewire
```

- `libpipewire-0.3-dev` (1.4.x) supplies the headers + `pipewire-sys`/`spa-sys`
  bindgen inputs. Note libspa on this distro is **0.2** (`libspa-0.2.pc`,
  `/usr/include/spa-0.2/`), not 0.3 — the `pipewire`-rs crate handles this.
- `libclang-dev`/`clang` are for `bindgen` (FFI generation at build time only).

---

## Runtime requirements (the part that bit us)

A `libpipewire` client is **not self-contained**. `pw_context_new` parses a config
file, then `pw_stream_connect` lazy-loads SPA plugins + PipeWire modules to build
its node. If any of those are absent you get opaque errors at connect time.

### 1. The `client.conf` config file  ← most easily missed

`pw_context_new` reads **`client.conf`** (search order: `$PIPEWIRE_CONFIG_DIR` →
`~/.config/pipewire/` → `/etc/pipewire/` → `/usr/share/pipewire/`). That file maps
`spa-libs` (factory-name → `.so`) and, crucially, **`context.modules`** that get
loaded on context creation.

The `libpipewire-0.3-dev` and `libpipewire-0.3-common` packages do **not** ship
`client.conf` — only the **`pipewire`** (daemon) package does
(`/usr/share/pipewire/client.conf`). With nothing present:

```
can't load config client.conf: No such file or directory
→ pw Context::new: Creation failed
```

**Two packaging strategies** — pick one:

- **(a) Depend on the `pipewire` package** and let the system config be used.
  Simplest; pulls the daemon package (config files + `pipewire` binary; the daemon
  itself need not run inside your process — it's already running on the user's
  desktop). Recommended for `.deb`/system installs.

- **(b) Ship your own minimal `client.conf`** and point PipeWire at it via
  `PIPEWIRE_CONFIG_DIR=<dir>`. Avoids the `pipewire` daemon dependency; you then
  only need the three library/module packages. A working minimal file (the modules
  a capture stream actually needs):

  ```ini
  # minimal client.conf — ship next to the binary, export PIPEWIRE_CONFIG_DIR to its dir
  context.properties = { log.level = 0 }
  context.spa-libs = {
      audio.convert.* = audioconvert/libspa-audioconvert
      support.*       = support/libspa-support
      video.convert.* = videoconvert/libspa-videoconvert
  }
  context.modules = [
      { name = libpipewire-module-protocol-native }     # ESSENTIAL: wire protocol to connect
      { name = libpipewire-module-client-node }         # ESSENTIAL: create the stream node
      { name = libpipewire-module-adapter }             # ESSENTIAL: wrap the format converter
      { name = libpipewire-module-metadata }            # optional
      { name = libpipewire-module-session-manager }     # optional
      { name = libpipewire-module-rt, flags = [ ifexists nofail ] }   # optional (rt priority)
  ]
  ```

### 2. PipeWire client modules (`libpipewire-0.3-modules`)

`client.conf`'s `context.modules` `dlopen`s these from
`/usr/lib/<arch>/pipewire-0.3/`. For a capture stream the **essential** three are
`protocol-native`, `client-node`, `adapter` (see above). Without the package:

- no `protocol-native` → `connect_fd: Creation failed` (the daemon's native
  protocol is never registered, so `pw_context_connect_fd` can't build the core).
- no `adapter` → `pw_stream_connect(): no adapter factory found` /
  `can't make node: No such file or directory` (the stream can't wrap its
  converter node).

### 3. SPA plugins (`libspa-0.2-modules`)

`/usr/lib/<arch>/spa-0.2/` — the format converters the adapter uses:
`audioconvert/libspa-audioconvert`, `videoconvert/libspa-videoconvert`,
`support/libspa-support`. Mapped via `client.conf`'s `spa-libs`. Missing → the
adapter finds no converter factory.

### 4. A graphical session (environment, not a package)

The `ashpd` ScreenCast negotiation needs, on the user's machine:

- a running **PipeWire daemon** (`/run/user/<uid>/pipewire-0` socket), and
- **`xdg-desktop-portal` + a backend** (`-gnome` or `-gtk`) to surface the
  ScreenCast session. GNOME's backend hands back a PipeWire node id + fd, which we
  feed to `connect_fd`.

The portal **shows a "select what to share" dialog each run** because the backend
uses `PersistMode::DoNot`. To go dialog-free, drive
`org.gnome.Mutter.ScreenCast` over D-Bus directly (`CreateSession` →
`RecordMonitor` → PipeWire node id) instead of the portal — it needs no approval.

---

## Pitfalls, in the order they appear  (the "坑")

| # | error string | cause | fix |
|---|---|---|---|
| 1 | `can't load config client.conf: No such file or directory` / `Context::new: Creation failed` | no `client.conf` on the system | install `pipewire` pkg (→ `/usr/share/pipewire/client.conf`) **or** ship one + `PIPEWIRE_CONFIG_DIR` |
| 2 | `connect_fd: Creation failed` | `protocol-native` module not loaded (pkg missing or not in `client.conf`) | ensure `libpipewire-0.3-modules` installed and `client.conf` loads `libpipewire-module-protocol-native` |
| 3 | `stream.connect: EPROTO: Protocol error` | offered an **empty** format list — the node has nothing to negotiate | build a real SPA `EnumFormat` POD (BGRx/BGRA + size range); done in `src/backend.rs` |
| 4 | `pw_stream_connect(): no adapter factory found` / `can't make node: ENOENT` | `adapter` module not loaded | `client.conf` must load `libpipewire-module-adapter` |
| 5 | (latent) frames never decode, no error | node hands **DMA-BUF** buffers; only the mmap'd (`SPA_DATA_MemPtr`) path is handled | TODO(host): handle `SPA_DATA_DmaBuf`. Mutter gave memfd in the verified run, so this hasn't triggered yet |

Debug aid: set `PIPEWIRE_DEBUG=3` to get native libpipewire log lines on stderr
(errors 1–4 all surface there before the Rust side sees them).

---

## Run

```bash
# one frame → PNG (the portal will prompt; pick a monitor and approve)
cargo run -p vrover-pipewire --example capture_one --features pipewire -- /tmp/shot.png
```

The example (`examples/capture_one.rs`) negotiates the session, polls
`CaptureSource::capture()` for the first frame, and writes `Frame::to_png()` to the
path given. It's gated by `required-features = ["pipewire"]`, so it's skipped under
default features and `cargo test --workspace` stays green.

---

## Packaging checklist

- **`.deb` / system package** — `Depends:` at minimum
  `libpipewire-0.3-0t64, libspa-0.2-modules, libpipewire-0.3-modules, pipewire`.
  (Drop `pipewire` if you ship your own `client.conf` + set `PIPEWIRE_CONFIG_DIR`.)
- **Bundled (AppImage / container / static-ish)** — copy four things alongside the
  binary: `libpipewire-0.3.so.0`, the `spa-0.2/` plugin tree, the
  `pipewire-0.3/` module tree, and a `client.conf`; then export
  `PIPEWIRE_CONFIG_DIR` (and, if you relocate them, `PIPEWIRE_MODULE_DIR` /
  point `spa-libs` at the moved `spa-0.2/`).
- **napi/TS wiring (next round)** — when this is lifted into `NativeLayer`, the
  above runtime requirements move with it; the TS side changes nothing.
