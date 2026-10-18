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
//! - At most `MAX_LIVE_BODIES` bodies at once, so a leak in the app ends
//!   in a clear error, not in WebAssembly running out of memory (its
//!   memory never shrinks). `live()` lets the app's tests check that what
//!   they build they free.
//! - A body is stored with the display mesh its validation made, so its
//!   view and STL never tessellate it again, and give exactly what
//!   `view_of` and `stl_of` give for the same spec.

use crate::api_error::{ApiError, ErrorKind};
use crate::ops::{Input, Meshed};
use crate::{build_meshed, stl, view_parts, BodySpec, BodyView, StlFile};
use std::collections::BTreeMap;

/// A stored body's number. 0 is never one.
pub type Handle = u64;

/// The most bodies the store holds at once. A timeline keeps one body per
/// solid feature plus the few it is replacing; the plan's largest test
/// timeline has 200 items.
pub const MAX_LIVE_BODIES: usize = 10_000;

/// The largest handle: 2^53 − 1, the largest whole number a JavaScript
/// number (a double) holds with every whole number below it.
pub const MAX_HANDLE: Handle = (1 << 53) - 1;

#[derive(Debug)]
pub struct BodyStore {
    /// The handle the next stored body gets.
    next: Handle,
    bodies: BTreeMap<Handle, Meshed>,
}

impl Default for BodyStore {
    fn default() -> Self {
        BodyStore::new()
    }
}

impl BodyStore {
    pub fn new() -> BodyStore {
        BodyStore { next: 1, bodies: BTreeMap::new() }
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
        let handle = self.next;
        self.next += 1;
        self.bodies.insert(handle, made);
        Ok(handle)
    }

    /// The view of a stored body, the same as `view_of` gives for its spec.
    pub fn view(&self, handle: Handle) -> Result<BodyView, ApiError> {
        let (body, mesh) = self.get(handle)?;
        Ok(view_parts(body, mesh, vec![]))
    }

    /// A stored body as binary STL, the same as `stl_of` gives for its spec.
    pub fn stl(&self, handle: Handle, name: &str) -> Result<StlFile, ApiError> {
        let (_, mesh) = self.get(handle)?;
        let out = stl::export(mesh, name);
        Ok(StlFile { bytes: out.bytes, rounding: out.rounding, warning: out.warning })
    }

    /// Lets a body go. Its handle is never handed out again.
    pub fn free(&mut self, handle: Handle) -> Result<(), ApiError> {
        self.bodies.remove(&handle).map(|_| ()).ok_or_else(|| unknown(handle))
    }

    /// How many bodies the store holds.
    pub fn live(&self) -> usize {
        self.bodies.len()
    }

    fn get(&self, handle: Handle) -> Result<&Meshed, ApiError> {
        self.bodies.get(&handle).ok_or_else(|| unknown(handle))
    }
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
        let specs: [fn() -> BodySpec; 4] = [
            || BodySpec::Box { width: 40.0, depth: 30.0, height: 20.0 },
            || BodySpec::Cylinder { radius: 3.0, height: 7.0 },
            || BodySpec::Sphere { radius: 4.0 },
            || BodySpec::Extrude { profile: ProfileIn { outer: BoundaryIn::Circle { center: [1.0, 2.0], radius: 3.0 }, holes: vec![] }, distance: 5.0 },
        ];
        let mut store = BodyStore::new();
        for spec in specs {
            let h = store.build(spec()).unwrap();
            let json = |v: BodyView| serde_json::to_string(&v).unwrap();
            assert_eq!(json(store.view(h).unwrap()), json(view_of(spec()).unwrap()));
            assert_eq!(store.stl(h, "part").unwrap().bytes, stl_of(spec(), "part").unwrap().bytes);
        }
        let h = store.build(BodySpec::Extrude { profile: rect(), distance: 2.0 }).unwrap();
        // 30·10 − π·2² = 300 − 4π, by 2: 600 − 8π.
        assert!(rel_eq(store.view(h).unwrap().volume, 600.0 - 8.0 * PI, FP_REL));
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
        // Filling with real bodies would take a while; the limit only looks
        // at the count, so fill the map with one body's copies.
        let one = build_meshed(cube(1.0)).unwrap();
        for h in 1..=MAX_LIVE_BODIES as Handle {
            store.bodies.insert(h, one.clone());
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
    }

    /// A random session of builds, views and frees on one store, checked
    /// step by step against a simple model: which handles are live, each
    /// with the volume worked out from its spec by formula (a box w·d·h, a
    /// cylinder πr²h, a sphere 4πr³/3, a rectangle extruded w·d·h).
    /// Returns the first disagreement.
    fn session(seed: u64, steps: usize, fault: Fault) -> Result<(), String> {
        let mut rng = Rng(seed);
        let mut store = BodyStore::new();
        let mut live: BTreeMap<Handle, f64> = BTreeMap::new();
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
                            (BodySpec::Extrude { profile, distance: if bad { -h } else { h } }, w * d * h)
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
        for fault in [Fault::ReuseHandles, Fault::LoseBody, Fault::SwapBodies] {
            let caught = (1..=12).filter(|&seed| session(seed, 120, fault).is_err()).count();
            assert!(caught > 0, "{fault:?} went unnoticed in every session");
        }
    }
}
