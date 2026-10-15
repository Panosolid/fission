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
}
