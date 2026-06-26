//! Pure-logic mapping from VRover's logical [`Key`]/[`Button`] to Linux
//! `input-event-codes.h` constants (`KEY_*` / `BTN_*`). Always compiled + unit
//! tested — it is the testable core of this crate; the evdev device glue that
//! *sends* these codes lives in [`crate::backend`] behind the `backend` feature.
//!
//! Values are the raw u16 event codes from `linux/input-event-codes.h`. Duplicating
//! them here (rather than depending on a codes crate) keeps the mapping testable
//! without pulling native deps.

use crate::{Button, Key};

// ── named keys ──────────────────────────────────────────────────────────────
pub const KEY_ENTER: u16 = 28;
pub const KEY_BACKSPACE: u16 = 14;
pub const KEY_TAB: u16 = 15;
pub const KEY_ESC: u16 = 1;
pub const KEY_SPACE: u16 = 57;
pub const KEY_INSERT: u16 = 110;
pub const KEY_DELETE: u16 = 111;
pub const KEY_HOME: u16 = 102;
pub const KEY_END: u16 = 107;
pub const KEY_PAGEUP: u16 = 104;
pub const KEY_PAGEDOWN: u16 = 109;
pub const KEY_LEFT: u16 = 105;
pub const KEY_RIGHT: u16 = 106;
pub const KEY_UP: u16 = 103;
pub const KEY_DOWN: u16 = 108;
pub const KEY_LEFTSHIFT: u16 = 42;
pub const KEY_RIGHTSHIFT: u16 = 54;
pub const KEY_LEFTCTRL: u16 = 29;
pub const KEY_RIGHTCTRL: u16 = 97;
pub const KEY_LEFTALT: u16 = 56;
pub const KEY_RIGHTALT: u16 = 100;
pub const KEY_LEFTMETA: u16 = 125;
pub const KEY_RIGHTMETA: u16 = 126;

// F1..F10 = 59..68 (58 + n); F11 = 87, F12 = 88 (NUMLOCK/SCROLLLOCK sit at 69/70).
pub const KEY_F1: u16 = 59;
pub const KEY_F10: u16 = 68;
pub const KEY_F11: u16 = 87;
pub const KEY_F12: u16 = 88;

// ── mouse buttons (BTN_*) ────────────────────────────────────────────────────
pub const BTN_LEFT: u16 = 0x110;
pub const BTN_RIGHT: u16 = 0x111;
pub const BTN_MIDDLE: u16 = 0x112;

/// Map a logical [`Key`] to its Linux `KEY_*` code, if the backend can emit it.
///
/// Letters/digits ignore case at the code level: uppercase is produced by the
/// caller holding a Shift modifier, not by a different code (true to evdev). Any
/// character that has no `KEY_*` (symbols, non-ASCII) maps to `None` — the uinput
/// backend then reports `NotSupported` for it (use libei for arbitrary unicode).
pub fn key_to_code(key: Key) -> Option<u16> {
    match key {
        Key::Char(c) => char_to_code(c),
        Key::Enter => Some(KEY_ENTER),
        Key::Backspace => Some(KEY_BACKSPACE),
        Key::Tab => Some(KEY_TAB),
        Key::Escape => Some(KEY_ESC),
        Key::Space => Some(KEY_SPACE),
        Key::Insert => Some(KEY_INSERT),
        Key::Delete => Some(KEY_DELETE),
        Key::Home => Some(KEY_HOME),
        Key::End => Some(KEY_END),
        Key::PageUp => Some(KEY_PAGEUP),
        Key::PageDown => Some(KEY_PAGEDOWN),
        Key::Left => Some(KEY_LEFT),
        Key::Right => Some(KEY_RIGHT),
        Key::Up => Some(KEY_UP),
        Key::Down => Some(KEY_DOWN),
        Key::LeftShift => Some(KEY_LEFTSHIFT),
        Key::RightShift => Some(KEY_RIGHTSHIFT),
        Key::LeftControl => Some(KEY_LEFTCTRL),
        Key::RightControl => Some(KEY_RIGHTCTRL),
        Key::LeftAlt => Some(KEY_LEFTALT),
        Key::RightAlt => Some(KEY_RIGHTALT),
        Key::LeftSuper => Some(KEY_LEFTMETA),
        Key::RightSuper => Some(KEY_RIGHTMETA),
        Key::F(n) => match n {
            1..=10 => Some(KEY_F1 - 1 + n as u16),
            11 => Some(KEY_F11),
            12 => Some(KEY_F12),
            _ => None,
        },
    }
}

/// Map a [`Button`] to its Linux `BTN_*` code.
pub fn button_to_code(button: Button) -> Option<u16> {
    match button {
        Button::Left => Some(BTN_LEFT),
        Button::Right => Some(BTN_RIGHT),
        Button::Middle => Some(BTN_MIDDLE),
        // uinput back/forward slots would be BTN_SIDE/BTN_EXTRA; left as future.
        Button::Other(_) => None,
    }
}

/// ASCII printable → `KEY_*`. Letters (both cases) → letter scan codes; digits →
/// digit codes; space; everything else (symbols, non-ASCII) → `None`.
fn char_to_code(c: char) -> Option<u16> {
    if c.is_ascii_alphabetic() {
        // a-z map to scan codes in QWERTY order (input-event-codes.h).
        Some(match c.to_ascii_lowercase() {
            'a' => 30,
            'b' => 48,
            'c' => 46,
            'd' => 32,
            'e' => 18,
            'f' => 33,
            'g' => 34,
            'h' => 35,
            'i' => 23,
            'j' => 36,
            'k' => 37,
            'l' => 38,
            'm' => 50,
            'n' => 49,
            'o' => 24,
            'p' => 25,
            'q' => 16,
            'r' => 19,
            's' => 31,
            't' => 20,
            'u' => 22,
            'v' => 47,
            'w' => 17,
            'x' => 45,
            'y' => 21,
            'z' => 44,
            _ => return None,
        })
    } else if c.is_ascii_digit() {
        // '1'..='9' → 2..=10; '0' → 11.
        Some(match c {
            '0' => 11,
            d => 1 + (d as u16 - b'0' as u16),
        })
    } else if c == ' ' {
        Some(KEY_SPACE)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_map_to_canonical_codes() {
        assert_eq!(key_to_code(Key::Enter), Some(KEY_ENTER));
        assert_eq!(key_to_code(Key::Space), Some(57));
        assert_eq!(key_to_code(Key::LeftControl), Some(29));
        assert_eq!(key_to_code(Key::LeftSuper), Some(125));
    }

    #[test]
    fn function_keys_are_58_plus_n() {
        assert_eq!(key_to_code(Key::F(1)), Some(59));
        assert_eq!(key_to_code(Key::F(12)), Some(88));
        assert_eq!(key_to_code(Key::F(0)), None);
        assert_eq!(key_to_code(Key::F(13)), None);
    }

    #[test]
    fn letters_map_case_insensitively() {
        assert_eq!(key_to_code(Key::Char('a')), Some(30));
        assert_eq!(key_to_code(Key::Char('A')), Some(30)); // case lost at code level
        assert_eq!(key_to_code(Key::Char('Q')), Some(16));
        assert_eq!(key_to_code(Key::Char('z')), Some(44));
    }

    #[test]
    fn digits_and_space_map() {
        assert_eq!(key_to_code(Key::Char('1')), Some(2));
        assert_eq!(key_to_code(Key::Char('9')), Some(10));
        assert_eq!(key_to_code(Key::Char('0')), Some(11));
    }

    #[test]
    fn unmappables_return_none() {
        assert_eq!(key_to_code(Key::Char('!')), None); // symbol
        assert_eq!(key_to_code(Key::Char('中')), None); // non-ASCII
        assert_eq!(key_to_code(Key::Char('\n')), None);
    }

    #[test]
    fn buttons_map() {
        assert_eq!(button_to_code(Button::Left), Some(0x110));
        assert_eq!(button_to_code(Button::Right), Some(0x111));
        assert_eq!(button_to_code(Button::Middle), Some(0x112));
        assert_eq!(button_to_code(Button::Other(4)), None);
    }
}
