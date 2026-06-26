//! `vrover-omniparser` — a Rust port of OmniParser's screen-parsing pipeline.
//!
//! **Phase 1 (this round):** YOLO icon detection (ONNX Runtime) + Set-of-Mark
//! annotation. A screenshot goes in; an annotated SoM image (each icon numbered)
//! + an element table come out. Icons are detected but **uncaptioned**
//! (`content = None`) — the brain VLM fills captions from the SoM image.
//!
//! Reserved seams for later phases: [`ocr::Ocr`] (Phase 2, RapidOCR ONNX) and
//! [`caption::Captioner`] (Phase 3, Florence-2 ONNX generate loop). They drop into
//! [`OmniParser::parse`] without restructuring.
//!
//! Ported from Microsoft's OmniParser (`util/utils.py` + `util/box_annotator.py`).

use std::path::PathBuf;

use image::{ImageFormat, RgbImage};

pub mod caption;
pub mod error;
pub mod ocr;
pub mod overlap;
pub mod som;
pub mod types;
pub mod yolo;

pub use error::{OmniError, Result};
pub use som::SomConfig;
pub use types::{BBox, ElementType, ParsedElement, SomResult};
pub use yolo::{Detection, YoloDetector};

/// Knobs for [`OmniParser`]. `yolo_path` points at the icon-detect ONNX (fetch
/// via `fetch_weights.sh`).
#[derive(Clone, Debug)]
pub struct OmniParserConfig {
    pub yolo_path: PathBuf,
    pub box_threshold: f32,
    pub iou_threshold: f32,
    pub som: SomConfig,
}

impl OmniParserConfig {
    /// Defaults: `box_threshold=0.05`, `iou_threshold=0.1` (matching
    /// `omniparserserver`), the standard SoM look.
    pub fn new(yolo_path: impl Into<PathBuf>) -> Self {
        Self {
            yolo_path: yolo_path.into(),
            box_threshold: 0.05,
            iou_threshold: 0.1,
            som: SomConfig::default(),
        }
    }
}

/// The OmniParser: holds the loaded YOLO session + render config.
#[derive(Debug)]
pub struct OmniParser {
    yolo: YoloDetector,
    som: SomConfig,
    /// IoU threshold for the post-detection `remove_overlap` dedup (Python default 0.9).
    overlap_iou: f32,
}

impl OmniParser {
    pub fn new(cfg: OmniParserConfig) -> Result<Self> {
        let yolo =
            YoloDetector::new(&cfg.yolo_path)?.with_thresholds(cfg.box_threshold, cfg.iou_threshold);
        Ok(Self {
            yolo,
            som: cfg.som,
            overlap_iou: 0.9,
        })
    }

    /// Parse one screenshot: detect icons → dedup overlapping boxes → annotate.
    pub fn parse(&mut self, rgb: &RgbImage) -> Result<SomResult> {
        let dets = self.yolo.detect(rgb)?;
        let boxes: Vec<BBox> = dets.iter().map(|d| d.bbox).collect();
        let kept = overlap::remove_overlap(&boxes, self.overlap_iou);

        let elements: Vec<ParsedElement> = kept
            .into_iter()
            .enumerate()
            .map(|(mark, bbox)| ParsedElement {
                mark,
                r#type: ElementType::Icon,
                bbox,
                interactivity: true,
                content: None,
            })
            .collect();

        let annotated = som::annotate(rgb, &elements, &self.som);
        let mut buf = std::io::Cursor::new(Vec::new());
        annotated.write_to(&mut buf, ImageFormat::Png)?;
        Ok(SomResult {
            annotated_png: buf.into_inner(),
            elements,
        })
    }
}
