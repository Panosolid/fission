//! Testing hunt 3c (docs/progress/testing-hunts.md): the whole modelling
//! range, 1 µm to 1 km (`MIN_FEATURE` to `MAX_SIZE`), and near-tangent
//! circles, through the calls the app makes (`view_of`, `stl_of`).
//!
//! - `ends_of_the_range_by_hand`: bodies at both ends of the range and
//!   plates a billion times wider than they are thick, with volumes and
//!   areas worked out by hand.
//! - `lengths_at_0_9_and_1_1_of_the_limits`: every length a body takes, and
//!   a profile's reach, at 0.9× and 1.1× of MIN_FEATURE, MAX_SIZE and
//!   MAX_COORD: refused on the wrong side (naming the input), built on the
//!   right one.
//! - `sizes_from_a_micrometre_to_a_kilometre`: three profiles (a plate with
//!   a hole, a D, a slot) scaled every quarter decade from 1 µm to 1 km,
//!   extruded from 1 µm to 10,000 times their size, in the XY plane and in
//!   level and tilted frames up to 90 km out, flipped and not; plus boxes,
//!   cylinders and spheres. Each body must be built exactly when the rules
//!   say it can be (and refused naming the right input when not), with its
//!   exact volume and area (FP_REL), its end cap's centroid where the frame
//!   puts it (within LINEAR), and an STL whose rounding is within single
//!   precision, warned about exactly when it passes MIN_FEATURE.
//! - `near_tangent_circles`: hand-worked cases, then 5,000 seeded ones
//!   (`FISSION_SEED` picks another run), of a hole circle f · MIN_FEATURE
//!   from the inside of an outer circle, from another hole, from a straight
//!   side, from the inside of an arc and from a side up to 1 km long, with f = 0.9 (refused: too close)
//!   and 1.1, 1.5, 3 (built, with the exact volume), at sizes from 10 µm to
//!   500 m and up to 50 km out.
//!
//! - `small_curves_beside_long_sides`: the bug this hunt found, at 0.9×
//!   and 1.1× of MIN_FEATURE.
//!
//! Hunt result (2026-10-22): one bug. A hole or a notch 1.1 µm from a long
//! straight side, away from its ends, was refused as crossing it ("0 mm
//! apart") once the side was a few hundred metres long: `crossing` in
//! ops/profile.rs took the squared distance from the line as a difference
//! of two squares as big as the line is long (fixed; regression test
//! `a_small_circle_beside_a_long_line_is_not_taken_for_a_crossing`).
//! Everything else gave the right answer. The first survey's other
//! differences were the harness's own: far out, a corner like 5e7 + 0.1
//! is stored rounded to 7.5e-9 mm, so an expected area must come from the
//! doubles the profile holds, not from the decimal sizes it was made from
//! (`square`, and the strip and the D in `tangent`).

use fission_kernel::api_error::ErrorKind;
use fission_kernel::fmath;
use fission_kernel::ops::Input;
use fission_kernel::tolerance::{rel_eq, FP_REL, LINEAR, MAX_COORD, MAX_SIZE, MIN_FEATURE};
use fission_kernel::{stl, stl_of, view_of, BodySpec, BodyView, BoundaryIn, FrameIn, ProfileIn, StlFile};
use std::f64::consts::PI;

fn path(c: &[[f64; 2]], b: &[f64]) -> BoundaryIn {
    BoundaryIn::Path { corners: c.iter().flatten().copied().collect(), bulges: b.to_vec() }
}

fn copy(b: &BoundaryIn) -> BoundaryIn {
    match b {
        BoundaryIn::Path { corners, bulges } => BoundaryIn::Path { corners: corners.clone(), bulges: bulges.clone() },
        BoundaryIn::Circle { center, radius } => BoundaryIn::Circle { center: *center, radius: *radius },
    }
}

fn extrude(p: &ProfileIn, distance: f64, frame: Option<FrameIn>, flip: bool) -> BodySpec {
    let profile = ProfileIn { outer: copy(&p.outer), holes: p.holes.iter().map(copy).collect() };
    BodySpec::Extrude { profile, distance, frame, flip }
}

/// The body's view and STL; panics naming `what` if either is refused or
/// the body fails validation.
fn built(spec: impl Fn() -> BodySpec, what: &str) -> (BodyView, StlFile) {
    let view = view_of(spec()).unwrap_or_else(|e| panic!("{what}: refused: {}", e.message));
    assert!(view.errors.is_empty(), "{what}: {:?}", view.errors);
    let file = stl_of(spec(), "sweep").unwrap_or_else(|e| panic!("{what}: STL refused: {}", e.message));
    (view, file)
}

/// The refusal of a body, asserting it is the user's to fix and names `input`.
fn refused(spec: BodySpec, input: &Input, what: &str) -> String {
    let e = view_of(spec).err().unwrap_or_else(|| panic!("{what}: built, but should be refused"));
    assert_eq!(e.kind, ErrorKind::InvalidInput, "{what}: {}", e.message);
    assert!(e.inputs.contains(input), "{what}: names {:?}, not {input:?}: {}", e.inputs, e.message);
    e.message
}

/// The STL's own checks: the largest rounding to single precision is at
/// most half a float's step at the farthest corner (2⁻²⁴ of `far`, a bound
/// on every coordinate), it is warned about exactly when it passes
/// MIN_FEATURE, and the file reads back with every triangle.
fn check_stl(file: &StlFile, far: f64, triangles: usize, what: &str) {
    assert!(file.rounding <= far * 2f64.powi(-24), "{what}: STL rounding {} for corners within {far}", file.rounding);
    assert_eq!(file.warning.is_some(), file.rounding > MIN_FEATURE, "{what}: rounding {} warning {:?}", file.rounding, file.warning);
    let back = stl::read(&file.bytes).unwrap_or_else(|e| panic!("{what}: STL unreadable: {e}"));
    assert_eq!(back.triangles.len(), triangles, "{what}");
}

#[test]
fn ends_of_the_range_by_hand() {
    // A 1 µm cube: V = (1e-3)³ = 1e-9 mm³, A = 6 · (1e-3)² = 6e-6 mm².
    let (v, _) = built(|| BodySpec::Box { width: 1e-3, depth: 1e-3, height: 1e-3 }, "1 µm cube");
    assert!(rel_eq(v.volume, 1e-9, FP_REL) && rel_eq(v.area, 6e-6, FP_REL), "{} {}", v.volume, v.area);
    // A 1 km cube: V = (1e6)³ = 1e18 mm³, A = 6 · (1e6)² = 6e12 mm².
    let (v, _) = built(|| BodySpec::Box { width: 1e6, depth: 1e6, height: 1e6 }, "1 km cube");
    assert!(rel_eq(v.volume, 1e18, FP_REL) && rel_eq(v.area, 6e12, FP_REL), "{} {}", v.volume, v.area);
    // A plate 1 km square and 1 µm thick, a billion to one:
    // V = 1e6 · 1e6 · 1e-3 = 1e9 mm³; A = 2 · 1e12 + 4 · (1e6 · 1e-3) = 2e12 + 4e3 mm².
    let (v, _) = built(|| BodySpec::Box { width: 1e6, depth: 1e6, height: 1e-3 }, "1 km plate");
    assert!(rel_eq(v.volume, 1e9, FP_REL) && rel_eq(v.area, 2e12 + 4e3, FP_REL), "{} {}", v.volume, v.area);
    // A disc of radius 1 km, 1 µm thick: V = π r² h = π · 1e12 · 1e-3 = π · 1e9;
    // A = 2πr² + 2πrh = 2π · 1e12 + 2π · 1e3.
    let (v, _) = built(|| BodySpec::Cylinder { radius: 1e6, height: 1e-3 }, "1 km disc");
    assert!(rel_eq(v.volume, PI * 1e9, FP_REL) && rel_eq(v.area, 2.0 * PI * (1e12 + 1e3), FP_REL), "{} {}", v.volume, v.area);
    // A wire 1 µm in radius and 1 km long: V = π · 1e-6 · 1e6 = π;
    // A = 2π · 1e-6 + 2π · 1e-3 · 1e6 = 2π(1e-6 + 1e3).
    let (v, _) = built(|| BodySpec::Cylinder { radius: 1e-3, height: 1e6 }, "1 km wire");
    assert!(rel_eq(v.volume, PI, FP_REL) && rel_eq(v.area, 2.0 * PI * (1e-6 + 1e3), FP_REL), "{} {}", v.volume, v.area);
    // Spheres of radius 1 µm and 1 km: V = 4/3 π r³, A = 4π r².
    for r in [1e-3, 1e6] {
        let (v, _) = built(|| BodySpec::Sphere { radius: r }, "sphere");
        assert!(rel_eq(v.volume, 4.0 / 3.0 * PI * r * r * r, FP_REL) && rel_eq(v.area, 4.0 * PI * r * r, FP_REL), "r {r}: {} {}", v.volume, v.area);
    }
    // A 1 km square with a hole of radius 1 µm whose centre is 2.1 µm in
    // from two sides (so 1.1 µm from each), extruded 1 µm:
    // area 1e12 − π(1e-3)² = 1e12 − π · 1e-6; V = that · 1e-3.
    let c = 1e-3 + 1.1e-3;
    let p = ProfileIn { outer: path(&[[0.0, 0.0], [1e6, 0.0], [1e6, 1e6], [0.0, 1e6]], &[]), holes: vec![BoundaryIn::Circle { center: [c, c], radius: 1e-3 }] };
    let (v, _) = built(|| extrude(&p, 1e-3, None, false), "1 km plate, 1 µm hole");
    assert!(rel_eq(v.volume, (1e12 - PI * 1e-6) * 1e-3, FP_REL), "{}", v.volume);
}

#[test]
fn lengths_at_0_9_and_1_1_of_the_limits() {
    let (lo, hi) = (MIN_FEATURE, MAX_SIZE);
    for (ok, bad) in [(1.1 * lo, 0.9 * lo), (0.9 * hi, 1.1 * hi)] {
        let mid = 1.0;
        let one_of = |x: f64| [(x, mid, mid), (mid, x, mid), (mid, mid, x)];
        for (i, (a, b, c)) in one_of(ok).into_iter().enumerate() {
            built(|| BodySpec::Box { width: a, depth: b, height: c }, &format!("box size {i} at {ok}"));
        }
        for (i, (a, b, c)) in one_of(bad).into_iter().enumerate() {
            let name = ["width", "depth", "height"][i];
            refused(BodySpec::Box { width: a, depth: b, height: c }, &Input::Param { name }, &format!("box {name} {bad}"));
        }
        built(|| BodySpec::Cylinder { radius: ok, height: ok }, "cylinder");
        refused(BodySpec::Cylinder { radius: bad, height: mid }, &Input::Param { name: "radius" }, "cylinder radius");
        refused(BodySpec::Cylinder { radius: mid, height: bad }, &Input::Param { name: "height" }, "cylinder height");
        built(|| BodySpec::Sphere { radius: ok }, "sphere");
        refused(BodySpec::Sphere { radius: bad }, &Input::Param { name: "radius" }, "sphere radius");
        let disc = |r: f64| ProfileIn { outer: BoundaryIn::Circle { center: [0.0, 0.0], radius: r }, holes: vec![] };
        // A disc's radius at the small end; at the large end its span (the
        // diameter) is what meets MAX_SIZE, so the radius is half that.
        let radius = if ok < mid { ok } else { ok / 2.0 };
        built(|| extrude(&disc(radius), ok, None, false), "extruded disc");
        refused(extrude(&disc(mid), bad, None, false), &Input::Param { name: "distance" }, "extrude distance");
        refused(extrude(&disc(bad), mid, None, false), &Input::Loop { boundary: 0 }, "disc radius");
    }
    // A square: its sides must be MIN_FEATURE long, and it may span MAX_SIZE.
    let square = |s: f64| ProfileIn { outer: path(&[[0.0, 0.0], [s, 0.0], [s, s], [0.0, s]], &[]), holes: vec![] };
    built(|| extrude(&square(1.1 * lo), 1.0, None, false), "1.1 µm square");
    refused(extrude(&square(0.9 * lo), 1.0, None, false), &Input::Piece { boundary: 0, piece: 0 }, "0.9 µm square");
    built(|| extrude(&square(0.9 * hi), 1.0, None, false), "0.9 km square");
    refused(extrude(&square(1.1 * hi), 1.0, None, false), &Input::Loop { boundary: 0 }, "1.1 km square");
    // A unit circle centred 0.9 · MAX_COORD out (reaching 9e7 + 1, inside
    // 1e8) is built; at 1.1 · MAX_COORD it reaches past model space.
    let at = |x: f64| ProfileIn { outer: BoundaryIn::Circle { center: [x, 0.0], radius: 1.0 }, holes: vec![] };
    built(|| extrude(&at(0.9 * MAX_COORD), 1.0, None, false), "circle 90 km out");
    let message = refused(extrude(&at(1.1 * MAX_COORD), 1.0, None, false), &Input::Piece { boundary: 0, piece: 0 }, "circle 110 km out");
    assert!(message.contains("beyond"), "{message}");
}

#[test]
fn small_curves_beside_long_sides() {
    // The bug this hunt found (`a_small_circle_beside_a_long_line_is_not_
    // taken_for_a_crossing` in ops/profile.rs): a curve f · MIN_FEATURE from
    // a long straight side, away from its ends, was refused as crossing it
    // once the side was a few hundred metres long. f = 0.9 must still be
    // refused (too close), f = 1.1 built.
    for (f, ok) in [(0.9, false), (1.1, true)] {
        let g = f * MIN_FEATURE;
        // A 1 km square with a hole of radius 1 µm whose centre is 1 µm + g
        // in from the left side, 5 mm up and halfway up: area 1e12 − π · 1e-6.
        for y in [5.0, 5e5] {
            let p = ProfileIn { outer: path(&[[0.0, 0.0], [1e6, 0.0], [1e6, 1e6], [0.0, 1e6]], &[]), holes: vec![BoundaryIn::Circle { center: [1e-3 + g, y], radius: 1e-3 }] };
            let what = format!("1 km square, hole {f} × MIN_FEATURE from its side at y = {y}");
            if ok {
                let (v, _) = built(|| extrude(&p, 1.0, None, false), &what);
                assert!(rel_eq(v.volume, 1e12 - PI * 1e-6, FP_REL), "{what}: {}", v.volume);
            } else {
                let message = refused(extrude(&p, 1.0, None, false), &Input::Piece { boundary: 1, piece: 0 }, &what);
                assert!(!message.contains(" 0e0 mm"), "{what}: measured as crossing: {message}");
            }
        }
        // The same test for an arc, in one outline as a sketch makes it (it
        // happened to be read right before the fix, here): a strip 1 km long and 1 mm
        // wide with a half-round notch of radius R = 1 − g cut down from
        // its top side at x = 3e5, so the notch's bottom is g above the
        // bottom side. Corners (0, 0), (1e6, 0), (1e6, 1), (3e5 + R, 1),
        // (3e5 − R, 1), (0, 1); the notch runs right to left through
        // (3e5, 1 − R), clockwise: bulge −1. Area 1e6 · 1 − πR²/2.
        let r = 1.0 - g;
        let corners = [[0.0, 0.0], [1e6, 0.0], [1e6, 1.0], [3e5 + r, 1.0], [3e5 - r, 1.0], [0.0, 1.0]];
        let p = ProfileIn { outer: path(&corners, &[0.0, 0.0, 0.0, -1.0, 0.0, 0.0]), holes: vec![] };
        let what = format!("1 km strip, notch {f} × MIN_FEATURE from its bottom");
        if ok {
            let (v, _) = built(|| extrude(&p, 1.0, None, false), &what);
            assert!(rel_eq(v.volume, 1e6 - PI * r * r / 2.0, FP_REL), "{what}: {}", v.volume);
        } else {
            let message = refused(extrude(&p, 1.0, None, false), &Input::Piece { boundary: 0, piece: 3 }, &what);
            assert!(!message.contains(" 0e0 mm"), "{what}: measured as crossing: {message}");
        }
    }
}

/// One shape of the sweep at size s: its profile, the length the rules
/// need to be at least MIN_FEATURE (its thinnest wall, shortest piece or
/// smallest radius), its span (the larger side of its bounding box), its
/// area and perimeter, and its centroid in its own coordinates.
struct Shape {
    profile: ProfileIn,
    thinnest: f64,
    span: f64,
    area: f64,
    perimeter: f64,
    centroid: [f64; 2],
}

fn shapes(s: f64) -> Vec<Shape> {
    vec![
        // A 4s × 3s plate with a hole of radius s at its middle, so its
        // walls above and below the hole are 0.5s thick: area 12s² − πs²,
        // perimeter 14s + 2πs, span 4s, centroid (2s, 1.5s) (the middle of
        // both the plate and the hole).
        Shape {
            profile: ProfileIn { outer: path(&[[0.0, 0.0], [4.0 * s, 0.0], [4.0 * s, 3.0 * s], [0.0, 3.0 * s]], &[]), holes: vec![BoundaryIn::Circle { center: [2.0 * s, 1.5 * s], radius: s }] },
            thinnest: 0.5 * s,
            span: 4.0 * s,
            area: (12.0 - PI) * s * s,
            perimeter: (14.0 + 2.0 * PI) * s,
            centroid: [2.0 * s, 1.5 * s],
        },
        // A D: the line (0, 0) → (2s, 0), then a half circle back over the
        // top round (s, 0) (bulge 1, counter-clockwise from angle 0 to π):
        // area πs²/2, perimeter 2s + πs, span 2s, and a half disc's
        // centroid, 4r / 3π above its diameter: (s, 4s / 3π).
        Shape {
            profile: ProfileIn { outer: path(&[[0.0, 0.0], [2.0 * s, 0.0]], &[0.0, 1.0]), holes: vec![] },
            thinnest: s,
            span: 2.0 * s,
            area: PI * s * s / 2.0,
            perimeter: (2.0 + PI) * s,
            centroid: [s, 4.0 * s / (3.0 * PI)],
        },
        // A slot: a 4s × 2s rectangle with half circles of radius s on its
        // ends (bulge 1: (4s, 0) → (4s, 2s) round (4s, s) through (5s, s),
        // and (0, 2s) → (0, 0) through (−s, s)): area 8s² + πs²,
        // perimeter 8s + 2πs, span 6s (x from −s to 5s), centroid (2s, s)
        // by symmetry.
        Shape {
            profile: ProfileIn { outer: path(&[[0.0, 0.0], [4.0 * s, 0.0], [4.0 * s, 2.0 * s], [0.0, 2.0 * s]], &[0.0, 1.0, 0.0, 1.0]), holes: vec![] },
            thinnest: s,
            span: 6.0 * s,
            area: (8.0 + PI) * s * s,
            perimeter: (8.0 + 2.0 * PI) * s,
            centroid: [2.0 * s, s],
        },
    ]
}

/// The frames the sweep places its profiles in: none (the XY plane), then
/// level and tilted frames 1 m, 100 m, 10 km and 90 km out. The tilted
/// one's x axis (0.36, 0.48, −0.8) and normal (0.8, −0.6, 0) are unit and
/// square: 0.1296 + 0.2304 + 0.64 = 1, 0.64 + 0.36 = 1, 0.288 − 0.288 = 0.
fn frames(s: f64) -> Vec<Option<FrameIn>> {
    let mut out = vec![None];
    for o in [1e3, 1e5, 1e7, 9e7 - 6.0 * s] {
        out.push(Some(FrameIn { origin: [o, -o, o], x: [1.0, 0.0, 0.0], normal: [0.0, 0.0, 1.0] }));
        out.push(Some(FrameIn { origin: [o, o, -o], x: [0.36, 0.48, -0.8], normal: [0.8, -0.6, 0.0] }));
    }
    out
}

/// Where a frame puts the point (u, v, w) of its own coordinates:
/// origin + u·x + v·y + w·normal, y = normal × x.
fn place(frame: &Option<FrameIn>, [u, v, w]: [f64; 3]) -> [f64; 3] {
    let Some(f) = frame else { return [u, v, w] };
    let (n, x) = (f.normal, f.x);
    let y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    std::array::from_fn(|i| f.origin[i] + u * x[i] + v * y[i] + w * n[i])
}

/// A bound on every coordinate of a body built in `frame` from a profile
/// within `reach` of its own origin, `h` long.
fn reach(frame: &Option<FrameIn>, reach: f64, h: f64) -> f64 {
    frame.map_or(0.0, |f| f.origin.iter().fold(0.0f64, |m, x| m.max(x.abs()))) + reach + h
}

#[test]
fn sizes_from_a_micrometre_to_a_kilometre() {
    let mut sizes: Vec<f64> = (0..=36).map(|k| MIN_FEATURE * fmath::powf(10.0, f64::from(k) / 4.0)).collect();
    sizes.extend([1.1 * MIN_FEATURE, 0.9 * MAX_SIZE]);
    let (mut made, mut refusals) = (0, 0);
    for &s in &sizes {
        // Primitives of size s: V and A by the usual formulas (a cylinder s
        // tall and s across, its radius kept to MIN_FEATURE at least).
        let r = (s / 2.0).max(MIN_FEATURE);
        for (spec, v, a) in [
            (BodySpec::Box { width: s, depth: s, height: s }, s * s * s, 6.0 * s * s),
            (BodySpec::Cylinder { radius: r, height: s }, PI * r * r * s, 2.0 * PI * r * (r + s)),
            (BodySpec::Sphere { radius: s }, 4.0 / 3.0 * PI * s * s * s, 4.0 * PI * s * s),
        ] {
            let what = format!("{spec:?}");
            let view = view_of(spec).unwrap_or_else(|e| panic!("{what}: {}", e.message));
            assert!(rel_eq(view.volume, v, FP_REL) && rel_eq(view.area, a, FP_REL) && view.errors.is_empty(), "{what}: {} {}", view.volume, view.area);
            made += 1;
        }
        for (k, shape) in shapes(s).into_iter().enumerate() {
            for frame in frames(s) {
                for flip in [false, true] {
                    for h in [MIN_FEATURE, s, MAX_SIZE.min(1e4 * s)] {
                        let what = format!("shape {k}, size {s}, height {h}, frame {frame:?}, flip {flip}");
                        let spec = || extrude(&shape.profile, h, frame, flip);
                        if shape.thinnest < MIN_FEATURE {
                            refused(spec(), &Input::Piece { boundary: 0, piece: 0 }, &what);
                            refusals += 1;
                            continue;
                        }
                        if shape.span > MAX_SIZE {
                            refused(spec(), &Input::Loop { boundary: 0 }, &what);
                            refusals += 1;
                            continue;
                        }
                        let (view, file) = built(spec, &what);
                        // V = profile area × h; A = two caps + the walls (perimeter × h).
                        assert!(rel_eq(view.volume, shape.area * h, FP_REL), "{what}: volume {} vs {}", view.volume, shape.area * h);
                        let area = 2.0 * shape.area + shape.perimeter * h;
                        assert!(rel_eq(view.area, area, FP_REL), "{what}: area {} vs {area}", view.area);
                        // The end cap's centroid: the profile's, carried h
                        // along the normal (backwards when flipped: the sketch
                        // stays where it was drawn, the cap goes behind it).
                        let end = view.face_roles.iter().position(|r| r.as_ref().is_some_and(|r| r.role == "end")).expect("an end cap");
                        let [u, v] = shape.centroid;
                        let want = place(&frame, [u, v, if flip { -h } else { h }]);
                        let got = view.face_centroids[end];
                        let off = (0..3).map(|i| (got[i] - want[i]).powi(2)).sum::<f64>().sqrt();
                        assert!(off <= LINEAR, "{what}: end cap centroid {got:?}, expected {want:?} ({off} off)");
                        check_stl(&file, reach(&frame, 6.0 * s, h), view.mesh.indices.len() / 3, &what);
                        made += 1;
                    }
                }
            }
        }
    }
    // Every case was built or refused for its stated reason; the counts
    // show the sweep reached both.
    eprintln!("sizes: {made} built, {refusals} refused");
    assert!(made > 3000 && refusals > 100, "{made} built, {refusals} refused");
}

/// splitmix64: a small seeded generator, so a run replays from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn pick<T: Copy>(&mut self, from: &[T]) -> T {
        from[(self.next() % from.len() as u64) as usize]
    }
}

/// One near-tangent case: the profile, its exact area from the doubles it
/// holds, the sum of the areas that cancel in it (the kernel's rounding is
/// FP_REL of that, not of a thin result), and a bound on its coordinates.
struct Tangent {
    profile: ProfileIn,
    area: f64,
    scale: f64,
    far: f64,
}

/// A square from corner (x0, y0) with sides `side`, and its area from the
/// corners as stored: (x1 − x0)², the difference exact (Sterbenz, or exact
/// anyway: x1 is x0 + side rounded, so x1 − x0 is a double's worth of it).
fn square(x0: f64, y0: f64, side: f64) -> (BoundaryIn, f64, f64) {
    let (x1, y1) = (x0 + side, y0 + side);
    (path(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], &[]), (x1 - x0) * (y1 - y0), x1)
}

/// The five kinds of near-tangent hole, `gap` from what it nearly touches.
/// `size` is the outer shape's size, `rho` the hole's share of it, `t` an
/// angle in [0, 2π), `at` where the shape sits.
fn tangent(kind: usize, gap: f64, size: f64, rho: f64, t: f64, at: f64) -> Option<Tangent> {
    let (s, c) = fmath::sin_cos(t);
    match kind {
        0 => {
            // Inside an outer circle of radius R, a hole of radius r whose
            // centre is R − r − gap from the outer centre: gap from it, on
            // the inside. Area π(R² − r²) = π(R − r)(R + r).
            let big = size;
            let r = (big * rho).max(MIN_FEATURE);
            let d = big - r - gap;
            (d >= 0.0 && 2.0 * big <= MAX_SIZE).then(|| Tangent {
                profile: ProfileIn { outer: BoundaryIn::Circle { center: [at, at], radius: big }, holes: vec![BoundaryIn::Circle { center: [at + d * c, at + d * s], radius: r }] },
                area: PI * (big - r) * (big + r),
                scale: PI * (big * big + r * r),
                far: at + big,
            })
        }
        1 => {
            // Two holes r1 + r2 + gap apart, centre to centre, in a square:
            // gap between them. Area: the square's less πr1² and πr2².
            let r1 = (size * rho / 2.0).max(MIN_FEATURE);
            let r2 = (size * (1.0 - rho / 2.0) / 2.0).max(MIN_FEATURE);
            let d = r1 + r2 + gap;
            let half = 2.0 * size + 2.0;
            let (outer, sq, x1) = square(at - half, at - half, 2.0 * half);
            (2.0 * half <= MAX_SIZE).then(|| Tangent {
                profile: ProfileIn {
                    outer,
                    holes: vec![
                        BoundaryIn::Circle { center: [at - d / 2.0 * c, at - d / 2.0 * s], radius: r1 },
                        BoundaryIn::Circle { center: [at + d / 2.0 * c, at + d / 2.0 * s], radius: r2 },
                    ],
                },
                area: sq - PI * (r1 * r1 + r2 * r2),
                scale: sq + PI * (r1 * r1 + r2 * r2),
                far: x1.abs().max((at - half).abs()),
            })
        }
        2 => {
            // A hole of radius r whose centre is r + gap above a square's
            // bottom side: gap from it.
            let r = (size * rho / 2.0).max(MIN_FEATURE);
            let w = 2.0 * r + 2.0 * size + 1.0;
            let (outer, sq, x1) = square(at, at, w);
            (w <= MAX_SIZE / 2.0).then(|| Tangent {
                profile: ProfileIn { outer, holes: vec![BoundaryIn::Circle { center: [(at + x1) / 2.0, at + r + gap], radius: r }] },
                area: sq - PI * r * r,
                scale: sq + PI * r * r,
                far: x1,
            })
        }
        4 => {
            // A strip `size` long (up to 1 km) and 3 mm tall, with a small
            // hole of radius r (1 µm to 1 mm) whose centre is r + gap above
            // its bottom side, somewhere along it (t): the case where a
            // long side's own length used to swamp the gap.
            let len = (size * 2.0).min(MAX_SIZE);
            let r = (1e-3 * rho * fmath::powf(1e3, t / (2.0 * PI))).clamp(MIN_FEATURE, 1.0);
            let x0 = at;
            let x1 = x0 + len;
            let x = x0 + (x1 - x0) * (0.05 + 0.9 * t / (2.0 * PI));
            (x - x0 > r + 1.0 && x1 - x > r + 1.0).then(|| Tangent {
                profile: ProfileIn { outer: path(&[[x0, at], [x1, at], [x1, at + 3.0], [x0, at + 3.0]], &[]), holes: vec![BoundaryIn::Circle { center: [x, at + r + gap], radius: r }] },
                // Corners as stored: (x1 − x0) × ((at + 3) − at).
                area: (x1 - x0) * ((at + 3.0) - at) - PI * r * r,
                scale: (x1 - x0) * ((at + 3.0) - at) + PI * r * r,
                far: x1,
            })
        }
        _ => {
            // A D of radius R, its arc over the top (bulge 1 from (x1, at)
            // back to (x0, at)), with a hole of radius r whose centre is
            // R − r − gap from the D's centre, up at an angle a in (0.3,
            // π − 0.3): gap from the arc's inside, and clear of the D's
            // flat side. R comes from the corners as stored, (x1 − x0) / 2.
            // Area πR²/2 − πr².
            let a = 0.3 + (PI - 0.6) * (t / (2.0 * PI));
            let (x0, x1) = (at - size, at + size);
            let big = (x1 - x0) / 2.0;
            let r = (big * rho * 0.45).max(MIN_FEATURE);
            let d = big - r - gap;
            let (sa, ca) = fmath::sin_cos(a);
            let centre = [(x0 + x1) / 2.0 + d * ca, at + d * sa];
            (centre[1] - at >= r + 2.0 * MIN_FEATURE && 2.0 * big <= MAX_SIZE).then(|| Tangent {
                profile: ProfileIn { outer: path(&[[x0, at], [x1, at]], &[0.0, 1.0]), holes: vec![BoundaryIn::Circle { center: centre, radius: r }] },
                area: PI * big * big / 2.0 - PI * r * r,
                scale: PI * big * big / 2.0 + PI * r * r,
                far: x1 + big,
            })
        }
    }
}

/// Builds or refuses a near-tangent case, as its gap (f · MIN_FEATURE) says
/// it must be; true if it was built.
fn check_tangent(case: &Tangent, f: f64, what: &str) -> bool {
    let h = 1.0;
    let spec = || extrude(&case.profile, h, None, false);
    if f < 1.0 {
        let e = view_of(spec()).err().unwrap_or_else(|| panic!("{what}: built, but the hole is {f} × MIN_FEATURE from its neighbour"));
        assert_eq!(e.kind, ErrorKind::InvalidInput, "{what}: {}", e.message);
        assert!(e.message.contains("apart"), "{what}: {}", e.message);
        return false;
    }
    let (view, file) = built(spec, what);
    assert!((view.volume - case.area * h).abs() <= FP_REL * case.scale * h, "{what}: volume {} vs {}", view.volume, case.area * h);
    check_stl(&file, case.far + h, view.mesh.indices.len() / 3, what);
    true
}

#[test]
fn near_tangent_circles() {
    // By hand: an outer circle of radius 10 with a hole of radius 4 whose
    // centre is 10 − 4 − g from the outer centre leaves a wall g thick at
    // its thinnest. g = 0.9 µm is refused; at 1.1 µm the area is
    // π(10² − 4²) = 84π, so 1 mm deep the volume is 84π mm³.
    for (f, ok) in [(0.9, false), (1.1, true)] {
        let case = tangent(0, f * MIN_FEATURE, 10.0, 0.4, 0.0, 0.0).expect("fits");
        assert!(rel_eq(case.area, 84.0 * PI, FP_REL));
        assert_eq!(check_tangent(&case, f, &format!("by hand, ring at {f}")), ok);
    }
    // By hand: two holes of radius 1 in a 10 mm square, 2 + g apart centre
    // to centre: g = 0.9 µm refused, 1.1 µm built, area 10² − 2π.
    let pair = |g: f64| Tangent {
        profile: ProfileIn {
            outer: path(&[[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]], &[]),
            holes: vec![BoundaryIn::Circle { center: [-1.0 - g / 2.0, 0.0], radius: 1.0 }, BoundaryIn::Circle { center: [1.0 + g / 2.0, 0.0], radius: 1.0 }],
        },
        area: 100.0 - 2.0 * PI,
        scale: 100.0 + 2.0 * PI,
        far: 5.0,
    };
    assert!(!check_tangent(&pair(0.9 * MIN_FEATURE), 0.9, "by hand, pair at 0.9"));
    assert!(check_tangent(&pair(1.1 * MIN_FEATURE), 1.1, "by hand, pair at 1.1"));

    let seed = std::env::var("FISSION_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1u64);
    let mut rng = Rng(seed);
    let (mut made, mut refusals) = (0, 0);
    for case in 0..5000 {
        let kind = case % 5;
        let f = [0.9, 1.1, 1.5, 3.0][(case / 5) % 4];
        let size = fmath::powf(10.0, -2.0 + 7.7 * rng.unit());
        let at = rng.pick(&[0.0, 1e3, 1e5, 1e7, 5e7]);
        let t = rng.unit() * 2.0 * PI;
        let rho = rng.pick(&[0.1, 0.5, 0.9, 0.999]);
        let Some(t) = tangent(kind, f * MIN_FEATURE, size, rho, t, at) else { continue };
        let what = format!("seed {seed} case {case}: kind {kind}, gap {f} × MIN_FEATURE, size {size}, rho {rho}, at {at}");
        if check_tangent(&t, f, &what) {
            made += 1;
        } else {
            refusals += 1;
        }
    }
    eprintln!("near-tangent, seed {seed}: {made} built, {refusals} refused");
    assert!(made > 2000 && refusals > 700, "{made} built, {refusals} refused");
}
