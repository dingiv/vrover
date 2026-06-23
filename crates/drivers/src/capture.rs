//! [`CaptureSource`] — the screen-capture half of the driver layer.

use crate::error::Result;
use crate::frame::Frame;

/// A source of screen frames.
///
/// Implementations: PipeWire ScreenCast (Wayland), DXGI Desktop Duplication
/// (Windows, future), v4l2 / capture card (future), `adb screencap` (Android,
/// future). Independent from [`crate::InputSink`]: a dual-machine setup may pair a
/// capture-card [`CaptureSource`] with a separate (network/HID) [`crate::InputSink`].
pub trait CaptureSource {
    /// Geometry of the source if known before the first capture; `None` if it is
    /// only discoverable by capturing (e.g. a PipeWire stream whose size arrives
    /// with the first buffer).
    fn size(&self) -> Option<(u32, u32)> {
        None
    }

    /// Grab the current frame as raw BGRA + dimensions.
    fn capture(&mut self) -> Result<Frame>;
}
