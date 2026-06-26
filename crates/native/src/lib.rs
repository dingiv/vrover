//! napi-rs bindings for `vrover-omniparser`.
//!
//! Exposes [`OmniParserNative`] — a JS class that wraps the Rust `OmniParser`.
//! One `parse(pngBuffer)` call does detection + SoM annotation in a single pass,
//! returning the annotated PNG and element list.

use std::cell::RefCell;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use vrover_omniparser::{ElementType, OmniParser, OmniParserConfig};

// ── config ──────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct OmniParserConfigNative {
    /// Path to the `icon_detect.onnx` weight file.
    pub yolo_path: String,
    /// Detection confidence threshold (default 0.05).
    pub box_threshold: f64,
    /// NMS IoU threshold (default 0.1).
    pub iou_threshold: f64,
}

// ── element ─────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct ParsedElementNative {
    /// 0-based mark index (maps to SoM mark number via `mark + 1` on the TS side).
    pub mark: i32,
    /// `"Icon"` or `"Text"`.
    pub r#type: String,
    /// Bounding box left edge (pixels).
    pub x1: f64,
    /// Bounding box top edge (pixels).
    pub y1: f64,
    /// Bounding box right edge (pixels).
    pub x2: f64,
    /// Bounding box bottom edge (pixels).
    pub y2: f64,
    /// Whether the element is interactive (always `true` in Phase 1).
    pub interactivity: bool,
    /// Caption / OCR text, if available (Phase 2+).
    pub content: Option<String>,
}

// ── result ──────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct ParseResult {
    /// PNG-encoded SoM-annotated image (same dimensions as input screenshot).
    pub annotated_png: Buffer,
    /// Detected elements with their bounding boxes.
    pub elements: Vec<ParsedElementNative>,
    /// Image width in pixels (from the decoded input PNG).
    pub width: u32,
    /// Image height in pixels (from the decoded input PNG).
    pub height: u32,
}

// ── parser ──────────────────────────────────────────────────────────────────

#[napi]
pub struct OmniParserNative {
    inner: RefCell<OmniParser>,
}

#[napi]
impl OmniParserNative {
    /// Create a new parser, loading the ONNX model from `config.yolo_path`.
    #[napi(constructor)]
    pub fn new(config: OmniParserConfigNative) -> Result<Self> {
        let mut cfg = OmniParserConfig::new(&config.yolo_path);
        cfg.box_threshold = config.box_threshold as f32;
        cfg.iou_threshold = config.iou_threshold as f32;

        let parser = OmniParser::new(cfg).map_err(|e| {
            napi::Error::from_reason(format!("OmniParser init failed: {e}"))
        })?;
        Ok(Self {
            inner: RefCell::new(parser),
        })
    }

    /// Parse one screenshot (PNG-encoded bytes).
    ///
    /// Decodes the PNG, runs YOLO icon detection + overlap removal + SoM
    /// annotation, and returns the annotated image + element list.
    #[napi]
    pub fn parse(&self, png_buffer: Buffer) -> Result<ParseResult> {
        // Decode PNG → RgbImage
        let img = image::load_from_memory(&png_buffer)
            .map_err(|e| napi::Error::from_reason(format!("PNG decode failed: {e}")))?
            .to_rgb8();
        let (w, h) = img.dimensions();

        // Run the full OmniParser pipeline
        let mut parser = self.inner.borrow_mut();
        let result = parser.parse(&img).map_err(|e| {
            napi::Error::from_reason(format!("OmniParser parse failed: {e}"))
        })?;

        // Convert elements to napi-friendly shape
        let elements: Vec<ParsedElementNative> = result
            .elements
            .into_iter()
            .map(|e| {
                let type_str = match e.r#type {
                    ElementType::Icon => "Icon".to_string(),
                    ElementType::Text => "Text".to_string(),
                };
                ParsedElementNative {
                    mark: e.mark as i32,
                    r#type: type_str,
                    x1: e.bbox.x1 as f64,
                    y1: e.bbox.y1 as f64,
                    x2: e.bbox.x2 as f64,
                    y2: e.bbox.y2 as f64,
                    interactivity: e.interactivity,
                    content: e.content,
                }
            })
            .collect();

        Ok(ParseResult {
            annotated_png: Buffer::from(result.annotated_png),
            elements,
            width: w,
            height: h,
        })
    }
}
