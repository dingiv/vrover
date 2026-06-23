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

# System libs only needed to build the pipewire backend
sudo apt-get install -y libpipewire-0.3-dev libclang-dev clang libdbus-1-dev pkg-config
```

```bash
cargo build --workspace                 # core + all stubs (always green)
cargo test --workspace                  # pure-logic tests: Frame/PNG, key/Button maps, trait defaults
cargo build --workspace --all-features  # compile EVERY real backend (evdev + pipewire + ashpd)
cargo build -p vrover-uinput --features backend    # just the uinput backend
cargo build -p vrover-pipewire --features pipewire # just the pipewire backend
```

## ⚠️ Headless-container caveat (read this)

This dev container has **no capturable Wayland desktop** — its `WAYLAND_DISPLAY`
socket is VS Code's own rendering, not a target desktop. So the live paths can be
**compiled and unit-tested here, but not run-tested**:

- `pipewire` capture needs a real graphical session + a running `xdg-desktop-portal`.
- `uinput` injection needs `/dev/uinput` write access (root / `uinput` group) and a
  real session to inject into.
- `libei` is not even packaged here.

### Validating on a real Wayland host

```bash
sudo apt-get install -y libpipewire-0.3-dev libclang-dev clang pkg-config \
                        xdg-desktop-portal libei-dev   # if/when available
cargo build -p vrover-pipewire --features pipewire
# A tiny example harness (TODO) that calls PipeWireSource::new() then capture()
# in a loop, writing PNGs. The portal will prompt to pick a screen.
```

Known gaps in `pipewire` to close on a real host (search the source for
`TODO(host)`): explicit SPA format-POD negotiation, DMA-BUF / hardware-locked
buffers, multi-monitor stream selection, cursor-mode / restore-token knobs.

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
