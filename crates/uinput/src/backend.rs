//! Real uinput backend (behind the `backend` feature). Drives an evdev
//! [`VirtualDevice`](evdev::uinput::VirtualDevice): a combined virtual keyboard +
//! absolute pointer + wheel. See crate docs for caveats (screen scaling, ASCII-only
//! `type_text`, root/`uinput` permission).

use std::io;

use evdev::{
    AbsInfo, AbsoluteAxisType, AttributeSet, EventType, InputEvent, Key as EvKey, RelativeAxisType,
    UinputAbsSetup, uinput::{VirtualDevice, VirtualDeviceBuilder},
};
use vrover_drivers::{Button, DriverError, InputSink, Key, Result};

use crate::keycode::{button_to_code, key_to_code};

/// Absolute coordinate space the device advertises for ABS_X/ABS_Y. Caller pixel
/// coords are scaled into `[0, COORD_MAX]` using the screen-size hint (or clamped
/// directly when no hint is given).
const COORD_MAX: i32 = 0xFFFF;

/// Builder for [`UinputSink`].
#[derive(Debug, Clone, Default)]
#[must_use]
pub struct UinputSinkBuilder {
    screen: Option<(u32, u32)>,
}

impl UinputSinkBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Screen size in pixels, used to scale absolute pointer coords into the
    /// device's coordinate space. Without it, coords are clamped to `[0, COORD_MAX]`
    /// and treated as already in that space.
    pub fn screen(mut self, width: u32, height: u32) -> Self {
        self.screen = Some((width, height));
        self
    }

    /// Create the virtual device (opens `/dev/uinput`).
    pub fn build(&self) -> Result<UinputSink> {
        UinputSink::open(self.screen)
    }
}

/// An [`InputSink`] backed by a Linux uinput virtual device.
pub struct UinputSink {
    dev: VirtualDevice,
    screen: Option<(u32, u32)>,
}

impl UinputSink {
    /// Open with no screen-size hint (coords clamped to the device space).
    pub fn new() -> Result<Self> {
        Self::open(None)
    }

    /// Open with a screen-size hint for absolute-pointer scaling.
    pub fn with_screen(width: u32, height: u32) -> Result<Self> {
        Self::open(Some((width, height)))
    }

    fn open(screen: Option<(u32, u32)>) -> Result<Self> {
        let mut keys = AttributeSet::<EvKey>::new();
        keys.insert(EvKey::BTN_LEFT);
        keys.insert(EvKey::BTN_RIGHT);
        keys.insert(EvKey::BTN_MIDDLE);
        for &code in emittable_key_codes() {
            keys.insert(EvKey::new(code));
        }

        let mut rel = AttributeSet::<RelativeAxisType>::new();
        rel.insert(RelativeAxisType::REL_WHEEL);
        rel.insert(RelativeAxisType::REL_HWHEEL);

        let abs_info = AbsInfo::new(0, 0, COORD_MAX, 0, 0, 0);
        let x_setup = UinputAbsSetup::new(AbsoluteAxisType::ABS_X, abs_info);
        let y_setup = UinputAbsSetup::new(AbsoluteAxisType::ABS_Y, abs_info);

        let dev = VirtualDeviceBuilder::new()?
            .name("VRover uinput sink")
            .with_keys(&keys)?
            .with_absolute_axis(&x_setup)?
            .with_absolute_axis(&y_setup)?
            .with_relative_axes(&rel)?
            .build()?;

        Ok(Self { dev, screen })
    }

    /// Scale absolute pixel coords into the device coordinate space.
    fn scale(&self, x: i32, y: i32) -> (i32, i32) {
        match self.screen {
            Some((w, h)) => (scale_axis(x, w), scale_axis(y, h)),
            None => (x.clamp(0, COORD_MAX), y.clamp(0, COORD_MAX)),
        }
    }

    /// Move the pointer (EV_ABS) without a button event.
    fn move_pointer(&mut self, x: i32, y: i32) -> Result<()> {
        let (sx, sy) = self.scale(x, y);
        self.dev
            .emit(&[
                InputEvent::new(EventType::ABSOLUTE, AbsoluteAxisType::ABS_X.0, sx),
                InputEvent::new(EventType::ABSOLUTE, AbsoluteAxisType::ABS_Y.0, sy),
            ])
            .map_err(driver_io)
    }

    fn send_button(&mut self, button: Button, pressed: bool) -> Result<()> {
        let code = button_to_code(button).ok_or(()).map_err(|_| not_supported(button_desc(button)))?;
        self.dev
            .emit(&[InputEvent::new(EventType::KEY, code, i32::from(pressed))])
            .map_err(driver_io)
    }

    fn send_key(&mut self, key: Key, pressed: bool) -> Result<()> {
        let code = key_to_code(key).ok_or(()).map_err(|_| not_supported(key_desc(key)))?;
        self.dev
            .emit(&[InputEvent::new(EventType::KEY, code, i32::from(pressed))])
            .map_err(driver_io)
    }
}

impl InputSink for UinputSink {
    fn move_to(&mut self, x: i32, y: i32) -> Result<()> {
        self.move_pointer(x, y)
    }

    fn press(&mut self, x: i32, y: i32, button: Button) -> Result<()> {
        self.move_pointer(x, y)?;
        self.send_button(button, true)
    }

    fn release(&mut self, button: Button) -> Result<()> {
        self.send_button(button, false)
    }

    fn scroll(&mut self, x: i32, y: i32, dx: i32, dy: i32) -> Result<()> {
        self.move_pointer(x, y)?;
        let mut events = Vec::with_capacity(2);
        if dx != 0 {
            events.push(InputEvent::new(EventType::RELATIVE, RelativeAxisType::REL_HWHEEL.0, dx));
        }
        if dy != 0 {
            events.push(InputEvent::new(EventType::RELATIVE, RelativeAxisType::REL_WHEEL.0, dy));
        }
        if events.is_empty() {
            return Ok(());
        }
        self.dev.emit(&events).map_err(driver_io)
    }

    fn key_press(&mut self, key: Key) -> Result<()> {
        self.send_key(key, true)
    }

    fn key_release(&mut self, key: Key) -> Result<()> {
        self.send_key(key, false)
    }

    fn type_text(&mut self, text: &str) -> Result<()> {
        for ch in text.chars() {
            if ch.is_ascii_uppercase() {
                // Shift + lowercase-letter key, then release shift.
                let lower = Key::Char(ch.to_ascii_lowercase());
                self.emit_single(EventType::KEY, crate::keycode::KEY_LEFTSHIFT, 1)?;
                self.send_key(lower, true)?;
                self.send_key(lower, false)?;
                self.emit_single(EventType::KEY, crate::keycode::KEY_LEFTSHIFT, 0)?;
            } else {
                let code = key_to_code(Key::Char(ch)).ok_or(()).map_err(|_| {
                    not_supported(format!("uinput cannot type character {ch:?} (non-ASCII/symbol)"))
                })?;
                self.emit_single(EventType::KEY, code, 1)?;
                self.emit_single(EventType::KEY, code, 0)?;
            }
        }
        Ok(())
    }
}

impl UinputSink {
    fn emit_single(&mut self, ty: EventType, code: u16, value: i32) -> Result<()> {
        self.dev
            .emit(&[InputEvent::new(ty, code, value)])
            .map_err(driver_io)
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn scale_axis(v: i32, extent: u32) -> i32 {
    if extent == 0 {
        return 0;
    }
    (v.clamp(0, extent as i32) * COORD_MAX / extent as i32).clamp(0, COORD_MAX)
}

fn driver_io(err: io::Error) -> DriverError {
    DriverError::Io(err)
}

fn not_supported<S: Into<String>>(what: S) -> DriverError {
    DriverError::NotSupported(what.into())
}

fn button_desc(b: Button) -> String {
    format!("button {b:?} has no uinput BTN_* code")
}

fn key_desc(k: Key) -> String {
    format!("key {k:?} has no uinput KEY_* code")
}

/// The set of Linux `KEY_*` codes our logical [`Key`] can produce, so the device
/// advertises exactly what it can emit.
fn emittable_key_codes() -> &'static [u16] {
    use crate::keycode::*;
    &[
        KEY_ENTER, KEY_BACKSPACE, KEY_TAB, KEY_ESC, KEY_SPACE, KEY_INSERT, KEY_DELETE, KEY_HOME,
        KEY_END, KEY_PAGEUP, KEY_PAGEDOWN, KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_LEFTSHIFT,
        KEY_RIGHTSHIFT, KEY_LEFTCTRL, KEY_RIGHTCTRL, KEY_LEFTALT, KEY_RIGHTALT, KEY_LEFTMETA,
        KEY_RIGHTMETA,
        // F1..F10 (59..68), F11 (87), F12 (88).
        59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88,
        // letters (QWERTY scan-code order) + digits.
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 36, 37, 38, 44, 45, 46, 47,
        48, 49, 50, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]
}
