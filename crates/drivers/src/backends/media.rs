//! `media` backend — file-backed **mock** capture + audio (no hardware, no portal).
//!
//! Spawns `ffmpeg` to decode a media file into raw BGRA frames (video) and
//! 16 kHz mono S16LE PCM (audio), served through the same [`CaptureSource`] /
//! [`AudioSource`] traits as the real PipeWire backends. This lets the daemon /
//! agent run end-to-end on canned A/V with **no screen-share prompt and no mic**.
//!
//! The only runtime dependency is the `ffmpeg` (+ `ffprobe`) binary on `PATH`;
//! there is no native Rust linking, so this module is compiled unconditionally
//! (no cargo feature). If `ffmpeg` is absent or the file has no usable track,
//! the source reports a fatal error rather than spinning.
//!
//! # Pacing + looping
//! Both pipes use `-stream_loop -1` (seamless infinite loop) and `-re` so ffmpeg
//! itself paces output to the file's native framerate / the audio realtime rate.
//! The worker threads drain continuously while active and **stop when set
//! inactive** — ffmpeg then backpressures (its pipe fills, it blocks) so an idle
//! mock costs ~zero CPU, mirroring the real source's idle-pause.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::audio::{AudioFormat, AudioSource, AudioSubscription};
use crate::capture::CaptureSource;
use crate::error::{DriverError, Result};
use crate::frame::Frame;

/// Bytes read per audio fan-out tick (~128 ms of 16 kHz mono S16LE).
const AUDIO_CHUNK: usize = 4096;
/// Per-subscriber chunk backlog (bounded mpsc capacity).
const SUBSCRIBER_BUF: usize = 64;
/// Park cadence while inactive (between checking `active`/`stop`).
const POLL_INACTIVE: Duration = Duration::from_millis(50);

static NEXT_SUB: AtomicU64 = AtomicU64::new(1);

/// `(width, height, fps)` probed from the file's first video stream.
fn probe_video(path: &str) -> Result<(u32, u32, u32)> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
            path,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| DriverError::Session(format!("ffprobe spawn: {e}")))?;
    if !out.status.success() {
        return Err(DriverError::Session(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let line = String::from_utf8_lossy(&out.stdout);
    let parts: Vec<&str> = line.trim().split(',').collect();
    if parts.len() < 3 {
        return Err(DriverError::Session(format!(
            "ffprobe: no video stream in {path} ({line})"
        )));
    }
    let w: u32 = parts[0]
        .parse()
        .map_err(|_| DriverError::Session(format!("bad width {}", parts[0])))?;
    let h: u32 = parts[1]
        .parse()
        .map_err(|_| DriverError::Session(format!("bad height {}", parts[1])))?;
    // r_frame_rate is "num/den" (e.g. "60/1"); fps = num/den.
    let fps = (|| {
        let (n, d) = parts[2].split_once('/')?;
        let n: f64 = n.parse().ok()?;
        let d: f64 = d.parse().ok()?;
        (d > 0.0).then_some((n / d).round() as u32)
    })()
    .unwrap_or(30);
    Ok((w, h, fps.max(1)))
}

/// Spawn the video-decoding ffmpeg child → raw BGRA frames on stdout.
fn spawn_video_ffmpeg(path: &str) -> std::io::Result<Child> {
    Command::new("ffmpeg")
        .args([
            "-loglevel",
            "error",
            "-nostdin",
            "-re",
            "-stream_loop",
            "-1",
            "-i",
            path,
            "-an",
            "-map",
            "0:v:0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgra",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

/// Spawn the audio-decoding ffmpeg child → 16 kHz mono S16LE on stdout.
fn spawn_audio_ffmpeg(path: &str) -> std::io::Result<Child> {
    Command::new("ffmpeg")
        .args([
            "-loglevel",
            "error",
            "-nostdin",
            "-re",
            "-stream_loop",
            "-1",
            "-i",
            path,
            "-vn",
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

// ── video ────────────────────────────────────────────────────────────────────

struct FrameSlot {
    buf: Vec<u8>,
    ready: bool,
    error: Option<String>,
}

/// File-backed mock [`CaptureSource`]: decodes the file's video track to BGRA at
/// native resolution/framerate, looping forever, paused when set inactive.
pub struct MediaVideoSource {
    width: u32,
    height: u32,
    slot: Arc<Mutex<FrameSlot>>,
    active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MediaVideoSource {
    /// Probe `path` and start the realtime-looping video feeder. Errors if
    /// `ffprobe`/`ffmpeg` are missing or the file has no video stream.
    pub fn new(path: &str) -> Result<Self> {
        let (w, h, _fps) = probe_video(path)?;
        let need = (w as usize) * (h as usize) * 4;
        let slot = Arc::new(Mutex::new(FrameSlot {
            buf: vec![0u8; need],
            ready: false,
            error: None,
        }));
        let active = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let path = path.to_string();
            let slot = Arc::clone(&slot);
            let active = Arc::clone(&active);
            let stop = Arc::clone(&stop);
            thread::Builder::new()
                .name("vrover-media-video".into())
                .spawn(move || video_worker(&path, w, h, &slot, &active, &stop))
                .map_err(|e| DriverError::Session(format!("video worker spawn: {e}")))?
        };
        Ok(Self {
            width: w,
            height: h,
            slot,
            active,
            stop,
            worker: Some(worker),
        })
    }

    /// The probed geometry.
    #[must_use]
    pub fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

impl CaptureSource for MediaVideoSource {
    fn size(&self) -> Option<(u32, u32)> {
        Some((self.width, self.height))
    }

    fn capture(&mut self) -> Result<Frame> {
        let g = self
            .slot
            .lock()
            .map_err(|_| DriverError::Backend("video slot mutex poisoned".into()))?;
        if let Some(ref e) = g.error {
            return Err(DriverError::Session(e.clone()));
        }
        if !g.ready {
            return Err(DriverError::Session(
                "no video frame yet (waiting for first decode)".into(),
            ));
        }
        Frame::new(self.width, self.height, g.buf.clone())
    }

    fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::Relaxed);
    }

    fn clear_frame(&self) {
        if let Ok(mut g) = self.slot.lock() {
            g.ready = false;
        }
    }
}

impl Drop for MediaVideoSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.active.store(true, Ordering::Relaxed); // unpark the worker so it sees `stop`
        let _ = self.worker.take(); // detach (worker exits within ~one frame)
    }
}

/// Continuously decode frames into `slot` while `active`; respawn on EOF; exit
/// when `stop`. ffmpeg's `-re` paces to native framerate.
fn video_worker(
    path: &str,
    w: u32,
    h: u32,
    slot: &Arc<Mutex<FrameSlot>>,
    active: &AtomicBool,
    stop: &AtomicBool,
) {
    let need = (w as usize) * (h as usize) * 4;
    while !stop.load(Ordering::Relaxed) {
        if !active.load(Ordering::Relaxed) {
            thread::sleep(POLL_INACTIVE);
            continue;
        }
        let mut child = match spawn_video_ffmpeg(path) {
            Ok(c) => c,
            Err(e) => return fail(slot, format!("ffmpeg spawn: {e}")),
        };
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut got_any = false;
        while !stop.load(Ordering::Relaxed) && active.load(Ordering::Relaxed) {
            let mut buf = vec![0u8; need];
            match stdout.read_exact(&mut buf) {
                Ok(()) => {
                    got_any = true;
                    if let Ok(mut g) = slot.lock() {
                        g.buf.copy_from_slice(&buf);
                        g.ready = true;
                    }
                }
                Err(_) => break, // EOF or ffmpeg died → respawn (or fatal below)
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        // ffmpeg exited before producing a single frame → fatal (no/bad video),
        // not a transient EOF: don't busy-loop the respawn.
        if !got_any && !stop.load(Ordering::Relaxed) {
            return fail(slot, format!("ffmpeg produced no video frames from {path}"));
        }
    }
}

// ── audio ────────────────────────────────────────────────────────────────────

struct AudioShared {
    subscribers: Vec<(u64, SyncSender<Arc<[u8]>>)>,
    error: Option<String>,
}

/// File-backed mock [`AudioSource`]: decodes the file's audio track to 16 kHz
/// mono S16LE, looping forever, paused when set inactive / no subscribers.
pub struct MediaAudioSource {
    shared: Arc<Mutex<AudioShared>>,
    active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MediaAudioSource {
    /// Start the realtime-looping audio feeder. Errors only on thread spawn
    /// failure; a missing audio track surfaces later (subscribe returns Err /
    /// the stream stays silent).
    pub fn new(path: &str) -> Result<Self> {
        let shared = Arc::new(Mutex::new(AudioShared {
            subscribers: Vec::new(),
            error: None,
        }));
        let active = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let path = path.to_string();
            let shared = Arc::clone(&shared);
            let active = Arc::clone(&active);
            let stop = Arc::clone(&stop);
            thread::Builder::new()
                .name("vrover-media-audio".into())
                .spawn(move || audio_worker(&path, &shared, &active, &stop))
                .map_err(|e| DriverError::Session(format!("audio worker spawn: {e}")))?
        };
        Ok(Self {
            shared,
            active,
            stop,
            worker: Some(worker),
        })
    }
}

impl AudioSource for MediaAudioSource {
    /// Always 16 kHz mono — we request exactly that from ffmpeg.
    fn format(&self) -> Option<AudioFormat> {
        Some(AudioFormat {
            rate: 16_000,
            channels: 1,
        })
    }

    fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::Relaxed);
    }

    fn subscribe(&self) -> Result<AudioSubscription> {
        let mut g = self
            .shared
            .lock()
            .map_err(|_| DriverError::Backend("audio shared mutex poisoned".into()))?;
        if let Some(ref e) = g.error {
            return Err(DriverError::Session(e.clone()));
        }
        let id = NEXT_SUB.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel::<Arc<[u8]>>(SUBSCRIBER_BUF);
        g.subscribers.push((id, tx));
        let shared_weak = Arc::downgrade(&self.shared);
        let unsub = Box::new(move || {
            if let Some(shared) = shared_weak.upgrade() {
                if let Ok(mut g) = shared.lock() {
                    g.subscribers.retain(|(sid, _)| *sid != id);
                }
            }
        });
        Ok(AudioSubscription::new(rx, unsub))
    }

    fn subscriber_count(&self) -> usize {
        self.shared
            .lock()
            .map(|g| g.subscribers.len())
            .unwrap_or(0)
    }
}

impl Drop for MediaAudioSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.active.store(true, Ordering::Relaxed);
        let _ = self.worker.take();
    }
}

/// Continuously read 16 kHz mono S16LE chunks from ffmpeg and fan them out to
/// subscribers while `active`; respawn on EOF; exit when `stop`. ffmpeg's `-re`
/// paces to realtime.
fn audio_worker(
    path: &str,
    shared: &Arc<Mutex<AudioShared>>,
    active: &AtomicBool,
    stop: &AtomicBool,
) {
    while !stop.load(Ordering::Relaxed) {
        if !active.load(Ordering::Relaxed) {
            thread::sleep(POLL_INACTIVE);
            continue;
        }
        let mut child = match spawn_audio_ffmpeg(path) {
            Ok(c) => c,
            Err(e) => return fail(shared, format!("ffmpeg spawn: {e}")),
        };
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut got_any = false;
        while !stop.load(Ordering::Relaxed) && active.load(Ordering::Relaxed) {
            let mut buf = vec![0u8; AUDIO_CHUNK];
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    got_any = true;
                    let chunk: Arc<[u8]> = Arc::from(&buf[..n]);
                    fan_out(shared, chunk);
                }
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        if !got_any && !stop.load(Ordering::Relaxed) {
            return fail(shared, format!("ffmpeg produced no audio from {path}"));
        }
    }
}

/// Push one chunk to every subscriber. Non-blocking: a full (slow) client skips
/// this chunk; a client whose receiver dropped is pruned (swap_remove, O(1)).
fn fan_out(shared: &Arc<Mutex<AudioShared>>, chunk: Arc<[u8]>) {
    let Ok(mut g) = shared.lock() else {
        return;
    };
    let mut i = 0;
    while i < g.subscribers.len() {
        match g.subscribers[i].1.try_send(Arc::clone(&chunk)) {
            Ok(()) => i += 1,
            Err(TrySendError::Full(_)) => i += 1,
            Err(TrySendError::Disconnected(_)) => {
                g.subscribers.swap_remove(i);
            }
        }
    }
}

fn fail<T>(slot_or_shared: &Arc<Mutex<T>>, msg: String)
where
    T: ErrorSink,
{
    if let Ok(mut g) = slot_or_shared.lock() {
        g.set_error(msg);
    }
}

trait ErrorSink {
    fn set_error(&mut self, msg: String);
}
impl ErrorSink for FrameSlot {
    fn set_error(&mut self, msg: String) {
        self.error = Some(msg);
    }
}
impl ErrorSink for AudioShared {
    fn set_error(&mut self, msg: String) {
        self.error = Some(msg);
    }
}
