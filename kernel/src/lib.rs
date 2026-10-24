//! SpindleLabs geometry kernel.
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
//! - `body_build`, `body_view`, `body_stl`, `body_step`, `body_free`, `body_count`,
//!   `js_error` and `from_js`: `packages/testing/journeys/body-store.journey.ts`
//!   (a stored 40 × 30 × 20 box's volume is 24000 and its view and STL are
//!   `make_box`'s and `export_stl`'s, and its STEP file has the box's
//!   eight hand-worked corners; the count goes up by one and back;
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
pub mod step_write;
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
use glam::DVec3;
use placed::Placed;
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
    /// The smallest axis-aligned box round the body in the world, [low,
    /// high] corners (`Placed::bounds`: exact for lines, circles and arcs,
    /// a sphere face boxed by its whole sphere). What a golden model's
    /// hand-worked box is checked against (step 28a).
    pub bounds: [[f64; 3]; 2],
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
    /// Each planar face's outward unit normal [x, y, z] in the world, by
    /// face index; null for a curved face. With the face's centroid (which
    /// lies on a plane face) it gives the face's plane exactly, as a sketch
    /// on that face needs it (step 26), not as the display mesh's
    /// single-precision normals would.
    pub face_normals: Vec<Option<[f64; 3]>>,
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
    /// Each vertex's point [x, y, z] in the world, exact (placed in double
    /// precision, like `face_centroids`): what a sketch point snapped to a
    /// face's corner lands on and follows (step 26f), where the display
    /// mesh's single-precision edge lines would be micrometres off.
    pub vertex_points: Vec<[f64; 3]>,
    /// Each edge's start and end vertex, by edge index (the edge's own
    /// direction, as in `edge_faces`); the same vertex twice for a closed
    /// edge (a whole circle, whose one vertex is only where its seam is).
    pub edge_vertices: Vec<[usize; 2]>,
    /// The point halfway along each edge's parameter, in the world: a line's
    /// midpoint, an arc's middle (half its turn, since a circle's parameter
    /// is its angle). Meaningless for a closed edge, which has no ends.
    pub edge_middles: Vec<[f64; 3]>,
    /// Each circular edge's centre in the world; null for a line.
    pub edge_centres: Vec<Option<[f64; 3]>>,
    /// The largest tolerance any vertex or edge of the body carries (B0
    /// decision 5, step 31a): LINEAR for every body the kernel makes until
    /// intersections grow them (32a), never past `tolerance::TOL_INPUT_MAX`
    /// in a body that passed validation. What a golden model's tolerance
    /// is checked against (step 28a).
    pub tolerance: f64,
    /// Empty when the body passed validation; otherwise one line per error,
    /// grouped by category and starting with it ("geometry: vertex 7 is …",
    /// `validate::report_lines`).
    pub errors: Vec<String>,
}

/// The view of any body, validating it first (its `errors` list what is
/// wrong). Validation tessellates the body anyway, so its mesh is reused.
pub fn view_body(body: &Body) -> Result<BodyView, ApiError> {
    view_at(body, &geom::Placement::IDENTITY)
}

/// `view_body` of a placed body: its local geometry validated, the view
/// carried into the world.
pub fn view_placed(placed: &Placed) -> Result<BodyView, ApiError> {
    view_at(&placed.body, &placed.placement)
}

fn view_at(body: &Body, placement: &geom::Placement) -> Result<BodyView, ApiError> {
    match validate::validate_meshed(body) {
        Ok(mesh) => Ok(view_parts(body, placement, &mesh, vec![])),
        Err(errs) => {
            let mesh = tessellate(body, &TessOptions::DISPLAY).map_err(|e| ApiError::internal(format!("face {}: {}", e.face, e.message)))?;
            Ok(view_parts(body, placement, &mesh, validate::report_lines(&errs)))
        }
    }
}

/// The view of a body's local geometry with its display mesh and
/// validation errors, carried into the world by `placement`: the mesh, the
/// face centroids and normals placed; volume, area and face areas, which a
/// rigid motion leaves alone, measured on the local geometry (`Placed`).
fn view_parts(body: &Body, placement: &geom::Placement, mesh: &mesh::Mesh, errors: Vec<String>) -> BodyView {
    let exact = mass::mass_properties(body);
    let faces = placed::placed_face_masses(body, placement);
    // As `Placed::bounds`: a placed body is boxed as its baked geometry, since a turn's box isn't the turned box.
    let (lo, hi) = if placement.is_identity() { body.bounds() } else { body.transformed(&placement.transform()).bounds() };
    // A plane's normal is the same everywhere on it, so any point will do.
    let normal = |f: usize| match body.faces[f].surface {
        geom::Surface::Plane { .. } => Some(placement.dir(body.face_normal_at(f, DVec3::ZERO)).to_array()),
        _ => None,
    };
    BodyView {
        mesh: display::display_mesh_placed(body, mesh, placement),
        volume: exact.volume,
        area: exact.area,
        bounds: [lo.to_array(), hi.to_array()],
        vertices: body.vertices.len(),
        edges: body.edges.len(),
        faces: body.faces.len(),
        face_types: body.faces.iter().map(|f| surface_type(&f.surface)).collect(),
        edge_types: body.edges.iter().map(|e| curve_type(&e.curve)).collect(),
        face_roles: body.faces.iter().map(|f| f.role.map(FaceRoleOut::from)).collect(),
        face_areas: faces.iter().map(|m| m.area).collect(),
        face_centroids: faces.iter().map(|m| m.centroid.to_array()).collect(),
        face_normals: (0..body.faces.len()).map(normal).collect(),
        edge_faces: edge_faces(body),
        vertex_points: body.vertices.iter().map(|v| placement.point(v.point).to_array()).collect(),
        edge_vertices: body.edges.iter().map(|e| [e.start, e.end]).collect(),
        edge_middles: body.edges.iter().map(|e| placement.point(e.curve.eval(0.5 * (e.t0 + e.t1))).to_array()).collect(),
        edge_centres: body
            .edges
            .iter()
            .map(|e| match e.curve {
                geom::Curve::Circle { center, .. } => Some(placement.point(center).to_array()),
                geom::Curve::Line { .. } => None,
            })
            .collect(),
        tolerance: body.vertices.iter().map(|v| v.tol).chain(body.edges.iter().map(|e| e.tol)).fold(0.0, f64::max),
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
    to_js(view_of(BodySpec::Extrude { profile, distance, frame: None, flip: false }))
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
///
/// An extrude may also say where its sketch's plane is (step 26b):
/// `frame: { origin, x, normal }` (`FrameIn`; the profile is in that
/// frame's own coordinates and goes along its normal; refused unless the
/// axes are unit and square, `ops::place::frame_placement`), and `flip:
/// true` to go the other way from the same plane, its start cap still on
/// the plane (`ops::place`). Without either it is the XY plane, going up.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodySpec {
    Box { width: f64, depth: f64, height: f64 },
    Cylinder { radius: f64, height: f64 },
    Sphere { radius: f64 },
    Extrude {
        profile: ProfileIn,
        distance: f64,
        #[serde(default)]
        frame: Option<FrameIn>,
        #[serde(default)]
        flip: bool,
    },
}

/// A sketch plane's frame as the app sends it: `{ origin: [x, y, z], x:
/// [x, y, z], normal: [x, y, z] }`, in world coordinates, the axes unit and
/// square to each other (y = normal × x).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct FrameIn {
    pub origin: [f64; 3],
    pub x: [f64; 3],
    pub normal: [f64; 3],
}

impl From<FrameIn> for ops::place::Frame {
    fn from(f: FrameIn) -> Self {
        ops::place::Frame { origin: f.origin.into(), x: f.x.into(), normal: f.normal.into() }
    }
}

/// A built body (its local geometry and placement) and the display mesh of
/// its local geometry, made by the operation's validation.
pub type Built = (Placed, mesh::Mesh);

/// Builds the body a spec describes (with the same checks as the make_*
/// functions).
pub fn build(spec: BodySpec) -> Result<Placed, ApiError> {
    build_meshed(spec).map(|(placed, _)| placed)
}

/// `build`, also handing back the display mesh the operation's validation
/// made (`ops::finish`). A body built without a frame is kept as built,
/// unplaced, so its numbers are bit for bit what they were before frames.
pub fn build_meshed(spec: BodySpec) -> Result<Built, ApiError> {
    let unplaced = |made: Result<ops::Meshed, ops::KernelError>| made.map(|(body, mesh)| (Placed { body, placement: geom::Placement::IDENTITY }, mesh));
    let made = match spec {
        BodySpec::Box { width, depth, height } => unplaced(ops::primitives::make_box_meshed(width, depth, height)),
        BodySpec::Cylinder { radius, height } => unplaced(ops::primitives::make_cylinder_meshed(radius, height)),
        BodySpec::Sphere { radius } => unplaced(ops::primitives::make_sphere_meshed(radius)),
        BodySpec::Extrude { profile, distance, frame: None, flip: false } => unplaced(ops::extrude::extrude_meshed(&profile_from_input(profile)?, distance)),
        BodySpec::Extrude { profile, distance, frame, flip } => {
            let frame = frame.map_or(ops::place::Frame::XY, ops::place::Frame::from);
            ops::place::extrude_in_frame(&profile_from_input(profile)?, distance, &frame, flip)
        }
    };
    Ok(made?)
}

/// What the make_* functions give the app: the view of the body a spec
/// describes, or the kernel's reason it can't be built (the same message
/// either way round: a bad profile's, an operation's, or tessellation's).
/// Validated and tessellated once, by the operation: the body passed
/// `checked`, so it has no errors to list.
pub fn view_of(spec: BodySpec) -> Result<BodyView, ApiError> {
    let (placed, mesh) = build_meshed(spec)?;
    Ok(view_parts(&placed.body, &placed.placement, &mesh, vec![]))
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
    let (placed, mut mesh) = build_meshed(spec)?;
    placed::mesh_into_world(&mut mesh, &placed.placement);
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

/// A kept body as a STEP AP214 file (`store::BodyStore::step`), placed
/// where the app shows it: the oracle's way to read the app's bodies with
/// OpenCascade (step 29b3).
#[wasm_bindgen]
pub fn body_step(body: f64) -> Result<JsValue, JsValue> {
    to_js(store::handle_from_js(body).and_then(|h| STORE.with_borrow(|s| s.step(h))))
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
        let v = view_of(BodySpec::Extrude { profile: l(outer), distance: 2.0, frame: None, flip: false }).unwrap();
        assert!(rel_eq(v.volume, 102.0, FP_REL) && v.faces == 8, "{}", v.volume);
        // Failures carry the reason the app shows: the kernel's for a bad
        // size, the profile reader's for odd coordinates.
        let e = view_of(BodySpec::Box { width: 1.0, depth: -1.0, height: 1.0 }).err().unwrap();
        assert!(e.message.contains("must be"));
        assert_eq!(e.inputs, vec![ops::Input::Param { name: "depth" }]);
        let odd = view_of(BodySpec::Extrude { profile: l(vec![0.0; 5]), distance: 1.0, frame: None, flip: false }).err().unwrap();
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
            frame: None,
            flip: false,
        };
        assert_eq!(count(&|| drop(view_of(plate()).unwrap())), 1);
        assert_eq!(count(&|| drop(stl_of(plate(), "plate").unwrap())), 1);
        let body = build(plate()).unwrap().body;
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
                    frame: None,
                    flip: false,
                },
            ]
        };
        for (a, b) in specs().into_iter().zip(specs()) {
            assert_eq!(json(view_of(a).unwrap()), json(view_placed(&build(b).unwrap()).unwrap()));
        }
    }

    #[test]
    fn view_bounds_are_the_hand_worked_box() {
        let bounds = |spec: BodySpec| view_placed(&build(spec).unwrap()).unwrap().bounds;
        let near = |got: [[f64; 3]; 2], want: [[f64; 3]; 2]| {
            let ok = got.iter().flatten().zip(want.iter().flatten()).all(|(g, w)| crate::tolerance::eq(*g, *w));
            assert!(ok, "{got:?} vs {want:?}");
        };
        // A box 10 × 20 × 30 from the origin.
        near(bounds(BodySpec::Box { width: 10.0, depth: 20.0, height: 30.0 }), [[0.0, 0.0, 0.0], [10.0, 20.0, 30.0]]);
        // A cylinder r 1, h 2 standing on the origin round +Z: its circles reach ±1 in x and y, though its only vertices are at x = 1.
        near(bounds(BodySpec::Cylinder { radius: 1.0, height: 2.0 }), [[-1.0, -1.0, 0.0], [1.0, 1.0, 2.0]]);
        // A ball r 3 round the origin: ±3, with one vertex on its equator at (3, 0, 0).
        near(bounds(BodySpec::Sphere { radius: 3.0 }), [[-3.0; 3], [3.0; 3]]);
        // A half disc: (0, 0) to (2, 0) with bulge 1 (half a turn counter-clockwise round (1, 0), so through (1, −1)), back by a line;
        // extruded 3 on a frame at (100, 0, 0) whose x is +Y and normal +X, so the sketch's y is X × Y = +Z: sketch (u, v) is world
        // (100, u, v) and the extrude runs to x = 103. The arc's lowest point (1, −1) is world z = −1, a point no vertex is at.
        let half_disc = BodySpec::Extrude {
            profile: ProfileIn { outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 2.0, 0.0], bulges: vec![1.0, 0.0] }, holes: vec![] },
            distance: 3.0,
            frame: Some(FrameIn { origin: [100.0, 0.0, 0.0], x: [0.0, 1.0, 0.0], normal: [1.0, 0.0, 0.0] }),
            flip: false,
        };
        near(bounds(half_disc), [[100.0, 0.0, -1.0], [103.0, 2.0, 0.0]]);
    }

    #[test]
    fn view_reports_validation_errors_instead_of_hiding_them() {
        let mut body = ops::primitives::make_box(1.0, 1.0, 1.0).unwrap();
        body.vertices[7].point.z += 0.5;
        let v = view_body(&body).unwrap();
        assert!(v.errors.iter().any(|e| e.contains("vertex 7")), "{:?}", v.errors);
        // Each line says its category: a vertex off its edges is geometry.
        assert!(v.errors.iter().all(|e| e.starts_with("geometry: vertex 7 is ")), "{:?}", v.errors);
    }

    #[test]
    fn the_view_carries_the_largest_tolerance() {
        // Every body the kernel makes carries LINEAR everywhere; one vertex
        // grown to 3e-5 and one edge to 7e-5 make the largest 7e-5, read
        // from the edges as well as the vertices.
        let mut body = ops::primitives::make_box(1.0, 2.0, 3.0).unwrap();
        assert_eq!(view_body(&body).unwrap().tolerance, tolerance::LINEAR);
        body.vertices[2].tol = 3e-5;
        assert_eq!(view_body(&body).unwrap().tolerance, 3e-5);
        body.edges[4].tol = 7e-5;
        let v = view_body(&body).unwrap();
        assert!(v.tolerance == 7e-5 && v.errors.is_empty(), "{} {:?}", v.tolerance, v.errors);
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
        let e = stl_of(BodySpec::Extrude { profile: l, distance: 2.0, frame: None, flip: false }, "L").unwrap();
        assert_eq!((count(&e), size(&e)), (20, 1084));
        // Bad shapes give the kernel's reason, not a file.
        assert!(stl_of(BodySpec::Box { width: -1.0, depth: 1.0, height: 1.0 }, "bad").unwrap_err().message.contains("must be"));
    }

    /// The 40 × 30 × 20 box of the step-26 plan, as the app will send it:
    /// a rectangle sketched on the front plane, extruded 20 (`flip` as given).
    fn front_box(flip: bool) -> BodySpec {
        let json = format!(
            r#"{{ "extrude": {{ "profile": {{ "outer": {{ "path": {{ "corners": [0, 0, 40, 0, 40, 30, 0, 30], "bulges": [] }} }}, "holes": [] }},
                "distance": 20, "frame": {{ "origin": [0, 0, 0], "x": [1, 0, 0], "normal": [0, -1, 0] }}, "flip": {flip} }} }}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn a_box_sketched_on_the_front_plane_by_hand() {
        // Front plane: sketch (u, v) is world (u, v·Z), the normal −Y, so
        // local (u, v, w) → (u, −w, v): x in [0, 40], y in [−20, 0], z in
        // [0, 30]. Volume 40·30·20 = 24000, area 2(1200 + 800 + 600) = 5200.
        // Faces: the start cap on the sketch plane y = 0 facing +Y (away from
        // the solid), centroid (20, 0, 15); the end cap y = −20 facing −Y; the
        // side from piece 0 ((0, 0) → (40, 0)) the bottom z = 0 facing −Z,
        // centroid (20, −10, 0); piece 1 ((40, 0) → (40, 30)) x = 40 facing
        // +X, centroid (40, −10, 15).
        let v = view_of(front_box(false)).unwrap();
        assert!(rel_eq(v.volume, 24000.0, FP_REL) && rel_eq(v.area, 5200.0, FP_REL) && v.errors.is_empty(), "{} {}", v.volume, v.area);
        let face = |role: &str, piece: Option<usize>| v.face_roles.iter().position(|r| r.as_ref().is_some_and(|r| r.role == role && r.piece == piece)).unwrap();
        let near = |a: [f64; 3], b: [f64; 3]| tolerance::points_eq(a.into(), b.into());
        for (role, piece, centroid, normal) in [
            ("start", None, [20.0, 0.0, 15.0], [0.0, 1.0, 0.0]),
            ("end", None, [20.0, -20.0, 15.0], [0.0, -1.0, 0.0]),
            ("side", Some(0), [20.0, -10.0, 0.0], [0.0, 0.0, -1.0]),
            ("side", Some(1), [40.0, -10.0, 15.0], [1.0, 0.0, 0.0]),
        ] {
            let f = face(role, piece);
            assert!(near(v.face_centroids[f], centroid), "{role} {piece:?}: {:?}", v.face_centroids[f]);
            assert!(near(v.face_normals[f].unwrap(), normal), "{role} {piece:?}: {:?}", v.face_normals[f]);
        }
        // The mesh the viewer draws is placed too: its box is the body's,
        // and every start-cap triangle's normal is +Y (to the rounding of the
        // quarter turn's quaternion, whose cos 45° = sin 45° = √½ is not a
        // double: ~2e-16).
        let pts = v.mesh.positions.chunks(3).map(|c| glam::DVec3::new(c[0] as f64, c[1] as f64, c[2] as f64));
        let (lo, hi) = pts.fold((glam::DVec3::INFINITY, glam::DVec3::NEG_INFINITY), |(l, h), p| (l.min(p), h.max(p)));
        assert!(tolerance::points_eq(lo, glam::DVec3::new(0.0, -20.0, 0.0)) && tolerance::points_eq(hi, glam::DVec3::new(40.0, 0.0, 30.0)), "{lo} {hi}");
        let start = face("start", None) as u32;
        for (t, &f) in v.mesh.triangle_faces.iter().enumerate() {
            if f == start {
                for k in 0..3 {
                    let i = v.mesh.indices[3 * t + k] as usize * 3;
                    let n = glam::DVec3::new(v.mesh.normals[i] as f64, v.mesh.normals[i + 1] as f64, v.mesh.normals[i + 2] as f64);
                    assert!(n.distance(glam::DVec3::Y) <= 4.0 * f64::EPSILON, "triangle {t}: {n}");
                }
            }
        }
        // Edge lines too: every one within the body's box (to that rounding).
        let inside = |c: &[f32]| glam::DVec3::new(c[0] as f64, c[1] as f64, c[2] as f64).clamp(lo, hi).distance(glam::DVec3::new(c[0] as f64, c[1] as f64, c[2] as f64)) <= tolerance::LINEAR;
        assert!(v.mesh.edge_lines.chunks(3).all(inside));
        assert!(tolerance::points_eq(lo, glam::DVec3::new(0.0, -20.0, 0.0)));
        // Flipped, it goes away from the viewer (y in [0, 20]), the start cap
        // still on the plane, now facing −Y; the end cap y = 20 facing +Y.
        let f = view_of(front_box(true)).unwrap();
        let start = f.face_roles.iter().position(|r| r.as_ref().is_some_and(|r| r.role == "start")).unwrap();
        let end = f.face_roles.iter().position(|r| r.as_ref().is_some_and(|r| r.role == "end")).unwrap();
        assert!(near(f.face_centroids[start], [20.0, 0.0, 15.0]) && near(f.face_normals[start].unwrap(), [0.0, -1.0, 0.0]), "{:?}", f.face_normals[start]);
        assert!(near(f.face_centroids[end], [20.0, 20.0, 15.0]) && near(f.face_normals[end].unwrap(), [0.0, 1.0, 0.0]));
        assert!(rel_eq(f.volume, 24000.0, FP_REL));
    }

    #[test]
    fn a_spec_without_a_frame_is_read_as_before() {
        // The app's specs from before frames: no frame, not flipped, built
        // unplaced, so the view is exactly what it was (the JSON the app gets
        // is make_extrude's).
        let json = r#"{ "extrude": { "profile": { "outer": { "circle": { "center": [1, 2], "radius": 3 } }, "holes": [] }, "distance": 4 } }"#;
        let spec: BodySpec = serde_json::from_str(json).unwrap();
        assert!(matches!(&spec, BodySpec::Extrude { frame: None, flip: false, .. }));
        let built = build(spec).unwrap();
        assert!(built.placement.is_identity());
        // Flip alone flips from the XY plane: z in [−4, 0], volume 36π.
        let flipped: BodySpec = serde_json::from_str(&json.replace(r#""distance": 4"#, r#""distance": 4, "flip": true"#)).unwrap();
        let (lo, hi) = build(flipped).unwrap().bounds();
        assert!(tolerance::points_eq(lo, glam::DVec3::new(-2.0, -1.0, -4.0)) && tolerance::points_eq(hi, glam::DVec3::new(4.0, 5.0, 0.0)), "{lo} {hi}");
        // A bad frame is refused with the part named, as the app reads it.
        let bad: BodySpec = serde_json::from_str(&json.replace(r#""distance": 4"#, r#""distance": 4, "frame": { "origin": [0, 0, 0], "x": [1, 0, 0], "normal": [1, 0, 0] }"#)).unwrap();
        let e = view_of(bad).unwrap_err();
        assert_eq!((e.kind, e.inputs), (api_error::ErrorKind::InvalidInput, vec![ops::Input::Param { name: "x" }, ops::Input::Param { name: "normal" }]));
    }

    #[test]
    fn face_normals_by_hand() {
        // A box's six faces are planes facing out along ±X, ±Y, ±Z; a
        // cylinder's caps face ∓Z and its side is curved (null); a sphere
        // has no plane face.
        let v = view_of(BodySpec::Box { width: 1.0, depth: 2.0, height: 3.0 }).unwrap();
        let by_role = |role: &str| v.face_normals[v.face_roles.iter().position(|r| r.as_ref().unwrap().role == role).unwrap()].unwrap();
        for (role, n) in [("top", [0.0, 0.0, 1.0]), ("bottom", [0.0, 0.0, -1.0]), ("front", [0.0, -1.0, 0.0]), ("back", [0.0, 1.0, 0.0]), ("left", [-1.0, 0.0, 0.0]), ("right", [1.0, 0.0, 0.0])] {
            assert_eq!(by_role(role), n, "{role}");
        }
        let c = view_of(BodySpec::Cylinder { radius: 1.0, height: 2.0 }).unwrap();
        let normals: Vec<_> = c.face_types.iter().zip(&c.face_normals).map(|(t, n)| (*t, *n)).collect();
        assert!(normals.contains(&("plane", Some([0.0, 0.0, 1.0]))) && normals.contains(&("plane", Some([0.0, 0.0, -1.0]))) && normals.contains(&("cylinder", None)), "{normals:?}");
        assert!(view_of(BodySpec::Sphere { radius: 1.0 }).unwrap().face_normals.iter().all(Option::is_none));
    }

    #[test]
    fn corners_middles_and_centres_by_hand() {
        // Step 26f. The front-plane box (sketch (u, v) → world (u, −w, v),
        // x in [0, 40], y in [−20, 0], z in [0, 30]) has the eight corners
        // of that range, exactly: every coordinate is a whole number and
        // the quarter turn's rounding (~2e-16 of the size, so ~1e-14 mm)
        // is far below LINEAR. Every edge is a line, so its middle is the
        // average of its two corners and it has no centre; its two ends
        // are two different corners.
        let v = view_of(front_box(false)).unwrap();
        let near = |a: [f64; 3], b: [f64; 3]| tolerance::points_eq(a.into(), b.into());
        assert_eq!((v.vertex_points.len(), v.edge_vertices.len(), v.edge_middles.len(), v.edge_centres.len()), (8, 12, 12, 12));
        for x in [0.0, 40.0] {
            for y in [-20.0, 0.0] {
                for z in [0.0, 30.0] {
                    assert_eq!(v.vertex_points.iter().filter(|p| near(**p, [x, y, z])).count(), 1, "corner {x} {y} {z}: {:?}", v.vertex_points);
                }
            }
        }
        for (e, [a, b]) in v.edge_vertices.iter().enumerate() {
            let (pa, pb) = (glam::DVec3::from(v.vertex_points[*a]), glam::DVec3::from(v.vertex_points[*b]));
            assert!(a != b && near(v.edge_middles[e], ((pa + pb) / 2.0).to_array()) && v.edge_centres[e].is_none(), "edge {e}");
        }
        // The edge between the start cap (y = 0) and piece 0's side (z = 0)
        // runs from (0, 0, 0) to (40, 0, 0) one way or the other: its middle
        // is (20, 0, 0).
        let face = |role: &str, piece: Option<usize>| v.face_roles.iter().position(|r| r.as_ref().is_some_and(|r| r.role == role && r.piece == piece)).unwrap();
        let (start, bottom) = (face("start", None), face("side", Some(0)));
        let e = v.edge_faces.iter().position(|p| p.is_some_and(|[a, b]| (a, b) == (start, bottom) || (a, b) == (bottom, start))).unwrap();
        assert!(near(v.edge_middles[e], [20.0, 0.0, 0.0]), "{:?}", v.edge_middles[e]);

        // A half disc of radius 10 on XY extruded 5: corners (10, 0) and
        // (−10, 0), the arc from (10, 0) to (−10, 0) with bulge 1 (a half
        // turn counter-clockwise, through (0, 10)), the line back. Each
        // cap's arc edge: centre (0, 0, z), middle (0, 10, z) (half of a
        // half turn from angle 0 is angle π/2: (10 cos π/2, 10 sin π/2)),
        // ends (±10, 0, z); z = 0 and 5.
        let half = BodySpec::Extrude {
            profile: ProfileIn { outer: BoundaryIn::Path { corners: vec![10.0, 0.0, -10.0, 0.0], bulges: vec![1.0, 0.0] }, holes: vec![] },
            distance: 5.0,
            frame: None,
            flip: false,
        };
        let h = view_of(half).unwrap();
        let arcs: Vec<usize> = (0..h.edges).filter(|&e| h.edge_types[e] == "circle").collect();
        assert_eq!(arcs.len(), 2, "{:?}", h.edge_types);
        for z in [0.0, 5.0] {
            let e = *arcs.iter().find(|&&e| (h.edge_centres[e].unwrap()[2] - z).abs() <= tolerance::LINEAR).unwrap();
            assert!(near(h.edge_centres[e].unwrap(), [0.0, 0.0, z]) && near(h.edge_middles[e], [0.0, 10.0, z]), "z {z}: {:?} {:?}", h.edge_centres[e], h.edge_middles[e]);
            let ends = h.edge_vertices[e].map(|k| h.vertex_points[k]);
            assert!(ends.iter().any(|p| near(*p, [10.0, 0.0, z])) && ends.iter().any(|p| near(*p, [-10.0, 0.0, z])), "z {z}: {ends:?}");
        }
        // A cylinder r 1, h 2: its two cap circles are closed (one vertex,
        // at the seam (1, 0, z)), centred (0, 0, 0) and (0, 0, 2).
        let c = view_of(BodySpec::Cylinder { radius: 1.0, height: 2.0 }).unwrap();
        let circles: Vec<usize> = (0..c.edges).filter(|&e| c.edge_types[e] == "circle").collect();
        assert_eq!(circles.len(), 2);
        for (e, z) in circles.iter().zip([0.0, 2.0]) {
            let [a, b] = c.edge_vertices[*e];
            assert!(a == b && near(c.vertex_points[a], [1.0, 0.0, z]) && near(c.edge_centres[*e].unwrap(), [0.0, 0.0, z]), "edge {e}");
        }
    }

    #[test]
    fn a_placed_view_s_corners_are_the_baked_body_s() {
        // A slanted 3-4-5 frame far from the origin, flipped: the placed
        // view's corners, middles and centres against the baked body's, to
        // rounding at that reach (they are the same geometry, placed once
        // or baked once).
        let spec = || BodySpec::Extrude {
            profile: ProfileIn {
                outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 30.0, 0.0, 30.0, 20.0, 0.0, 20.0], bulges: vec![0.0, 0.4, 0.0, 0.0] },
                holes: vec![BoundaryIn::Circle { center: [10.0, 10.0], radius: 4.0 }],
            },
            distance: 7.0,
            frame: Some(FrameIn { origin: [5e4, -3e3, 7.5], x: [0.0, 0.6, 0.8], normal: [1.0, 0.0, 0.0] }),
            flip: true,
        };
        let a = view_of(spec()).unwrap();
        let b = view_body(&build(spec()).unwrap().baked()).unwrap();
        let slack = 1e3 * tolerance::rounding_slack(5.1e4);
        let close = |p: [f64; 3], q: [f64; 3]| glam::DVec3::from(p).distance(q.into()) <= slack;
        assert_eq!((&a.edge_vertices, a.vertex_points.len()), (&b.edge_vertices, b.vertex_points.len()));
        assert!(a.vertex_points.iter().zip(&b.vertex_points).all(|(p, q)| close(*p, *q)));
        assert!(a.edge_middles.iter().zip(&b.edge_middles).all(|(p, q)| close(*p, *q)));
        assert!(a.edge_centres.iter().zip(&b.edge_centres).all(|(p, q)| match (p, q) {
            (Some(p), Some(q)) => close(*p, *q),
            (None, None) => true,
            _ => false,
        }));
    }

    #[test]
    fn a_placed_view_is_the_baked_body_s_view() {
        // Seeded frames (slanted, far, flipped): the placed view, made from
        // the local geometry, against the view of the same body baked into
        // world coordinates and validated afresh. Volume, area and face
        // areas to rounding at the part's size; centroids and normals to
        // rounding at its reach; both pass validation.
        let frames = [
            ([0.0, 0.0, 0.0], [0.0, 0.6, 0.8], [1.0, 0.0, 0.0], false),
            ([5e4, -3e3, 7.5], [0.0, 0.0, 1.0], [0.6, -0.8, 0.0], true),
            ([-2.5e6, 1e6, 3e6], [0.36, 0.48, -0.8], [0.8, -0.6, 0.0], false),
            ([1.0, 2.0, 3.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0], true),
        ];
        for (origin, x, normal, flip) in frames {
            let x = glam::DVec3::from(x).normalize().to_array();
            let normal = glam::DVec3::from(normal).normalize().to_array();
            let spec = || BodySpec::Extrude {
                // A 30 × 20 plate with one bowed side and a round hole.
                profile: ProfileIn {
                    outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 30.0, 0.0, 30.0, 20.0, 0.0, 20.0], bulges: vec![0.0, 0.4, 0.0, 0.0] },
                    holes: vec![BoundaryIn::Circle { center: [10.0, 10.0], radius: 4.0 }],
                },
                distance: 7.0,
                frame: Some(FrameIn { origin, x, normal }),
                flip,
            };
            let placed = build(spec()).unwrap();
            let a = view_of(spec()).unwrap();
            let b = view_body(&placed.baked()).unwrap();
            assert!(a.errors.is_empty() && b.errors.is_empty(), "{:?}", b.errors);
            let reach = glam::DVec3::from(origin).abs().max_element() + 60.0;
            let slack = tolerance::rounding_slack(reach);
            assert!(tolerance::measure_eq(a.volume, b.volume, a.area * slack) && tolerance::measure_eq(a.area, b.area, a.area * slack), "{origin:?}: {} {} vs {} {}", a.volume, a.area, b.volume, b.area);
            assert_eq!((a.faces, a.edges, a.vertices, &a.face_types, &a.edge_faces), (b.faces, b.edges, b.vertices, &b.face_types, &b.edge_faces));
            for f in 0..a.faces {
                assert!(tolerance::measure_eq(a.face_areas[f], b.face_areas[f], a.area * slack), "face {f}");
                let off = glam::DVec3::from(a.face_centroids[f]).distance(b.face_centroids[f].into());
                assert!(off <= 1e3 * slack, "{origin:?} face {f}: centroid {off:e} off");
                match (a.face_normals[f], b.face_normals[f]) {
                    (Some(n), Some(m)) => assert!(glam::DVec3::from(n).distance(m.into()) <= tolerance::ANGULAR, "face {f}: {n:?} vs {m:?}"),
                    (None, None) => {}
                    other => panic!("face {f}: {other:?}"),
                }
            }
            // The meshes' boxes agree to single precision (the viewer's).
            let bounds = |v: &BodyView| v.mesh.positions.chunks(3).fold(([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]), |(mut l, mut h), c| {
                (0..3).for_each(|k| { l[k] = l[k].min(c[k]); h[k] = h[k].max(c[k]); });
                (l, h)
            });
            let ((al, ah), (bl, bh)) = (bounds(&a), bounds(&b));
            for k in 0..3 {
                let f32_slack = (reach * tolerance::F32_REL) as f32;
                assert!((al[k] - bl[k]).abs() <= f32_slack && (ah[k] - bh[k]).abs() <= f32_slack, "{origin:?} axis {k}: {al:?} {ah:?} vs {bl:?} {bh:?}");
            }
        }
    }

    #[test]
    fn a_placed_body_s_stl_is_placed() {
        // The front-plane box as STL: 12 triangles (684 bytes), read back
        // with its corners where the view has them (whole millimetres, up to
        // the quarter turn's ~1e-14 rounding, far below what single
        // precision rounds: no warning), welded volume 24000.
        let f = stl_of(front_box(false), "front").unwrap();
        assert_eq!((f.bytes.len(), f.warning), (684, None));
        assert!(f.rounding <= tolerance::rounding_slack(40.0), "{}", f.rounding);
        let read = stl::read(&f.bytes).unwrap();
        let mesh = read.welded();
        let (lo, hi) = mesh.positions.iter().fold((glam::DVec3::INFINITY, glam::DVec3::NEG_INFINITY), |(l, h), p| (l.min(*p), h.max(*p)));
        assert!(tolerance::points_eq(lo, glam::DVec3::new(0.0, -20.0, 0.0)) && tolerance::points_eq(hi, glam::DVec3::new(40.0, 0.0, 30.0)), "{lo} {hi}");
        assert!(rel_eq(mesh.signed_volume(), 24000.0, FP_REL), "{}", mesh.signed_volume());
    }
}
