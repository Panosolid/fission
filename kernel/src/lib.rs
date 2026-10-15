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
use serde::{Deserialize, Serialize};
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

/// One loop of a profile as the app sends it: corners as flat
/// [x0, y0, x1, y1, …] with one bulge per corner (or none: all straight),
/// or a circle. In JavaScript: `{ path: { corners, bulges } }` or
/// `{ circle: { center: [x, y], radius } }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoundaryIn {
    Path { corners: Vec<f64>, bulges: Vec<f64> },
    Circle { center: [f64; 2], radius: f64 },
}

/// A profile as the app sends it: `{ outer, holes: [...] }`.
#[derive(Debug, Deserialize)]
pub struct ProfileIn {
    pub outer: BoundaryIn,
    pub holes: Vec<BoundaryIn>,
}

/// The kernel's profile from the app's form; refuses coordinates that don't
/// come in pairs. Everything else is checked by the extrude itself.
pub fn profile_from_input(p: ProfileIn) -> Result<ops::extrude::Profile, String> {
    use ops::extrude::Boundary;
    let convert = |b: BoundaryIn| match b {
        BoundaryIn::Path { corners, bulges } => {
            if !corners.len().is_multiple_of(2) {
                return Err("profile coordinates must come in x, y pairs".to_string());
            }
            let corners = corners.chunks_exact(2).map(|p| glam::DVec2::new(p[0], p[1])).collect();
            Ok(Boundary::Path { corners, bulges })
        }
        BoundaryIn::Circle { center, radius } => Ok(Boundary::Circle { center: center.into(), radius }),
    };
    Ok(ops::extrude::Profile { outer: convert(p.outer)?, holes: p.holes.into_iter().map(convert).collect::<Result<_, _>>()? })
}

/// Extrudes a profile (see `ProfileIn`) along +Z by `distance`.
#[wasm_bindgen]
pub fn make_extrude(profile: JsValue, distance: f64) -> Result<JsValue, JsError> {
    let input: ProfileIn = serde_wasm_bindgen::from_value(profile).map_err(|e| JsError::new(&format!("bad profile: {e}")))?;
    let profile = profile_from_input(input).map_err(|e| JsError::new(&e))?;
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
        let outer = vec![0.0, 0.0, 10.0, 0.0, 10.0, 3.0, 3.0, 3.0, 3.0, 10.0, 0.0, 10.0];
        let profile = profile_from_input(ProfileIn { outer: BoundaryIn::Path { corners: outer, bulges: vec![] }, holes: vec![] }).unwrap();
        let v = view_body(&ops::extrude::extrude(&profile, 2.0).unwrap()).unwrap();
        assert!(rel_eq(v.volume, 102.0, FP_REL) && rel_eq(v.area, 182.0, FP_REL), "{} {}", v.volume, v.area);
        assert_eq!((v.vertices, v.edges, v.faces), (12, 18, 8));
    }

    #[test]
    fn app_profiles_are_split_into_corners() {
        // (Was flat_profiles_are_split_into_holes, for the old flat-array
        // form.) Corners [0..6) pair up as (0,1) (2,3) (4,5); a hole of 4
        // corners [6..14) gives (12,13) last; a circle passes through.
        let path = |from: i32, to: i32| BoundaryIn::Path { corners: (from..to).map(f64::from).collect(), bulges: vec![] };
        let circle = BoundaryIn::Circle { center: [1.0, 2.0], radius: 3.0 };
        let p = profile_from_input(ProfileIn { outer: path(0, 6), holes: vec![path(6, 14), circle] }).unwrap();
        use ops::extrude::Boundary;
        let Boundary::Path { corners, .. } = &p.outer else { panic!() };
        assert_eq!(corners, &vec![glam::DVec2::new(0.0, 1.0), glam::DVec2::new(2.0, 3.0), glam::DVec2::new(4.0, 5.0)]);
        let Boundary::Path { corners, .. } = &p.holes[0] else { panic!() };
        assert_eq!(corners[3], glam::DVec2::new(12.0, 13.0));
        assert_eq!(p.holes[1], Boundary::Circle { center: glam::DVec2::new(1.0, 2.0), radius: 3.0 });
    }

    #[test]
    fn malformed_app_profiles_are_refused_not_panicked_on() {
        // An odd number of coordinates, in the outline or in a hole.
        let path = |n: usize| BoundaryIn::Path { corners: vec![0.0; n], bulges: vec![] };
        assert!(profile_from_input(ProfileIn { outer: path(5), holes: vec![] }).is_err());
        assert!(profile_from_input(ProfileIn { outer: path(6), holes: vec![path(3)] }).is_err());
        // Wrong bulge counts reach the kernel's own check as a clean error.
        let p = profile_from_input(ProfileIn {
            outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0], bulges: vec![0.0] },
            holes: vec![],
        })
        .unwrap();
        assert!(matches!(ops::extrude::extrude(&p, 1.0), Err(ops::KernelError::InvalidInput(_))));
    }
}
