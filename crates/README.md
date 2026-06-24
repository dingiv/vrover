# `crates/` — VRover native driver layer (Rust)

A Cargo workspace living alongside the pnpm TS monorepo (`packages/`, `apps/`).
The two coexist at the repo root: pnpm ignores `crates/`/`target/`, cargo ignores
`packages/`. This is the **real native capture + input layer** that will eventually
back the TS `NativeLayer` seam (`packages/platform/src/desktop.ts`) via a napi-rs
binding (next round). It supersedes the JS/Python explorations in `playground/nutjs`
and `playground/pyautogui`, which only wrap X11/Win32 and "can install but not run
in a headless container".

## Why capture and input are separate

Two independent traits, in the leaf crate [`drivers`](./drivers):

- **`CaptureSource`** — produce screen frames (`Frame`, raw BGRA).
- **`InputSink`** — inject mouse + keyboard events.

They are decoupled because on a **dual-machine / capture-card** setup the frame
*source* and the input *sink* target different devices: you might read a screen from
an HDMI capture card while sending input back over ADB or a USB HID gadget. A backend
implements one or both. This is why the four target platforms map cleanly:

| platform | capture (CaptureSource) | input (InputSink) |
|---|---|---|
| **Linux Wayland** (priority) | `pipewire` — xdg-desktop-portal ScreenCast | `uinput` (kernel virt. device), `libei` (portal emulated) |
| Windows (future) | DXGI Desktop Duplication / GDI | Win32 `SendInput` |
| capture card / dual-machine (future) | v4l2 video device | (separate return channel) |
| Android (future, dual-machine) | `adb exec-out screencap` | `adb shell input` |

## Crates

| crate | path | role | feature / target |
|---|---|---|---|
| **`vrover-drivers`** | [`drivers`](./drivers) | `CaptureSource` + `InputSink` traits, `Frame`/`Button`/`Key`/`DriverError`, test stubs. Pure leaf, **no platform deps** — always builds + tests. | — |
| **`vrover-pipewire`** | [`pipewire`](./pipewire) | `CaptureSource` via PipeWire ScreenCast (ashpd + pipewire-rs). | `pipewire` feature (off by default) |
| **`vrover-uinput`** | [`uinput`](./uinput) | `InputSink` via the uinput kernel virtual device (evdev). Keycode map always compiles + tests. | `backend` feature (off by default), Linux |
| **`vrover-libei`** | [`libei`](./libei) | `InputSink` via libei / xdg-desktop-portal emulated input. **Scaffold this round.** | `libei` feature (off by default) |

The three mechanism crates each implement **one** trait and depend only on
`vrover-drivers`. Mechanism crates are feature-gated so the workspace always builds
without their native deps; the `drivers` core is always green.

## Build & test

Toolchain + system libs (one-time; the dev container has passwordless `sudo`):

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
sh /tmp/rustup-init.sh -y --profile minimal
source "$HOME/.cargo/env"

# System libs. The first line is enough to *build* the pipewire backend; the
# second line is needed to *run* it (the modules supply protocol-native +
# adapter; the `pipewire` pkg supplies the runtime client.conf that loads them).
sudo apt-get install -y libpipewire-0.3-dev libclang-dev clang libdbus-1-dev pkg-config
sudo apt-get install -y libpipewire-0.3-modules pipewire
```

```bash
cargo build --workspace                 # core + all stubs (always green)
cargo test --workspace                  # pure-logic tests: Frame/PNG, key/Button maps, trait defaults
cargo build --workspace --all-features  # compile EVERY real backend (evdev + pipewire + ashpd)
cargo build -p vrover-uinput --features backend    # just the uinput backend
cargo build -p vrover-pipewire --features pipewire # just the pipewire backend
```

## Capturable desktop in this container (verified 2026-06-24)

The dev container is **not** headless: `.devcontainer/devcontainer.json` bind-mounts
the host's `/tmp/.X11-unix` and `/run/user/1000`, so the real GNOME/Wayland desktop
(`gnome-shell` + `Xwayland :0/:1`), the PipeWire socket (`pipewire-0`), the full
`xdg-desktop-portal` stack (+gnome, +gtk), and `org.gnome.Mutter.ScreenCast` are all
reachable from inside. So the **pipewire capture path is run-testable here now.**

```bash
cargo run -p vrover-pipewire --example capture_one --features pipewire -- /tmp/shot.png
```

`capture_one` negotiates an ashpd ScreenCast session, waits for the first PipeWire
frame, and writes it to PNG. **The portal pops a "select what to share" dialog on the
host desktop each run** (the backend uses `PersistMode::DoNot`) — approve it (pick the
monitor) and the PNG lands at the path you give. A verified capture produced a real
2560×1600 RGBA PNG of the live desktop.

**Runtime deps, the pitfalls hit, and a packaging checklist live in
[`pipewire/README.md`](./pipewire/README.md)** — building this backend and running
it are *different* dependency sets (you also need `libpipewire-0.3-modules` +
`client.conf` to run, not just `-dev` to build).

Two notes for future work:
- **No per-run dialog:** the dialog-free route is to drive
  `org.gnome.Mutter.ScreenCast` directly over D-Bus (`CreateSession` → `RecordMonitor`
  → PipeWire node id), bypassing the portal — proven callable with no dialog. The
  portal path could also be made non-interactive by switching to `PersistMode::Persistent`
  + reusing the restore token.
- **DMA-BUF still TODO:** Mutter handed an mmap'd (memfd) buffer here, so the current
  decoder path works. A hardware/DMA-BUF path would need `SPA_DATA_DmaBuf` handling.
  Multi-monitor stream selection (we take stream 0) and cursor-mode/restore-token knobs
  on `PipeWireSourceBuilder` remain open (search `TODO(host)`).

## Relationship to the TS side (next round)

The traits line up 1:1 with `NativeLayer` (`packages/platform/src/desktop.ts`):

| TS `NativeLayer` | Rust |
|---|---|
| `captureScreen()` → `Screenshot{png}` | `CaptureSource::capture()` + `Frame::to_png()` |
| `performClick/Type/Scroll/Keypress` | `InputSink` methods |

The next round adds a **napi-rs binding crate** that composes a `CaptureSource` +
`InputSink` into a `NativeLayer` and hands it to `DesktopPlatform`, so the TS agent
loop drives real capture/input with no other changes. Grounding
(`getAccessibilityElements` / AT-SPI) is a separate concern and stays out of this
layer.
