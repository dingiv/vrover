//! Feature-gated platform backends for the driver traits.
//!
//! Each backend is gated by a cargo feature (off by default), so this crate
//! builds + tests with no native system libraries. With its feature off, a
//! backend compiles as a [`DriverError::NotBuilt`](crate::DriverError) stub;
//! with it on, the real backend links its native deps.
//!
//! | backend | trait | feature | native deps |
//! |---|---|---|---|
//! | [`pipewire`] | [`CaptureSource`](crate::CaptureSource) | `pipewire` | libpipewire + xdg-desktop-portal |
//! | [`uinput`] | [`InputSink`](crate::InputSink) | `uinput` | evdev (`/dev/uinput`) |
//! | [`libei`] | [`InputSink`](crate::InputSink) | `libei` | libei (not packaged; stub) |
//!
//! These used to be three standalone crates (`vrover-pipewire` / `-uinput` /
//! `-libei`); they are one crate now — a backend is just a feature-gated module.

pub mod libei;
pub mod pipewire;
pub mod uinput;
