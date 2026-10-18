//! Fission geometry kernel.
//!
//! Pure Rust lives in the modules; the `#[wasm_bindgen]` functions below are the
//! thin layer the browser app calls. Vectors cross the boundary as flat
//! `[x, y, z]` arrays (`Float64Array` in JavaScript).
//!
//! Each entry point only converts: the work is in a plain Rust function
//! (`view_of`, `stl_of`, `sketch::snap_to_grid`, `sketch_outline_of`) that
//! the lib tests call. A `JsValue` can't be made
//! or read outside WebAssembly (natively every wasm-bindgen import panics:
//! "cannot call wasm-bindgen imported functions on non-wasm targets"), so
//! no lib test can run the conversions themselves.
//!
//! Failures cross as `ApiError` (`api_error.rs`): JavaScript gets an
//! `Error` with the message, plus `kind` and `inputs` (`js_error`).
//!
//! Mutation testing (`cargo mutants -f src/lib.rs`) leaves these
//! survivors, which no native test can reach (they are not equivalent):
//! each `#[wasm_bindgen]` entry point, and `to_js`, `from_js` and
//! `js_error`, replaced by a default answer (`Ok(Default::default())`, an
//! undefined `JsValue`, `Ok(())`, a fixed number), excluded in
//! `.cargo/mutants.toml`. The real WebAssembly build covers them, through
//! the kernel bridge (`packages/testing/src/node-kernel.ts`, and the app's
//! worker in the browser):
//! - `body_build`, `body_view`, `body_stl`, `body_free`, `body_count`,
//!   `js_error` and `from_js`: `packages/testing/journeys/body-store.journey.ts`
//!   (a stored 40 × 30 × 20 box's volume is 24000 and its view and STL are
//!   `make_box`'s and `export_stl`'s; the count goes up by one and back;
//!   each refusal's `kind` and `inputs`; seeded sessions against a model).
//! - `make_box`, `make_cylinder`, `make_sphere`, `make_extrude` and
//!   `to_js`: `packages/testing/journeys/command-fuzz.journey.ts` (3000
//!   random commands over every shape; each built view must have
//!   `errors: []`), `open-saved-file.journey.ts` (a 50 × 30 × 20 box's
//!   volume is 30000), and the e2e checks in `apps/fission/e2e/smoke.mjs`
//!   ("default 40×30×20 box shows hand-worked numbers", "cylinder
//!   primitive: diameter from the width", "sphere primitive: diameter from
//!   the width", "L-bracket extrusion shows hand-worked numbers").
//! - `export_stl`: `packages/testing/journeys/design-to-stl.journey.ts`
//!   (the STL's volume is 24000, then 30000 after an edit) and the e2e
//!   check "the STL button saves the box as a binary STL with hand-worked
//!   contents".
//! - `snap_to_grid`, `sketch_outline`:
//!   `packages/testing/journeys/sketch-kernel.journey.ts` ((12.4, −7.6) on a
//!   5 mm grid snaps to (10, −10)).

pub mod accurate;
pub mod api_error;
pub mod geom;
pub mod intersect;
pub mod mass;
#[cfg(not(target_arch = "wasm32"))]
pub mod debug_dump;
pub mod display;
pub mod face_mass;
pub mod fmath;
pub mod mesh;
pub mod ops;
pub mod placed;
pub mod self_intersect;
pub mod sketch;
pub mod stl;
pub mod store;
pub mod tessellate;
pub mod tolerance;
pub mod topology;
pub mod validate;

#[cfg(test)]
pub(crate) mod fixtures;

use api_error::ApiError;
use display::DisplayMesh;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::cell::RefCell;
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
    /// Exact, from the B-rep (`mass::mass_properties`), not the mesh.
    pub volume: f64,
    pub area: f64,
    pub vertices: usize,
    pub edges: usize,
    pub faces: usize,
    /// The surface type of each face, by face index ("plane", "cylinder", "sphere").
    pub face_types: Vec<&'static str>,
    /// The curve type of each edge, by edge index ("line", "circle").
    pub edge_types: Vec<&'static str>,
    /// What each face is in the operation that made it, by face index
    /// (`FaceRoleOut`; null for a body built by hand).
    pub face_roles: Vec<Option<FaceRoleOut>>,
    /// Each face's exact area and centroid [x, y, z], by face index
    /// (`face_mass`).
    pub face_areas: Vec<f64>,
    pub face_centroids: Vec<[f64; 3]>,
    /// The two faces each edge joins, by edge index (`edge_pair`): first the
    /// face whose boundary runs along the edge's own direction (start to
    /// end), then the face running it backwards; null for an edge not used
    /// exactly once each way, which only a body that failed validation has.
    /// Design names an edge by these faces (step 24c). An extrude's edge
    /// between two sides runs from the start cap up to the end cap, so its
    /// first face is the side before it going round the loop with the solid
    /// on the left: counter-clockwise round the outline seen from the end
    /// cap, clockwise round a hole.
    pub edge_faces: Vec<Option<[usize; 2]>>,
    /// Empty when the body passed validation.
    pub errors: Vec<String>,
}

/// The view of any body, validating it first (its `errors` list what is
/// wrong). Validation tessellates the body anyway, so its mesh is reused.
pub fn view_body(body: &Body) -> Result<BodyView, ApiError> {
    match validate::validate_meshed(body) {
        Ok(mesh) => Ok(view_parts(body, &mesh, vec![])),
        Err(errs) => {
            let mesh = tessellate(body, &TessOptions::DISPLAY).map_err(|e| ApiError::internal(format!("face {}: {}", e.face, e.message)))?;
            Ok(view_parts(body, &mesh, errs.iter().map(|e| e.to_string()).collect()))
        }
    }
}

/// The view of a body with its display mesh and validation errors.
fn view_parts(body: &Body, mesh: &mesh::Mesh, errors: Vec<String>) -> BodyView {
    let exact = mass::mass_properties(body);
    let faces = face_mass::face_masses(body);
    BodyView {
        mesh: display::display_mesh(body, mesh),
        volume: exact.volume,
        area: exact.area,
        vertices: body.vertices.len(),
        edges: body.edges.len(),
        faces: body.faces.len(),
        face_types: body.faces.iter().map(|f| surface_type(&f.surface)).collect(),
        edge_types: body.edges.iter().map(|e| curve_type(&e.curve)).collect(),
        face_roles: body.faces.iter().map(|f| f.role.map(FaceRoleOut::from)).collect(),
        face_areas: faces.iter().map(|m| m.area).collect(),
        face_centroids: faces.iter().map(|m| m.centroid.to_array()).collect(),
        edge_faces: edge_faces(body),
        errors,
    }
}

/// Each edge's two faces, the one running it forwards first (`edge_pair`),
/// by edge index: what `BodyView.edge_faces` holds.
pub fn edge_faces(body: &Body) -> Vec<Option<[usize; 2]>> {
    body.edge_faces().iter().map(|uses| edge_pair(uses)).collect()
}

/// The faces of an edge's two uses, the one running it forwards first, or
/// None unless there are exactly two uses running opposite ways.
fn edge_pair(uses: &[(topology::FaceId, topology::Coedge)]) -> Option<[usize; 2]> {
    match uses {
        [(f, c), (g, d)] if c.reversed != d.reversed => Some(if c.reversed { [*g, *f] } else { [*f, *g] }),
        _ => None,
    }
}

/// A face's role as the app sees it: `{ role: "start" }`, …, or for an
/// extrude's side `{ role: "side", boundary, piece }` (the profile loop, 0
/// the outer one, and the piece in it as given; a cylinder's side has
/// neither). Roles: start, end, side, bottom, top, front, back, left,
/// right, upper, lower (`topology::FaceRole`).
#[derive(Debug, Serialize, PartialEq)]
pub struct FaceRoleOut {
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub piece: Option<usize>,
}

impl From<topology::FaceRole> for FaceRoleOut {
    fn from(role: topology::FaceRole) -> Self {
        use topology::FaceRole::*;
        let only = |role| FaceRoleOut { role, boundary: None, piece: None };
        match role {
            Start => only("start"),
            End => only("end"),
            Wall => only("side"),
            Side(p) => FaceRoleOut { role: "side", boundary: Some(p.boundary.into()), piece: Some(p.piece.into()) },
            Bottom => only("bottom"),
            Top => only("top"),
            Front => only("front"),
            Back => only("back"),
            Left => only("left"),
            Right => only("right"),
            Upper => only("upper"),
            Lower => only("lower"),
        }
    }
}

/// What the app's properties panel calls a face's surface.
fn surface_type(surface: &geom::Surface) -> &'static str {
    match surface {
        geom::Surface::Plane { .. } => "plane",
        geom::Surface::Cylinder { .. } => "cylinder",
        geom::Surface::Sphere { .. } => "sphere",
    }
}

/// What the app's properties panel calls an edge's curve.
fn curve_type(curve: &geom::Curve) -> &'static str {
    match curve {
        geom::Curve::Line { .. } => "line",
        geom::Curve::Circle { .. } => "circle",
    }
}

/// An answer for JavaScript, or the reason there is none as a thrown error
/// (`js_error`).
fn to_js<T: Serialize>(value: Result<T, ApiError>) -> Result<JsValue, JsValue> {
    let value = value.map_err(js_error)?;
    serde_wasm_bindgen::to_value(&value).map_err(|e| js_error(ApiError::internal(e.to_string())))
}

/// An argument from JavaScript, refused as a `BadRequest` naming it when
/// it isn't of the form `T` (the message is "bad {what}: …").
fn from_js<T: DeserializeOwned>(value: JsValue, name: &'static str, what: &str) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(|e| js_error(ApiError::bad_argument(name, format!("bad {what}: {e}"))))
}

/// The error JavaScript sees: an `Error` with the message, plus `kind`
/// and `inputs` (`ApiError`), so `e.message` reads as it always has.
fn js_error(e: ApiError) -> JsValue {
    let err = js_sys::Error::new(&e.message);
    let field = |value: Result<JsValue, serde_wasm_bindgen::Error>| value.unwrap_or(JsValue::UNDEFINED);
    // Setting a property on a fresh Error can't fail (it isn't frozen).
    let _ = js_sys::Reflect::set(&err, &JsValue::from_str("kind"), &field(serde_wasm_bindgen::to_value(&e.kind)));
    let _ = js_sys::Reflect::set(&err, &JsValue::from_str("inputs"), &field(serde_wasm_bindgen::to_value(&e.inputs)));
    err.into()
}

/// Box with one corner at the origin, sizes in millimetres.
#[wasm_bindgen]
pub fn make_box(width: f64, depth: f64, height: f64) -> Result<JsValue, JsValue> {
    to_js(view_of(BodySpec::Box { width, depth, height }))
}

/// Sphere centred on the origin, radius in millimetres.
#[wasm_bindgen]
pub fn make_sphere(radius: f64) -> Result<JsValue, JsValue> {
    to_js(view_of(BodySpec::Sphere { radius }))
}

/// Cylinder standing on the origin along +Z, sizes in millimetres.
#[wasm_bindgen]
pub fn make_cylinder(radius: f64, height: f64) -> Result<JsValue, JsValue> {
    to_js(view_of(BodySpec::Cylinder { radius, height }))
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
/// come in pairs (a `BadRequest` naming the loop). Everything else is
/// checked by the extrude itself.
pub fn profile_from_input(p: ProfileIn) -> Result<ops::extrude::Profile, ApiError> {
    use ops::extrude::Boundary;
    let convert = |(boundary, b): (usize, BoundaryIn)| match b {
        BoundaryIn::Path { corners, bulges } => {
            if !corners.len().is_multiple_of(2) {
                let inputs = vec![ops::Input::Loop { boundary }];
                return Err(ApiError::new(api_error::ErrorKind::BadRequest, inputs, "profile coordinates must come in x, y pairs".to_string()));
            }
            let corners = corners.as_chunks::<2>().0.iter().map(|&[x, y]| glam::DVec2::new(x, y)).collect();
            Ok(Boundary::Path { corners, bulges })
        }
        BoundaryIn::Circle { center, radius } => Ok(Boundary::Circle { center: center.into(), radius }),
    };
    Ok(ops::extrude::Profile { outer: convert((0, p.outer))?, holes: p.holes.into_iter().enumerate().map(|(k, h)| convert((k + 1, h))).collect::<Result<_, _>>()? })
}

/// Extrudes a profile (see `ProfileIn`) along +Z by `distance`.
#[wasm_bindgen]
pub fn make_extrude(profile: JsValue, distance: f64) -> Result<JsValue, JsValue> {
    let profile: ProfileIn = from_js(profile, "profile", "profile")?;
    to_js(view_of(BodySpec::Extrude { profile, distance }))
}

/// The nearest node of a square grid (`sketch::snap_to_grid`), as `[x, y]`.
#[wasm_bindgen]
pub fn snap_to_grid(x: f64, y: f64, spacing: f64) -> Result<JsValue, JsValue> {
    to_js(sketch::snap_to_grid(glam::DVec2::new(x, y), spacing).map(|p| [p.x, p.y]).map_err(ApiError::from))
}

/// Where a click lands with grid snap off (`sketch::place_freely`): rounded to the largest power of ten no bigger than a pixel (mm), as `[x, y]`.
#[wasm_bindgen]
pub fn place_freely(x: f64, y: f64, pixel: f64) -> Result<JsValue, JsValue> {
    to_js(sketch::place_freely(glam::DVec2::new(x, y), pixel).map(|p| [p.x, p.y]).map_err(ApiError::from))
}

/// A sketch line as the app sends it: `{ a: [x, y], b: [x, y] }`.
#[derive(Debug, Deserialize)]
pub struct LineIn {
    pub a: [f64; 2],
    pub b: [f64; 2],
}

/// A sketch circle as the app sends it: `{ centre: [x, y], radius }`.
#[derive(Debug, Deserialize)]
pub struct CircleIn {
    pub centre: [f64; 2],
    pub radius: f64,
}

/// A sketch arc as the app sends it: `{ start: [x, y], end: [x, y],
/// centre: [x, y] }`, counter-clockwise round the centre from start to end.
#[derive(Debug, Deserialize)]
pub struct ArcIn {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub centre: [f64; 2],
}

/// An outline in the form `make_extrude` takes (`ProfileIn`):
/// `{ outer: loop, holes: [], pieces }`, where `pieces` (which
/// `make_extrude` ignores) says which sketch curve each piece of `outer`
/// came from, in order: the extrude's side of piece i
/// (`{ role: "side", boundary: 0, piece: i }`) is that curve's.
#[derive(Debug, Serialize, PartialEq)]
pub struct ProfileOut {
    pub outer: LoopOut,
    pub holes: Vec<LoopOut>,
    pub pieces: Vec<PieceOut>,
}

/// `{ curve: "line" | "arc" | "circle", index, reversed }`: the sketch's
/// line, arc or circle at `index` in the list given, run backwards (from
/// its `b` or `end`) when `reversed` (`sketch::Source`).
#[derive(Debug, Serialize, PartialEq)]
pub struct PieceOut {
    pub curve: &'static str,
    pub index: usize,
    pub reversed: bool,
}

impl From<sketch::Source> for PieceOut {
    fn from(s: sketch::Source) -> Self {
        let (curve, index) = match s.curve {
            sketch::SketchCurve::Line(i) => ("line", i),
            sketch::SketchCurve::Arc(i) => ("arc", i),
            sketch::SketchCurve::Circle(i) => ("circle", i),
        };
        PieceOut { curve, index, reversed: s.reversed }
    }
}

/// One loop: `{ path: { corners: [x0, y0, …], bulges: [] } }` or
/// `{ circle: { center: [x, y], radius } }`, as `BoundaryIn`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LoopOut {
    Path { corners: Vec<f64>, bulges: Vec<f64> },
    Circle { center: [f64; 2], radius: f64 },
}

/// What a sketch makes: `{ closed: profile }` or `{ open: "why, in words" }`;
/// when its curves close up but break the profile rules, also `invalid`:
/// the sketch's lines, arcs and circles the rules name (`{ input: "line",
/// index }`…, possibly none), so the app can mark them without reading the
/// words (`Open(why, None)` for every other reason).
#[derive(Debug, PartialEq)]
pub enum SketchOutlineOut {
    Closed(ProfileOut),
    Open(String, Option<Vec<ops::Input>>),
}

impl Serialize for SketchOutlineOut {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // A struct, not a map: serde-wasm-bindgen turns a map into a JavaScript Map, which has no `open` key.
        use serde::ser::SerializeStruct;
        match self {
            SketchOutlineOut::Closed(p) => {
                let mut out = s.serialize_struct("SketchOutlineOut", 1)?;
                out.serialize_field("closed", p)?;
                out.end()
            }
            SketchOutlineOut::Open(why, invalid) => {
                // The field count is only a size hint to the serializer (JSON and the WebAssembly bridge ignore it): at most two.
                let mut out = s.serialize_struct("SketchOutlineOut", 2)?;
                out.serialize_field("open", why)?;
                if let Some(curves) = invalid {
                    out.serialize_field("invalid", curves)?;
                }
                out.end()
            }
        }
    }
}

/// `sketch::sketch_outline` in the app's form; lines, circles or arcs
/// breaking the sketch rules are an error.
pub fn sketch_outline_of(lines: &[LineIn], circles: &[CircleIn], arcs: &[ArcIn]) -> Result<SketchOutlineOut, ApiError> {
    let lines: Vec<sketch::Line> = lines.iter().map(|l| sketch::Line { a: l.a.into(), b: l.b.into() }).collect();
    let circles: Vec<sketch::Circle> = circles.iter().map(|c| sketch::Circle { centre: c.centre.into(), radius: c.radius }).collect();
    let arcs: Vec<sketch::Arc> = arcs.iter().map(|a| sketch::Arc { start: a.start.into(), end: a.end.into(), centre: a.centre.into() }).collect();
    match sketch::sketch_outline(&lines, &circles, &arcs)? {
        sketch::SketchOutline::Open(why) => {
            let invalid = match &why {
                sketch::Open::NotAProfile { curves, .. } => Some(
                    curves
                        .iter()
                        .map(|c| match *c {
                            sketch::SketchCurve::Line(index) => ops::Input::Line { index },
                            sketch::SketchCurve::Arc(index) => ops::Input::Arc { index },
                            sketch::SketchCurve::Circle(index) => ops::Input::Circle { index },
                        })
                        .collect(),
                ),
                _ => None,
            };
            Ok(SketchOutlineOut::Open(why.to_string(), invalid))
        }
        sketch::SketchOutline::Closed(profile, sources) => {
            let outer = match profile.outer {
                ops::profile::Boundary::Path { corners, bulges } => LoopOut::Path { corners: corners.iter().flat_map(|p| [p.x, p.y]).collect(), bulges },
                ops::profile::Boundary::Circle { center, radius } => LoopOut::Circle { center: center.into(), radius },
            };
            let pieces = sources.into_iter().map(PieceOut::from).collect();
            Ok(SketchOutlineOut::Closed(ProfileOut { outer, holes: vec![], pieces }))
        }
    }
}

/// The one closed outline a sketch's lines (`[LineIn, …]`), circles
/// (`[CircleIn, …]`) and arcs (`[ArcIn, …]`) make, or why they make none
/// (see `SketchOutlineOut`).
#[wasm_bindgen]
pub fn sketch_outline(lines: JsValue, circles: JsValue, arcs: JsValue) -> Result<JsValue, JsValue> {
    let lines: Vec<LineIn> = from_js(lines, "lines", "sketch lines")?;
    let circles: Vec<CircleIn> = from_js(circles, "circles", "sketch circles")?;
    let arcs: Vec<ArcIn> = from_js(arcs, "arcs", "sketch arcs")?;
    to_js(sketch_outline_of(&lines, &circles, &arcs))
}

/// What to build, in the app's words: the same shapes as `make_box`,
/// `make_cylinder`, `make_sphere` and `make_extrude`. In JavaScript:
/// `{ box: { width, depth, height } }`, `{ cylinder: { radius, height } }`,
/// `{ sphere: { radius } }` or `{ extrude: { profile, distance } }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodySpec {
    Box { width: f64, depth: f64, height: f64 },
    Cylinder { radius: f64, height: f64 },
    Sphere { radius: f64 },
    Extrude { profile: ProfileIn, distance: f64 },
}

/// Builds the body a spec describes (with the same checks as the make_*
/// functions).
pub fn build(spec: BodySpec) -> Result<Body, ApiError> {
    build_meshed(spec).map(|(body, _)| body)
}

/// `build`, also handing back the display mesh the operation's validation
/// made (`ops::finish`).
pub fn build_meshed(spec: BodySpec) -> Result<ops::Meshed, ApiError> {
    let made = match spec {
        BodySpec::Box { width, depth, height } => ops::primitives::make_box_meshed(width, depth, height),
        BodySpec::Cylinder { radius, height } => ops::primitives::make_cylinder_meshed(radius, height),
        BodySpec::Sphere { radius } => ops::primitives::make_sphere_meshed(radius),
        BodySpec::Extrude { profile, distance } => ops::extrude::extrude_meshed(&profile_from_input(profile)?, distance),
    };
    Ok(made?)
}

/// What the make_* functions give the app: the view of the body a spec
/// describes, or the kernel's reason it can't be built (the same message
/// either way round: a bad profile's, an operation's, or tessellation's).
/// Validated and tessellated once, by the operation: the body passed
/// `checked`, so it has no errors to list.
pub fn view_of(spec: BodySpec) -> Result<BodyView, ApiError> {
    let (body, mesh) = build_meshed(spec)?;
    Ok(view_parts(&body, &mesh, vec![]))
}

/// An STL file for the app to download.
#[derive(Debug, Serialize)]
pub struct StlFile {
    /// Binary STL (a Uint8Array in JavaScript).
    #[serde(with = "serde_bytes")]
    pub bytes: Vec<u8>,
    /// Largest rounding of any corner to single precision (mm).
    pub rounding: f64,
    /// Set when that rounding is more than the smallest feature.
    pub warning: Option<String>,
}

/// The body as a binary STL, from its display mesh (the same triangles the
/// viewer shows), with `name` in the file's header.
pub fn stl_of(spec: BodySpec, name: &str) -> Result<StlFile, ApiError> {
    let (_, mesh) = build_meshed(spec)?;
    let out = stl::export(&mesh, name);
    Ok(StlFile { bytes: out.bytes, rounding: out.rounding, warning: out.warning })
}

/// `stl_of` for the app (see `BodySpec`).
#[wasm_bindgen]
pub fn export_stl(spec: JsValue, name: &str) -> Result<JsValue, JsValue> {
    let spec: BodySpec = from_js(spec, "spec", "body")?;
    to_js(stl_of(spec, name))
}

thread_local! {
    /// The bodies the app keeps between calls (`store`). One per kernel
    /// instance: the app's worker has one, each test process its own.
    static STORE: RefCell<store::BodyStore> = RefCell::new(store::BodyStore::new());
}

/// Builds the body a `BodySpec` describes and keeps it; returns its handle
/// (a whole number from 1, never reused). Free it with `body_free`.
#[wasm_bindgen]
pub fn body_build(spec: JsValue) -> Result<f64, JsValue> {
    let spec: BodySpec = from_js(spec, "spec", "body")?;
    STORE.with_borrow_mut(|s| s.build(spec)).map(|h| h as f64).map_err(js_error)
}

/// A kept body's view (`BodyView`), the same as the make_* call gives.
#[wasm_bindgen]
pub fn body_view(body: f64) -> Result<JsValue, JsValue> {
    to_js(store::handle_from_js(body).and_then(|h| STORE.with_borrow(|s| s.view(h))))
}

/// A kept body as binary STL (`StlFile`), the same as `export_stl` gives.
#[wasm_bindgen]
pub fn body_stl(body: f64, name: &str) -> Result<JsValue, JsValue> {
    to_js(store::handle_from_js(body).and_then(|h| STORE.with_borrow(|s| s.stl(h, name))))
}

/// Lets a kept body go; its handle is refused from then on.
#[wasm_bindgen]
pub fn body_free(body: f64) -> Result<(), JsValue> {
    store::handle_from_js(body).and_then(|h| STORE.with_borrow_mut(|s| s.free(h))).map_err(js_error)
}

/// How many bodies the kernel keeps (for the app's tests: what they build
/// they free).
#[wasm_bindgen]
pub fn body_count() -> f64 {
    STORE.with_borrow(|s| s.live()) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{rel_eq, FP_REL};
    use std::f64::consts::{PI, TAU};

    #[test]
    fn sketch_outline_in_the_apps_form() {
        // A 3-4-5 right triangle drawn with its last line backwards: the
        // corners come out as flat pairs in walking order, no bulges, no
        // holes. The walk runs line 1 then line 2, and line 3 from (0, 3)
        // back to (0, 0), the other way from how it was drawn.
        let line = |a: [f64; 2], b: [f64; 2]| LineIn { a, b };
        let lines = [line([0.0, 0.0], [4.0, 0.0]), line([4.0, 0.0], [0.0, 3.0]), line([0.0, 0.0], [0.0, 3.0])];
        let want = ProfileOut { outer: LoopOut::Path { corners: vec![0.0, 0.0, 4.0, 0.0, 0.0, 3.0], bulges: vec![] }, holes: vec![], pieces: vec![
            PieceOut { curve: "line", index: 0, reversed: false },
            PieceOut { curve: "line", index: 1, reversed: false },
            PieceOut { curve: "line", index: 2, reversed: true },
        ] };
        assert_eq!(sketch_outline_of(&lines, &[], &[]).unwrap(), SketchOutlineOut::Closed(want));
        // Its closed outline extrudes: area ½·4·3 = 6, so 2 mm deep is 12 mm³.
        let SketchOutlineOut::Closed(p) = sketch_outline_of(&lines, &[], &[]).unwrap() else { panic!() };
        let LoopOut::Path { corners, .. } = p.outer else { panic!() };
        let profile = ops::profile::Profile::polygon(corners.chunks(2).map(|c| glam::DVec2::new(c[0], c[1])).collect(), vec![]);
        let body = ops::extrude::extrude(&profile, 2.0).unwrap();
        assert!(rel_eq(view_body(&body).unwrap().volume, 12.0, FP_REL));
        // Open sketches say why in words; bad lines are errors.
        assert_eq!(
            sketch_outline_of(&lines[..2], &[], &[]).unwrap(),
            SketchOutlineOut::Open("the end at (0, 0) is not joined to another line or arc".into(), None)
        );
        assert_eq!(sketch_outline_of(&[], &[], &[]).unwrap(), SketchOutlineOut::Open("the sketch has no lines, arcs or circles yet".into(), None));
        // The first line (index 0, "line 1" as a person counts) is named.
        let e = sketch_outline_of(&[line([0.0, 0.0], [0.0, 0.0])], &[], &[]).unwrap_err();
        assert_eq!(e.message, "line 1 must be between 0.001 and 1000000 mm long, got 0");
        assert_eq!((e.kind, e.inputs), (api_error::ErrorKind::InvalidInput, vec![ops::Input::Line { index: 0 }]));
        // The second, "line 2", is index 1.
        let e = sketch_outline_of(&[line([0.0, 0.0], [1.0, 0.0]), line([1.0, 0.0], [1.0, 0.0])], &[], &[]).unwrap_err();
        assert!(e.message.starts_with("line 2 must be"), "{e}");
        assert_eq!(e.inputs, vec![ops::Input::Line { index: 1 }]);
    }

    #[test]
    fn a_sketched_pie_slice_in_the_apps_form_extrudes_worked_by_hand() {
        // (0,0) → (10,0), a quarter arc round the origin to (0,10), back to
        // (0,0). The outline is a path with the arc's bulge tan(90°/4) =
        // √2 − 1 on its second piece.
        let lines = [LineIn { a: [0.0, 0.0], b: [10.0, 0.0] }, LineIn { a: [0.0, 10.0], b: [0.0, 0.0] }];
        let arcs = [ArcIn { start: [10.0, 0.0], end: [0.0, 10.0], centre: [0.0, 0.0] }];
        let SketchOutlineOut::Closed(ProfileOut { outer: LoopOut::Path { corners, bulges }, holes, pieces }) = sketch_outline_of(&lines, &[], &arcs).unwrap() else { panic!() };
        assert_eq!((corners.clone(), holes), (vec![0.0, 0.0, 10.0, 0.0, 0.0, 10.0], vec![]));
        // Pieces: line 0, the arc, then line 1, each the way it was drawn.
        let piece = |curve, index| PieceOut { curve, index, reversed: false };
        assert_eq!(pieces, vec![piece("line", 0), piece("arc", 0), piece("line", 1)]);
        assert!(bulges[0] == 0.0 && rel_eq(bulges[1], 2f64.sqrt() - 1.0, FP_REL) && bulges[2] == 0.0, "{bulges:?}");
        // Extruded 4 mm: V = ¼π·10²·4 = 100π. A = the two quarter discs
        // 2 × 25π, the two flat sides 2 × 10·4 = 80 and the curved side
        // ¼·2π·10·4 = 20π: 70π + 80. Three corners top and bottom, three
        // edges round each and three up the sides, five faces.
        let profile = profile_from_input(ProfileIn { outer: BoundaryIn::Path { corners, bulges }, holes: vec![] }).unwrap();
        let v = view_body(&ops::extrude::extrude(&profile, 4.0).unwrap()).unwrap();
        assert!(rel_eq(v.volume, 100.0 * PI, FP_REL) && rel_eq(v.area, 70.0 * PI + 80.0, FP_REL), "{} {}", v.volume, v.area);
        assert_eq!((v.vertices, v.edges, v.faces), (6, 9, 5));
        // A bad arc is an error naming it.
        let bad = [ArcIn { start: [10.0, 0.0], end: [0.0, 10.0], centre: [1.0, 0.0] }];
        let e = sketch_outline_of(&lines, &[], &bad).unwrap_err();
        assert!(e.message.starts_with("arc 1 has its centre 0.7071"));
        assert_eq!(e.inputs, vec![ops::Input::Arc { index: 0 }]);
    }

    #[test]
    fn an_outline_that_breaks_the_profile_rules_names_its_curves_in_the_apps_form() {
        let line = |a: [f64; 2], b: [f64; 2]| LineIn { a, b };
        // A bow tie drawn out of order, one line backwards: corners (0,0),
        // (10,10), (10,0), (0,10). The diagonals (0,0)–(10,10) (given as
        // line 2) and (10,0)–(0,10) (given as line 0, backwards) cross at
        // (5,5), so those two lines are named, and the edges (lines 1 and 3)
        // aren't.
        let bow = [line([0.0, 10.0], [10.0, 0.0]), line([10.0, 10.0], [10.0, 0.0]), line([0.0, 0.0], [10.0, 10.0]), line([0.0, 10.0], [0.0, 0.0])];
        let SketchOutlineOut::Open(why, Some(mut named)) = sketch_outline_of(&bow, &[], &[]).unwrap() else { panic!() };
        assert!(why.starts_with("the curves close up but are not a valid outline: "), "{why}");
        named.sort_by_key(|i| format!("{i:?}"));
        assert_eq!(named, vec![ops::Input::Line { index: 0 }, ops::Input::Line { index: 2 }]);
        // A cusp: (0,0) → (40,0) → (20,0) doubles back at (40,0), where line
        // 0 meets line 1: both named.
        let cusp = [line([0.0, 0.0], [40.0, 0.0]), line([40.0, 0.0], [20.0, 0.0]), line([20.0, 0.0], [0.0, 30.0]), line([0.0, 30.0], [0.0, 0.0])];
        let SketchOutlineOut::Open(_, Some(mut named)) = sketch_outline_of(&cusp, &[], &[]).unwrap() else { panic!() };
        named.sort_by_key(|i| format!("{i:?}"));
        assert_eq!(named, vec![ops::Input::Line { index: 0 }, ops::Input::Line { index: 1 }]);
        // The same half circle twice: arcs, by their own index.
        let half = || ArcIn { start: [5.0, 0.0], end: [-5.0, 0.0], centre: [0.0, 0.0] };
        let SketchOutlineOut::Open(_, Some(named)) = sketch_outline_of(&[], &[], &[half(), half()]).unwrap() else { panic!() };
        assert!(!named.is_empty() && named.iter().all(|i| matches!(i, ops::Input::Arc { index: 0 | 1 })), "{named:?}");
        // Over the wire: `invalid` beside `open`, and only for this reason.
        let json = serde_json::to_value(sketch_outline_of(&cusp, &[], &[]).unwrap()).unwrap();
        assert_eq!(json["invalid"], serde_json::json!([{ "input": "line", "index": 0 }, { "input": "line", "index": 1 }]));
        assert!(json["open"].is_string());
        let loose = serde_json::to_value(sketch_outline_of(&cusp[..2], &[], &[]).unwrap()).unwrap();
        assert_eq!(loose.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["open"]);
    }

    #[test]
    fn a_sketched_circle_in_the_apps_form_extrudes_to_pi_r_squared_h() {
        // One circle round (3, -4), radius 5: the outline is that circle in
        // make_extrude's form, the same numbers back.
        let c = CircleIn { centre: [3.0, -4.0], radius: 5.0 };
        let out = sketch_outline_of(&[], &[c], &[]).unwrap();
        assert_eq!(out, SketchOutlineOut::Closed(ProfileOut { outer: LoopOut::Circle { center: [3.0, -4.0], radius: 5.0 }, holes: vec![], pieces: vec![PieceOut { curve: "circle", index: 0, reversed: false }] }));
        // Extruded 2 mm: V = πr²h = π·25·2 = 50π; A = two discs 2πr² = 50π
        // plus the side 2πr·h = 20π, so 70π. One cylinder side, two discs;
        // each rim is one closed circle edge starting and ending at its one
        // vertex, as the cylinder primitive's are.
        let SketchOutlineOut::Closed(ProfileOut { outer: LoopOut::Circle { center, radius }, .. }) = out else { panic!() };
        let profile = profile_from_input(ProfileIn { outer: BoundaryIn::Circle { center, radius }, holes: vec![] }).unwrap();
        let v = view_body(&ops::extrude::extrude(&profile, 2.0).unwrap()).unwrap();
        assert!(rel_eq(v.volume, 50.0 * PI, FP_REL) && rel_eq(v.area, 70.0 * PI, FP_REL), "{} {}", v.volume, v.area);
        assert_eq!((v.vertices, v.edges, v.faces), (2, 2, 3));
        // A circle with a line, two circles: several loops; a bad circle is an error.
        let two = [CircleIn { centre: [0.0, 0.0], radius: 1.0 }, CircleIn { centre: [9.0, 0.0], radius: 1.0 }];
        assert_eq!(
            sketch_outline_of(&[], &two, &[]).unwrap(),
            SketchOutlineOut::Open("the sketch makes 2 separate loops; for now a sketch makes one outline".into(), None)
        );
        assert_eq!(
            sketch_outline_of(&[], &[CircleIn { centre: [0.0, 0.0], radius: 0.0 }], &[]).unwrap_err(),
            ApiError::new(api_error::ErrorKind::InvalidInput, vec![ops::Input::Circle { index: 0 }], "circle 1's radius must be between 0.001 and 500000 mm, got 0".into())
        );
    }

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
    fn view_of_each_spec_by_hand() {
        // What make_box, make_cylinder, make_sphere and make_extrude hand
        // to JavaScript. Box 10 × 20 × 30: V = 6000, A = 2(200 + 600 +
        // 300) = 2200. Cylinder r = 1, h = 2: V = π·1²·2 = 2π, A = two
        // caps 2π + side 2π·1·2 = 6π (swapping r and h would give 4π, 12π).
        // Sphere r = 3: V = 4/3·π·27 = 36π. The L of
        // l_bracket_view_reports_hand_worked_numbers extruded 2: V = 102.
        let v = view_of(BodySpec::Box { width: 10.0, depth: 20.0, height: 30.0 }).unwrap();
        assert!(rel_eq(v.volume, 6000.0, FP_REL) && rel_eq(v.area, 2200.0, FP_REL) && v.errors.is_empty(), "{} {}", v.volume, v.area);
        let v = view_of(BodySpec::Cylinder { radius: 1.0, height: 2.0 }).unwrap();
        assert!(rel_eq(v.volume, 2.0 * PI, FP_REL) && rel_eq(v.area, 6.0 * PI, FP_REL), "{} {}", v.volume, v.area);
        let v = view_of(BodySpec::Sphere { radius: 3.0 }).unwrap();
        assert!(rel_eq(v.volume, 36.0 * PI, FP_REL) && v.face_types == ["sphere"; 2], "{}", v.volume);
        let outer = vec![0.0, 0.0, 10.0, 0.0, 10.0, 3.0, 3.0, 3.0, 3.0, 10.0, 0.0, 10.0];
        let l = |outer: Vec<f64>| ProfileIn { outer: BoundaryIn::Path { corners: outer, bulges: vec![] }, holes: vec![] };
        let v = view_of(BodySpec::Extrude { profile: l(outer), distance: 2.0 }).unwrap();
        assert!(rel_eq(v.volume, 102.0, FP_REL) && v.faces == 8, "{}", v.volume);
        // Failures carry the reason the app shows: the kernel's for a bad
        // size, the profile reader's for odd coordinates.
        let e = view_of(BodySpec::Box { width: 1.0, depth: -1.0, height: 1.0 }).err().unwrap();
        assert!(e.message.contains("must be"));
        assert_eq!(e.inputs, vec![ops::Input::Param { name: "depth" }]);
        let odd = view_of(BodySpec::Extrude { profile: l(vec![0.0; 5]), distance: 1.0 }).err().unwrap();
        assert_eq!(odd.message, "profile coordinates must come in x, y pairs");
        assert_eq!((odd.kind, odd.inputs), (api_error::ErrorKind::BadRequest, vec![ops::Input::Loop { boundary: 0 }]));
    }

    #[test]
    fn the_app_s_calls_tessellate_a_body_once() {
        // Regression (a 1,996-hole plate took 45 s natively): make_extrude
        // validated the body in the operation, then tessellated it for the
        // view and validated it again (another tessellation), and STL export
        // rebuilt and retessellated it. Now the operation's own validation
        // mesh is the one shown and exported.
        let count = |f: &dyn Fn()| {
            tessellate::TESSELLATIONS.with(|n| n.set(0));
            f();
            tessellate::TESSELLATIONS.with(|n| n.get())
        };
        let plate = || BodySpec::Extrude {
            profile: ProfileIn {
                outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0], bulges: vec![] },
                holes: vec![BoundaryIn::Circle { center: [5.0, 5.0], radius: 2.0 }],
            },
            distance: 3.0,
        };
        assert_eq!(count(&|| drop(view_of(plate()).unwrap())), 1);
        assert_eq!(count(&|| drop(stl_of(plate(), "plate").unwrap())), 1);
        let body = build(plate()).unwrap();
        assert_eq!(count(&|| drop(view_body(&body).unwrap())), 1);
        // A body that fails before the mesh checks is tessellated once, to show it.
        let mut broken = body.clone();
        broken.vertices[0].point.z += 0.5;
        assert_eq!(count(&|| assert!(!view_body(&broken).unwrap().errors.is_empty())), 1);
    }

    #[test]
    fn view_of_shows_what_validating_the_body_again_would() {
        // Skipping the second validation changes nothing the app sees: the
        // view of a spec is the view of its body validated afresh, field for
        // field (compared as the JSON the app receives).
        let json = |v: BodyView| serde_json::to_string(&v).unwrap();
        let specs = || {
            vec![
                BodySpec::Box { width: 10.0, depth: 20.0, height: 30.0 },
                BodySpec::Cylinder { radius: 1.0, height: 2.0 },
                BodySpec::Sphere { radius: 3.0 },
                BodySpec::Extrude {
                    profile: ProfileIn {
                        outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 9.0, 0.0, 9.0, 9.0, 0.0, 9.0], bulges: vec![0.0, 0.3, 0.0, 0.0] },
                        holes: vec![BoundaryIn::Circle { center: [3.0, 3.0], radius: 1.0 }],
                    },
                    distance: 2.0,
                },
            ]
        };
        for (a, b) in specs().into_iter().zip(specs()) {
            assert_eq!(json(view_of(a).unwrap()), json(view_body(&build(b).unwrap()).unwrap()));
        }
    }

    #[test]
    fn view_reports_validation_errors_instead_of_hiding_them() {
        let mut body = ops::primitives::make_box(1.0, 1.0, 1.0).unwrap();
        body.vertices[7].point.z += 0.5;
        let v = view_body(&body).unwrap();
        assert!(v.errors.iter().any(|e| e.contains("vertex 7")), "{:?}", v.errors);
    }

    #[test]
    fn cylinder_view_reports_hand_worked_numbers() {
        // Radius 20, height 20 (the app's default 40 wide cylinder): the
        // view's numbers are exact, V = π·400·20 = 8000π, A = 2·400π +
        // 2π·20·20 = 1600π. 2 seam vertices, 2 circle edges, 2 caps + 1 side.
        let body = ops::primitives::make_cylinder(20.0, 20.0).unwrap();
        let v = view_body(&body).unwrap();
        assert!(rel_eq(v.volume, 8000.0 * PI, FP_REL), "{} vs {}", v.volume, 8000.0 * PI);
        assert!(rel_eq(v.area, 1600.0 * PI, FP_REL), "{} vs {}", v.area, 1600.0 * PI);
        assert_eq!((v.vertices, v.edges, v.faces), (2, 2, 3));
        assert!(v.errors.is_empty());
        // What's drawn is the display mesh: display chords may sag 0.01, so
        // each turns at most 2·acos(1 − 0.01/20) = 0.063249 rad and a turn
        // needs ceil(2π / 0.063249) = ceil(99.34) = 100 chords: a 100-sided
        // prism, each cap 100 triangles of ½·r²·sin(2π/100).
        let mesh = tessellate(&body, &TessOptions::DISPLAY).unwrap();
        let cap = 50.0 * 400.0 * fmath::sin(TAU / 100.0);
        assert!(rel_eq(mesh.signed_volume(), cap * 20.0, FP_REL), "{} vs {}", mesh.signed_volume(), cap * 20.0);
        // Bad sizes come back as clean errors.
        assert!(ops::primitives::make_cylinder(-1.0, 1.0).is_err());
    }

    #[test]
    fn sphere_view_reports_hand_worked_numbers() {
        // Radius 20: V = 4/3·π·8000, A = 4π·400 = 1600π. One vertex on the
        // equator, the equator edge, two hemispheres.
        let v = view_body(&ops::primitives::make_sphere(20.0).unwrap()).unwrap();
        assert!(rel_eq(v.volume, 32000.0 / 3.0 * PI, FP_REL), "{}", v.volume);
        assert!(rel_eq(v.area, 1600.0 * PI, FP_REL), "{}", v.area);
        assert_eq!((v.vertices, v.edges, v.faces), (1, 1, 2));
        assert!(v.errors.is_empty());
        assert!(ops::primitives::make_sphere(0.0).is_err());
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
    fn views_name_each_face_surface_and_edge_curve() {
        // A box is six planes bounded by twelve lines. A cylinder
        // (primitives.rs) is the bottom cap, the top cap, then the side,
        // bounded by two circles; a sphere two hemispheres on one circle.
        // An L extruded: 8 planar faces, 18 straight edges.
        let types = |b: &Body| {
            let v = view_body(b).unwrap();
            (v.face_types, v.edge_types)
        };
        assert_eq!(types(&ops::primitives::make_box(1.0, 2.0, 3.0).unwrap()), (vec!["plane"; 6], vec!["line"; 12]));
        assert_eq!(types(&ops::primitives::make_cylinder(2.0, 1.0).unwrap()), (vec!["plane", "plane", "cylinder"], vec!["circle"; 2]));
        assert_eq!(types(&ops::primitives::make_sphere(2.0).unwrap()), (vec!["sphere"; 2], vec!["circle"]));
        let outer = vec![0.0, 0.0, 10.0, 0.0, 10.0, 3.0, 3.0, 3.0, 3.0, 10.0, 0.0, 10.0];
        let profile = profile_from_input(ProfileIn { outer: BoundaryIn::Path { corners: outer, bulges: vec![] }, holes: vec![] }).unwrap();
        assert_eq!(types(&ops::extrude::extrude(&profile, 2.0).unwrap()), (vec!["plane"; 8], vec!["line"; 18]));
        // A plate with a round hole: its side is a cylinder and the hole's rims are circles.
        let square = BoundaryIn::Path { corners: vec![0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0], bulges: vec![] };
        let hole = BoundaryIn::Circle { center: [5.0, 5.0], radius: 2.0 };
        let plate = profile_from_input(ProfileIn { outer: square, holes: vec![hole] }).unwrap();
        let (faces, edges) = types(&ops::extrude::extrude(&plate, 1.0).unwrap());
        assert_eq!((faces.iter().filter(|t| **t == "cylinder").count(), faces.len()), (1, 7));
        assert_eq!((edges.iter().filter(|t| **t == "circle").count(), edges.len()), (2, 14));
    }

    #[test]
    fn a_sketched_slot_names_its_faces_by_the_curves_drawn_worked_by_hand() {
        // The slot of sketch.rs's each_piece_names_the_arc_it_came_from:
        // radius 5 round (0, 5) and (20, 5), walked clockwise, so its
        // pieces are line 0, arc 1 backwards, line 1 backwards, arc 0
        // backwards. Extruded by 4 from the outline as the app sends it,
        // the side of piece 1 is arc 1's wall, the left half circle: π·5·4
        // = 20π, its centroid 2r/π = 10/π left of (0, 5), half way up.
        // Caps: 20·10 + 25π, centred (10, 5) by symmetry.
        let lines = [LineIn { a: [20.0, 0.0], b: [0.0, 0.0] }, LineIn { a: [20.0, 10.0], b: [0.0, 10.0] }];
        let arcs = [ArcIn { start: [20.0, 0.0], end: [20.0, 10.0], centre: [20.0, 5.0] }, ArcIn { start: [0.0, 10.0], end: [0.0, 0.0], centre: [0.0, 5.0] }];
        let SketchOutlineOut::Closed(ProfileOut { outer: LoopOut::Path { corners, bulges }, pieces, .. }) = sketch_outline_of(&lines, &[], &arcs).unwrap() else { panic!() };
        assert_eq!((pieces[1].curve, pieces[1].index, pieces[1].reversed), ("arc", 1, true));
        let profile = profile_from_input(ProfileIn { outer: BoundaryIn::Path { corners, bulges }, holes: vec![] }).unwrap();
        let v = view_body(&ops::extrude::extrude(&profile, 4.0).unwrap()).unwrap();
        let face = |role: FaceRoleOut| v.face_roles.iter().position(|r| r.as_ref() == Some(&role)).unwrap();
        let only = |role| FaceRoleOut { role, boundary: None, piece: None };
        let side = |piece| FaceRoleOut { role: "side", boundary: Some(0), piece: Some(piece) };
        let near = |got: [f64; 3], want: [f64; 3]| (0..3).all(|k| (got[k] - want[k]).abs() <= 1e-12 * want[k].abs().max(1.0));
        let left = face(side(1));
        assert!(rel_eq(v.face_areas[left], 20.0 * PI, FP_REL) && near(v.face_centroids[left], [-10.0 / PI, 5.0, 2.0]), "{:?}", v.face_centroids[left]);
        let right = face(side(3));
        assert!(near(v.face_centroids[right], [20.0 + 10.0 / PI, 5.0, 2.0]), "{:?}", v.face_centroids[right]);
        let start = face(only("start"));
        assert!(rel_eq(v.face_areas[start], 200.0 + 25.0 * PI, FP_REL) && near(v.face_centroids[start], [10.0, 5.0, 0.0]));
        // In JavaScript: { role: "side", boundary: 0, piece: 1 } and { role: "start" }.
        assert_eq!(serde_json::to_string(&v.face_roles[left]).unwrap(), r#"{"role":"side","boundary":0,"piece":1}"#);
        assert_eq!(serde_json::to_string(&v.face_roles[start]).unwrap(), r#"{"role":"start"}"#);
        // A body built by hand has no roles.
        assert!(view_body(&fixtures::hand_cube()).unwrap().face_roles.iter().all(Option::is_none));
    }

    /// Each edge's two faces as role words ("side" with its loop and piece),
    /// sorted, for a body the primitives or an extrude made.
    fn edge_roles(v: &BodyView) -> Vec<[String; 2]> {
        let word = |f: usize| {
            let r = v.face_roles[f].as_ref().unwrap();
            match (r.boundary, r.piece) {
                (Some(b), Some(p)) => format!("side {b}.{p}"),
                _ => r.role.to_string(),
            }
        };
        let mut pairs: Vec<[String; 2]> = v.edge_faces.iter().map(|p| p.unwrap()).map(|[f, g]| [word(f), word(g)]).collect();
        pairs.sort();
        pairs
    }

    #[test]
    fn each_edge_joins_two_faces_worked_by_hand() {
        // A box's 12 edges each join two faces at right angles: the bottom
        // and the top with each of front, back, left and right (8), and
        // front and back with left and right (4); never two opposite faces.
        // Which comes first depends only on which way the edge runs, so the
        // check here is on each pair as a set.
        let v = view_of(BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 }).unwrap();
        let mut sets: Vec<[String; 2]> = edge_roles(&v).into_iter().map(|mut p| { p.sort(); p }).collect();
        sets.sort();
        let mut want: Vec<[String; 2]> = vec![];
        for cap in ["bottom", "top"] {
            for wall in ["back", "front", "left", "right"] {
                let mut p = [cap.to_string(), wall.to_string()];
                p.sort();
                want.push(p);
            }
        }
        for a in ["back", "front"] {
            for b in ["left", "right"] {
                want.push([a.to_string(), b.to_string()]);
            }
        }
        want.sort();
        assert_eq!(sets, want);
        // A cylinder: its two rims, bottom with the side and the side with
        // the top (no seam edge). A sphere: one edge, the equator.
        let v = view_of(BodySpec::Cylinder { radius: 1.0, height: 2.0 }).unwrap();
        let mut sets: Vec<[String; 2]> = edge_roles(&v).into_iter().map(|mut p| { p.sort(); p }).collect();
        sets.sort();
        assert_eq!(sets, [["bottom".to_string(), "side".to_string()], ["side".to_string(), "top".to_string()]]);
        let v = view_of(BodySpec::Sphere { radius: 3.0 }).unwrap();
        let mut sets: Vec<[String; 2]> = edge_roles(&v).into_iter().map(|mut p| { p.sort(); p }).collect();
        sets.sort();
        assert_eq!(sets, [["lower".to_string(), "upper".to_string()]]);
    }

    /// An upright edge: the corner it stands on, and its two faces as (loop, piece).
    type Upright = ([f64; 2], [(usize, usize); 2]);

    /// For an extrude of these loops by 10: each upright edge (from the
    /// start cap to the end cap) by the corner it stands on, with its two
    /// faces as (loop, piece), first face first.
    fn uprights(outer: Vec<f64>, bulges: Vec<f64>, holes: Vec<Vec<f64>>) -> Vec<Upright> {
        let holes = holes.into_iter().map(|corners| BoundaryIn::Path { corners, bulges: vec![] }).collect();
        let profile = profile_from_input(ProfileIn { outer: BoundaryIn::Path { corners: outer, bulges }, holes }).unwrap();
        let body = ops::extrude::extrude(&profile, 10.0).unwrap();
        let v = view_body(&body).unwrap();
        let piece = |f: usize| {
            let r = v.face_roles[f].as_ref().unwrap();
            (r.boundary.unwrap(), r.piece.unwrap())
        };
        let mut out = vec![];
        for (e, edge) in body.edges.iter().enumerate() {
            let (a, b) = (body.vertices[edge.start].point, body.vertices[edge.end].point);
            if a.z == b.z {
                continue; // on a cap
            }
            // Every upright runs up, from the start cap to the end cap.
            assert_eq!((a.z, b.z, a.x, a.y), (0.0, 10.0, b.x, b.y), "edge {e}");
            let [f, g] = v.edge_faces[e].unwrap();
            out.push(([a.x, a.y], [piece(f), piece(g)]));
        }
        out.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap());
        out
    }

    #[test]
    fn an_upright_edge_names_the_side_before_it_first_worked_by_hand() {
        // A 40 × 30 rectangle given counter-clockwise: piece 0 runs (0, 0)
        // to (40, 0), 1 up the right, 2 back along the top, 3 down the left.
        // Going round with the solid on the left, seen from the end cap,
        // the corner (40, 0) comes after piece 0 and before piece 1, and so
        // on round.
        let ccw = vec![0.0, 0.0, 40.0, 0.0, 40.0, 30.0, 0.0, 30.0];
        assert_eq!(
            uprights(ccw, vec![], vec![]),
            [([0.0, 0.0], [(0, 3), (0, 0)]), ([0.0, 30.0], [(0, 2), (0, 3)]), ([40.0, 0.0], [(0, 0), (0, 1)]), ([40.0, 30.0], [(0, 1), (0, 2)])]
        );
        // The same rectangle given clockwise from (0, 0): piece 0 runs up
        // the left, 1 along the top, 2 down the right, 3 back along the
        // bottom. Counter-clockwise, (40, 0) comes after the bottom (piece
        // 3) and before the right (piece 2): the given order is turned, the
        // pieces keep their given numbers.
        let cw = vec![0.0, 0.0, 0.0, 30.0, 40.0, 30.0, 40.0, 0.0];
        assert_eq!(
            uprights(cw, vec![], vec![]),
            [([0.0, 0.0], [(0, 0), (0, 3)]), ([0.0, 30.0], [(0, 1), (0, 0)]), ([40.0, 0.0], [(0, 3), (0, 2)]), ([40.0, 30.0], [(0, 2), (0, 1)])]
        );
        // A half disc of radius 5: piece 0 the line (−5, 0) to (5, 0), piece
        // 1 the arc back over the top (bulge 1, a half turn). Its two sides
        // meet twice, so only the order tells the uprights apart: at (5, 0)
        // the line comes first, at (−5, 0) the arc.
        assert_eq!(
            uprights(vec![-5.0, 0.0, 5.0, 0.0], vec![0.0, 1.0], vec![]),
            [([-5.0, 0.0], [(0, 1), (0, 0)]), ([5.0, 0.0], [(0, 0), (0, 1)])]
        );
        // A square hole (10, 10) to (20, 20) given counter-clockwise in a 30
        // × 30 plate: pieces 0 bottom, 1 right, 2 top, 3 left. With the
        // solid on the left the hole is walked clockwise, every piece
        // backwards: (10, 10) up the left to (10, 20), along the top to
        // (20, 20), down the right, back along the bottom. So (10, 20) comes
        // after piece 3 and before piece 2, and (10, 10) after piece 0 and
        // before piece 3.
        let plate = vec![0.0, 0.0, 30.0, 0.0, 30.0, 30.0, 0.0, 30.0];
        let hole = vec![10.0, 10.0, 20.0, 10.0, 20.0, 20.0, 10.0, 20.0];
        let got: Vec<_> = uprights(plate, vec![], vec![hole]).into_iter().filter(|(_, p)| p[0].0 == 1).collect();
        assert_eq!(
            got,
            [([10.0, 10.0], [(1, 0), (1, 3)]), ([10.0, 20.0], [(1, 3), (1, 2)]), ([20.0, 10.0], [(1, 1), (1, 0)]), ([20.0, 20.0], [(1, 2), (1, 1)])]
        );
    }

    #[test]
    fn an_edge_not_used_once_each_way_has_no_pair() {
        // The hand-built cube: every edge used once each way.
        let cube = fixtures::hand_cube();
        let pairs = |b: &Body| b.edge_faces().iter().map(|u| edge_pair(u)).collect::<Vec<_>>();
        assert!(pairs(&cube).iter().all(Option::is_some));
        // Broken on purpose: a face taken away leaves its four edges used
        // once; the other eight keep their pairs.
        let mut open = cube.clone();
        open.faces.pop();
        let p = pairs(&open);
        assert_eq!((p.iter().filter(|x| x.is_none()).count(), p.len()), (4, 12));
        // One use flipped: that edge is used twice the same way.
        let mut flipped = cube.clone();
        let c = &mut flipped.faces[0].loops[0].coedges[0];
        c.reversed = !c.reversed;
        let e = c.edge;
        assert_eq!(pairs(&flipped)[e], None);
        // A third use: a loop listed twice.
        let mut thrice = cube.clone();
        let again = thrice.faces[0].loops[0].clone();
        thrice.faces[0].loops.push(again);
        assert_eq!(pairs(&thrice)[e], None);
        // And the order: the face running the edge forwards comes first,
        // whichever way round the uses are listed.
        let fwd = topology::Coedge { edge: 0, reversed: false };
        let rev = topology::Coedge { edge: 0, reversed: true };
        assert_eq!(edge_pair(&[(3, fwd), (5, rev)]), Some([3, 5]));
        assert_eq!(edge_pair(&[(3, rev), (5, fwd)]), Some([5, 3]));
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
        // Each names its loop: the outer one is 0, hole k is k + 1.
        let loop_of = |p: ProfileIn| profile_from_input(p).unwrap_err().inputs;
        assert_eq!(loop_of(ProfileIn { outer: path(5), holes: vec![] }), vec![ops::Input::Loop { boundary: 0 }]);
        assert_eq!(loop_of(ProfileIn { outer: path(6), holes: vec![path(6), path(3)] }), vec![ops::Input::Loop { boundary: 2 }]);
        // Wrong bulge counts reach the kernel's own check as a clean error.
        let p = profile_from_input(ProfileIn {
            outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0], bulges: vec![0.0] },
            holes: vec![],
        })
        .unwrap();
        assert!(matches!(ops::extrude::extrude(&p, 1.0), Err(ops::KernelError::InvalidInput { .. })));
    }

    #[test]
    fn stl_of_each_kind_by_hand() {
        // A 40 × 30 × 20 box: 12 triangles, 84 + 12 × 50 = 684 bytes; a
        // cylinder and sphere: whatever their meshes hold, 84 + 50 n bytes
        // with n the count in the file; an extruded L (6 corners): 6 side
        // faces of 2 triangles plus 2 caps of 6 − 2 = 4 triangles each = 20
        // triangles, 84 + 20 × 50 = 1084 bytes.
        let size = |f: &StlFile| f.bytes.len();
        let count = |f: &StlFile| u32::from_le_bytes(f.bytes[80..84].try_into().unwrap()) as usize;
        let b = stl_of(BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 }, "box").unwrap();
        assert_eq!((size(&b), count(&b), b.rounding, b.warning.clone()), (684, 12, 0.0, None));
        for spec in [BodySpec::Cylinder { radius: 20.0, height: 20.0 }, BodySpec::Sphere { radius: 20.0 }] {
            let f = stl_of(spec, "round").unwrap();
            assert_eq!(size(&f), 84 + 50 * count(&f));
            assert!(f.warning.is_none());
        }
        let l = ProfileIn {
            outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 4.0, 0.0, 4.0, 1.0, 1.0, 1.0, 1.0, 3.0, 0.0, 3.0], bulges: vec![] },
            holes: vec![],
        };
        let e = stl_of(BodySpec::Extrude { profile: l, distance: 2.0 }, "L").unwrap();
        assert_eq!((count(&e), size(&e)), (20, 1084));
        // Bad shapes give the kernel's reason, not a file.
        assert!(stl_of(BodySpec::Box { width: -1.0, depth: 1.0, height: 1.0 }, "bad").unwrap_err().message.contains("must be"));
    }
}
