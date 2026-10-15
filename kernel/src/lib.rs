//! Fission geometry kernel.
//!
//! Pure Rust lives in the modules; the `#[wasm_bindgen]` functions below are the
//! thin layer the browser app calls. Vectors cross the boundary as flat
//! `[x, y, z]` arrays (`Float64Array` in JavaScript).

pub mod geom;
#[cfg(not(target_arch = "wasm32"))]
pub mod debug_dump;
pub mod display;
pub mod mesh;
pub mod ops;
pub mod tessellate;
pub mod tolerance;
pub mod topology;
pub mod validate;

#[cfg(test)]
pub(crate) mod fixtures;

use display::DisplayMesh;
use serde::Serialize;
use tessellate::{tessellate, TessOptions};
use topology::Body;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn kernel_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Everything the viewer needs to show one body.
#[derive(Debug, Serialize)]
pub struct BodyView {
    pub mesh: DisplayMesh,
    pub volume: f64,
    pub area: f64,
    pub vertices: usize,
    pub edges: usize,
    pub faces: usize,
    /// Empty when the body passed validation.
    pub errors: Vec<String>,
}

pub fn view_body(body: &Body) -> Result<BodyView, String> {
    let mesh = tessellate(body, &TessOptions::DISPLAY).map_err(|e| format!("face {}: {}", e.face, e.message))?;
    let errors = match validate::validate(body) {
        Ok(()) => vec![],
        Err(errs) => errs.iter().map(|e| e.to_string()).collect(),
    };
    Ok(BodyView {
        mesh: display::display_mesh(body, &mesh),
        volume: mesh.signed_volume(),
        area: mesh.area(),
        vertices: body.vertices.len(),
        edges: body.edges.len(),
        faces: body.faces.len(),
        errors,
    })
}

fn to_js(view: BodyView) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(&view).map_err(|e| JsError::new(&e.to_string()))
}

/// Box with one corner at the origin, sizes in millimetres.
#[wasm_bindgen]
pub fn make_box(width: f64, depth: f64, height: f64) -> Result<JsValue, JsError> {
    let body = ops::primitives::make_box(width, depth, height).map_err(|e| JsError::new(&e.to_string()))?;
    to_js(view_body(&body).map_err(|e| JsError::new(&e))?)
}

/// A profile from flat arrays, the way they cross from JavaScript: `outer`
/// is [x0, y0, x1, y1, …]; `holes` holds every hole's corners flattened the
/// same way, one after another, and `hole_corners` says how many each has.
pub fn profile_from_flat(outer: &[f64], hole_corners: &[u32], holes: &[f64]) -> Result<ops::extrude::Profile, String> {
    let pairs = |v: &[f64]| v.chunks_exact(2).map(|p| glam::DVec2::new(p[0], p[1])).collect::<Vec<_>>();
    if !outer.len().is_multiple_of(2) || !holes.len().is_multiple_of(2) {
        return Err("profile coordinates must come in x, y pairs".into());
    }
    let needed: u64 = hole_corners.iter().map(|&n| n as u64).sum();
    if needed * 2 != holes.len() as u64 {
        return Err(format!("hole corner counts add up to {needed}, but {} corners were given", holes.len() / 2));
    }
    let corners = pairs(holes);
    let mut start = 0;
    let holes = hole_corners
        .iter()
        .map(|&n| {
            let hole = corners[start..start + n as usize].to_vec();
            start += n as usize;
            hole
        })
        .collect();
    Ok(ops::extrude::Profile { outer: pairs(outer), holes })
}

/// Extrudes a polygon profile (see `profile_from_flat`) along +Z.
#[wasm_bindgen]
pub fn make_extrude(outer: Vec<f64>, hole_corners: Vec<u32>, holes: Vec<f64>, distance: f64) -> Result<JsValue, JsError> {
    let profile = profile_from_flat(&outer, &hole_corners, &holes).map_err(|e| JsError::new(&e))?;
    let body = ops::extrude::extrude(&profile, distance).map_err(|e| JsError::new(&e.to_string()))?;
    to_js(view_body(&body).map_err(|e| JsError::new(&e))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{rel_eq, FP_REL};

    #[test]
    fn version_comes_from_cargo() {
        assert_eq!(kernel_version(), "0.1.0");
    }

    #[test]
    fn box_view_reports_hand_worked_numbers() {
        // 10 × 20 × 30 box: V = 6000, A = 2(200 + 600 + 300) = 2200,
        // 8 vertices, 12 edges, 6 faces.
        let body = ops::primitives::make_box(10.0, 20.0, 30.0).unwrap();
        let v = view_body(&body).unwrap();
        assert!(rel_eq(v.volume, 6000.0, FP_REL));
        assert!(rel_eq(v.area, 2200.0, FP_REL));
        assert_eq!((v.vertices, v.edges, v.faces), (8, 12, 6));
        assert!(v.errors.is_empty());
    }

    #[test]
    fn view_reports_validation_errors_instead_of_hiding_them() {
        let mut body = ops::primitives::make_box(1.0, 1.0, 1.0).unwrap();
        body.vertices[7].point.z += 0.5;
        let v = view_body(&body).unwrap();
        assert!(v.errors.iter().any(|e| e.contains("vertex 7")), "{:?}", v.errors);
    }

    #[test]
    fn l_bracket_view_reports_hand_worked_numbers() {
        // L outline (0,0) (10,0) (10,3) (3,3) (3,10) (0,10), extruded 2:
        // area = 10·10 − 7·7 = 51, so V = 51·2 = 102; the perimeter equals
        // the bounding square's, 40, so S = 2·51 + 40·2 = 182. Six corners:
        // 12 vertices, 6 + 6 + 6 = 18 edges, 6 sides + 2 caps = 8 faces.
        let outer = [0.0, 0.0, 10.0, 0.0, 10.0, 3.0, 3.0, 3.0, 3.0, 10.0, 0.0, 10.0];
        let profile = profile_from_flat(&outer, &[], &[]).unwrap();
        let v = view_body(&ops::extrude::extrude(&profile, 2.0).unwrap()).unwrap();
        assert!(rel_eq(v.volume, 102.0, FP_REL) && rel_eq(v.area, 182.0, FP_REL), "{} {}", v.volume, v.area);
        assert_eq!((v.vertices, v.edges, v.faces), (12, 18, 8));
    }

    #[test]
    fn flat_profiles_are_split_into_holes() {
        // Two holes of 3 and 4 corners: corners 0–2 and 3–6.
        let holes: Vec<f64> = (0..14).map(f64::from).collect();
        let p = profile_from_flat(&[0.0; 6], &[3, 4], &holes).unwrap();
        assert_eq!(p.holes.len(), 2);
        assert_eq!(p.holes[0], vec![glam::DVec2::new(0.0, 1.0), glam::DVec2::new(2.0, 3.0), glam::DVec2::new(4.0, 5.0)]);
        assert_eq!(p.holes[1][3], glam::DVec2::new(12.0, 13.0));
    }

    #[test]
    fn malformed_flat_profiles_are_refused_not_panicked_on() {
        assert!(profile_from_flat(&[0.0; 5], &[], &[]).is_err()); // odd count
        assert!(profile_from_flat(&[0.0; 6], &[3], &[0.0; 4]).is_err()); // too few hole corners
        assert!(profile_from_flat(&[0.0; 6], &[1], &[0.0; 4]).is_err()); // too many
        assert!(profile_from_flat(&[0.0; 6], &[u32::MAX, u32::MAX], &[0.0; 4]).is_err()); // no overflow
    }
}
