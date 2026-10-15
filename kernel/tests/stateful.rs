//! Stateful random testing of the kernel.
//!
//! Random chains of 1–10 operations (add a placed primitive or extrusion,
//! move, rotate)
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
use fission_kernel::mass::{mass_properties, MassProps};
use fission_kernel::mesh::Mesh;
use fission_kernel::ops::extrude::{self, Boundary, Profile};
use fission_kernel::ops::{primitives, transform, KernelError};
use fission_kernel::tessellate::{tessellate, TessOptions};
use fission_kernel::tolerance::{self, ANGULAR, LINEAR, MAX_COORD, MAX_SIZE, MIN_FEATURE};
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
    Extrude { outer: Ring, holes: Vec<Ring>, dist: Num, expect: Option<bool> },
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
        let r = chord.length() / (2.0 * (phi / 2.0).sin().abs());
        let left = DVec2::new(-chord.y, chord.x) / chord.length();
        let c = (a + b) / 2.0 + left * (r * (phi / 2.0).cos() * phi.signum());
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
/// rest random across the whole range (log-uniform 1 µm to 10 km) or at
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
        })
        .boxed()
}

/// A random extrusion: half straight outlines (`polygon_profile`), half
/// curved ones (`curved_profile`).
fn extruded(scene: &Scene) -> BoxedStrategy<Shape> {
    prop_oneof![polygon_profile(scene), curved_profile(scene)].boxed()
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

/// Curved outlines. Four families built around a known thinnest feature,
/// so whether the kernel must accept them is known (`verdict`):
/// - slots: a rectangle with half-circle ends (radius = half the width);
/// - plates with a row of 1–3 round holes, every wall and gap the same
///   chosen width (often 0.9/1.0/1.1 × MIN_FEATURE);
/// - washers: a circle with an off-centre round hole;
/// - a quarter are random star polygons with bowed edges and round or
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
        let r = reach(&pts, w / 2.0);
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
    (prop_oneof![1 => slot, 1 => plate, 1 => washer, 1 => wavy], l)
        // The distance comes from `length`, always in range (MIN_FEATURE
        // itself is legal), so it doesn't change the verdict.
        .prop_map(|((outer, holes, expect), dist)| Shape::Extrude { outer, holes, dist: Num(dist), expect })
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
    body: Option<Body>,
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
    let now = b.bounds().0.abs().max(b.bounds().1.abs()).max_element() + s.affine.translation.abs().max_element();
    // Rounding allowance for the farthest point reached, per step, but
    // never more than the modelling tolerance: inside the supported range
    // that allowance is ~1e-8 per step, so a part off by more than LINEAR
    // is a kernel bug, not rounding.
    let slack = (tolerance::rounding_slack(now.max(s.reach)) * s.steps as f64).min(LINEAR);
    for (k, (&p0, v)) in s.start.iter().zip(&b.vertices).enumerate() {
        let expected = s.affine.transform_point3(p0);
        let off = expected.distance(v.point);
        if off.is_nan() || off > slack {
            return Err(format!("vertex {k} is at {} but should be at {expected} ({off:e} off)", v.point));
        }
    }
    Ok(())
}

fn body_reach(b: &Body) -> f64 {
    let (lo, hi) = b.bounds();
    lo.abs().max(hi.abs()).max_element()
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

fn measure(b: &Body) -> Result<Measure, String> {
    let mesh = tessellate(b, &TessOptions::DISPLAY).map_err(|e| format!("tessellation failed: face {}: {}", e.face, e.message))?;
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
    let radii = b.edges.iter().filter_map(|e| match e.curve {
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
    Ok(Measure { exact: mass_properties(b), volume: mesh.signed_volume(), area: mesh.area(), perimeters, lo, hi, mesh })
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
                Shape::Extrude { dist, .. } => {
                    // Any profile number non-finite or beyond MAX_COORD.
                    len_bad(dist) || shape.clone().numbers().into_iter().any(|v| coord_bad(v))
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

/// Applies one operation. With `checks` off it only runs the kernel (used
/// for the determinism replay, whose results are compared bit for bit).
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
                Shape::Extrude { outer, holes, dist, expect } => {
                    let polygons: Option<Vec<Vec<DVec2>>> = std::iter::once(outer).chain(holes).map(Ring::polygon).collect();
                    let verdict = if !size_ok(dist.0) || shape.clone().numbers().iter().any(|v| !v.0.is_finite() || v.0.abs() > MAX_COORD) {
                        Expect::Invalid
                    } else if let Some(e) = expect {
                        if *e { Expect::Valid } else { Expect::Invalid }
                    } else if let Some(loops) = polygons {
                        profile_expect(&loops, dist.0)
                    } else {
                        Expect::Either
                    };
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
            let m0 = measure(&base).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            check_primitive(shape, &m0).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;

            // Place it: rotate about the origin, then move.
            let (ax, an, to) = (v3(axis), angle.0, v3(at));
            let rotated = classify(guarded(|| transform::rotate(&base, DVec3::ZERO, ax, an)))
                .map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            let placed = match &rotated {
                Some(r) => classify(guarded(|| transform::translate(r, to)))
                    .map_err(|m| fail(m, vec![("rotated".into(), r.clone())]))?,
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
                let m1 = measure(p).map_err(|m| fail(m, vec![("placed".into(), p.clone())]))?;
                check_rigid(&m0, &m1, "placing").map_err(|m| fail(m, vec![("primitive".into(), base.clone()), ("placed".into(), p.clone())]))?;
            }
            record(op, placed.is_some());
            let affine = glam::DAffine3::from_translation(to) * if rot_ok { rotation(ax, an) } else { glam::DAffine3::IDENTITY };
            let mut slot = Slot { body: placed, shape: shape.clone(), affine, start: base.vertices.iter().map(|v| v.point).collect(), steps: 1, reach: 0.0 };
            slot.reach = slot.body.as_ref().map_or(0.0, body_reach).max(to.abs().max_element());
            check_position(&slot).map_err(|m| fail(m, slot.body.iter().map(|b| ("placed".to_string(), b.clone())).collect()))?;
            slots.push(slot);
        }
        Op::Move { target, by } => {
            let Some(body) = slots[*target].body.clone() else { return Ok(()) };
            let by = v3(by);
            let before = measure(&body).map_err(|m| fail(m, vec![("before".into(), body.clone())]))?;
            let moved = classify(guarded(|| transform::translate(&body, by))).map_err(|m| fail(m, vec![("before".into(), body.clone())]))?;
            if moved.is_some() && !by.is_finite() {
                return Err(fail("non-finite move accepted".into(), vec![]));
            }
            if by.is_finite() && reach(&before) + by.abs().max_element() < MAX_COORD * 0.5 && moved.is_none() {
                return Err(fail(format!("move by {by} well inside model space was refused"), vec![("before".into(), body)]));
            }
            record(op, moved.is_some());
            if let Some(m) = moved {
                let after = measure(&m).map_err(|e| fail(e, vec![("after".into(), m.clone())]))?;
                let both = || vec![("before".into(), body.clone()), ("after".into(), m.clone())];
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
            let before = measure(&body).map_err(|m| fail(m, vec![("before".into(), body.clone())]))?;
            let turned = classify(guarded(|| transform::rotate(&body, pv, ax, an))).map_err(|m| fail(m, vec![("before".into(), body.clone())]))?;
            let valid = axis_ok(ax) && an.is_finite() && pv.is_finite();
            if turned.is_some() && !valid {
                return Err(fail("invalid rotation accepted".into(), vec![]));
            }
            // A rotation keeps every point within reach + 2|pivot| of the origin.
            if valid && 2.0 * (reach(&before) + 2.0 * pv.abs().max_element()) < MAX_COORD && turned.is_none() {
                return Err(fail("rotation well inside model space was refused".into(), vec![("before".into(), body)]));
            }
            record(op, turned.is_some());
            if let Some(t) = turned {
                let after = measure(&t).map_err(|e| fail(e, vec![("after".into(), t.clone())]))?;
                let both = || vec![("before".into(), body.clone()), ("after".into(), t.clone())];
                check_rigid(&before, &after, "rotating").map_err(|e| fail(e, both()))?;
                // Every vertex keeps its distance from the pivot.
                let slack = tolerance::rounding_slack(reach(&before).max(reach(&after)) + pv.abs().max_element());
                for (p, q) in body.vertices.iter().zip(&t.vertices) {
                    let (d0, d1) = (p.point.distance(pv), q.point.distance(pv));
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
                .and_then(|b| guarded(|| transform::rotate(&b, DVec3::ZERO, v3(axis), angle.0)).ok().and_then(quiet))
                .and_then(|b| guarded(|| transform::translate(&b, v3(at))).ok().and_then(quiet));
            slots.push(Slot { body: placed, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], steps: 0, reach: 0.0 });
        }
        Op::Move { target, by } => {
            if let Some(b) = slots[*target].body.clone() {
                if let Some(m) = guarded(|| transform::translate(&b, v3(by))).ok().and_then(quiet) {
                    slots[*target].body = Some(m);
                }
            }
        }
        Op::Rotate { target, pivot, axis, angle } => {
            if let Some(b) = slots[*target].body.clone() {
                if let Some(t) = guarded(|| transform::rotate(&b, v3(pivot), v3(axis), angle.0)).ok().and_then(quiet) {
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
                    .filter_map(|(b, l)| b.as_ref().map(|b| (l.to_string(), b.clone())))
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
        // Largest distance of a triangle centroid or edge midpoint from its
        // surface: how far the mesh strays from the exact shape.
        let mut dev = 0.0f64;
        for (t, tri) in m.mesh.triangles.iter().enumerate() {
            let surf = &b.faces[m.mesh.triangle_face[t]].surface;
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
            "shape": s.shape, "matrix": matrix, "faces": b.faces.len(),
            "volume": m.volume, "area": m.area, "exact_volume": m.exact.volume, "exact_area": m.exact.area, "lo": m.lo.to_array(), "hi": m.hi.to_array(), "max_deviation": dev,
            "volume_slack": m.area * delta, "area_slack": m.perimeters * delta,
            "curve_volume_slack": curve_volume_slack, "curve_area_slack": curve_area_slack,
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
            "  {kind:<13} {:>7} / {:<7} → {:5.1}%  {:>8.1?}  slowest {:.1?}\n",
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
