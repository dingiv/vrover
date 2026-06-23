//! `vrover-uinput` — VRover [`InputSink`] backend via the Linux **uinput** kernel
//! virtual device.
//!
//! uinput is the most portable Linux input path: it creates a virtual keyboard +
//! mouse in `/dev/uinput` and emits raw evdev events, so it works regardless of
//! the compositor (Wayland or X11). It needs root or the `input`/`uinput` group.
//!
//! # Layout.
//! - [`keycode`]: the pure, always-compiled, unit-tested logical → Linux code map.
//! - With the `backend` feature (default off): [`UinputSink`] drives a real evdev
//!   `VirtualDevice`. Without it, [`UinputSink`] is a [`DriverError::NotBuilt`]
//!   stub so the workspace builds without pulling evdev.
//!
//! # Caveats.
//! - `type_text` covers only the ASCII subset that maps to a `KEY_*`; non-ASCII
//!   returns `NotSupported` (use the libei backend for arbitrary unicode).
//! - Absolute-pointer scaling to screen geometry is approximate without a screen
//!   size hint; pass one via [`UinputSink::with_screen`] (backend feature).
//! - Live injection needs `/dev/uinput` write access + a real session; this
//!   container can compile it but not run it (see `crates/README.md`).

pub mod keycode;

#[cfg(feature = "backend")]
mod backend;
#[cfg(not(feature = "backend"))]
mod stub;

#[cfg(feature = "backend")]
pub use backend::{UinputSink, UinputSinkBuilder};
#[cfg(not(feature = "backend"))]
pub use stub::{UinputSink, UinputSinkBuilder};
