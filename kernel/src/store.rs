//! The kernel's body store: bodies kept between calls, so later operations
//! can start from an earlier result (the design step before the timeline
//! rebuild, 24d; health check 2026-10-17, risk 1).
//!
//! The app builds a body and gets a handle, a number; it asks for the
//! body's view or STL by that handle, and frees it when no feature needs it
//! any more. Bodies are never changed in place: an operation on a stored
//! body (booleans, fillets, sketch on a face) will make a new body with a
//! new handle, so a timeline can keep a failed feature's last shape, and
//! undo can go back to an older one, just by keeping the handle.
//!
//! Rules, each with a test:
//! - Handles count up from 1 and are never reused, so a handle kept past
//!   its `free` is refused (`UnknownBody`), never answered with another
//!   body. They stay below 2^53, so a JavaScript number holds each one
//!   exactly; past that the store refuses to build (`TooManyBodies`).
//! - A failed build stores nothing and uses no handle.
//! - At most `MAX_LIVE_BODIES` bodies at once, and at most `MAX_HELD_BYTES`
//!   of them (`held_bytes`), so a leak in the app ends in a clear error,
//!   not in WebAssembly running out of memory (its memory never shrinks).
//!   The count alone didn't do it: a 50 mm sphere holds about 1 MB, so
//!   leaking them filled the browser build's 4 GiB at 4,366 spheres and
//!   the kernel died ("unreachable", every later call too), long before
//!   10,000 (kernel crash hunt, 2026-10-19). `live()` lets the app's tests
//!   check that what they build they free.
//! - A body is stored with the display mesh its validation made, so its
//!   view and STL never tessellate it again, and give exactly what
//!   `view_of` and `stl_of` give for the same spec.
//! - Its STEP file (`step`, step 29b3) is the placed body's, in world
//!   coordinates, as `step_write::write` writes the baked body, so the
//!   oracle reads exactly the body the app shows.

use crate::api_error::{ApiError, ErrorKind};
use crate::mesh::Mesh;
use crate::ops::Input;
use crate::{build_meshed, placed, stl, step_write, view_parts, BodySpec, Built, BodyView, StlFile};
use std::collections::BTreeMap;

/// A stored body's number. 0 is never one.
pub type Handle = u64;

/// The most bodies the store holds at once. A timeline keeps one body per
/// solid feature plus the few it is replacing; the plan's largest test
/// timeline has 200 items.
pub const MAX_LIVE_BODIES: usize = 10_000;

/// The most the stored bodies may hold at once, by `held_bytes`: 500 MB
/// counted, about 0.7 GB of the browser build's memory. That memory stops
/// at 4 GiB (less on some phones), and the costliest legal call needs
/// ~0.7 GB more while it runs (the plate of `tests/worst_case.rs`: ~0.2 GB
/// to build, ~0.5 GB more for its view). A design's bodies come nowhere
/// near it: a box counts 624 bytes, a 50 mm sphere 0.7 MB, that plate
/// 62 MB.
pub const MAX_HELD_BYTES: usize = 500_000_000;

/// The largest handle: 2^53 − 1, the largest whole number a JavaScript
/// number (a double) holds with every whole number below it.
pub const MAX_HANDLE: Handle = (1 << 53) - 1;

#[derive(Debug)]
pub struct BodyStore {
    /// The handle the next stored body gets.
    next: Handle,
    bodies: BTreeMap<Handle, Built>,
    /// The bodies' `held_bytes`, all together.
    held: usize,
}

impl Default for BodyStore {
    fn default() -> Self {
        BodyStore::new()
    }
}

impl BodyStore {
    pub fn new() -> BodyStore {
        BodyStore { next: 1, bodies: BTreeMap::new(), held: 0 }
    }

    /// Builds the body `spec` describes (as `build_meshed`) and keeps it.
    pub fn build(&mut self, spec: BodySpec) -> Result<Handle, ApiError> {
        if self.bodies.len() >= MAX_LIVE_BODIES {
            return Err(ApiError::new(
                ErrorKind::TooManyBodies,
                vec![],
                format!("the kernel already holds {MAX_LIVE_BODIES} bodies; free the ones no longer needed"),
            ));
        }
        if self.next > MAX_HANDLE {
            return Err(ApiError::new(ErrorKind::TooManyBodies, vec![], format!("the kernel has handed out all {MAX_HANDLE} body handles")));
        }
        let made = build_meshed(spec)?;
        let bytes = held_bytes(&made);
        if bytes > MAX_HELD_BYTES - self.held {
            return Err(ApiError::new(
                ErrorKind::TooManyBodies,
                vec![],
                format!(
                    "the kernel's bodies already take {} of the {} MB it keeps for them, and this one needs {} more; free the ones no longer needed",
                    mb(self.held),
                    MAX_HELD_BYTES / 1_000_000,
                    mb(bytes)
                ),
            ));
        }
        self.held += bytes;
        let handle = self.next;
        self.next += 1;
        self.bodies.insert(handle, made);
        Ok(handle)
    }

    /// The view of a stored body, the same as `view_of` gives for its spec.
    pub fn view(&self, handle: Handle) -> Result<BodyView, ApiError> {
        let (placed, mesh) = self.get(handle)?;
        Ok(view_parts(&placed.body, &placed.placement, mesh, vec![]))
    }

    /// A stored body as binary STL, the same as `stl_of` gives for its spec.
    pub fn stl(&self, handle: Handle, name: &str) -> Result<StlFile, ApiError> {
        let (placed, mesh) = self.get(handle)?;
        let out = if placed.placement.is_identity() {
            stl::export(mesh, name)
        } else {
            let mut world = mesh.clone();
            placed::mesh_into_world(&mut world, &placed.placement);
            stl::export(&world, name)
        };
        Ok(StlFile { bytes: out.bytes, rounding: out.rounding, warning: out.warning })
    }

    /// A stored body as a STEP AP214 file (`step_write::write`), placed
    /// where the app shows it: the oracle's way to read the app's own
    /// bodies with OpenCascade (step 29b3). The store holds only valid
    /// single-shell bodies today, so the writer's refusals can't happen
    /// yet; one would come back as `InvalidInput` with the writer's words.
    pub fn step(&self, handle: Handle) -> Result<String, ApiError> {
        let (placed, _) = self.get(handle)?;
        step_write::write(&placed.baked()).map_err(ApiError::from)
    }

    /// Lets a body go. Its handle is never handed out again.
    pub fn free(&mut self, handle: Handle) -> Result<(), ApiError> {
        let made = self.bodies.remove(&handle).ok_or_else(|| unknown(handle))?;
        self.held -= held_bytes(&made);
        Ok(())
    }

    /// How many bodies the store holds.
    pub fn live(&self) -> usize {
        self.bodies.len()
    }

    /// The `held_bytes` of every body the store holds.
    pub fn held(&self) -> usize {
        self.held
    }

    fn get(&self, handle: Handle) -> Result<&Built, ApiError> {
        self.bodies.get(&handle).ok_or_else(|| unknown(handle))
    }
}

/// What a stored body holds, as the store counts it against
/// `MAX_HELD_BYTES`: its display mesh, by far the biggest part, in the
/// sizes the browser build gives it (a point 24 bytes; a triangle 12, and
/// 4 more for its face; each edge's line 4 per point, and 12 for the list
/// itself). Counted from the numbers of things, not from the allocator, so
/// every build and machine counts the same. It is a lower bound: the
/// B-rep is left out (a 50 mm sphere's is 2 faces, 1 edge and 1 vertex
/// beside 24,964 triangles), and so is the allocator's spare room; the
/// browser build grew by 0.94 MB for each such sphere counted here as
/// 0.70 MB.
pub fn held_bytes<B>((_, mesh): &(B, Mesh)) -> usize {
    let lines: usize = mesh.edge_polylines.iter().map(|l| 12 + 4 * l.len()).sum();
    24 * mesh.positions.len() + 12 * mesh.triangles.len() + 4 * mesh.triangle_face.len() + lines
}

/// Bytes as megabytes, one decimal.
fn mb(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

fn unknown(handle: Handle) -> ApiError {
    ApiError::new(ErrorKind::UnknownBody, vec![Input::Param { name: "body" }], format!("body {handle} is not in the kernel (it was freed, or never made)"))
}

/// A handle as the app sends it (a JavaScript number): a whole number from
/// 1 to `MAX_HANDLE`. Anything else (0, −1, 1.5, NaN, 2^53) is the app's
/// bug, refused rather than rounded onto some other body.
pub fn handle_from_js(x: f64) -> Result<Handle, ApiError> {
    if x.fract() == 0.0 && (1.0..=MAX_HANDLE as f64).contains(&x) {
        Ok(x as Handle)
    } else {
        Err(ApiError::bad_argument("body", format!("a body handle is a whole number from 1 to {MAX_HANDLE}, got {x}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{rel_eq, FP_REL};
    use crate::{stl_of, view_of, BoundaryIn, ProfileIn};
    use std::f64::consts::PI;

    fn cube(side: f64) -> BodySpec {
        BodySpec::Box { width: side, depth: side, height: side }
    }

    #[test]
    fn a_stored_box_gives_hand_worked_numbers_until_freed() {
        let mut store = BodyStore::new();
        let a = store.build(BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 }).unwrap();
        // 40·30·20 = 24000 mm³; area 2(40·30 + 40·20 + 30·20) = 2·2600 = 5200 mm².
        let v = store.view(a).unwrap();
        assert!(rel_eq(v.volume, 24000.0, FP_REL) && rel_eq(v.area, 5200.0, FP_REL), "{} {}", v.volume, v.area);
        assert_eq!((v.faces, v.edges, v.vertices), (6, 12, 8));
        // A cylinder r = 5, h = 10 beside it: πr²h = 250π.
        let b = store.build(BodySpec::Cylinder { radius: 5.0, height: 10.0 }).unwrap();
        assert_eq!((a, b, store.live()), (1, 2, 2));
        assert!(rel_eq(store.view(b).unwrap().volume, 250.0 * PI, FP_REL));
        // Freeing a leaves b as it was, and a is gone for good.
        store.free(a).unwrap();
        assert_eq!(store.live(), 1);
        assert!(rel_eq(store.view(b).unwrap().volume, 250.0 * PI, FP_REL));
        let gone = store.view(a).unwrap_err();
        assert_eq!((gone.kind, gone.inputs.clone()), (ErrorKind::UnknownBody, vec![Input::Param { name: "body" }]));
        assert_eq!(gone.message, "body 1 is not in the kernel (it was freed, or never made)");
        assert_eq!(store.stl(a, "x").unwrap_err().kind, ErrorKind::UnknownBody);
        // Freeing twice is refused too, and changes nothing.
        assert_eq!(store.free(a).unwrap_err().kind, ErrorKind::UnknownBody);
        assert_eq!(store.live(), 1);
        // The next body is 3, never 1 again.
        assert_eq!(store.build(cube(1.0)).unwrap(), 3);
    }

    #[test]
    fn a_failed_build_stores_nothing_and_uses_no_handle() {
        let mut store = BodyStore::new();
        let e = store.build(BodySpec::Box { width: -1.0, depth: 1.0, height: 1.0 }).unwrap_err();
        assert_eq!((e.kind, e.inputs), (ErrorKind::InvalidInput, vec![Input::Param { name: "width" }]));
        assert_eq!(e.message, "width must be between 0.001 and 1000000 mm, got -1");
        assert_eq!(store.live(), 0);
        assert_eq!(store.build(cube(1.0)).unwrap(), 1);
    }

    #[test]
    fn stored_views_and_stls_are_what_the_one_shot_calls_give() {
        // Same spec through the store and through view_of / stl_of: the
        // same JSON and the same bytes, for each kind of body.
        let rect = || ProfileIn {
            outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 30.0, 0.0, 30.0, 10.0, 0.0, 10.0], bulges: vec![] },
            holes: vec![BoundaryIn::Circle { center: [15.0, 5.0], radius: 2.0 }],
        };
        // Placed ones too (step 26b): on a slanted frame, far out, and
        // flipped on the front plane.
        fn slanted() -> Option<crate::FrameIn> {
            Some(crate::FrameIn { origin: [1e5, -2e4, 3.5], x: [0.0, 0.8, 0.6], normal: [0.0, -0.6, 0.8] })
        }
        fn front() -> Option<crate::FrameIn> {
            Some(crate::FrameIn { origin: [0.0, 0.0, 0.0], x: [1.0, 0.0, 0.0], normal: [0.0, -1.0, 0.0] })
        }
        let specs: [fn() -> BodySpec; 6] = [
            || BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 },
            || BodySpec::Cylinder { radius: 3.0, height: 7.0 },
            || BodySpec::Sphere { radius: 4.0 },
            || BodySpec::Extrude { profile: ProfileIn { outer: BoundaryIn::Circle { center: [1.0, 2.0], radius: 3.0 }, holes: vec![] }, distance: 5.0, frame: None, flip: false },
            || BodySpec::Extrude { profile: ProfileIn { outer: BoundaryIn::Circle { center: [1.0, 2.0], radius: 3.0 }, holes: vec![] }, distance: 5.0, frame: slanted(), flip: false },
            || BodySpec::Extrude { profile: ProfileIn { outer: BoundaryIn::Circle { center: [1.0, 2.0], radius: 3.0 }, holes: vec![] }, distance: 5.0, frame: front(), flip: true },
        ];
        let mut store = BodyStore::new();
        for spec in specs {
            let h = store.build(spec()).unwrap();
            let json = |v: BodyView| serde_json::to_string(&v).unwrap();
            assert_eq!(json(store.view(h).unwrap()), json(view_of(spec()).unwrap()));
            assert_eq!(store.stl(h, "part").unwrap().bytes, stl_of(spec(), "part").unwrap().bytes);
        }
        let h = store.build(BodySpec::Extrude { profile: rect(), distance: 2.0, frame: None, flip: false }).unwrap();
        // 30·10 − π·2² = 300 − 4π, by 2: 600 − 8π.
        assert!(rel_eq(store.view(h).unwrap().volume, 600.0 - 8.0 * PI, FP_REL));
    }

    /// The corners a STEP file's vertices sit at (each `VERTEX_POINT`'s
    /// `CARTESIAN_POINT`), sorted.
    fn step_vertices(text: &str) -> Vec<[f64; 3]> {
        let mut points = BTreeMap::new();
        let mut corners = vec![];
        for line in text.lines() {
            let Some((id, rest)) = line.split_once(" = ") else { continue };
            if let Some(xyz) = rest.strip_prefix("CARTESIAN_POINT('',(").and_then(|r| r.strip_suffix("));")) {
                let c: Vec<f64> = xyz.split(',').map(|x| x.parse().unwrap()).collect();
                points.insert(id.to_string(), [c[0], c[1], c[2]]);
            } else if let Some(p) = rest.strip_prefix("VERTEX_POINT('',").and_then(|r| r.strip_suffix(");")) {
                corners.push(points[p]);
            }
        }
        corners.sort_by(|a, b| a.partial_cmp(b).unwrap());
        corners
    }

    #[test]
    fn a_stored_bodys_step_file_is_the_placed_body_written_by_hand() {
        let mut store = BodyStore::new();
        // A unit box is make_box(1, 1, 1): the file is the one checked by
        // hand line by line (tests/step/unit_cube.step, step_write.rs).
        let h = store.build(cube(1.0)).unwrap();
        let box_file = store.step(h).unwrap();
        assert_eq!(box_file, step_write::write(&crate::ops::primitives::make_box(1.0, 1.0, 1.0).unwrap()).unwrap());
        // The unit square drawn on the front plane (origin 0, x (1, 0, 0),
        // normal (0, −1, 0)), extruded 1 the other way (flip). The plane's
        // y is normal × x = (−1·0 − 0·0, 0·1 − 0·0, 0·0 − (−1)·1) = (0, 0, 1),
        // so sketch (u, v) is world (u, 0, v), and the flipped extrude goes
        // along −normal = +y: the cube [0, 1]³ again, its eight corners
        // every 0/1 triple. The placement turns by a rotation worked out
        // from the frame, so the corners carry a few ulps of rounding
        // (2.2e-16 seen): within 1e-12 mm, far below LINEAR.
        let front = crate::FrameIn { origin: [0.0, 0.0, 0.0], x: [1.0, 0.0, 0.0], normal: [0.0, -1.0, 0.0] };
        let square = ProfileIn { outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0], bulges: vec![] }, holes: vec![] };
        let p = store.build(BodySpec::Extrude { profile: square, distance: 1.0, frame: Some(front), flip: true }).unwrap();
        let placed_file = store.step(p).unwrap();
        let mut want = vec![];
        for k in 0..8 {
            want.push([(k & 1) as f64, (k >> 1 & 1) as f64, (k >> 2 & 1) as f64]);
        }
        want.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let near = |got: Vec<[f64; 3]>| got.len() == 8 && got.iter().zip(&want).all(|(g, w)| (0..3).all(|i| (g[i] - w[i]).abs() < 1e-12));
        let placed_corners = step_vertices(&placed_file);
        assert!(near(placed_corners.clone()), "{placed_corners:?}");
        assert_eq!(step_vertices(&box_file), want);
        // Six faces, each written once; the local body (before placing) sits
        // at z in [−1, 0] (flipped on its own plane), so its file differs:
        // the store wrote the placed one.
        assert_eq!(placed_file.matches("= ADVANCED_FACE(").count(), 6);
        let (built, _) = store.get(p).unwrap();
        assert!(!near(step_vertices(&step_write::write(&built.body).unwrap())));
        assert_eq!(placed_file, step_write::write(&built.baked()).unwrap());
        // A freed or never-made handle is refused like the other calls.
        store.free(h).unwrap();
        assert_eq!(store.step(h).unwrap_err().kind, ErrorKind::UnknownBody);
        assert_eq!(store.step(99).unwrap_err().kind, ErrorKind::UnknownBody);
    }

    #[test]
    fn handles_from_javascript_are_whole_numbers_in_range() {
        assert_eq!(handle_from_js(1.0).unwrap(), 1);
        assert_eq!(handle_from_js(MAX_HANDLE as f64).unwrap(), MAX_HANDLE);
        // 2^53 itself is out: past it, a double can't tell n from n + 1.
        for bad in [0.0, -1.0, 1.5, 0.999, f64::NAN, f64::INFINITY, -0.0, (MAX_HANDLE + 1) as f64] {
            let e = handle_from_js(bad).unwrap_err();
            assert_eq!((e.kind, e.inputs), (ErrorKind::BadRequest, vec![Input::Param { name: "body" }]), "{bad}");
        }
        assert_eq!(handle_from_js(1.5).unwrap_err().message, "a body handle is a whole number from 1 to 9007199254740991, got 1.5");
    }

    #[test]
    fn the_store_refuses_past_its_limits_and_recovers_after_a_free() {
        let mut store = BodyStore::new();
        // Filling with real bodies would take a while; this limit only
        // looks at the count, so fill the map with one body's copies (and
        // count their bytes, 10,000 · 624, far under the memory limit).
        let one = build_meshed(cube(1.0)).unwrap();
        for h in 1..=MAX_LIVE_BODIES as Handle {
            store.bodies.insert(h, one.clone());
            store.held += held_bytes(&one);
        }
        store.next = MAX_LIVE_BODIES as Handle + 1;
        let e = store.build(cube(1.0)).unwrap_err();
        assert_eq!((e.kind, e.inputs.len()), (ErrorKind::TooManyBodies, 0));
        assert_eq!(store.live(), MAX_LIVE_BODIES);
        // One fewer and it builds again.
        store.free(5).unwrap();
        assert_eq!(store.build(cube(1.0)).unwrap(), MAX_LIVE_BODIES as Handle + 1);
        // The last handle a JavaScript number holds exactly is handed out;
        // the one after is refused, never wrapped round to 0 or reused.
        let mut store = BodyStore::new();
        store.next = MAX_HANDLE;
        assert_eq!(store.build(cube(1.0)).unwrap(), MAX_HANDLE);
        assert_eq!(store.build(cube(1.0)).unwrap_err().kind, ErrorKind::TooManyBodies);
        assert_eq!(store.live(), 1);
    }

    #[test]
    fn a_box_holds_what_its_mesh_counts_worked_by_hand() {
        // A box's mesh: its 8 corners, 2 triangles on each of the 6 flat
        // faces, and each of the 12 edges a line of its 2 ends. In the
        // browser build's sizes: 8·24 + 12·12 + 12·4 + 12·(12 + 2·4)
        // = 192 + 144 + 48 + 240 = 624 bytes.
        let made = build_meshed(BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 }).unwrap();
        assert_eq!((made.1.positions.len(), made.1.triangles.len(), made.1.edge_polylines.len()), (8, 12, 12));
        assert_eq!(held_bytes(&made), 624);
        let mut store = BodyStore::new();
        store.build(BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 }).unwrap();
        assert_eq!(store.held(), 624);
    }

    #[test]
    fn the_memory_limit_takes_a_body_that_just_fits_and_refuses_one_byte_more() {
        let boxed = || BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 };
        // 624 bytes left, the box's own count: it fits, filling the limit.
        let mut store = BodyStore::new();
        store.held = MAX_HELD_BYTES - 624;
        assert_eq!(store.build(boxed()).unwrap(), 1);
        assert_eq!(store.held(), MAX_HELD_BYTES);
        // 623 left: refused, nothing stored, no handle used.
        let mut store = BodyStore::new();
        store.held = MAX_HELD_BYTES - 623;
        let e = store.build(boxed()).unwrap_err();
        assert_eq!((e.kind, e.inputs.len()), (ErrorKind::TooManyBodies, 0));
        assert_eq!(
            e.message,
            "the kernel's bodies already take 500.0 MB of the 500 MB it keeps for them, and this one needs 0.0 MB more; free the ones no longer needed"
        );
        assert_eq!((store.live(), store.held()), (0, MAX_HELD_BYTES - 623));
        // A body 0.9× the room left fits; one 1.1× it doesn't. The box is
        // 624 bytes: room 624 / 0.9 = 693 fits it, 624 / 1.1 = 567 doesn't.
        for (room, fits) in [(693, true), (567, false)] {
            let mut store = BodyStore::new();
            store.held = MAX_HELD_BYTES - room;
            assert_eq!(store.build(boxed()).is_ok(), fits, "{room} bytes left");
        }
        // Once a body is freed, its bytes are back.
        let mut store = BodyStore::new();
        store.held = MAX_HELD_BYTES - 1248;
        let a = store.build(boxed()).unwrap();
        store.build(boxed()).unwrap();
        assert_eq!(store.build(boxed()).unwrap_err().kind, ErrorKind::TooManyBodies);
        store.free(a).unwrap();
        assert_eq!(store.build(boxed()).unwrap(), 3);
    }

    #[test]
    fn a_leak_of_spheres_is_refused_long_before_the_browser_runs_out() {
        // The crash hunt's leak (2026-10-19): 50 mm spheres built and never
        // freed. The browser build died at 4,366 of them ("unreachable", at
        // its 4 GiB), well under the 10,000-body count, so the count alone
        // never refused one. Each counts 12,484 points · 24 + 24,964
        // triangles · 16 + its one edge's line 12 + 159 · 4 = 299,616 +
        // 399,424 + 648 = 699,688 bytes, so 5e8 / 699,688 = 714.6: the
        // 714th fits and the 715th is refused.
        let sphere = || BodySpec::Sphere { radius: 50.0 };
        let mut store = BodyStore::new();
        store.build(sphere()).unwrap();
        let each = store.held();
        assert_eq!(each, 699_688);
        // As if 713 had leaked already (only the count matters to the limit).
        store.held = 713 * each;
        store.build(sphere()).unwrap();
        let e = store.build(sphere()).unwrap_err();
        assert_eq!(e.kind, ErrorKind::TooManyBodies);
        assert_eq!(
            e.message,
            "the kernel's bodies already take 499.6 MB of the 500 MB it keeps for them, and this one needs 0.7 MB more; free the ones no longer needed"
        );
    }

    #[test]
    fn freeing_gives_back_exactly_what_building_counted() {
        let specs: [fn() -> BodySpec; 4] = [
            || cube(3.0),
            || BodySpec::Cylinder { radius: 5.0, height: 10.0 },
            || BodySpec::Sphere { radius: 7.0 },
            || BodySpec::Extrude {
                profile: ProfileIn {
                    outer: BoundaryIn::Path { corners: vec![0.0, 0.0, 30.0, 0.0, 30.0, 10.0, 0.0, 10.0], bulges: vec![0.0, 0.5, 0.0, 0.0] },
                    holes: vec![BoundaryIn::Circle { center: [12.0, 5.0], radius: 2.0 }],
                },
                distance: 4.0,
                frame: None,
                flip: false,
            },
        ];
        let each: Vec<usize> = specs.iter().map(|s| held_bytes(&build_meshed(s()).unwrap())).collect();
        let mut store = BodyStore::new();
        let handles: Vec<Handle> = specs.iter().map(|s| store.build(s()).unwrap()).collect();
        assert_eq!(store.held(), each.iter().sum::<usize>());
        // Freed out of order, the count steps down by each body's own.
        let mut left = store.held();
        for i in [2, 0, 3, 1] {
            store.free(handles[i]).unwrap();
            left -= each[i];
            assert_eq!(store.held(), left);
        }
        assert_eq!(store.held(), 0);
        // A refused free gives nothing back.
        assert!(store.free(handles[0]).is_err());
        assert_eq!(store.held(), 0);
    }

    /// splitmix64: a seeded stream of numbers, so a failing session replays.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// A bug planted in the store between steps, to prove the session
    /// check notices it (`a_planted_bug_is_caught_by_every_session_check`).
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Fault {
        None,
        /// Hands out handles again from 1.
        ReuseHandles,
        /// Loses a body nobody freed.
        LoseBody,
        /// Gives one body's handle the other's body.
        SwapBodies,
        /// Counts a byte that no body holds.
        MiscountBytes,
    }

    /// A random session of builds, views and frees on one store, checked
    /// step by step against a simple model: which handles are live, each
    /// with the volume worked out from its spec by formula (a box w·d·h, a
    /// cylinder πr²h, a sphere 4πr³/3, a rectangle extruded w·d·h), and
    /// the bytes each counted when it was built, which the store's `held`
    /// must add up to. Returns the first disagreement.
    fn session(seed: u64, steps: usize, fault: Fault) -> Result<(), String> {
        let mut rng = Rng(seed);
        let mut store = BodyStore::new();
        let mut live: BTreeMap<Handle, f64> = BTreeMap::new();
        let mut bytes: BTreeMap<Handle, usize> = BTreeMap::new();
        let mut freed: Vec<Handle> = vec![];
        let mut last: Handle = 0;
        for step in 0..steps {
            let at = |m: String| format!("seed {seed}, step {step}: {m}");
            if step == steps / 2 {
                match fault {
                    Fault::None => {}
                    Fault::ReuseHandles => store.next = 1,
                    Fault::LoseBody => {
                        if let Some(&h) = live.keys().next() {
                            store.bodies.remove(&h);
                        }
                    }
                    Fault::MiscountBytes => store.held += 1,
                    Fault::SwapBodies => {
                        let keys: Vec<Handle> = live.keys().copied().collect();
                        if keys.len() >= 2 {
                            let a = store.bodies.remove(&keys[0]).unwrap();
                            let b = store.bodies.insert(keys[1], a).unwrap();
                            store.bodies.insert(keys[0], b);
                        }
                    }
                }
            }
            let size = |rng: &mut Rng| 1.0 + rng.below(40) as f64;
            match rng.below(10) {
                // Build: a valid body, or one with a bad size.
                0..=4 => {
                    let bad = rng.below(6) == 0;
                    let (spec, volume) = match rng.below(4) {
                        0 => {
                            let (w, d, h) = (size(&mut rng), size(&mut rng), size(&mut rng));
                            (BodySpec::Box { width: if bad { -w } else { w }, depth: d, height: h }, w * d * h)
                        }
                        1 => {
                            let (r, h) = (size(&mut rng), size(&mut rng));
                            (BodySpec::Cylinder { radius: r, height: if bad { 0.0 } else { h } }, PI * r * r * h)
                        }
                        2 => {
                            let r = size(&mut rng);
                            (BodySpec::Sphere { radius: if bad { f64::NAN } else { r } }, 4.0 * PI * r * r * r / 3.0)
                        }
                        _ => {
                            let (w, d, h) = (size(&mut rng), size(&mut rng), size(&mut rng));
                            let corners = vec![0.0, 0.0, w, 0.0, w, d, 0.0, d];
                            let profile = ProfileIn { outer: BoundaryIn::Path { corners, bulges: vec![] }, holes: vec![] };
                            // Half of them on the XY, front or side plane, either way (26b): the same volume.
                            let planes = [([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]), ([1.0, 0.0, 0.0], [0.0, -1.0, 0.0]), ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0])];
                            let (frame, flip) = match rng.below(2) {
                                0 => (None, false),
                                _ => {
                                    let (x, normal) = planes[rng.below(3) as usize];
                                    (Some(crate::FrameIn { origin: [size(&mut rng), -size(&mut rng), 0.0], x, normal }), rng.below(2) == 1)
                                }
                            };
                            (BodySpec::Extrude { profile, distance: if bad { -h } else { h }, frame, flip }, w * d * h)
                        }
                    };
                    let want_input = match &spec {
                        BodySpec::Box { .. } => "width",
                        BodySpec::Cylinder { .. } => "height",
                        BodySpec::Sphere { .. } => "radius",
                        BodySpec::Extrude { .. } => "distance",
                    };
                    match (store.build(spec), bad) {
                        (Ok(h), false) => {
                            if h <= last || live.contains_key(&h) || freed.contains(&h) {
                                return Err(at(format!("handle {h} was handed out before (last {last})")));
                            }
                            last = h;
                            live.insert(h, volume);
                            bytes.insert(h, held_bytes(&store.bodies[&h]));
                        }
                        (Err(e), true) => {
                            if e.kind != ErrorKind::InvalidInput || e.inputs != vec![Input::Param { name: want_input }] {
                                return Err(at(format!("a bad {want_input} gave {e:?}")));
                            }
                        }
                        (got, _) => return Err(at(format!("bad = {bad} gave {got:?}"))),
                    }
                }
                // View a live body: its volume by formula.
                5..=6 => {
                    let Some((&h, &volume)) = live.iter().nth(rng.below(live.len().max(1) as u64) as usize) else { continue };
                    let v = store.view(h).map_err(|e| at(format!("live body {h}: {e:?}")))?;
                    if !rel_eq(v.volume, volume, FP_REL) {
                        return Err(at(format!("body {h} has volume {}, its spec {volume}", v.volume)));
                    }
                }
                // Free a live body.
                7..=8 => {
                    let Some(&h) = live.keys().nth(rng.below(live.len().max(1) as u64) as usize) else { continue };
                    store.free(h).map_err(|e| at(format!("freeing live body {h}: {e:?}")))?;
                    live.remove(&h);
                    bytes.remove(&h);
                    freed.push(h);
                }
                // Use a freed or never-made handle: refused, nothing changes.
                _ => {
                    let h = if !freed.is_empty() && rng.below(2) == 0 { freed[rng.below(freed.len() as u64) as usize] } else { last + 1 + rng.below(5) };
                    for e in [store.view(h).err(), store.free(h).err()] {
                        if e.map(|e| e.kind) != Some(ErrorKind::UnknownBody) {
                            return Err(at(format!("handle {h} is not live but was answered")));
                        }
                    }
                }
            }
            if store.live() != live.len() {
                return Err(at(format!("the store holds {} bodies, the model {}", store.live(), live.len())));
            }
            if store.held() != bytes.values().sum::<usize>() {
                return Err(at(format!("the store counts {} bytes, its bodies {}", store.held(), bytes.values().sum::<usize>())));
            }
        }
        Ok(())
    }

    #[test]
    fn seeded_sessions_agree_with_the_model() {
        for seed in 1..=12 {
            session(seed, 120, Fault::None).unwrap();
        }
    }

    #[test]
    fn a_planted_bug_is_caught_by_every_session_check() {
        // Each fault, planted half way through, must make at least one of
        // the seeds' sessions fail; else the session check is too weak to
        // trust its passes.
        for fault in [Fault::ReuseHandles, Fault::LoseBody, Fault::SwapBodies, Fault::MiscountBytes] {
            let caught = (1..=12).filter(|&seed| session(seed, 120, fault).is_err()).count();
            assert!(caught > 0, "{fault:?} went unnoticed in every session");
        }
    }
}
