//! YOLO icon detector — the OmniParser `predict_yolo` half, on ONNX Runtime.
//!
//! Runs `onnx-community/OmniParser-v2.0_icon_detect` (a YOLOv8, single class
//! "icon"). Verified I/O: input `images` is `[1,3,640,640]` f32 RGB /255; output
//! `output0` is `[1,5,8400]` = `[cx, cy, w, h, conf]` per anchor, box in 640-space.
//!
//! Flow: letterbox the source to 640 → run → filter by `box_threshold` → NMS at
//! `iou_threshold` (the 0.1 `get_som_labeled_img` passes to `predict_yolo`) →
//! un-letterbox boxes back to source pixel coords.

use std::path::Path;

use image::{imageops, RgbImage};
use ndarray::Array4;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use crate::error::{ort_err, Result};
use crate::overlap;
use crate::types::BBox;

/// Inference image size (the model's baked-in input dimension).
const IMGSZ: u32 = 640;
/// Letterbox fill value (ultralytics default 114).
const PAD_GRAY: f32 = 114.0 / 255.0;

#[derive(Clone, Debug)]
pub struct Detection {
    /// xyxy, source pixel coords.
    pub bbox: BBox,
    pub conf: f32,
}

#[derive(Debug)]
pub struct YoloDetector {
    session: Session,
    pub box_threshold: f32,
    pub iou_threshold: f32,
}

impl YoloDetector {
    /// Load the ONNX model from `path`. Defaults: `box_threshold=0.05`,
    /// `iou_threshold=0.1` (matching `omniparserserver` / `get_som_labeled_img`).
    pub fn new(path: impl AsRef<Path>) -> Result<Self> {
        let session = Session::builder()
            .map_err(ort_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(ort_err)?
            .commit_from_file(path.as_ref())
            .map_err(ort_err)?;
        Ok(Self {
            session,
            box_threshold: 0.05,
            iou_threshold: 0.1,
        })
    }

    #[must_use]
    pub fn with_thresholds(mut self, box_threshold: f32, iou_threshold: f32) -> Self {
        self.box_threshold = box_threshold;
        self.iou_threshold = iou_threshold;
        self
    }

    /// Detect icons. Boxes are in source-image pixel coords.
    pub fn detect(&mut self, rgb: &RgbImage) -> Result<Vec<Detection>> {
        let (iw, ih) = (rgb.width(), rgb.height());
        let (ratio, new_w, new_h, dw, dh) = letterbox(iw, ih, IMGSZ);
        let input = preprocess(rgb, new_w, new_h, dw, dh)?;
        let tensor = Tensor::from_array(input).map_err(ort_err)?;
        let outputs = self
            .session
            .run(ort::inputs![tensor])
            .map_err(ort_err)?;
        let (_shape, data) = outputs["output0"]
            .try_extract_tensor::<f32>()
            .map_err(ort_err)?;

        // Layout [1, 5, 8400]: element (0, c, j) = data[c*8400 + j].
        let n = 8400usize;
        debug_assert!(data.len() >= 5 * n, "output0 len {} < {}", data.len(), 5 * n);

        // The export may or may not pre-apply sigmoid to the class score. Heuristic:
        // if the max raw score looks like a logit (>1.5), sigmoid it; else use as-is.
        let need_sigmoid = (0..n).map(|j| data[4 * n + j]).fold(0.0_f32, f32::max) > 1.5;

        // Candidates above box_threshold, un-letterboxed to source space.
        let mut cands: Vec<(BBox, f32)> = Vec::new();
        for j in 0..n {
            let conf = if need_sigmoid {
                sigmoid(data[4 * n + j])
            } else {
                data[4 * n + j]
            };
            if conf <= self.box_threshold {
                continue;
            }
            let (cx, cy, w, h) = (data[j], data[n + j], data[2 * n + j], data[3 * n + j]);
            let x1 = cx - w / 2.0;
            let y1 = cy - h / 2.0;
            let x2 = cx + w / 2.0;
            let y2 = cy + h / 2.0;
            let bbox = BBox {
                x1: (x1 - dw as f32) / ratio,
                y1: (y1 - dh as f32) / ratio,
                x2: (x2 - dw as f32) / ratio,
                y2: (y2 - dh as f32) / ratio,
            }
            .clamp_to(iw as f32, ih as f32);
            cands.push((bbox, conf));
        }

        // Greedy NMS, highest-conf first, suppressed at the plain IoU threshold.
        cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut kept: Vec<Detection> = Vec::new();
        for (b, c) in cands {
            if kept.iter().all(|d| plain_iou(&b, &d.bbox) < self.iou_threshold) {
                kept.push(Detection { bbox: b, conf: c });
            }
        }
        Ok(kept)
    }
}

/// Letterbox params for fitting `(iw,ih)` into `target×target`: scale ratio +
/// resized size + integer offsets to center the image.
fn letterbox(iw: u32, ih: u32, target: u32) -> (f32, u32, u32, u32, u32) {
    let ratio = (target as f32 / iw.max(1) as f32).min(target as f32 / ih.max(1) as f32);
    let new_w = ((iw as f32 * ratio).round() as u32).clamp(1, target);
    let new_h = ((ih as f32 * ratio).round() as u32).clamp(1, target);
    let dw = (target - new_w) / 2;
    let dh = (target - new_h) / 2;
    (ratio, new_w, new_h, dw, dh)
}

/// Resize to `new_w×new_h`, place at integer offset `(dw,dh)` on a `target²` gray
/// canvas, and lay out as NCHW `[1,3,target,target]` f32, RGB, /255.
fn preprocess(rgb: &RgbImage, new_w: u32, new_h: u32, dw: u32, dh: u32) -> Result<Array4<f32>> {
    let resized = imageops::resize(rgb, new_w, new_h, imageops::FilterType::Triangle);
    let mut arr = Array4::from_elem((1, 3, IMGSZ as usize, IMGSZ as usize), PAD_GRAY);
    for y in 0..new_h {
        for x in 0..new_w {
            let p = resized.get_pixel(x, y);
            let (yy, xx) = (y as usize + dh as usize, x as usize + dw as usize);
            arr[[0, 0, yy, xx]] = p.0[0] as f32 / 255.0;
            arr[[0, 1, yy, xx]] = p.0[1] as f32 / 255.0;
            arr[[0, 2, yy, xx]] = p.0[2] as f32 / 255.0;
        }
    }
    Ok(arr)
}

#[inline]
fn plain_iou(a: &BBox, b: &BBox) -> f32 {
    let i = overlap::intersection(a, b);
    let u = a.area() + b.area() - i;
    if u > 0.0 {
        i / u
    } else {
        0.0
    }
}

#[inline]
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_fits_square_image() {
        let (r, w, h, dw, dh) = letterbox(640, 640, 640);
        assert_eq!(r, 1.0);
        assert_eq!((w, h), (640, 640));
        assert_eq!((dw, dh), (0, 0));
    }

    #[test]
    fn letterbox_centers_landscape_image() {
        // 1280×640 → ratio 0.5 → 640×320, centered vertically.
        let (r, w, h, dw, dh) = letterbox(1280, 640, 640);
        assert!((r - 0.5).abs() < 1e-3);
        assert_eq!((w, h), (640, 320));
        assert_eq!((dw, dh), (0, 160));
    }

    #[test]
    fn nms_suppresses_overlapping_higher_iou() {
        // Two near-identical boxes (plain IoU ~0.9) collapse at iou 0.1; far box survives.
        let a = BBox { x1: 0.0, y1: 0.0, x2: 10.0, y2: 10.0 };
        let b = BBox { x1: 1.0, y1: 1.0, x2: 11.0, y2: 11.0 };
        assert!(plain_iou(&a, &b) > 0.1);
        let c = BBox { x1: 100.0, y1: 100.0, x2: 110.0, y2: 110.0 };
        assert!(plain_iou(&a, &c) < 0.1);
    }

    #[test]
    fn sigmoid_bounded() {
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-3);
        assert!(sigmoid(100.0) > 0.99);
        assert!(sigmoid(-100.0) < 0.01);
    }
}
