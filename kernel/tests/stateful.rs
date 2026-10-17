//! Stateful random testing of the kernel.
//!
//! Random chains of 1–10 operations (add a placed primitive or extrusion,
//! some extrusions drawn as shuffled sketch lines and arcs or one sketch
//! circle first, move, rotate)
//! are run against the kernel. After every step:
//! - nothing panics;
//! - the operation either returns a body that passes `validate()`, or a
//!   clean `InvalidInput` error, and the error/success matches what the
//!   inputs predict;
//! - volume, area and bounds obey the identities of the operation;
//! - replaying the same chain gives bit-identical bodies and meshes.
//!
//! Values are biased towards coincidences (a 0.5 grid, values reused from
//! other shapes so faces touch and surfaces are tangent, near-misses at 0.9×
//! and 1.1× tolerance); about 30% are fully random, a few of those hostile
//! (NaN, infinities, zero, negative, huge, subnormal).
//!
//! Modes (environment variables):
//! - FISSION_STATEFUL_CASES  cases per seed (default 200: the quick mode)
//! - FISSION_STATEFUL_SEEDS  number of seeds (default 1)
//! - FISSION_SEED            base seed (default 0x5EED)
//! - FISSION_ORACLE_OUT      if set, append every final body to this JSONL
//!   file for the OpenCascade oracle
//!
//! On failure the minimal chain is saved to tests/regressions/stateful/ (and
//! replayed by `saved_regressions_still_pass` forever after), and a failure
//! dump (STL + HTML viewer) is written to target/failure-dumps/.
//!
//! When a new kernel operation lands, add it to `Op`, `Scene::transitions`
//! and `apply_op`.

use fission_kernel::debug_dump;
use fission_kernel::mass::MassProps;
use fission_kernel::mesh::Mesh;
use fission_kernel::ops::extrude::{self, Boundary, Profile};
use fission_kernel::ops::{primitives, transform, KernelError};
use fission_kernel::tessellate::TessOptions;
use fission_kernel::tolerance::{self, ANGULAR, LINEAR, MAX_COORD, MAX_SIZE, MIN_FEATURE};
use fission_kernel::placed::Placed;
use fission_kernel::sketch;
use fission_kernel::stl;
use fission_kernel::topology::Body;
use fission_kernel::validate::validate;
use glam::{DVec2, DVec3};
use proptest::prelude::*;
use proptest::test_runner::{
    Config, FileFailurePersistence, RngAlgorithm, TestCaseError, TestError, TestRng, TestRunner,
};
use proptest_state_machine::ReferenceStateMachine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Operations

/// An f64 that survives JSON exactly, including NaN and infinities (stored
/// as Rust's shortest round-trip text, e.g. "0.1", "NaN", "-inf").
#[derive(Clone, Copy, PartialEq)]
struct Num(f64);

impl fmt::Debug for Num {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl Serialize for Num {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:?}", self.0))
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<f64>().map(Num).map_err(serde::de::Error::custom)
    }
}

type V3 = [Num; 3];

fn v3(v: &V3) -> DVec3 {
    DVec3::new(v[0].0, v[1].0, v[2].0)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum Shape {
    Box { w: Num, d: Num, h: Num },
    Cylinder { r: Num, h: Num },
    Sphere { r: Num },
    /// A profile in the XY plane (outer loop and holes, either winding;
    /// straight and arc pieces, or circles), swept along +Z by `dist`.
    /// `expect` is what the generator built it to be: Some(true) must be
    /// accepted, Some(false) refused, None not known (then `profile_expect`
    /// decides for straight outlines; curved ones may go either way).
    ///
    /// `sketch`, when set on a straight outline without holes, draws the
    /// outline as sketch lines instead (shuffled and some reversed by that
    /// seed, `sketch_lines`); on a curved one without holes, as sketch lines
    /// and arcs (step 23a, `sketch_pieces`); and on a lone circle as one
    /// sketch circle (step 22b); either way it extrudes the loop
    /// `sketch::sketch_outline` finds, and `apply_op` checks it is the loop
    /// drawn.
    Extrude {
        outer: Ring,
        holes: Vec<Ring>,
        dist: Num,
        expect: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sketch: Option<u64>,
    },
}

/// The sides of polygon `pts` as sketch lines, in an order and directions
/// picked by `seed` (SplitMix64): a Fisher–Yates shuffle, then each line
/// reversed on a coin flip.
fn sketch_lines(pts: &[DVec2], seed: u64) -> Vec<sketch::Line> {
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    let n = pts.len();
    let mut lines: Vec<sketch::Line> = (0..n).map(|i| sketch::Line { a: pts[i], b: pts[(i + 1) % n] }).collect();
    for i in (1..n).rev() {
        lines.swap(i, (next() % (i as u64 + 1)) as usize);
    }
    for l in &mut lines {
        if next() % 2 == 1 {
            *l = sketch::Line { a: l.b, b: l.a };
        }
    }
    lines
}

/// The pieces of a curved path (corners `pts`, one bulge each) as sketch
/// lines and arcs (step 23a), in an order picked by `seed` (SplitMix64, as
/// `sketch_lines`): a Fisher–Yates shuffle of the pieces, then each line
/// reversed on a coin flip. An arc always runs counter-clockwise round its
/// centre, so a piece bulging clockwise (negative bulge) becomes the arc
/// from its end back to its start. Each arc's centre is the harness's own
/// (`Piece::new`, from first principles), not the kernel's.
fn sketch_pieces(pts: &[DVec2], bulges: &[f64], seed: u64) -> (Vec<sketch::Line>, Vec<sketch::Arc>) {
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    let n = pts.len();
    let mut order: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        order.swap(i, (next() % (i as u64 + 1)) as usize);
    }
    let (mut lines, mut arcs) = (vec![], vec![]);
    for i in order {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        let flip = next() % 2 == 1;
        match Piece::new(a, b, bulges[i]) {
            Piece::Arc { c, phi, .. } if phi > 0.0 => arcs.push(sketch::Arc { start: a, end: b, centre: c }),
            Piece::Arc { c, .. } => arcs.push(sketch::Arc { start: b, end: a, centre: c }),
            _ if flip => lines.push(sketch::Line { a: b, b: a }),
            _ => lines.push(sketch::Line { a, b }),
        }
    }
    (lines, arcs)
}

/// What a sketched extrusion draws (`Shape::Extrude`'s `sketch` doc): its
/// polygon as shuffled lines, its curved path as shuffled lines and arcs,
/// or its one circle.
enum Drawn {
    Lines(Vec<DVec2>, u64),
    Pieces(Vec<DVec2>, Vec<f64>, u64),
    Circle(sketch::Circle),
}

impl Drawn {
    /// What `sketch::sketch_outline` makes of the drawing.
    fn outline(&self) -> Result<sketch::SketchOutline, KernelError> {
        match self {
            Drawn::Lines(pts, seed) => sketch::sketch_outline(&sketch_lines(pts, *seed), &[], &[]),
            Drawn::Pieces(pts, bulges, seed) => {
                let (lines, arcs) = sketch_pieces(pts, bulges, *seed);
                sketch::sketch_outline(&lines, &[], &arcs)
            }
            Drawn::Circle(c) => sketch::sketch_outline(&[], &[*c], &[]),
        }
    }
}

/// The drawing a sketched extrusion makes, if it is one.
fn sketched(shape: &Shape) -> Option<Drawn> {
    match shape {
        Shape::Extrude { outer: Ring::Circle { c, r }, holes, sketch: Some(_), .. } if holes.is_empty() => {
            Some(Drawn::Circle(sketch::Circle { centre: p2(c), radius: r.0 }))
        }
        Shape::Extrude { outer: outer @ Ring::Path { pts, bulges }, holes, sketch: Some(seed), .. }
            if holes.is_empty() && (bulges.is_empty() || bulges.len() == pts.len()) =>
        {
            Some(match outer.polygon() {
            Some(p) => Drawn::Lines(p, *seed),
                None => Drawn::Pieces(pts.iter().map(p2).collect(), bulges.iter().map(|b| b.0).collect(), *seed),
            })
        }
        _ => None,
    }
}

/// One loop of an extrusion profile (kernel `ops::profile::Boundary`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum Ring {
    /// Corners with one bulge each (tan of a quarter of the arc's signed
    /// sweep; 0 straight), or no bulges at all.
    Path { pts: Vec<P2>, bulges: Vec<Num> },
    Circle { c: P2, r: Num },
}

impl Ring {
    fn straight(pts: Vec<DVec2>) -> Ring {
        Ring::Path { pts: pts.into_iter().map(|p| [Num(p.x), Num(p.y)]).collect(), bulges: vec![] }
    }

    fn curved(pts: Vec<DVec2>, bulges: Vec<f64>) -> Ring {
        Ring::Path { pts: pts.into_iter().map(|p| [Num(p.x), Num(p.y)]).collect(), bulges: bulges.into_iter().map(Num).collect() }
    }

    fn numbers(&mut self) -> Vec<&mut Num> {
        match self {
            Ring::Path { pts, bulges } => pts.iter_mut().flatten().chain(bulges.iter_mut()).collect(),
            Ring::Circle { c, r } => c.iter_mut().chain(std::iter::once(r)).collect(),
        }
    }

    /// The numbers that are lengths or positions in mm, so bounded by
    /// MAX_COORD: everything but the bulges. A bulge is tan(sweep / 4), a
    /// plain number with no unit; any finite one is legal, and the arc it
    /// makes is held to the range by its radius and extent instead
    /// (seedbfd7aebc2ed6: bulge 1.1e8 over a 2 µm chord is a 55 m arc,
    /// well inside the range, but it was counted as a 110 km coordinate).
    fn coords(&self) -> Vec<f64> {
        match self {
            Ring::Path { pts, .. } => pts.iter().flatten().map(|v| v.0).collect(),
            Ring::Circle { c, r } => vec![c[0].0, c[1].0, r.0],
        }
    }

    /// True if one of this ring's arcs certainly has a radius the kernel
    /// refuses: outside [MIN_FEATURE, MAX_SIZE] by more than rounding,
    /// worked out with the harness's own formula (`Piece::new`).
    fn arc_radius_out_of_range(&self) -> bool {
        self.pieces().iter().any(|p| match *p {
            Piece::Arc { r, .. } => !(MIN_FEATURE * (1.0 - 1e-9)..=MAX_SIZE * (1.0 + 1e-9)).contains(&r),
            _ => false,
        })
    }

    fn boundary(&self) -> Boundary {
        match self {
            Ring::Path { pts, bulges } => Boundary::Path { corners: pts.iter().map(p2).collect(), bulges: bulges.iter().map(|b| b.0).collect() },
            Ring::Circle { c, r } => Boundary::Circle { center: p2(c), radius: r.0 },
        }
    }

    /// The corners, if this is a straight-only path.
    fn polygon(&self) -> Option<Vec<DVec2>> {
        match self {
            Ring::Path { pts, bulges } if bulges.iter().all(|b| b.0 == 0.0) => Some(pts.iter().map(p2).collect()),
            _ => None,
        }
    }

    /// True if this ring is certainly bigger than the kernel allows: its
    /// corners alone (points on the outline, so a lower bound on its
    /// extent) span more than MAX_SIZE, or a circle's radius is over it.
    /// Saved regressions store the generator's verdict from the day they
    /// were found; this keeps them right after the range changes.
    fn certainly_too_big(&self) -> bool {
        let over = |x: f64| x > MAX_SIZE * (1.0 + 1e-9);
        match self {
            Ring::Circle { r, .. } => over(r.0) || over(2.0 * r.0),
            Ring::Path { pts, .. } => {
                let (mut lo, mut hi) = (DVec2::INFINITY, DVec2::NEG_INFINITY);
                for p in pts.iter().map(p2) {
                    (lo, hi) = (lo.min(p), hi.max(p));
                }
                over((hi - lo).max_element())
            }
        }
    }

    /// The pieces as the harness's own arcs (see `Piece`).
    fn pieces(&self) -> Vec<Piece> {
        match self {
            Ring::Circle { c, r } => vec![Piece::Circle { c: p2(c), r: r.0 }],
            Ring::Path { pts, bulges } => {
                let n = pts.len();
                (0..n).map(|i| Piece::new(p2(&pts[i]), p2(&pts[(i + 1) % n]), bulges.get(i).map_or(0.0, |b| b.0))).collect()
            }
        }
    }
}

/// A profile piece, worked out by the harness itself from first
/// principles (not with the kernel's formulas): an arc turning φ = 4·atan(β)
/// over a chord c has radius c / (2|sin(φ/2)|), and its centre lies on the
/// chord's perpendicular bisector, r·cos(φ/2) to the left for φ > 0 (to
/// the right for φ < 0).
#[derive(Clone, Copy, Debug)]
enum Piece {
    Line { a: DVec2, b: DVec2 },
    Arc { a: DVec2, b: DVec2, c: DVec2, r: f64, phi: f64 },
    Circle { c: DVec2, r: f64 },
}

impl Piece {
    fn new(a: DVec2, b: DVec2, bulge: f64) -> Piece {
        if bulge == 0.0 {
            return Piece::Line { a, b };
        }
        let phi = 4.0 * bulge.atan();
        let chord = b - a;
        // sin(φ/2) and cos(φ/2) straight from β (φ/2 = 2·atan β, so they are
        // 2β/(1 + β²) and (1 − β²)/(1 + β²), written to stay finite for any
        // β): taking the sine of φ/2 itself loses its digits near a full
        // turn, where φ/2 ≈ π (seed74ed8ceb85a8: β = 1.1e6, a 605 mm arc on
        // a 2.2 µm chord, whose radius came out 3.8e-11 of itself too large).
        let (sin_half, cos_half) = (2.0 / (bulge + 1.0 / bulge), (1.0 / bulge - bulge) / (bulge + 1.0 / bulge));
        let r = chord.length() / (2.0 * sin_half.abs());
        let left = DVec2::new(-chord.y, chord.x) / chord.length();
        let c = (a + b) / 2.0 + left * (r * cos_half * phi.signum());
        Piece::Arc { a, b, c, r, phi }
    }

    /// Twice the signed area this piece adds (from origin `o`), and its length.
    fn area2_and_length(&self, o: DVec2) -> (f64, f64) {
        match *self {
            Piece::Line { a, b } => ((a - o).perp_dot(b - o), a.distance(b)),
            // Chord's shoelace term plus the circular segment beyond it.
            Piece::Arc { a, b, r, phi, .. } => ((a - o).perp_dot(b - o) + r * r * (phi - phi.sin()), r * phi.abs()),
            Piece::Circle { r, .. } => (r * r * std::f64::consts::TAU, r * std::f64::consts::TAU),
        }
    }

    fn distance(&self, p: DVec2) -> f64 {
        match *self {
            Piece::Line { a, b } => {
                let t = ((p - a).dot(b - a) / (b - a).length_squared()).clamp(0.0, 1.0);
                p.distance(a + (b - a) * t)
            }
            Piece::Circle { c, r } => (p.distance(c) - r).abs(),
            Piece::Arc { a, b, c, r, phi } => {
                // On the arc's span: turned from a towards b by at most |φ|.
                let (u, w) = (a - c, p - c);
                let turn = u.perp_dot(w).atan2(u.dot(w)) * phi.signum();
                if turn.rem_euclid(std::f64::consts::TAU) <= phi.abs() {
                    (w.length() - r).abs()
                } else {
                    p.distance(a).min(p.distance(b))
                }
            }
        }
    }

    /// Radius, length and largest chord sag of a curved piece in the
    /// display mesh: chords turn at most 0.2 rad, sag at most DISPLAY_CHORD,
    /// except that a circle never gets more than 256 chords per turn
    /// (r·(1 − cos(π/256)) then); splitting chords only lowers the sag.
    fn curve(&self) -> Option<(f64, f64, f64)> {
        let (r, len) = match *self {
            Piece::Line { .. } => return None,
            Piece::Arc { r, phi, .. } => (r, r * phi.abs()),
            Piece::Circle { r, .. } => (r, r * std::f64::consts::TAU),
        };
        let sag = tolerance::DISPLAY_CHORD.max(r * (1.0 - (std::f64::consts::PI / 256.0).cos())) * (1.0 + 1e-9);
        Some((r, len, sag))
    }
}

/// How far a curved extrusion's mesh may be from the exact solid because
/// its arcs are chords: volume (profile area off by arc length × sag, times
/// the distance) and area (both caps, plus the walls' chord deficit). Zero
/// for anything else; boxes and straight extrusions are exact.
fn curve_slacks(shape: &Shape) -> (f64, f64) {
    let Shape::Extrude { outer, holes, dist, .. } = shape else { return (0.0, 0.0) };
    let (mut v, mut a) = (0.0, 0.0);
    for piece in std::iter::once(outer).chain(holes).flat_map(Ring::pieces) {
        if let Some((_, arc, sag)) = piece.curve() {
            v += arc * sag * dist.0;
            a += 2.0 * arc * sag + arc * 0.2f64.powi(2) / 24.0 * dist.0;
        }
    }
    (v, a)
}

type P2 = [Num; 2];

fn p2(p: &P2) -> DVec2 {
    DVec2::new(p[0].0, p[1].0)
}

impl Shape {
    /// Every number in the shape, for `extreme` to replace one.
    fn numbers(&mut self) -> Vec<&mut Num> {
        match self {
            Shape::Box { w, d, h } => vec![w, d, h],
            Shape::Cylinder { r, h } => vec![r, h],
            Shape::Sphere { r } => vec![r],
            Shape::Extrude { outer, holes, dist, .. } => {
                let mut v: Vec<&mut Num> = outer.numbers();
                v.extend(holes.iter_mut().flat_map(Ring::numbers));
                v.push(dist);
                v
            }
        }
    }

    fn make(&self) -> Result<Body, KernelError> {
        match self {
            Shape::Box { w, d, h } => primitives::make_box(w.0, d.0, h.0),
            Shape::Cylinder { r, h } => primitives::make_cylinder(r.0, h.0),
            Shape::Sphere { r } => primitives::make_sphere(r.0),
            Shape::Extrude { dist, .. } if sketched(self).is_some() => {
                match sketched(self).unwrap().outline()? {
                    sketch::SketchOutline::Closed(profile) => extrude::extrude(&profile, dist.0),
                    sketch::SketchOutline::Open(why) => Err(KernelError::InvalidInput(why.to_string())),
                }
            }
            Shape::Extrude { outer, holes, dist, .. } => {
                let profile = Profile { outer: outer.boundary(), holes: holes.iter().map(Ring::boundary).collect() };
                extrude::extrude(&profile, dist.0)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum Op {
    /// Make a primitive at the origin, rotate it about the origin, move it.
    Add { shape: Shape, axis: V3, angle: Num, at: V3 },
    Move { target: usize, by: V3 },
    Rotate { target: usize, pivot: V3, axis: V3, angle: Num },
}

impl Op {
    fn kind(&self) -> &'static str {
        match self {
            Op::Add { shape: Shape::Box { .. }, .. } => "add box",
            Op::Add { shape: Shape::Cylinder { .. }, .. } => "add cylinder",
            Op::Add { shape: Shape::Sphere { .. }, .. } => "add sphere",
            Op::Add { shape: Shape::Extrude { outer: Ring::Circle { .. }, sketch: Some(_), .. }, .. } => "add sketch circle extrude",
            Op::Add { shape: Shape::Extrude { outer: Ring::Path { bulges, .. }, sketch: Some(_), .. }, .. } if bulges.iter().any(|b| b.0 != 0.0) => {
                "add sketch arc extrude"
            }
            Op::Add { shape: Shape::Extrude { sketch: Some(_), .. }, .. } => "add sketch extrude",
            Op::Add { shape: Shape::Extrude { .. }, .. } => "add extrude",
            Op::Move { .. } => "move",
            Op::Rotate { .. } => "rotate",
        }
    }
}

// ---------------------------------------------------------------------------
// Reference state and generators

const MAX_SLOTS: usize = 6;
const POOL: usize = 24;

/// What the generator knows: how many shape slots exist, and recent sizes
/// and coordinates to reuse so shapes touch, share faces and line up.
#[derive(Clone, Debug, Default)]
struct Scene {
    slots: usize,
    lengths: Vec<f64>,
    coords: Vec<f64>,
}

/// Adds `v` to a reuse pool if it is within `limit` (lengths: MIN_FEATURE
/// up to MAX_SIZE; coordinates: up to MAX_COORD either way). Extreme values
/// from the 5% stay out, so they can't leak into in-range operations.
fn remember(pool: &mut Vec<f64>, v: f64, limit: (f64, f64)) {
    if (limit.0..=limit.1).contains(&v) && !pool.contains(&v) {
        pool.push(v);
        if pool.len() > POOL {
            pool.remove(0);
        }
    }
}

const LENGTHS: (f64, f64) = (MIN_FEATURE, MAX_SIZE);
const COORDS: (f64, f64) = (-MAX_COORD, MAX_COORD);

/// Values outside the supported range, used only by `extreme`.
const HOSTILE: [f64; 14] = [
    0.0, -0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1e300, -1e18, 5e-324, LINEAR,
    MIN_FEATURE * 0.9, MAX_SIZE * 1.1, MAX_COORD * 1.1, -MAX_COORD * 1.1,
];

/// Share of operations (out of 100) that get one extreme value; the rest
/// stay inside the supported range.
const EXTREME_PERCENT: u32 = 5;

/// A near-miss: `v` nudged by 0.9× or 1.1× the linear tolerance either way.
fn near_miss(v: impl Strategy<Value = f64>) -> impl Strategy<Value = f64> {
    (v, prop::sample::select(vec![-1.1, -0.9, 0.9, 1.1])).prop_map(|(v, k)| v + k * LINEAR)
}

fn from_pool(pool: &[f64], fallback: BoxedStrategy<f64>) -> BoxedStrategy<f64> {
    if pool.is_empty() { fallback } else { prop::sample::select(pool.to_vec()).boxed() }
}

/// An in-range size: ~70% coincident (0.5 grid, reused, near-miss), the
/// rest random across the whole range (log-uniform MIN_FEATURE to MAX_SIZE, 1 µm to 1 km) or at
/// its edges.
fn length(scene: &Scene) -> BoxedStrategy<f64> {
    let grid = (1..=200i32).prop_map(|k| k as f64 * 0.5).boxed();
    let reuse = from_pool(&scene.lengths, grid.clone());
    let (lo, hi) = (MIN_FEATURE.log10(), MAX_SIZE.log10());
    prop_oneof![
        37 => grid.clone(),
        21 => reuse.clone(),
        12 => near_miss(reuse),
        3 => prop::sample::select(vec![MIN_FEATURE, MIN_FEATURE * 1.1, MAX_SIZE * (1.0 - 1e-12), MAX_SIZE]),
        27 => (lo..hi).prop_map(|e| 10f64.powf(e).clamp(MIN_FEATURE, MAX_SIZE)),
    ]
    .boxed()
}

/// An in-range coordinate: same mix, signed; mostly within a metre, some
/// anywhere out to ±100 km, a few at the edge of model space.
fn coord(scene: &Scene) -> BoxedStrategy<f64> {
    let grid = (-40..=40i32).prop_map(|k| k as f64 * 0.5).boxed();
    let reuse = from_pool(&scene.coords, grid.clone());
    let flip = (reuse.clone(), any::<bool>()).prop_map(|(v, neg)| if neg { -v } else { v });
    let far = (MIN_FEATURE.log10()..MAX_COORD.log10(), any::<bool>())
        .prop_map(|(e, neg)| 10f64.powf(e).min(MAX_COORD) * if neg { -1.0 } else { 1.0 });
    prop_oneof![
        37 => grid,
        21 => flip,
        12 => near_miss(reuse),
        3 => prop::sample::select(vec![MAX_COORD - 1.0, -(MAX_COORD - 1.0), MAX_COORD * 0.5]),
        20 => -1e3f64..1e3,
        7 => far,
    ]
    .boxed()
}

fn vec3(s: BoxedStrategy<f64>) -> impl Strategy<Value = V3> {
    (s.clone(), s.clone(), s).prop_map(|(x, y, z)| [Num(x), Num(y), Num(z)])
}

fn axis() -> impl Strategy<Value = V3> {
    let tilted = |k: f64| [Num((k * ANGULAR).sin()), Num(0.0), Num((k * ANGULAR).cos())];
    prop_oneof![
        40 => prop::sample::select(vec![
            [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [-1.0, 0.0, 0.0], [0.0, 0.0, -1.0],
            [1.0, 1.0, 0.0], [1.0, 1.0, 1.0], [0.0, 3.0, 4.0],
        ])
        .prop_map(|a| a.map(Num)),
        10 => prop::sample::select(vec![tilted(0.9), tilted(1.1), tilted(-0.9), tilted(-1.1)]),
        50 => (-1.0f64..1.0, -1.0f64..1.0, -1.0f64..1.0).prop_map(|(x, y, z)| [Num(x), Num(y), Num(z)]),
    ]
}

/// Axes `extreme` swaps in whole: zero, tiny, overflowing, NaN.
const HOSTILE_AXES: [[f64; 3]; 4] = [[0.0; 3], [f64::NAN, 0.0, 1.0], [0.0, ANGULAR * 0.5, 0.0], [1e300, 1e300, 0.0]];

fn angle() -> impl Strategy<Value = Num> {
    prop_oneof![
        40 => (-4..=4i32).prop_map(|k| k as f64 * FRAC_PI_2),
        15 => (-8..=8i32).prop_map(|k| k as f64 * FRAC_PI_4),
        10 => ((-4..=4i32), prop::sample::select(vec![-1.1, -0.9, 0.9, 1.1]))
            .prop_map(|(k, f)| k as f64 * FRAC_PI_2 + f * ANGULAR),
        35 => -10.0f64..10.0,
    ]
    .prop_map(Num)
}

/// An operation whose every input is inside the supported range.
fn in_range_op(s: &Scene) -> BoxedStrategy<Op> {
    let add = (shape(s), axis(), angle(), vec3(coord(s)))
        .prop_map(|(shape, axis, angle, at)| Op::Add { shape, axis, angle, at })
        .boxed();
    if s.slots == 0 {
        return add;
    }
    let target = 0..s.slots;
    let mv = (target.clone(), vec3(coord(s))).prop_map(|(target, by)| Op::Move { target, by });
    let rot = (target, vec3(coord(s)), axis(), angle())
        .prop_map(|(target, pivot, axis, angle)| Op::Rotate { target, pivot, axis, angle });
    prop_oneof![3 => add, 3 => mv, 3 => rot].boxed()
}

/// The same operation with one input pushed outside the supported range:
/// one number replaced by a hostile value, or (half the time, for
/// operations with an axis) the whole axis replaced by a hostile one.
fn extreme(mut op: Op, pick: prop::sample::Index, number: f64, axis: [f64; 3], swap_axis: bool) -> Op {
    if swap_axis {
        if let Op::Add { axis: a, .. } | Op::Rotate { axis: a, .. } = &mut op {
            *a = axis.map(Num);
            return op;
        }
    }
    let mut nums: Vec<&mut Num> = match &mut op {
        Op::Add { shape, axis, angle, at } => {
            let mut v = shape.numbers();
            v.extend(axis.iter_mut());
            v.push(angle);
            v.extend(at.iter_mut());
            v
        }
        Op::Move { by, .. } => by.iter_mut().collect(),
        Op::Rotate { pivot, axis, angle, .. } => {
            let mut v: Vec<&mut Num> = pivot.iter_mut().collect();
            v.extend(axis.iter_mut());
            v.push(angle);
            v
        }
    };
    let i = pick.index(nums.len());
    *nums[i] = Num(number);
    // A changed profile number makes the generator's verdict unknown.
    if let Op::Add { shape: Shape::Extrude { expect, .. }, .. } = &mut op {
        *expect = None;
    }
    op
}

fn shape(scene: &Scene) -> impl Strategy<Value = Shape> {
    let l = length(scene);
    prop_oneof![
        (l.clone(), l.clone(), l.clone()).prop_map(|(w, d, h)| Shape::Box { w: Num(w), d: Num(d), h: Num(h) }),
        (l.clone(), l.clone()).prop_map(|(r, h)| Shape::Cylinder { r: Num(r), h: Num(h) }),
        l.prop_map(|r| Shape::Sphere { r: Num(r) }),
        extruded(scene),
    ]
}

/// A random extrusion. Outlines are rectangles (on the grid, with optional
/// holes whose walls can be 0.9×/1.0×/1.1× MIN_FEATURE, and optional
/// collinear corners) or star-shaped polygons with up to two holes, about a
/// third of them then broken on purpose (corners swapped or duplicated, a
/// hole moved out, a corner pushed next to another edge). Whether the kernel
/// must accept each one is decided independently by `profile_expect`.
fn polygon_profile(scene: &Scene) -> BoxedStrategy<Shape> {
    let l = length(scene);
    let centre = (coord(scene), coord(scene)).prop_map(|(x, y)| DVec2::new(x, y));
    let wall = prop::sample::select(vec![None, Some(0.25), Some(-0.9), Some(-1.0), Some(-1.1)]);
    let rect = (l.clone(), l.clone(), centre.clone(), wall, 0..3usize).prop_map(|(w, h, c, wall, extra)| {
        let mut outer = vec![c, c + DVec2::new(w, 0.0), c + DVec2::new(w, h), c + DVec2::new(0.0, h)];
        for k in 0..extra {
            // A collinear corner halfway along an edge.
            let i = 2 * k;
            outer.insert(i + 1, (outer[i] + outer[(i + 1) % outer.len()]) * 0.5);
        }
        let mut holes = vec![];
        // Positive: inset as a fraction of the size; negative: inset of
        // that many MIN_FEATUREs, giving walls at the tolerance boundary.
        if let Some(f) = wall {
            let t = if f > 0.0 { f * w.min(h) } else { -f * MIN_FEATURE };
            let (a, b) = (c + DVec2::splat(t), c + DVec2::new(w, h) - DVec2::splat(t));
            holes.push(vec![a, DVec2::new(a.x, b.y), b, DVec2::new(b.x, a.y)]);
        }
        (outer, holes)
    });
    let star = (3..=12usize, prop::collection::vec((0.2..1.0f64, 0.5..1.0f64), 12), l.clone(), centre, 0..=2usize, any::<bool>())
        .prop_map(|(n, raw, r, c, nholes, flip)| {
            let total: f64 = raw[..n].iter().map(|g| g.0).sum();
            let mut a = 0.0;
            let mut outer = vec![];
            for &(gap, k) in &raw[..n] {
                a += gap / total * std::f64::consts::TAU;
                outer.push(c + DVec2::from_angle(a) * r * k);
            }
            if flip {
                outer.reverse();
            }
            let hole = |o: DVec2, size: f64| (0..5).map(|i| o + DVec2::from_angle(i as f64 * 1.2566) * size).collect::<Vec<_>>();
            let holes = match nholes {
                0 => vec![],
                1 => vec![hole(c, 0.2 * r)],
                _ => vec![hole(c + DVec2::new(0.25 * r, 0.0), 0.1 * r), hole(c - DVec2::new(0.25 * r, 0.0), 0.1 * r)],
            };
            (outer, holes)
        });
    let good = prop_oneof![rect, star];
    let broken = (good.clone(), 0..5usize, any::<prop::sample::Index>(), prop::sample::select(vec![0.9, 1.1]))
        .prop_map(|((mut outer, mut holes), how, pick, k)| {
            let n = outer.len();
            let i = pick.index(n);
            match how {
                0 => outer.swap(i, (i + 2) % n),
                1 => outer.insert(i, outer[i]),
                2 => {
                    // A hole moved well outside, or a hole where there was none.
                    let span = outer.iter().fold(0.0f64, |m, p| m.max((*p - outer[0]).length()));
                    let shift = DVec2::new(3.0 * span, 0.0);
                    match holes.first_mut() {
                        Some(h) => h.iter_mut().for_each(|p| *p += shift),
                        None => holes.push(vec![outer[0] + shift, outer[1] + shift, outer[2] + shift]),
                    }
                }
                3 => {
                    // Corner i moved to k × MIN_FEATURE from the segment two
                    // corners on, on its inner side.
                    let (a, b) = (outer[(i + 2) % n], outer[(i + 3) % n]);
                    let mid = (a + b) * 0.5;
                    let normal = (b - a).perp().normalize_or_zero();
                    outer[i] = mid + normal * k * MIN_FEATURE;
                }
                _ => outer.truncate(2),
            }
            (outer, holes)
        });
    (prop_oneof![2 => good, 1 => broken], l)
        .prop_map(move |((outer, holes), dist)| Shape::Extrude {
            outer: Ring::straight(outer),
            holes: holes.into_iter().map(Ring::straight).collect(),
            dist: Num(dist),
            expect: None,
            sketch: None,
        })
        .boxed()
}

/// A random extrusion: two fifths straight outlines (`polygon_profile`),
/// two fifths curved ones (`curved_profile`), a fifth lone circles
/// (`circle_profile`). Half of the outlines without holes are drawn as a
/// sketch: straight ones as sketch lines, curved ones as sketch lines and
/// arcs, lone circles as a sketch circle.
fn extruded(scene: &Scene) -> BoxedStrategy<Shape> {
    (prop_oneof![2 => polygon_profile(scene), 2 => curved_profile(scene), 1 => circle_profile(scene)], any::<u64>(), 0..4u8)
        .prop_map(|(mut shape, seed, pick)| {
            if let Shape::Extrude { holes, sketch, .. } = &mut shape {
                if pick < 2 && holes.is_empty() {
                    *sketch = Some(seed);
                }
            }
            shape
        })
        .boxed()
}

/// A circle on its own (what a sketch of one circle makes, step 22b), its
/// radius often at 0.9×, 1× or 1.1× of MIN_FEATURE or of MAX_SIZE / 2 (a
/// diameter of MAX_SIZE, the most a profile may span).
fn circle_profile(scene: &Scene) -> BoxedStrategy<Shape> {
    let near = |limit: f64| prop::sample::select(vec![0.9, 1.0, 1.1]).prop_map(move |k| k * limit);
    let radius = prop_oneof![3 => length(scene), 1 => near(MIN_FEATURE), 1 => near(MAX_SIZE / 2.0)];
    (coord(scene), coord(scene), radius, length(scene))
        .prop_map(|(x, y, r, dist)| Shape::Extrude {
            outer: Ring::Circle { c: [Num(x), Num(y)], r: Num(r) },
            holes: vec![],
            dist: Num(dist),
            // Its thinnest feature is its radius; it spans 2r.
            expect: verdict(r, 2.0 * r, x.abs().max(y.abs()) + r),
            sketch: None,
        })
        .boxed()
}

/// The generator's verdict from the thinnest feature it built in and the
/// overall size: must be accepted if every feature is at least 1.01 ×
/// MIN_FEATURE and the outline spans at most MAX_SIZE, refused if one is
/// under 0.99 × MIN_FEATURE; too close to call otherwise.
fn verdict(thinnest: f64, span: f64, reach: f64) -> Option<bool> {
    if thinnest < 0.99 * MIN_FEATURE || span > MAX_SIZE * (1.0 + 1e-9) || reach > MAX_COORD * (1.0 + 1e-9) {
        Some(false)
    } else if thinnest > 1.01 * MIN_FEATURE && span < MAX_SIZE * (1.0 - 1e-9) && reach < MAX_COORD * (1.0 - 1e-9) {
        Some(true)
    } else {
        None
    }
}

/// Curved outlines. Five families built around a known thinnest feature,
/// so whether the kernel must accept them is known (`verdict`), plus one
/// of random shapes:
/// - slots: a rectangle with half-circle ends (radius = half the width);
/// - plates with a row of 1–3 round holes, every wall and gap the same
///   chosen width (often 0.9/1.0/1.1 × MIN_FEATURE);
/// - washers: a circle with an off-centre round hole;
/// - lenses (two arcs) with a square hole starting on their chord;
/// - "D"s: a nearly whole arc closed by a short flat (often at 0.9/1.0/
///   1.1 × MIN_FEATURE, or under LINEAR);
/// - a sixth are random star polygons with bowed edges and round or
///   bowed holes, whose verdict is unknown: if accepted, every check runs.
fn curved_profile(scene: &Scene) -> BoxedStrategy<Shape> {
    let l = length(scene);
    let centre = (coord(scene), coord(scene)).prop_map(|(x, y)| DVec2::new(x, y));
    // A wall or gap: any length, or right at the minimum feature size.
    let gap = prop_oneof![
        2 => l.clone(),
        1 => prop::sample::select(vec![0.9, 1.0, 1.1]).prop_map(|k| k * MIN_FEATURE),
    ];
    let flip = any::<bool>();
    let reach = |pts: &[DVec2], extra: f64| pts.iter().fold(0.0f64, |m, p| m.max(p.abs().max_element())) + extra;
    // Reverses a path's direction: corners backwards, each bulge moves to
    // the piece it now starts and changes sign.
    let reverse = |pts: Vec<DVec2>, bulges: Vec<f64>| {
        let n = pts.len();
        let back: Vec<DVec2> = (0..n).map(|i| pts[(n - i) % n]).collect();
        let bulges: Vec<f64> = (0..n).map(|i| -bulges[(2 * n - 1 - i) % n]).collect();
        (back, bulges)
    };
    // Radii come from `gap` too, so arcs and holes are often right at the
    // 1 µm minimum radius (0.9×, 1×, 1.1×).
    let slot = (l.clone(), gap.clone(), centre.clone(), flip).prop_map(move |(len, half, c, flip)| {
        let w = 2.0 * half;
        let pts = vec![c, c + DVec2::new(len, 0.0), c + DVec2::new(len, w), c + DVec2::new(0.0, w)];
        let bulges = vec![0.0, 1.0, 0.0, 1.0];
        // The round ends bulge sideways only: x from c.x − w/2 to c.x + len
        // + w/2, y from c.y to c.y + w. (Adding w/2 every way, as this once
        // did, called a slot 99999999 out "past MAX_COORD"; seed 0xa3452331.)
        let r = (c.x - w / 2.0).abs().max((c.x + len + w / 2.0).abs()).max(c.y.abs()).max((c.y + w).abs());
        let (pts, bulges) = if flip { reverse(pts, bulges) } else { (pts, bulges) };
        // Thinnest: the end radius w/2 and the straight sides' length.
        let expect = verdict((w / 2.0).min(len), len + w, r);
        (Ring::curved(pts, bulges), vec![], expect)
    });
    let plate = (gap.clone(), gap.clone(), 1..=3usize, centre.clone(), flip).prop_map(move |(rho, g, n, c, flip)| {
        // n holes of radius rho in a row, every gap and wall g.
        let w = n as f64 * (2.0 * rho + g) + g;
        let h = 2.0 * rho + 2.0 * g;
        let mut outer = vec![c, c + DVec2::new(w, 0.0), c + DVec2::new(w, h), c + DVec2::new(0.0, h)];
        if flip {
            outer.reverse();
        }
        let holes = (0..n)
            .map(|i| {
                let at = c + DVec2::new(g + rho + i as f64 * (2.0 * rho + g), g + rho);
                Ring::Circle { c: [Num(at.x), Num(at.y)], r: Num(rho) }
            })
            .collect();
        let expect = verdict(g.min(rho), w.max(h), reach(&outer, 0.0));
        (Ring::straight(outer), holes, expect)
    });
    let washer = (gap.clone(), gap.clone(), l.clone(), centre.clone()).prop_map(move |(rho, g, e, c)| {
        // Hole of radius rho, e off centre; the outer circle leaves a wall g.
        let big = e + rho + g;
        let hole = c + DVec2::new(e, 0.0);
        let expect = verdict(g.min(rho), 2.0 * big, c.abs().max_element() + big);
        (Ring::Circle { c: [Num(c.x), Num(c.y)], r: Num(big) }, vec![Ring::Circle { c: [Num(hole.x), Num(hole.y)], r: Num(rho) }], expect)
    });
    let lens = (l.clone(), gap.clone(), 0.3..=1.0f64, centre.clone(), flip).prop_map(move |(half, a, beta, c, flip)| {
        // A lens from c − (half, 0) to c + (half, 0), both arcs of bulge β:
        // radius R = half(1 + β²)/(2β), centres k = half(1 − β²)/(2β) above
        // (the lower arc's) and below (the upper's). A square hole of side
        // a has its first corner at c, on both arcs' chord (where a winding
        // number sees each chord as half a turn either way). A convex shape
        // inside a circle is nearest it at the corner farthest from the
        // centre: each wall is R minus that distance (negative: it pokes
        // out).
        let (r, k) = (half * (1.0 + beta * beta) / (2.0 * beta), half * (1.0 - beta * beta) / (2.0 * beta));
        let square = [DVec2::ZERO, DVec2::new(a, 0.0), DVec2::new(a, a), DVec2::new(0.0, a)];
        let wall = |centre: DVec2| r - square.iter().map(|q| q.distance(centre)).fold(0.0, f64::max);
        let thinnest = a.min(wall(DVec2::new(0.0, k))).min(wall(DVec2::new(0.0, -k)));
        let pts = vec![c - DVec2::new(half, 0.0), c + DVec2::new(half, 0.0)];
        let (pts, bulges) = if flip { reverse(pts, vec![beta, beta]) } else { (pts, vec![beta, beta]) };
        let hole = Ring::straight(square.iter().map(|&q| c + q).collect());
        // The arcs reach half sideways and bulge β·half (their sagitta) up
        // and down.
        let r = (c.x.abs() + half).max(c.y.abs() + beta * half);
        (Ring::curved(pts, bulges), vec![hole], verdict(thinnest, 2.0 * half, r))
    });
    // A "D": the long way round a circle of radius R from `at` to `at` +
    // (c, 0) (bulge −β, the larger root of β² − (4R/c)β + 1 = 0, centre
    // above the chord), then the flat c back. Both pieces end at both
    // corners, so only a rule on the corners themselves sees c (found by
    // the white-box hunt: a flat under LINEAR built a broken body). The
    // circle spans 2R; its thinnest feature is the flat (or R itself).
    let flat = prop::sample::select(vec![0.5 * LINEAR, 0.9 * MIN_FEATURE, MIN_FEATURE, 1.1 * MIN_FEATURE, 1.0]);
    let d_shape = (l.clone(), flat, centre.clone(), flip).prop_map(move |(radius, c, at, flip)| {
        let r = radius.max(c);
        let k = 4.0 * r / c;
        let beta = (k + (k * k - 4.0).sqrt()) / 2.0;
        let pts = vec![at, at + DVec2::new(c, 0.0)];
        let (pts, bulges) = if flip { reverse(pts, vec![-beta, 0.0]) } else { (pts, vec![-beta, 0.0]) };
        let reach = (at.x + c / 2.0).abs() + r;
        let reach = reach.max(at.y.abs()).max((at.y + 2.0 * r).abs());
        (Ring::curved(pts, bulges), vec![], verdict(c.min(r), 2.0 * r, reach))
    });
    let bulge = prop_oneof![
        3 => Just(0.0),
        3 => -0.3..0.3f64,
        1 => prop::sample::select(vec![1.0, -1.0, 0.05, -0.05, 2.0, -2.0]),
    ];
    let wavy = (3..=10usize, prop::collection::vec((0.2..1.0f64, 0.5..1.0f64), 10), prop::collection::vec(bulge, 20), l.clone(), centre, 0..=2usize)
        .prop_map(|(n, raw, bulges, r, c, holes)| {
            let total: f64 = raw[..n].iter().map(|g| g.0).sum();
            let mut a = 0.0;
            let pts: Vec<DVec2> = raw[..n]
                .iter()
                .map(|&(gap, k)| {
                    a += gap / total * std::f64::consts::TAU;
                    c + DVec2::from_angle(a) * r * k
                })
                .collect();
            let holes = match holes {
                0 => vec![],
                1 => vec![Ring::Circle { c: [Num(c.x), Num(c.y)], r: Num(0.2 * r) }],
                _ => {
                    let lens = |x: f64| Ring::curved(vec![c + DVec2::new(x - 0.1 * r, 0.0), c + DVec2::new(x + 0.1 * r, 0.0)], vec![bulges[18], bulges[19].abs() + 0.3]);
                    vec![lens(-0.25 * r), lens(0.25 * r)]
                }
            };
            (Ring::curved(pts, bulges[..n].to_vec()), holes, None)
        });
    (prop_oneof![1 => slot, 1 => plate, 1 => washer, 1 => lens, 1 => d_shape, 1 => wavy], l)
        // The distance comes from `length`, always in range (MIN_FEATURE
        // itself is legal), so it doesn't change the verdict.
        .prop_map(|((outer, holes, expect), dist)| Shape::Extrude { outer, holes, dist: Num(dist), expect, sketch: None })
        .boxed()
}

impl ReferenceStateMachine for Scene {
    type State = Scene;
    type Transition = Op;

    fn init_state() -> BoxedStrategy<Scene> {
        Just(Scene::default()).boxed()
    }

    fn transitions(s: &Scene) -> BoxedStrategy<Op> {
        let normal = in_range_op(s);
        let hostile_number = prop::sample::select(HOSTILE.to_vec());
        let hostile_axis = prop::sample::select(HOSTILE_AXES.to_vec());
        let extreme = (normal.clone(), any::<prop::sample::Index>(), hostile_number, hostile_axis, any::<bool>())
            .prop_map(|(op, pick, number, axis, swap_axis)| extreme(op, pick, number, axis, swap_axis));
        prop_oneof![100 - EXTREME_PERCENT => normal, EXTREME_PERCENT => extreme].boxed()
    }

    fn apply(mut s: Scene, op: &Op) -> Scene {
        match op {
            Op::Add { shape, at, .. } => {
                s.slots += 1;
                let sizes: Vec<f64> = match shape {
                    Shape::Box { w, d, h } => vec![w.0, d.0, h.0],
                    Shape::Cylinder { r, h } => vec![r.0, h.0, 2.0 * r.0],
                    Shape::Sphere { r } => vec![r.0, 2.0 * r.0],
                    Shape::Extrude { outer, dist, .. } => match outer {
                        Ring::Path { pts, .. } => {
                            let (lo, hi) = pts.iter().map(p2).fold((DVec2::INFINITY, DVec2::NEG_INFINITY), |(lo, hi), p| (lo.min(p), hi.max(p)));
                            vec![hi.x - lo.x, hi.y - lo.y, dist.0]
                        }
                        Ring::Circle { r, .. } => vec![r.0, 2.0 * r.0, dist.0],
                    },
                };
                for &v in &sizes {
                    remember(&mut s.lengths, v, LENGTHS);
                }
                // Positions plus sizes give touching faces and shared edges.
                for (k, p) in at.iter().enumerate() {
                    remember(&mut s.coords, p.0, COORDS);
                    if let Some(&size) = sizes.get(k) {
                        remember(&mut s.coords, p.0 + size, COORDS);
                        remember(&mut s.coords, p.0 - size, COORDS);
                    }
                }
            }
            Op::Move { by, .. } => by.iter().for_each(|v| remember(&mut s.coords, v.0, COORDS)),
            Op::Rotate { pivot, .. } => pivot.iter().for_each(|v| remember(&mut s.coords, v.0, COORDS)),
        }
        s
    }

    fn preconditions(s: &Scene, op: &Op) -> bool {
        match op {
            Op::Add { .. } => s.slots < MAX_SLOTS,
            Op::Move { target, .. } | Op::Rotate { target, .. } => *target < s.slots,
        }
    }
}

// ---------------------------------------------------------------------------
// Running and checking

#[derive(Default, Clone)]
struct Tally {
    ok: usize,
    clean_error: usize,
    time: std::time::Duration,
    slowest: (std::time::Duration, String),
}

static STATS: Mutex<BTreeMap<&'static str, Tally>> = Mutex::new(BTreeMap::new());

#[derive(Debug, Clone)]
struct Failure {
    step: usize,
    op: String,
    message: String,
    /// Bodies worth looking at: (label, body).
    bodies: Vec<(String, Body)>,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "step {} ({}): {}", self.step + 1, self.op, self.message)
    }
}

/// Everything known about one slot: the body (None if creating it failed
/// cleanly) and the history needed to rebuild it independently (for the
/// oracle).
#[derive(Clone)]
struct Slot {
    /// The kernel's body: its local geometry and its placement.
    body: Option<Placed>,
    shape: Shape,
    /// Placement tracked by the harness itself, independently of the kernel.
    affine: glam::DAffine3,
    /// Vertex positions of the unplaced primitive.
    start: Vec<DVec3>,
    /// Operations applied so far (rounding grows with each).
    steps: u32,
    /// Farthest coordinate the part or its arithmetic has reached: its
    /// bounds after every step, moves, and rotation pivots. A part that went
    /// 50 km out and came back carries rounding from 50 km.
    reach: f64,
}

/// The kernel's vertices must be where the harness's own matrix puts them.
/// Catches operations that keep every invariant but do the wrong thing
/// (e.g. a "rotation" that silently did nothing).
fn check_position(s: &Slot) -> Result<(), String> {
    let Some(b) = &s.body else { return Ok(()) };
    let now = body_reach(b) + s.affine.translation.abs().max_element();
    // Rounding allowance for the farthest point reached, per step, but
    // never more than the modelling tolerance: inside the supported range
    // that allowance is ~1e-8 per step, so a part off by more than LINEAR
    // is a kernel bug, not rounding.
    let slack = (tolerance::rounding_slack(now.max(s.reach)) * s.steps as f64).min(LINEAR);
    for (k, &p0) in s.start.iter().enumerate() {
        let expected = s.affine.transform_point3(p0);
        let at = b.vertex(k);
        let off = expected.distance(at);
        if off.is_nan() || off > slack {
            return Err(format!("vertex {k} is at {at} but should be at {expected} ({off:e} off)"));
        }
    }
    Ok(())
}

fn body_reach(b: &Placed) -> f64 {
    let (lo, hi) = b.bounds();
    lo.abs().max(hi.abs()).max_element()
}

/// Export as STL and read it back: the same triangles in the same order,
/// each corner the nearest f32 to the kernel's (so no corner moved by more
/// than the reported rounding); and, when the rounding is too small to merge
/// two distinct corners, a closed mesh whose volume is the mesh's to that
/// rounding (each corner moved by at most it: |ΔV| ≤ area × rounding).
fn check_stl(b: &Placed) -> Result<(), String> {
    let mesh = b.tessellate(&TessOptions::DISPLAY).map_err(|e| format!("tessellation failed: {}", e.message))?;
    let out = stl::export(&mesh, "body");
    let back = stl::read(&out.bytes)?;
    if back.triangles.len() != mesh.triangles.len() {
        return Err(format!("STL holds {} triangles, the mesh {}", back.triangles.len(), mesh.triangles.len()));
    }
    let mut moved = 0.0f64;
    for (t, tri) in back.triangles.iter().enumerate() {
        for (p, q) in tri.iter().zip(mesh.triangle(t)) {
            if *p != q.as_vec3() {
                return Err(format!("STL corner {p} is not the f32 nearest {q}"));
            }
            moved = moved.max((p.as_dvec3() - q).abs().max_element());
        }
    }
    if moved != out.rounding {
        return Err(format!("STL reported rounding {} but corners moved up to {moved}", out.rounding));
    }
    if (out.rounding > MIN_FEATURE) != out.warning.is_some() {
        return Err(format!("STL rounding {} with warning {:?}", out.rounding, out.warning));
    }
    // Rounding can only merge two corners closer than 2 × rounding (each
    // moves by at most that), and any two distinct corners may be that
    // close, not only the ends of one edge: across a thin wall or a gap
    // between two holes they are not joined by an edge at all (seed
    // f0cc04acbba8: two holes 0.6 mm apart at 1.9 km, where f32 rounds by
    // 0.06 mm, merged corners while every edge was longer than 0.25 mm).
    if !corners_closer_than(&mesh.positions, 4.0 * out.rounding) {
        let welded = back.welded();
        welded.check_closed().map_err(|e| format!("STL mesh not closed after reading back: {} problems", e.len()))?;
        let slack = mesh.area() * out.rounding * 2.0 + tolerance::rounding_slack(body_reach(b)) * mesh.area();
        let (v0, v1) = (mesh.signed_volume(), welded.signed_volume());
        if (v0 - v1).abs() > slack {
            return Err(format!("STL volume {v1} vs mesh {v0} (allowed {slack:e})"));
        }
    }
    Ok(())
}

/// Whether any two distinct points are within `d` of each other: points
/// are bucketed in cubes of side `d`, so a close pair lies in the same or
/// neighbouring cubes.
fn corners_closer_than(points: &[DVec3], d: f64) -> bool {
    if d <= 0.0 {
        return false;
    }
    let mut cells: std::collections::HashMap<[i64; 3], Vec<DVec3>> = std::collections::HashMap::new();
    let key = |p: DVec3| (p / d).floor().to_array().map(|x| x as i64);
    for &p in points {
        let [i, j, k] = key(p);
        for di in -1..=1 {
            for dj in -1..=1 {
                for dk in -1..=1 {
                    if let Some(qs) = cells.get(&[i + di, j + dj, k + dk]) {
                        if qs.iter().any(|&q| q != p && q.distance(p) < d) {
                            return true;
                        }
                    }
                }
            }
        }
        cells.entry([i, j, k]).or_default().push(p);
    }
    false
}

fn panic_message(p: Box<dyn std::any::Any + Send>) -> String {
    let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()));
    let loc = LAST_PANIC_LOCATION.with(|l| l.borrow().clone());
    format!("PANIC: {} (at {loc})", msg.unwrap_or_else(|| "non-string payload".into()))
}

thread_local! {
    static LAST_PANIC_LOCATION: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// Runs a kernel call, turning a panic into an error message.
fn guarded<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f)).map_err(panic_message)
}

/// Measurements of a body used for the identities.
struct Measure {
    mesh: Mesh,
    /// The kernel's exact volume and area (from the B-rep, not the mesh).
    exact: MassProps,
    volume: f64,
    area: f64,
    /// Sum of all triangle perimeters: bounds how much area can change when
    /// every vertex moves by δ (|ΔA| ≤ perimeters·δ).
    perimeters: f64,
    lo: DVec3,
    hi: DVec3,
}

fn measure(b: &Placed) -> Result<Measure, String> {
    let mesh = b.tessellate(&TessOptions::DISPLAY).map_err(|e| format!("tessellation failed: face {}: {}", e.face, e.message))?;
    mesh.check_closed().map_err(|e| format!("mesh not closed: {} problems", e.len()))?;
    let perimeters = (0..mesh.triangles.len())
        .map(|t| {
            let [a, b, c] = mesh.triangle(t);
            a.distance(b) + b.distance(c) + c.distance(a)
        })
        .sum();
    let (lo, hi) = b.bounds();
    // The bounds must hold every mesh point (all of them lie on the body's
    // surface) and reach past them by no more than the mesh can fall short
    // of the surface: the largest chord sag, doubled for the diagonals of a
    // sphere's quads (see Piece::curve for the sag).
    let (mlo, mhi) = mesh.positions.iter().fold((DVec3::INFINITY, DVec3::NEG_INFINITY), |(l, h), &p| (l.min(p), h.max(p)));
    let radii = b.body.edges.iter().filter_map(|e| match e.curve {
        fission_kernel::geom::Curve::Circle { radius, .. } => Some(radius),
        _ => None,
    });
    let sag = radii.map(|r| 2.0 * tolerance::DISPLAY_CHORD.max(r * (1.0 - (std::f64::consts::PI / 256.0).cos()))).fold(0.0, f64::max);
    let slack = tolerance::rounding_slack(lo.abs().max(hi.abs()).max_element()) * 4.0;
    if (mlo - lo).min_element() < -slack || (hi - mhi).min_element() < -slack {
        return Err(format!("bounds {lo}..{hi} miss mesh points spanning {mlo}..{mhi}"));
    }
    if (mlo - lo).max_element() > sag + slack || (hi - mhi).max_element() > sag + slack {
        return Err(format!("bounds {lo}..{hi} reach more than the chord sag {sag:e} past the mesh {mlo}..{mhi}"));
    }
    Ok(Measure { exact: b.mass_properties(), volume: mesh.signed_volume(), area: mesh.area(), perimeters, lo, hi, mesh })
}

fn reach(m: &Measure) -> f64 {
    m.lo.abs().max(m.hi.abs()).max_element()
}

/// Volume and area unchanged by a rigid motion, allowing for rounding of
/// coordinates of magnitude up to `scale`: each vertex moves by at most δ,
/// so |ΔV| ≤ area·δ and |ΔA| ≤ perimeters·δ.
fn check_rigid(before: &Measure, after: &Measure, what: &str) -> Result<(), String> {
    let delta = tolerance::rounding_slack(reach(before).max(reach(after)));
    if !tolerance::measure_eq(before.volume, after.volume, before.area * delta) {
        return Err(format!("{what} changed the volume: {} → {}", before.volume, after.volume));
    }
    if !tolerance::measure_eq(before.area, after.area, before.perimeters * delta) {
        return Err(format!("{what} changed the area: {} → {}", before.area, after.area));
    }
    if after.volume <= 0.0 {
        return Err(format!("{what} left a non-positive volume {}", after.volume));
    }
    // The exact values move by no more than the mesh's do: the surface's
    // points each move by at most δ too.
    let (b, a) = (before.exact, after.exact);
    if !tolerance::measure_eq(b.volume, a.volume, before.area * delta) {
        return Err(format!("{what} changed the exact volume: {} → {}", b.volume, a.volume));
    }
    if !tolerance::measure_eq(b.area, a.area, before.perimeters * delta) {
        return Err(format!("{what} changed the exact area: {} → {}", b.area, a.area));
    }
    Ok(())
}

fn size_ok(x: f64) -> bool {
    x.is_finite() && (MIN_FEATURE..=MAX_SIZE).contains(&x)
}

/// Mirrors the kernel's rule: an axis counts as zero when its largest
/// component is within ANGULAR of zero.
fn axis_ok(a: DVec3) -> bool {
    a.is_finite() && a.abs().max_element() > ANGULAR
}

/// The harness's own rotation, built independently of the kernel.
fn rotation(axis: DVec3, angle: f64) -> glam::DAffine3 {
    let k = fission_kernel::geom::unit(axis).expect("checked by axis_ok");
    glam::DAffine3::from_axis_angle(k, angle.rem_euclid(std::f64::consts::TAU))
}

/// The kernel's exact volume and area against closed forms, to rounding.
fn exact_is(m: &Measure, volume: f64, area: f64, what: &str) -> Result<(), String> {
    if !tolerance::rel_eq(m.exact.volume, volume, tolerance::FP_REL) || !tolerance::rel_eq(m.exact.area, area, tolerance::FP_REL) {
        return Err(format!("{what}: exact volume {} expected {volume}; exact area {} expected {area}", m.exact.volume, m.exact.area));
    }
    Ok(())
}

/// Checks the freshly built, unplaced primitive against hand-derived values.
fn check_primitive(shape: &Shape, m: &Measure) -> Result<(), String> {
    match shape {
        Shape::Box { w, d, h } => {
            // V = w·d·h, A = 2(wd + dh + wh), exactly up to rounding.
            let (w, d, h) = (w.0, d.0, h.0);
            if !tolerance::rel_eq(m.volume, w * d * h, tolerance::FP_REL)
                || !tolerance::rel_eq(m.area, 2.0 * (w * d + d * h + w * h), tolerance::FP_REL)
            {
                return Err(format!("box {w}×{d}×{h}: volume {} area {}", m.volume, m.area));
            }
            exact_is(m, w * d * h, 2.0 * (w * d + d * h + w * h), "box")?;
        }
        Shape::Cylinder { r, h } => {
            // Prism over the inscribed n-gon: V = (n/2)r²sin(2π/n)·h.
            let (r, h) = (r.0, h.0);
            let n = (m.mesh.edge_polylines[0].len() - 1) as f64;
            let v = 0.5 * n * r * r * (std::f64::consts::TAU / n).sin() * h;
            if !tolerance::rel_eq(m.volume, v, tolerance::FP_REL) {
                return Err(format!("cylinder r={r} h={h}: volume {} expected {v}", m.volume));
            }
            // Exact: V = πr²h, A = 2πr² + 2πrh.
            exact_is(m, PI * r * r * h, 2.0 * PI * r * (r + h), "cylinder")?;
        }
        Shape::Sphere { r } => {
            // Inscribed convex mesh: strictly inside the true ball.
            let ball = 4.0 / 3.0 * std::f64::consts::PI * r.0.powi(3);
            if !(m.volume > 0.0 && m.volume < ball) {
                return Err(format!("sphere r={}: volume {} not in (0, {ball})", r.0, m.volume));
            }
            // Exact: V = 4/3·πr³, A = 4πr².
            exact_is(m, ball, 4.0 * PI * r.0 * r.0, "sphere")?;
        }
        Shape::Extrude { outer, holes, dist, .. } => {
            // Prism: V = A·d and S = 2A + P·d, where A is the profile's area
            // (outer minus holes: shoelace over the corners plus, for each
            // arc, the circular segment (r²/2)(φ − sin φ) beyond its chord)
            // and P the length of all its loops.
            let d = dist.0;
            let loops: Vec<Vec<Piece>> = std::iter::once(outer).chain(holes).map(Ring::pieces).collect();
            let o = match loops[0][0] {
                Piece::Line { a, .. } | Piece::Arc { a, .. } => a,
                Piece::Circle { c, .. } => c,
            };
            let (mut area, mut area_err, mut perimeter) = (0.0, 0.0, 0.0);
            // Chords instead of arcs: the mesh's profile differs from the
            // exact one by at most (arc length × sag) per curve, and its side
            // walls are short by at most (arc length × step²/24), the
            // chord-to-arc deficit for chords turning step ≤ 0.2 rad.
            let (mut curve_area, mut curve_side) = (0.0, 0.0);
            let mut reach_r = 0.0f64;
            for (k, pieces) in loops.iter().enumerate() {
                let (mut twice, mut abs, mut len) = (0.0, 0.0, 0.0);
                for piece in pieces {
                    let (a2, l) = piece.area2_and_length(o);
                    twice += a2;
                    abs += a2.abs() + l * l;
                    len += l;
                    if let Some((r, arc, sag)) = piece.curve() {
                        curve_area += arc * sag;
                        curve_side += arc * 0.2f64.powi(2) / 24.0;
                        reach_r = reach_r.max(r);
                    }
                }
                perimeter += len;
                area += if k == 0 { twice.abs() / 2.0 } else { -twice.abs() / 2.0 };
                // Rounding bound for this reference sum: a few ulps per term,
                // plus the subtraction of `o` from far coordinates.
                area_err += 4.0 * pieces.len() as f64 * f64::EPSILON * abs / 2.0 + len * tolerance::rounding_slack(o.abs().max_element() + reach_r);
            }
            let (v, s) = (area * d, 2.0 * area + perimeter * d);
            // Kernel rounding as in check_rigid (each vertex within δ of
            // exact), plus the reference's own rounding, plus the chords.
            let delta = tolerance::rounding_slack(reach(m) + reach_r);
            let v_slack = m.area * delta + area_err * d + curve_area * d;
            let s_slack = m.perimeters * delta + 2.0 * area_err + 2.0 * curve_area + curve_side * d;
            if !tolerance::measure_eq(m.volume, v, v_slack) || !tolerance::measure_eq(m.area, s, s_slack) {
                return Err(format!(
                    "extrude: volume {} expected A·d = {v} (±{v_slack:e}); area {} expected 2A + P·d = {s} (±{s_slack:e})",
                    m.volume, m.area
                ));
            }
            // The exact values have no chords to allow for: only rounding.
            let (ve, se) = (m.area * delta + area_err * d, m.perimeters * delta + 2.0 * area_err);
            if !tolerance::measure_eq(m.exact.volume, v, ve) || !tolerance::measure_eq(m.exact.area, s, se) {
                return Err(format!(
                    "extrude: exact volume {} expected A·d = {v} (±{ve:e}); exact area {} expected 2A + P·d = {s} (±{se:e})",
                    m.exact.volume, m.exact.area
                ));
            }
            // Every mesh point is a boundary point of a cap (the caps and
            // walls get no inner points): at z = 0 or d, on the outline.
            let slack = 8.0 * delta;
            let all: Vec<Piece> = loops.concat();
            for (i, q) in m.mesh.positions.iter().enumerate() {
                let off_cap = q.z.abs().min((q.z - d).abs());
                let off_outline = all.iter().map(|piece| piece.distance(q.truncate())).fold(f64::INFINITY, f64::min);
                if off_cap > slack || off_outline > slack {
                    return Err(format!("extrude: mesh point {i} at {q} is {off_cap:e} off the caps and {off_outline:e} off the outline"));
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Expect {
    Valid,
    Invalid,
    /// Too close to a tolerance boundary to call.
    Either,
}

/// Whether the kernel must accept a profile, decided independently of its
/// code: plain floating point with error bounds instead of exact
/// predicates, and a 1% band around MIN_FEATURE where either answer is
/// fine. The rules: every loop has ≥ 3 finite corners within MAX_COORD, at
/// most MAX_PROFILE_CORNERS in all; the outer loop spans ≤ MAX_SIZE; no two
/// edges cross; every corner is ≥ MIN_FEATURE from every edge it isn't an
/// end of; every hole is inside the outer loop and not inside another hole.
/// The model's verdict on an extrusion: certainly out of range, the
/// generator's own verdict where it gave one, the polygon model for
/// straight outlines, else too hard to call (curved outlines: the kernel
/// decides, and its result is then measured).
fn extrude_expect(shape: &Shape) -> Expect {
    let Shape::Extrude { outer, holes, dist, expect, .. } = shape else { panic!("not an extrusion") };
    let rings = || std::iter::once(outer).chain(holes);
    if !size_ok(dist.0)
        || shape.clone().numbers().iter().any(|v| !v.0.is_finite())
        || rings().flat_map(Ring::coords).any(|v| v.abs() > MAX_COORD)
        || rings().any(Ring::arc_radius_out_of_range)
        || outer.certainly_too_big()
        || sketch_line_out_of_range(shape)
    {
        Expect::Invalid
    } else if let Some(e) = expect {
        if *e { Expect::Valid } else { Expect::Invalid }
    } else if let Some(loops) = rings().map(Ring::polygon).collect::<Option<Vec<_>>>() {
        profile_expect(&loops, dist.0)
    } else {
        Expect::Either
    }
}

/// A sketched extrusion's lines must each be within [MIN_FEATURE, MAX_SIZE]
/// long (`sketch::check_lines`), and its arcs' ends at least MIN_FEATURE
/// apart (`sketch::check_arcs`), which a profile only implies.
fn sketch_line_out_of_range(shape: &Shape) -> bool {
    let chord = |pts: &[DVec2], i: usize| pts[i].distance(pts[(i + 1) % pts.len()]);
    match sketched(shape) {
        Some(Drawn::Lines(pts, _)) => (0..pts.len()).any(|i| !(MIN_FEATURE..=MAX_SIZE).contains(&chord(&pts, i))),
        Some(Drawn::Pieces(pts, bulges, _)) => (0..pts.len()).any(|i| {
            let range = if bulges[i] == 0.0 { MIN_FEATURE..=MAX_SIZE } else { MIN_FEATURE..=f64::INFINITY };
            !range.contains(&chord(&pts, i))
        }),
        _ => false,
    }
}

fn profile_expect(loops: &[Vec<DVec2>], dist: f64) -> Expect {
    if !size_ok(dist)
        || loops.iter().map(Vec::len).sum::<usize>() > tolerance::MAX_PROFILE_CORNERS
        || loops.iter().any(|l| l.len() < 3 || l.iter().any(|p| !p.is_finite() || p.abs().max_element() > MAX_COORD))
    {
        return Expect::Invalid;
    }
    let (lo, hi) = loops[0].iter().fold((DVec2::INFINITY, DVec2::NEG_INFINITY), |(lo, hi), &p| (lo.min(p), hi.max(p)));
    if (hi - lo).max_element() > MAX_SIZE {
        return Expect::Invalid;
    }
    let scale = loops.iter().flatten().fold(1.0f64, |m, p| m.max(p.abs().max_element()));
    let err = 16.0 * f64::EPSILON * scale; // a distance's rounding
    let mut verdict = Expect::Valid;
    let segs: Vec<(usize, usize)> = loops.iter().enumerate().flat_map(|(k, l)| (0..l.len()).map(move |i| (k, i))).collect();
    let ends = |(k, i): (usize, usize)| (loops[k][i], loops[k][(i + 1) % loops[k].len()]);
    // Signed distance of c from line ab, and whether its sign is certain.
    let side = |a: DVec2, b: DVec2, c: DVec2| {
        let len = a.distance(b);
        let d = (b - a).perp_dot(c - a) / len;
        (d.signum(), d.abs() > err * 4.0)
    };
    for (n, &s) in segs.iter().enumerate() {
        for &t in &segs[n + 1..] {
            let ((a, b), (c, d)) = (ends(s), ends(t));
            let ((s1, k1), (s2, k2), (s3, k3), (s4, k4)) = (side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b));
            if k1 && k2 && k3 && k4 && s1 != s2 && s3 != s4 {
                return Expect::Invalid; // a proper crossing
            }
        }
    }
    for (k, l) in loops.iter().enumerate() {
        for (i, &p) in l.iter().enumerate() {
            for &s in &segs {
                if s.0 == k && (s.1 == i || (s.1 + 1) % l.len() == i) {
                    continue;
                }
                let (a, b) = ends(s);
                let t = ((p - a).dot(b - a) / (b - a).length_squared()).clamp(0.0, 1.0);
                let dist = p.distance(a + (b - a) * t);
                if dist.is_nan() || dist < MIN_FEATURE * 0.99 - err {
                    return Expect::Invalid;
                }
                if dist < MIN_FEATURE * 1.01 + err {
                    verdict = Expect::Either;
                }
            }
        }
    }
    // No crossings and every corner clear of every edge, so each hole is
    // wholly inside or outside each other loop: one corner decides.
    let inside = |p: DVec2, l: &[DVec2]| {
        let mut odd = false;
        for i in 0..l.len() {
            let (a, b) = (l[i], l[(i + 1) % l.len()]);
            if (a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x) {
                odd = !odd;
            }
        }
        odd
    };
    for (h, hole) in loops.iter().enumerate().skip(1) {
        if !inside(hole[0], &loops[0]) || loops.iter().enumerate().skip(1).any(|(g, other)| g != h && inside(hole[0], other)) {
            return Expect::Invalid;
        }
    }
    verdict
}

fn record(op: &Op, ok: bool) {
    let mut s = STATS.lock().unwrap_or_else(|e| e.into_inner());
    let kinds: &[&'static str] = if is_extreme(op) { &[op.kind(), EXTREME_ROW] } else { &[op.kind()] };
    for &kind in kinds {
        let t = s.entry(kind).or_default();
        if ok { t.ok += 1 } else { t.clean_error += 1 }
    }
}

/// Report row counting operations with an input outside the supported range.
const EXTREME_ROW: &str = "~extreme input";

/// Whether any input is outside the supported range (non-finite, a size
/// outside [MIN_FEATURE, MAX_SIZE], a coordinate beyond MAX_COORD, a
/// degenerate or overflowing axis, an angle beyond ±1000 rad).
fn is_extreme(op: &Op) -> bool {
    let len_bad = |v: &Num| !(LENGTHS.0..=LENGTHS.1).contains(&v.0);
    let coord_bad = |v: &Num| !(COORDS.0..=COORDS.1).contains(&v.0);
    let axis_bad = |a: &V3| !axis_ok(v3(a)) || a.iter().any(|c| c.0.abs() > 1e3);
    let angle_bad = |a: &Num| !(-1e3..=1e3).contains(&a.0);
    match op {
        Op::Add { shape, axis, angle, at } => {
            let sizes_bad = match shape {
                Shape::Box { w, d, h } => [w, d, h].into_iter().any(len_bad),
                Shape::Cylinder { r, h } => [r, h].into_iter().any(len_bad),
                Shape::Sphere { r } => len_bad(r),
                Shape::Extrude { outer, holes, dist, .. } => {
                    // Any profile number non-finite, or any coordinate or
                    // radius beyond MAX_COORD (a bulge has no unit).
                    len_bad(dist)
                        || shape.clone().numbers().into_iter().any(|v| !v.0.is_finite())
                        || std::iter::once(outer).chain(holes).flat_map(Ring::coords).any(|v| coord_bad(&Num(v)))
                }
            };
            sizes_bad || axis_bad(axis) || angle_bad(angle) || at.iter().any(coord_bad)
        }
        Op::Move { by, .. } => by.iter().any(coord_bad),
        Op::Rotate { pivot, axis, angle, .. } => pivot.iter().any(coord_bad) || axis_bad(axis) || angle_bad(angle),
    }
}

/// Classifies a kernel result: Ok(Some(body)) on success, Ok(None) on a
/// clean error, Err on anything else.
fn classify(r: Result<Result<Body, KernelError>, String>) -> Result<Option<Body>, String> {
    match r {
        Err(panic) => Err(panic),
        Ok(Ok(b)) => match validate(&b) {
            Ok(()) => Ok(Some(b)),
            Err(errs) => Err(format!("returned an invalid body: {}", errs[0])),
        },
        Ok(Err(KernelError::InvalidInput(_))) => Ok(None),
        Ok(Err(KernelError::InvalidResult(errs))) => Err(format!("InvalidResult: {}", errs[0])),
    }
}

/// A move or turn: the kernel may refuse it cleanly, and when it does not,
/// it must have changed only the placement, leaving the geometry (and so
/// its validity, volume and area) bit for bit as it was.
fn classify_motion(before: &Placed, r: Result<Result<Placed, KernelError>, String>) -> Result<Option<Placed>, String> {
    match r {
        Err(panic) => Err(panic),
        Ok(Ok(p)) if p.body != before.body => Err("moving or turning changed the body's geometry, not just its placement".into()),
        Ok(Ok(p)) => Ok(Some(p)),
        Ok(Err(KernelError::InvalidInput(_))) => Ok(None),
        Ok(Err(KernelError::InvalidResult(errs))) => Err(format!("InvalidResult: {}", errs[0])),
    }
}

/// The loop `sketch_outline` found for a sketched curved path is the path
/// drawn: the same corners, bit for bit, in order round the loop, either
/// way round, starting where the first piece walked starts (the first
/// line's start, or the first arc's with no lines), and each piece shaped
/// as drawn: a line's bulge exactly 0, an arc's bulge the drawn one (its
/// sign changed when walked the other way), its sagitta (bulge × half the
/// chord, how far the arc's middle stands off the chord) within rounding of
/// the drawn sagitta. Checked against the generator's corners and bulges,
/// not against anything the kernel computed.
fn check_sketch_pieces(pts: &[DVec2], bulges: &[f64], seed: u64) -> Result<(), String> {
    let (lines, arcs) = sketch_pieces(pts, bulges, seed);
    let (found, found_bulges) = match sketch::sketch_outline(&lines, &[], &arcs) {
        Ok(sketch::SketchOutline::Closed(Profile { outer: Boundary::Path { corners, bulges }, .. })) => (corners, bulges),
        other => return Err(format!("sketched path built, but its outline is {other:?}")),
    };
    let n = pts.len();
    let first = lines.first().map_or_else(|| arcs[0].start, |l| l.a);
    let Some(start) = pts.iter().position(|&p| p == first) else {
        return Err(format!("first piece starts at {first}, not a corner"));
    };
    let scale = pts.iter().fold(0.0f64, |m, p| m.max(p.abs().max_element()))
        + (0..n).map(|i| Piece::new(pts[i], pts[(i + 1) % n], bulges[i])).map(|p| if let Piece::Arc { r, .. } = p { r } else { 0.0 }).fold(0.0, f64::max);
    let shaped = |i: usize, want: f64| {
        let got = found_bulges.get(i).copied().unwrap_or(0.0);
        let chord = found[i].distance(found[(i + 1) % n]);
        if want == 0.0 { got.to_bits() == 0 } else { (got - want).abs() * chord / 2.0 <= tolerance::rounding_slack(scale) }
    };
    let forward = (0..n).all(|i| found.get(i) == Some(&pts[(start + i) % n]) && shaped(i, bulges[(start + i) % n]));
    let backward = (0..n).all(|i| found.get(i) == Some(&pts[(start + n - i) % n]) && shaped(i, -bulges[(start + 2 * n - i - 1) % n]));
    if found.len() != n || !(forward || backward) {
        return Err(format!("sketch loop {found:?} bulging {found_bulges:?} is not the path drawn {pts:?} bulging {bulges:?}"));
    }
    Ok(())
}

/// Applies one operation. With `checks` off it only runs the kernel (used
/// for the determinism replay, whose results are compared bit for bit).
/// The outline `sketch_outline` found for a sketched circle is that circle,
/// bit for bit, with no holes.
fn check_sketch_circle(c: sketch::Circle) -> Result<(), String> {
    let want = Profile { outer: Boundary::Circle { center: c.centre, radius: c.radius }, holes: vec![] };
    match sketch::sketch_outline(&[], &[c], &[]) {
        Ok(sketch::SketchOutline::Closed(p)) if p == want => Ok(()),
        other => Err(format!("sketched circle {c:?} built, but its outline is {other:?}")),
    }
}

/// The loop `sketch_outline` found for a sketched polygon is the polygon
/// drawn: the same corners, bit for bit (each is a line end, copied), in
/// order round the loop, either way round, starting where the first line
/// in the shuffled list starts. Checked against the generator's polygon,
/// not against anything the kernel computed.
fn check_sketch_loop(pts: &[DVec2], seed: u64) -> Result<(), String> {
    let lines = sketch_lines(pts, seed);
    let found = match sketch::sketch_outline(&lines, &[], &[]) {
        Ok(sketch::SketchOutline::Closed(Profile { outer: Boundary::Path { corners, .. }, .. })) => corners,
        other => return Err(format!("sketched polygon built, but its outline is {other:?}")),
    };
    let n = pts.len();
    let Some(start) = pts.iter().position(|&p| p == lines[0].a) else {
        return Err(format!("first line starts at {}, not a corner", lines[0].a));
    };
    let forward = (0..n).all(|i| found.get(i) == Some(&pts[(start + i) % n]));
    let backward = (0..n).all(|i| found.get(i) == Some(&pts[(start + n - i) % n]));
    if found.len() != n || !(forward || backward) {
        return Err(format!("sketch loop {found:?} is not the polygon drawn {pts:?}"));
    }
    Ok(())
}

fn apply_op(slots: &mut Vec<Slot>, op: &Op, step: usize, checks: bool) -> Result<(), Failure> {
    if !checks {
        return replay_op(slots, op);
    }
    let fail = |message: String, bodies: Vec<(String, Body)>| Failure { step, op: format!("{op:?}"), message, bodies };
    match op {
        Op::Add { shape, axis, angle, at } => {
            let base = classify(guarded(|| shape.make())).map_err(|m| fail(m, vec![]))?;
            let sizes_ok = match shape {
                Shape::Box { w, d, h } => size_ok(w.0) && size_ok(d.0) && size_ok(h.0),
                Shape::Cylinder { r, h } => size_ok(r.0) && size_ok(h.0),
                Shape::Sphere { r } => size_ok(r.0),
                Shape::Extrude { .. } => {
                    let verdict = extrude_expect(shape);
                    match verdict {
                        Expect::Valid => true,
                        Expect::Invalid => false,
                        Expect::Either => base.is_some(),
                    }
                }
            };
            if base.is_some() != sizes_ok {
                return Err(fail(format!("sizes valid = {sizes_ok} but kernel {}", if base.is_some() { "accepted" } else { "rejected" }), vec![]));
            }
            let Some(base) = base else {
                record(op, false);
                slots.push(Slot { body: None, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], steps: 0, reach: 0.0 });
                return Ok(());
            };
            let drawn = match sketched(shape) {
                Some(Drawn::Lines(pts, seed)) => check_sketch_loop(&pts, seed),
                Some(Drawn::Pieces(pts, bulges, seed)) => check_sketch_pieces(&pts, &bulges, seed),
                Some(Drawn::Circle(c)) => check_sketch_circle(c),
                None => Ok(()),
            };
            drawn.map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            let built = Placed::new(base.clone());
            let m0 = measure(&built).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            check_primitive(shape, &m0).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;

            // Place it: rotate about the origin, then move.
            let (ax, an, to) = (v3(axis), angle.0, v3(at));
            let rotated = classify_motion(&built, guarded(|| transform::rotate(&built, DVec3::ZERO, ax, an)))
                .map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            let placed = match &rotated {
                Some(r) => classify_motion(r, guarded(|| transform::translate(r, to)))
                    .map_err(|m| fail(m, vec![("rotated".into(), r.baked())]))?,
                None => None,
            };
            // Bad rotation inputs must be refused; modest ones must work.
            let rot_ok = axis_ok(ax) && an.is_finite();
            let radius = m0.lo.abs().max(m0.hi.abs()).length();
            let surely_inside = to.is_finite() && to.abs().max_element() + radius < MAX_COORD * 0.5;
            // Bad rotation inputs must be refused. A valid rotation may still
            // be refused if it swings the shape out of model space, but not
            // when the shape is well inside it.
            if rotated.is_some() && !rot_ok {
                return Err(fail("invalid rotation accepted".into(), vec![("primitive".into(), base)]));
            }
            if rotated.is_none() && rot_ok && radius < MAX_COORD * 0.5 {
                return Err(fail("valid rotation of a shape well inside model space was refused".into(), vec![("primitive".into(), base)]));
            }
            if rotated.is_some() && !to.is_finite() && placed.is_some() {
                return Err(fail("non-finite move accepted".into(), vec![]));
            }
            if rotated.is_some() && surely_inside && placed.is_none() {
                return Err(fail(format!("move by {to} well inside model space was refused"), vec![("primitive".into(), base)]));
            }
            if let Some(p) = &placed {
                let m1 = measure(p).map_err(|m| fail(m, vec![("placed".into(), p.baked())]))?;
                check_rigid(&m0, &m1, "placing").map_err(|m| fail(m, vec![("primitive".into(), base.clone()), ("placed".into(), p.baked())]))?;
            }
            record(op, placed.is_some());
            let affine = glam::DAffine3::from_translation(to) * if rot_ok { rotation(ax, an) } else { glam::DAffine3::IDENTITY };
            let mut slot = Slot { body: placed, shape: shape.clone(), affine, start: base.vertices.iter().map(|v| v.point).collect(), steps: 1, reach: 0.0 };
            slot.reach = slot.body.as_ref().map_or(0.0, body_reach).max(to.abs().max_element());
            check_position(&slot).map_err(|m| fail(m, slot.body.iter().map(|b| ("placed".to_string(), b.baked())).collect()))?;
            slots.push(slot);
        }
        Op::Move { target, by } => {
            let Some(body) = slots[*target].body.clone() else { return Ok(()) };
            let by = v3(by);
            let before = measure(&body).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
            let moved = classify_motion(&body, guarded(|| transform::translate(&body, by))).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
            if moved.is_some() && !by.is_finite() {
                return Err(fail("non-finite move accepted".into(), vec![]));
            }
            if by.is_finite() && reach(&before) + by.abs().max_element() < MAX_COORD * 0.5 && moved.is_none() {
                return Err(fail(format!("move by {by} well inside model space was refused"), vec![("before".into(), body.baked())]));
            }
            record(op, moved.is_some());
            if let Some(m) = moved {
                let after = measure(&m).map_err(|e| fail(e, vec![("after".into(), m.baked())]))?;
                let both = || vec![("before".into(), body.baked()), ("after".into(), m.baked())];
                check_rigid(&before, &after, "moving").map_err(|e| fail(e, both()))?;
                // Bounds shift by exactly `by`, up to rounding.
                let slack = tolerance::rounding_slack(reach(&before).max(reach(&after)));
                let off = ((after.lo - before.lo - by).abs().max_element()).max((after.hi - before.hi - by).abs().max_element());
                if off > slack {
                    return Err(fail(format!("bounds moved {off:e} away from the requested offset"), both()));
                }
                let s = &mut slots[*target];
                s.affine = glam::DAffine3::from_translation(by) * s.affine;
                s.reach = s.reach.max(reach(&before)).max(reach(&after)).max(by.abs().max_element());
                s.body = Some(m.clone());
                s.steps += 1;
                check_position(s).map_err(|e| fail(e, both()))?;
            }
        }
        Op::Rotate { target, pivot, axis, angle } => {
            let Some(body) = slots[*target].body.clone() else { return Ok(()) };
            let (pv, ax, an) = (v3(pivot), v3(axis), angle.0);
            let before = measure(&body).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
            let turned = classify_motion(&body, guarded(|| transform::rotate(&body, pv, ax, an))).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
            // Like every point, the pivot must lie in model space.
            let valid = axis_ok(ax) && an.is_finite() && pv.is_finite() && pv.abs().max_element() <= MAX_COORD;
            if turned.is_some() && !valid {
                return Err(fail("invalid rotation accepted".into(), vec![]));
            }
            // A rotation keeps every point within reach + 2|pivot| of the origin.
            if valid && 2.0 * (reach(&before) + 2.0 * pv.abs().max_element()) < MAX_COORD && turned.is_none() {
                return Err(fail("rotation well inside model space was refused".into(), vec![("before".into(), body.baked())]));
            }
            record(op, turned.is_some());
            if let Some(t) = turned {
                let after = measure(&t).map_err(|e| fail(e, vec![("after".into(), t.baked())]))?;
                let both = || vec![("before".into(), body.baked()), ("after".into(), t.baked())];
                check_rigid(&before, &after, "rotating").map_err(|e| fail(e, both()))?;
                // Every vertex keeps its distance from the pivot.
                let slack = tolerance::rounding_slack(reach(&before).max(reach(&after)) + pv.abs().max_element());
                for v in 0..body.body.vertices.len() {
                    let (d0, d1) = (body.vertex(v).distance(pv), t.vertex(v).distance(pv));
                    if (d0 - d1).abs() > slack {
                        return Err(fail(format!("a vertex's distance to the pivot changed {d0} → {d1}"), both()));
                    }
                }
                let s = &mut slots[*target];
                let r = glam::DAffine3::from_translation(pv) * rotation(ax, an) * glam::DAffine3::from_translation(-pv);
                s.affine = r * s.affine;
                // The kernel works relative to the pivot, so its arithmetic
                // reaches as far as the pivot plus the part.
                s.reach = s.reach.max(reach(&before) + pv.abs().max_element()).max(reach(&after));
                s.body = Some(t.clone());
                s.steps += 1;
                check_position(s).map_err(|e| fail(e, both()))?;
            }
        }
    }
    Ok(())
}

fn replay_op(slots: &mut Vec<Slot>, op: &Op) -> Result<(), Failure> {
    let quiet = |r: Result<Body, KernelError>| r.ok();
    match op {
        Op::Add { shape, axis, angle, at } => {
            let base = guarded(|| shape.make())
            .ok()
            .and_then(quiet);
            let placed = base
                .and_then(|b| guarded(|| transform::rotate(&Placed::new(b), DVec3::ZERO, v3(axis), angle.0)).ok().and_then(Result::ok))
                .and_then(|b| guarded(|| transform::translate(&b, v3(at))).ok().and_then(Result::ok));
            slots.push(Slot { body: placed, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], steps: 0, reach: 0.0 });
        }
        Op::Move { target, by } => {
            if let Some(b) = slots[*target].body.clone() {
                if let Some(m) = guarded(|| transform::translate(&b, v3(by))).ok().and_then(Result::ok) {
                    slots[*target].body = Some(m);
                }
            }
        }
        Op::Rotate { target, pivot, axis, angle } => {
            if let Some(b) = slots[*target].body.clone() {
                if let Some(t) = guarded(|| transform::rotate(&b, v3(pivot), v3(axis), angle.0)).ok().and_then(Result::ok) {
                    slots[*target].body = Some(t);
                }
            }
        }
    }
    Ok(())
}

/// Runs a chain of operations and checks everything, including that a
/// second run gives identical results.
fn check_chain(ops: &[Op], seen: Option<&AtomicUsize>) -> Result<Vec<Slot>, Failure> {
    let mut slots = Vec::new();
    for (step, op) in ops.iter().enumerate() {
        if let Some(c) = seen {
            c.fetch_add(1, Ordering::SeqCst);
        }
        let t0 = std::time::Instant::now();
        apply_op(&mut slots, op, step, true)?;
        let dt = t0.elapsed();
        let mut s = STATS.lock().unwrap_or_else(|e| e.into_inner());
        let t = s.entry(op.kind()).or_default();
        t.time += dt;
        if dt > t.slowest.0 {
            t.slowest = (dt, format!("{op:?}"));
        }
    }
    // Every finished body survives an STL round trip.
    for (i, s) in slots.iter().enumerate() {
        if let Some(b) = &s.body {
            check_stl(b).map_err(|message| Failure { step: ops.len() - 1, op: format!("STL round trip of shape {i}"), message, bodies: vec![("body".into(), b.baked())] })?;
        }
    }
    // Determinism: same chain, same bits.
    let mut again = Vec::new();
    for (step, op) in ops.iter().enumerate() {
        apply_op(&mut again, op, step, false)?;
    }
    // Bit-identical bodies give identical meshes: tessellation is itself
    // deterministic (tessellate::tests::tessellation_is_deterministic).
    for (i, (a, b)) in slots.iter().zip(&again).enumerate() {
        if a.body != b.body {
            return Err(Failure {
                step: ops.len() - 1,
                op: "replay".into(),
                message: format!("replaying the same chain gave a different result for shape {i}"),
                bodies: [(&a.body, "first run"), (&b.body, "second run")]
                    .into_iter()
                    .filter_map(|(b, l)| b.as_ref().map(|b| (l.to_string(), b.baked())))
                    .collect(),
            });
        }
    }
    Ok(slots)
}

// ---------------------------------------------------------------------------
// Regressions, dumps, oracle output, report

fn kernel_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn regressions_dir() -> PathBuf {
    kernel_dir().join("tests/regressions/stateful")
}

#[derive(Serialize, Deserialize)]
struct Regression {
    seed: u64,
    failure: String,
    ops: Vec<Op>,
}

fn save_regression(seed: u64, ops: &[Op], failure: &Failure) -> PathBuf {
    let dir = regressions_dir();
    std::fs::create_dir_all(&dir).expect("create regressions dir");
    let body = serde_json::to_string_pretty(&Regression { seed, failure: failure.to_string(), ops: ops.to_vec() }).unwrap();
    // Name by content so the same minimal case is saved once.
    let hash = body.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    let path = dir.join(format!("seed{seed:x}-{hash:016x}.json"));
    std::fs::write(&path, body).expect("write regression");
    path
}

fn write_dump(name: &str, f: &Failure, ops: &[Op]) -> Option<PathBuf> {
    let dir = kernel_dir().join("target/failure-dumps");
    let bodies: Vec<(&str, &Body)> = f.bodies.iter().map(|(l, b)| (l.as_str(), b)).collect();
    let note = format!("{f}\n\nChain:\n{}", ops.iter().enumerate().map(|(i, o)| format!("{}. {o:?}", i + 1)).collect::<Vec<_>>().join("\n"));
    debug_dump::dump(&dir, name, &bodies, &note).ok()
}

fn oracle_lines(slots: &[Slot]) -> String {
    let mut out = String::new();
    for s in slots {
        let Some(b) = &s.body else { continue };
        let Ok(m) = measure(b) else { continue };
        let world = b.baked();
        // Largest distance of a triangle centroid or edge midpoint from its
        // surface: how far the mesh strays from the exact shape.
        let mut dev = 0.0f64;
        for (t, tri) in m.mesh.triangles.iter().enumerate() {
            let surf = &world.faces[m.mesh.triangle_face[t]].surface;
            let p = tri.map(|i| m.mesh.positions[i as usize]);
            dev = dev.max(surf.distance((p[0] + p[1] + p[2]) / 3.0));
            for k in 0..3 {
                dev = dev.max(surf.distance((p[k] + p[(k + 1) % 3]) / 2.0));
            }
        }
        let a = s.affine;
        let matrix = [
            a.matrix3.x_axis.x, a.matrix3.y_axis.x, a.matrix3.z_axis.x, a.translation.x,
            a.matrix3.x_axis.y, a.matrix3.y_axis.y, a.matrix3.z_axis.y, a.translation.y,
            a.matrix3.x_axis.z, a.matrix3.y_axis.z, a.matrix3.z_axis.z, a.translation.z,
        ];
        // Rounding allowance for the placed coordinates, as in check_rigid.
        let delta = tolerance::rounding_slack(reach(&m)) * s.steps.max(1) as f64;
        let (curve_volume_slack, curve_area_slack) = curve_slacks(&s.shape);
        let line = serde_json::json!({
            "shape": s.shape, "matrix": matrix, "faces": b.body.faces.len(),
            "volume": m.volume, "area": m.area, "exact_volume": m.exact.volume, "exact_area": m.exact.area, "lo": m.lo.to_array(), "hi": m.hi.to_array(), "max_deviation": dev,
            "volume_slack": m.area * delta, "area_slack": m.perimeters * delta,
            "curve_volume_slack": curve_volume_slack, "curve_area_slack": curve_area_slack,
            // For reading disagreements: how far the part has been and how
            // many operations it went through (rounding from there stays).
            "reached": s.reach, "steps": s.steps,
        });
        out.push_str(&line.to_string());
        out.push('\n');
    }
    out
}

struct RunReport {
    seeds: Vec<u64>,
    cases: usize,
    failures: Vec<String>,
    saved: Vec<PathBuf>,
    dumps: Vec<PathBuf>,
    elapsed: std::time::Duration,
}

fn env_num(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn seed_bytes(seed: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (i, chunk) in b.chunks_mut(8).enumerate() {
        chunk.copy_from_slice(&seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(i as u64).to_le_bytes());
    }
    b
}

fn run(cases: u32, seeds: &[u64], oracle: Option<&Path>) -> RunReport {
    let start = std::time::Instant::now();
    let mut report = RunReport { seeds: seeds.to_vec(), cases: 0, failures: vec![], saved: vec![], dumps: vec![], elapsed: Default::default() };
    // Keep panic messages out of the test output; record where they happened.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|info| {
        let loc = info.location().map(|l| l.to_string()).unwrap_or_default();
        LAST_PANIC_LOCATION.with(|l| *l.borrow_mut() = loc);
    }));
    let oracle_file = oracle.map(|p| Mutex::new(std::fs::OpenOptions::new().create(true).append(true).open(p).expect("open oracle file")));
    for &seed in seeds {
        let config = Config {
            cases,
            max_shrink_iters: 20_000,
            failure_persistence: Some(Box::new(FileFailurePersistence::Direct("tests/regressions/stateful-seeds.txt"))),
            ..Config::default()
        };
        let mut runner = TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &seed_bytes(seed)));
        let ran = AtomicUsize::new(0);
        let result = runner.run(&Scene::sequential_strategy(1..=10), |(_, ops, seen)| {
            ran.fetch_add(1, Ordering::Relaxed);
            let slots = check_chain(&ops, seen.as_deref()).map_err(|f| TestCaseError::fail(f.to_string()))?;
            if let Some(f) = &oracle_file {
                use std::io::Write;
                let _ = f.lock().unwrap().write_all(oracle_lines(&slots).as_bytes());
            }
            Ok(())
        });
        report.cases += ran.load(Ordering::Relaxed);
        if let Err(TestError::Fail(_, (_, ops, _))) = result {
            // Re-run the minimal chain once more to capture the details.
            let failure = check_chain(&ops, None).err().unwrap_or(Failure {
                step: 0,
                op: "?".into(),
                message: "failed during the run but passed on replay (non-deterministic?)".into(),
                bodies: vec![],
            });
            report.saved.push(save_regression(seed, &ops, &failure));
            report.dumps.extend(write_dump(&format!("seed{seed:x}"), &failure, &ops));
            report.failures.push(format!("seed {seed:#x}: {failure} (minimal chain: {} ops)", ops.len()));
        } else if let Err(e) = result {
            report.failures.push(format!("seed {seed:#x}: runner error: {e}"));
        }
    }
    std::panic::set_hook(default_hook);
    report.elapsed = start.elapsed();
    report
}

fn print_report(r: &RunReport) -> String {
    let mut s = format!(
        "Stateful kernel test: {} cases over {} seed(s) {:?} in {:.1?}\nFailures: {}\n",
        r.cases,
        r.seeds.len(),
        r.seeds.iter().map(|s| format!("{s:#x}")).collect::<Vec<_>>(),
        r.elapsed,
        r.failures.len()
    );
    for f in &r.failures {
        s += &format!("  {f}\n");
    }
    for p in &r.saved {
        s += &format!("  saved regression: {}\n", p.display());
    }
    for p in &r.dumps {
        s += &format!("  failure dump: {}/index.html\n", p.display());
    }
    s += "Per operation (ok / clean error → success rate, total time, slowest):\n";
    for (kind, t) in STATS.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        let total = t.ok + t.clean_error;
        s += &format!(
            "  {kind:<18} {:>7} / {:<7} → {:5.1}%  {:>8.1?}  slowest {:.1?}\n",
            t.ok,
            t.clean_error,
            100.0 * t.ok as f64 / total.max(1) as f64,
            t.time,
            t.slowest.0
        );
    }
    if std::env::var("FISSION_STATEFUL_SLOWEST").is_ok() {
        for (kind, t) in STATS.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(_, t)| !t.slowest.1.is_empty()) {
            s += &format!("  slowest {kind}: {}\n", t.slowest.1);
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Tests

#[test]
fn stateful_random_chains() {
    let cases = env_num("FISSION_STATEFUL_CASES", 200) as u32;
    let n = env_num("FISSION_STATEFUL_SEEDS", 1);
    let base = env_num("FISSION_SEED", 0x5EED);
    let seeds: Vec<u64> = (0..n).map(|i| base.wrapping_add(i)).collect();
    let oracle = std::env::var("FISSION_ORACLE_OUT").ok().map(PathBuf::from);
    let report = run(cases, &seeds, oracle.as_deref());
    let text = print_report(&report);
    eprintln!("{text}");
    let _ = std::fs::create_dir_all(kernel_dir().join("target"));
    let _ = std::fs::write(kernel_dir().join("target/stateful-report.txt"), &text);
    assert!(report.failures.is_empty(), "{text}");
}

/// Every minimal failing chain ever found stays a test forever.
#[test]
fn saved_regressions_still_pass() {
    let Ok(entries) = std::fs::read_dir(regressions_dir()) else { return };
    let mut failures = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            let r: Regression = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            if let Err(f) = check_chain(&r.ops, None) {
                failures.push(format!("{}: {f}", path.display()));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn arc_pieces_by_hand() {
    // Bulge 1 turns φ = 4·atan 1 = π over the chord (0,0)→(2,0): a
    // semicircle of radius 1 centred on the chord's midpoint (1, 0).
    let Piece::Arc { c, r, .. } = Piece::new(DVec2::ZERO, DVec2::new(2.0, 0.0), 1.0) else { panic!() };
    assert!(tolerance::eq(r, 1.0) && tolerance::points_eq(c.extend(0.0), DVec3::new(1.0, 0.0, 0.0)), "{c} {r}");
    // Regression (seed74ed8ceb85a8): bulge β = 1.1e6 over a 0.0022 mm
    // chord. sin(φ/2) = 2β/(1 + β²), so r = c(1 + β²)/(4β)
    // = 0.0022 × 1.21e12 / 4.4e6 + 0.0022 / 4.4e6 = 605 + 5e-10. Taking sin of φ/2 ≈ π − 1.8e-6 gave
    // 605.0000000228 (3.8e-11 of it too large).
    let Piece::Arc { r, .. } = Piece::new(DVec2::new(0.5, 0.0), DVec2::new(0.5, 0.0022), 1.1e6) else { panic!() };
    assert!((r - (605.0 + 5e-10)).abs() <= 605.0 * 4.0 * f64::EPSILON, "{r}");
}

fn strip_with_bulges(pts: &[(f64, f64)], bulges: &[f64], dist: f64) -> Shape {
    let outer = Ring::curved(pts.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), bulges.to_vec());
    Shape::Extrude { outer, holes: vec![], dist: Num(dist), expect: None, sketch: None }
}

#[test]
fn huge_bulge_is_not_a_coordinate_by_hand() {
    // Regression (seedbfd7aebc2ed6, nightly issue #54): bulge β = 1.1e8 on
    // the 0.002 mm left end of a 0.5 × 0.002 strip. The model counted β as
    // a coordinate beyond MAX_COORD (1e8 mm) and called the shape invalid;
    // the kernel built it, rightly. Worked by hand: r = c(1 + β²)/(4β)
    // = 0.002 × 1.21e16 / 4.4e8 + 0.002 / 4.4e8 = 55000 mm (+4.5e-12), a
    // 110 m circle, well inside MAX_SIZE. The sweep φ = 4·atan β is a full
    // turn less 4/β, so the centre is on the chord's perpendicular
    // bisector y = 0.001, a whole radius off on the side away from the
    // strip: (55000, 0.001). The arc runs right round that circle, so the
    // strip is a slot cut into a disc.
    let shape = strip_with_bulges(&[(0.0, 0.0), (0.0, 0.002), (0.5, 0.002), (0.5, 0.0)], &[1.1e8, 0.0, -1.0, 0.0], 0.5);
    let Shape::Extrude { outer, .. } = &shape else { unreachable!() };
    let Piece::Arc { c, r, .. } = outer.pieces()[0] else { panic!() };
    assert!((r - 55000.0).abs() <= 55000.0 * 4.0 * f64::EPSILON, "{r}");
    assert!(c.distance(DVec2::new(55000.0, 0.001)) <= 55000.0 * 4.0 * f64::EPSILON, "{c}");
    assert_eq!(extrude_expect(&shape), Expect::Either);
    // Its volume, by hand: the disc πr² less the slot, which is the 0.5 ×
    // 0.002 rectangle plus the half circle of radius 0.001 that bulge −1
    // puts on its far end (π·0.001²/2), less the sliver between the 2 µm
    // chord and the short arc the loop leaves out ((2/3)·c·sag with sag
    // ≈ (c/2)²/(2r) = 9.1e-12 mm: 1.2e-14 mm², far below rounding), all
    // times 0.5: 0.5 × (9503317777.109125 − 0.0010015708) = 4751658888.554062.
    // The slot alone is 5.0e-4 of that, so the allowance (1e-4 mm³,
    // 2e-14 of the volume, about a hundred ulps) is tight enough to see it.
    let body = shape.make().expect("the slotted disc is a valid profile");
    let v = fission_kernel::mass::mass_properties(&body).volume;
    let by_hand = 0.5 * (PI * 55000.0f64.powi(2) - 0.001 - PI * 0.001f64.powi(2) / 2.0);
    assert!((v - by_hand).abs() <= 1e-4, "volume {v}, by hand {by_hand}");
    // A corner at the same 1.1e8 is a coordinate: out of range, both ways.
    let far = strip_with_bulges(&[(1.1e8, 0.0), (1.1e8, 0.002), (1.1e8 + 0.5, 0.002), (1.1e8 + 0.5, 0.0)], &[0.0; 4], 0.5);
    assert_eq!(extrude_expect(&far), Expect::Invalid);
    assert!(matches!(far.make(), Err(KernelError::InvalidInput(_))));
}

#[test]
fn arc_radius_limits_boundary() {
    // A "D": the chord (0,0)→(c,0) and an arc back over it. The model
    // calls an arc whose radius is outside [MIN_FEATURE, MAX_SIZE] invalid
    // from its own formula, and the kernel must agree at 0.9× and 1.1× of
    // each limit (between them the model leaves curved outlines to the
    // kernel, so only the kernel's answer is checked there).
    // Bulge for radius r over chord c, from 4rβ = c(1 + β²), the smaller
    // root: β = (2r − √(4r² − c²))/c, written as c / (2r + √(4r² − c²))
    // so it doesn't cancel for r ≫ c.
    let d_shape = |c: f64, r: f64| strip_with_bulges(&[(0.0, 0.0), (c, 0.0)], &[0.0, c / (2.0 * r + (4.0 * r * r - c * c).sqrt())], 1.0);
    let radius = |s: &Shape| match s {
        Shape::Extrude { outer, .. } => match outer.pieces()[1] {
            Piece::Arc { r, .. } => r,
            _ => panic!(),
        },
        _ => unreachable!(),
    };
    // MIN_FEATURE: half circles (r = c/2) of 0.9 and 1.1 µm radius. At
    // 1.1× the arc's top is r = 1.1 µm from the chord, clear of it.
    for (k, valid) in [(0.9, false), (1.1, true)] {
        let s = d_shape(2.0 * k * MIN_FEATURE, k * MIN_FEATURE);
        assert!(tolerance::eq(radius(&s), k * MIN_FEATURE), "{}", radius(&s));
        assert_eq!(extrude_expect(&s) == Expect::Invalid, !valid, "radius {k} × MIN_FEATURE");
        assert_eq!(s.make().is_ok(), valid, "kernel, radius {k} × MIN_FEATURE");
    }
    // MAX_SIZE: shallow arcs over a 1000 mm chord, sagging c²/(8r) =
    // 0.139 and 0.114 mm, so only the radius can be wrong with them.
    for (k, valid) in [(0.9, true), (1.1, false)] {
        let s = d_shape(1000.0, k * MAX_SIZE);
        assert!((radius(&s) - k * MAX_SIZE).abs() <= k * MAX_SIZE * 1e-9, "{}", radius(&s));
        assert_eq!(extrude_expect(&s) == Expect::Invalid, !valid, "radius {k} × MAX_SIZE");
        assert_eq!(s.make().is_ok(), valid, "kernel, radius {k} × MAX_SIZE");
    }
}

#[test]
fn close_corners_by_hand() {
    // Two corners 1 apart: closer than 1.1, not closer than 0.9.
    let pair = [DVec3::ZERO, DVec3::X];
    assert!(corners_closer_than(&pair, 1.1));
    assert!(!corners_closer_than(&pair, 0.9));
    // In neighbouring cells (1.05/0.11 → cell 9, 1.15/0.11 → cell 10),
    // 0.1 apart: found.
    assert!(corners_closer_than(&[DVec3::new(1.05, 0.0, 0.0), DVec3::new(1.15, 0.0, 0.0)], 0.11));
    // The same corner twice is one corner, not two close ones.
    assert!(!corners_closer_than(&[DVec3::ONE, DVec3::ONE], 1.0));
}

/// The harness must be able to fail: a chain whose checks are known to
/// trip proves the checker isn't silently passing everything.
#[test]
fn harness_rejects_a_wrong_answer() {
    // A rejected 0-width box is fine; claiming it valid would not be. Here
    // we feed the checker a body that lies about its shape by corrupting a
    // vertex after construction and confirm `classify` refuses it.
    let mut b = primitives::make_box(1.0, 1.0, 1.0).unwrap();
    b.vertices[7].point.z += 0.5;
    let verdict = classify(Ok(Ok(b)));
    assert!(verdict.is_err_and(|m| m.contains("invalid body")));
    // And a panic inside a kernel call is caught and reported, not fatal.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {})); // keep the expected panic quiet
    let caught = guarded(|| -> Result<Body, KernelError> { panic!("boom") });
    std::panic::set_hook(hook);
    assert!(caught.is_err_and(|m| m.contains("boom")));
}

#[test]
fn num_round_trips_through_json_exactly() {
    for v in [0.1, -0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 5e-324, 1e300, LINEAR * 1.1] {
        let back: Num = serde_json::from_str(&serde_json::to_string(&Num(v)).unwrap()).unwrap();
        assert!(back.0.to_bits() == v.to_bits() || (v.is_nan() && back.0.is_nan()), "{v:?} → {:?}", back.0);
    }
}
