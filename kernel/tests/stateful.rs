//! Stateful random testing of the kernel.
//!
//! Random chains of 1–10 operations (add a placed primitive or extrusion,
//! some extrusions drawn as shuffled sketch lines and arcs or one sketch
//! circle first; build an extrusion in a frame, either way, step 26b;
//! move, rotate)
//! are run against the kernel. After every step:
//! - nothing panics;
//! - the operation either returns a body that passes `validate()`, or a
//!   clean `InvalidInput` error, and the error/success matches what the
//!   inputs predict;
//! - volume, area and bounds obey the identities of the operation;
//! - every face has one role, exactly the roles the shape must have, with
//!   the area and centroid the harness works out from the shape itself
//!   (step 24b, `face_model`), and moves and turns carry each face's role
//!   and centroid with it (`check_faces`), measured on the baked body and,
//!   more tightly, in the body's own frame (`Placed::face_masses`, 24d3);
//! - every edge joins two faces, the one walking it forwards first
//!   (`edge_faces`), checked against the loops and by geometry
//!   (`check_edge_pairs`);
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
//!   file for the OpenCascade oracle, with the body's STEP file (step 29b)
//! - FISSION_STEP_FAULT      if set, every STEP file given to the oracle has
//!   its first face's normal flipped: a planted fault the oracle must report
//!
//! On failure the minimal chain is saved to tests/regressions/stateful/ (and
//! replayed by `saved_regressions_still_pass` forever after), and a failure
//! dump (STL + HTML viewer) is written to target/failure-dumps/.
//!
//! When a new kernel operation lands, add it to `Op`, `Scene::transitions`,
//! `apply_op` and `replay_op`.
// Expected values may use the f64 maths methods (clippy.toml, src/fmath.rs).
#![allow(clippy::disallowed_methods)]

use fission_kernel::debug_dump;
use fission_kernel::mass::MassProps;
use fission_kernel::mesh::Mesh;
use fission_kernel::ops::extrude::{self, Boundary, Profile};
use fission_kernel::ops::place::{self, Frame};
use fission_kernel::ops::{primitives, transform, KernelError};
use fission_kernel::tessellate::TessOptions;
use fission_kernel::tolerance::{self, ANGULAR, FRAME_SQUARE, LINEAR, MAX_COORD, MAX_SIZE, MIN_FEATURE};
use fission_kernel::placed::Placed;
use fission_kernel::sketch;
use fission_kernel::stl;
use fission_kernel::step_write;
#[path = "support/step_file.rs"]
mod step_file;
use step_file::{flip_first_face, step_file};
use fission_kernel::face_mass::{face_masses, FaceMass};
use fission_kernel::geom::{Curve, Surface};
use fission_kernel::topology::{Body, FaceRole, Piece as PieceId};
use fission_kernel::validate::validate;
use glam::{DVec2, DVec3};
use proptest::prelude::*;
use proptest::test_runner::{
    Config, FileFailurePersistence, RngAlgorithm, TestCaseError, TestError, TestRng, TestRunner,
};
use proptest_state_machine::ReferenceStateMachine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI, TAU};
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

    /// True if some point of this ring is certainly beyond MAX_COORD (by
    /// more than 1e-9 of it), with the harness's own arcs (`Piece::reach`).
    /// The generators' verdicts say so too, but saved regressions keep the
    /// verdict from the day they were found (issue #205's was wrong).
    fn certainly_out_of_reach(&self) -> bool {
        self.pieces().iter().any(|p| p.reach() > MAX_COORD * (1.0 + 1e-9))
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

    /// The largest |coordinate| of any point on the piece: its ends, and
    /// for a curve each of the four axis extremes of its circle that it
    /// passes through (turned from a towards b by at most |φ|, as
    /// `distance` decides).
    fn reach(&self) -> f64 {
        let far = |p: DVec2| p.abs().max_element();
        match *self {
            Piece::Line { a, b } => far(a).max(far(b)),
            Piece::Circle { c, r } => far(c.abs() + r),
            Piece::Arc { a, b, c, r, phi } => [DVec2::X, DVec2::Y, DVec2::NEG_X, DVec2::NEG_Y]
                .into_iter()
                .filter(|&u| {
                    let v = a - c;
                    (v.perp_dot(u).atan2(v.dot(u)) * phi.signum()).rem_euclid(std::f64::consts::TAU) <= phi.abs()
                })
                .fold(far(a).max(far(b)), |m, u| m.max(far(c + u * r))),
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
                    sketch::SketchOutline::Closed(profile, _) => extrude::extrude(&profile, dist.0),
                    sketch::SketchOutline::Open(why) => Err(KernelError::InvalidInput { inputs: vec![], message: why.to_string() }),
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
    /// Build an extrusion in a frame (`ops::place::extrude_in_frame`, step
    /// 26b): its profile in the frame's own coordinates, along the normal,
    /// or against it from the same plane when `flip`.
    Place { shape: Shape, origin: V3, x: V3, normal: V3, flip: bool },
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
            Op::Place { flip: false, .. } => "place extrude",
            Op::Place { flip: true, .. } => "place flipped extrude",
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
    prop_oneof![3 => add, 2 => placed(s), 3 => mv, 3 => rot].boxed()
}

/// An extrusion built in a frame (step 26b): the frame one of the origin
/// planes either way up (exact), any frame from angles, or an origin plane
/// with an axis stretched, shrunk or tilted to 0.9× or 1.1× FRAME_SQUARE
/// (the boundary, accepted and refused); the origin anywhere in range;
/// either way.
fn placed(scene: &Scene) -> BoxedStrategy<Op> {
    let planes = vec![
        ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        ([1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
        ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
    ];
    let plane = prop::sample::select(planes.clone()).prop_map(|(x, n)| (DVec3::from(x), DVec3::from(n)));
    let turned = (0.0..PI, 0.0..TAU, 0.0..TAU).prop_map(|(theta, phi, spin)| {
        let n = DVec3::new(theta.sin() * phi.cos(), theta.sin() * phi.sin(), theta.cos()).normalize();
        let p = fission_kernel::geom::any_perpendicular(n);
        ((p * spin.cos() + n.cross(p) * spin.sin()).normalize(), n)
    });
    // (which part, how): 0 stretches x, 1 the normal, 2 tilts the normal towards x.
    let boundary = (prop::sample::select(planes), 0..3u8, prop::sample::select(vec![0.9, -0.9, 1.1, -1.1])).prop_map(|((x, n), part, k)| {
        let (x, n) = (DVec3::from(x), DVec3::from(n));
        match part {
            0 => (x * (1.0 + k * FRAME_SQUARE), n),
            1 => (x, n * (1.0 + k * FRAME_SQUARE)),
            _ => (x, n + x * (k * FRAME_SQUARE)),
        }
    });
    let frame = prop_oneof![4 => plane, 4 => turned, 2 => boundary];
    (extruded(scene), vec3(coord(scene)), frame, any::<bool>())
        .prop_map(|(shape, origin, (x, n), flip)| Op::Place { shape, origin, x: x.to_array().map(Num), normal: n.to_array().map(Num), flip })
        .boxed()
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
        if let Op::Place { x, normal, .. } = &mut op {
            *(if pick.index(2) == 0 { x } else { normal }) = axis.map(Num);
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
        Op::Place { shape, origin, x, normal, .. } => {
            let mut v = shape.numbers();
            v.extend(origin.iter_mut());
            v.extend(x.iter_mut());
            v.extend(normal.iter_mut());
            v
        }
    };
    let i = pick.index(nums.len());
    *nums[i] = Num(number);
    // A changed profile number makes the generator's verdict unknown.
    if let Op::Add { shape: Shape::Extrude { expect, .. }, .. } | Op::Place { shape: Shape::Extrude { expect, .. }, .. } = &mut op {
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

/// The "D" of `curved_profile`: corners `at` and `at` + (c, 0), the long
/// way round a circle of radius `radius` (at least c) from one to the
/// other, then the flat back; with the generator's verdict.
///
/// Everything is measured on the corners as built, not as asked for. Far
/// out the flat rounds: 1e8 mm out a double's step is 1.49e-8 mm, so a
/// 0.0011 mm flat comes out up to ~1e-5 of itself long or short. The
/// radius is c·β/4 for the bulge β, so a β worked out from the flat asked
/// for, put on the flat as built, makes a circle off by that same
/// fraction: issue #205 (seed 0x9bb83e3bb4e9) asked for 325722.32 mm,
/// got 325723.42 mm (the flat came out 0.00110000372), and the circle
/// reached 0.1 mm past MAX_COORD where the verdict, from the radius asked
/// for, had it 1 mm inside.
fn d_profile(radius: f64, c: f64, at: DVec2) -> (Vec<DVec2>, Vec<f64>, Option<bool>) {
    let pts = vec![at, at + DVec2::new(c, 0.0)];
    let flat = pts[0].distance(pts[1]);
    let r = radius.max(flat);
    let k = 4.0 * r / flat;
    let beta = (k + (k * k - 4.0).sqrt()) / 2.0;
    let Piece::Arc { c: centre, r, .. } = Piece::new(pts[0], pts[1], -beta) else { unreachable!("a non-zero bulge is an arc") };
    // Nearly the whole circle: both sides (|x| + r is the farther of x ± r),
    // its top, and its lowest points, the corners (its bottom is in the gap).
    let reach = (centre.x.abs() + r).max((centre.y + r).abs()).max(at.y.abs());
    (pts, vec![-beta, 0.0], verdict(flat.min(r), 2.0 * r, reach))
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
        let (pts, bulges, expect) = d_profile(radius, c, at);
        let (pts, bulges) = if flip { reverse(pts, bulges) } else { (pts, bulges) };
        (Ring::curved(pts, bulges), vec![], expect)
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
            Op::Add { shape, at, .. } | Op::Place { shape, origin: at, .. } => {
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
            Op::Add { .. } | Op::Place { .. } => s.slots < MAX_SLOTS,
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
    /// Face centroids of the unplaced primitive.
    start_faces: Vec<DVec3>,
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

/// How far face `f`'s baked corners (and circle centres) lie from where the
/// harness's matrix puts them, worked exactly (`Exact`) so the rounding of
/// the comparison itself doesn't hide or add any: the boundary of the face
/// the kernel holds is at most this far from the ideal one.
fn corner_rounding(s: &Slot, b: &Placed, baked: &Body, f: usize) -> f64 {
    let a = s.affine.matrix3.to_cols_array_2d();
    let t = s.affine.translation;
    // Distance from `world` to the matrix's image of `unplaced`, exactly
    // up to the final rounding of each component.
    let gap = |unplaced: DVec3, world: DVec3| {
        let mut d = DVec3::ZERO;
        for i in 0..3 {
            let mut e = fission_kernel::accurate::Exact::default();
            for (j, x) in unplaced.to_array().into_iter().enumerate() {
                e.add_product(a[j][i], x);
            }
            e.add(t[i]);
            e.add(-world[i]);
            d[i] = e.value();
        }
        d.length()
    };
    // The local body may be re-centred from the unplaced one (`Placed::new`).
    let shift = s.start[0] - b.body.vertices[0].point;
    let mut worst: f64 = 0.0;
    for c in baked.faces[f].loops.iter().flat_map(|l| l.coedges.iter().copied()) {
        let v = baked.coedge_start(c);
        worst = worst.max(gap(s.start[v], baked.vertices[v].point));
        if let (Curve::Circle { center: local, .. }, Curve::Circle { center: world, .. }) = (&b.body.edges[c.edge].curve, &baked.edges[c.edge].curve) {
            worst = worst.max(gap(*local + shift, *world));
        }
    }
    worst
}

/// How far face `f`'s centroid can move per unit its boundary moves: moving
/// every boundary point by at most δ changes the area A by at most δ·P and
/// the first moment about the centroid c, ∬ (x − c) dA, by at most
/// δ ∮ |x − c| ds; the centroid moves by that moment change over A (to
/// first order, as the area's own change multiplies x − c = 0 at c). So
/// the lever is ∮ |x − c| ds / A, bounded edge by edge by its length times
/// its farthest point from c: a line's farther end, a circle's centre
/// distance plus radius. About 1 for a square, L / w for a long strip.
fn face_lever(s: &Slot, b: &Placed, f: usize, area: f64) -> f64 {
    let c = s.start_faces[f];
    let shift = s.start[0] - b.body.vertices[0].point;
    let body = &b.body;
    let mut sum = 0.0;
    for k in body.faces[f].loops.iter().flat_map(|l| l.coedges.iter().copied()) {
        let e = &body.edges[k.edge];
        let (p, q) = (s.start[e.start], s.start[e.end]);
        sum += match e.curve {
            Curve::Line { .. } => p.distance(q) * p.distance(c).max(q.distance(c)),
            Curve::Circle { center, radius, .. } => radius * (e.t1 - e.t0).abs() * ((center + shift).distance(c) + radius),
        };
    }
    sum / area
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

/// `b`'s mesh and measurements, after checking its bounds against its mesh
/// to the rounding of numbers of size `built_at` or its own size, whichever
/// is larger.
fn measure(b: &Placed, built_at: f64) -> Result<Measure, String> {
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
    // Both are rounded at the size of the numbers they went through, which
    // can be far larger than where the body ends up: a disc drawn at
    // −62.75 km and placed back at the origin by its frame keeps the
    // rounding of 62.75 km (seedf88c3ef60948), though the placed body,
    // re-centred, no longer shows it. `built_at` is that size, from the
    // harness's record of the body's history (0 for a body built where it
    // is).
    let scale = lo.abs().max(hi.abs()).max_element().max(built_at);
    check_bounds_hold_mesh((lo, hi), (mlo, mhi), sag, scale)?;
    Ok(Measure { exact: b.mass_properties(), volume: mesh.signed_volume(), area: mesh.area(), perimeters, lo, hi, mesh })
}

/// The bounds `lo..hi` hold every mesh point in `mlo..mhi` and reach past
/// them by no more than `sag`, each to the rounding of numbers of size
/// `scale` (four times the slack: the box and the mesh round separately,
/// each through a placement).
fn check_bounds_hold_mesh((lo, hi): (DVec3, DVec3), (mlo, mhi): (DVec3, DVec3), sag: f64, scale: f64) -> Result<(), String> {
    let slack = tolerance::rounding_slack(scale) * 4.0;
    if (mlo - lo).min_element() < -slack || (hi - mhi).min_element() < -slack {
        return Err(format!("bounds {lo}..{hi} miss mesh points spanning {mlo}..{mhi}"));
    }
    if (mlo - lo).max_element() > sag + slack || (hi - mhi).max_element() > sag + slack {
        return Err(format!("bounds {lo}..{hi} reach more than the chord sag {sag:e} past the mesh {mlo}..{mhi}"));
    }
    Ok(())
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
/// The faces a shape must have, worked out by the harness from the shape
/// alone (step 24b): each face's role, area and centroid, before placing.
/// Box, cylinder and sphere by their closed forms; an extrusion's caps
/// from its rings (the fan of triangles from one corner plus each arc's
/// circular segment, whose centroid is 4r sin³(φ/2) / (3(φ − sin φ)) from
/// its centre towards the arc's middle), and the side of each piece (a
/// line's is length × d at its midpoint; an arc's r|φ|·d at
/// r sin(φ/2)/(φ/2) from its centre; a circle's 2πr·d on its axis), half
/// way up. A drawn sketch names its sides by the outline's pieces, which
/// `sketch_outline` says came from which drawn curve: the harness maps
/// each to the line, arc or circle it drew and measures that one.
fn face_model(shape: &Shape) -> Result<Vec<(FaceRole, f64, DVec3)>, String> {
    let named = |role, area, (x, y, z): (f64, f64, f64)| (role, area, DVec3::new(x, y, z));
    Ok(match *shape {
        Shape::Box { w, d, h } => {
            let (w, d, h) = (w.0, d.0, h.0);
            vec![
                named(FaceRole::Bottom, w * d, (w / 2.0, d / 2.0, 0.0)),
                named(FaceRole::Top, w * d, (w / 2.0, d / 2.0, h)),
                named(FaceRole::Front, w * h, (w / 2.0, 0.0, h / 2.0)),
                named(FaceRole::Back, w * h, (w / 2.0, d, h / 2.0)),
                named(FaceRole::Left, d * h, (0.0, d / 2.0, h / 2.0)),
                named(FaceRole::Right, d * h, (w, d / 2.0, h / 2.0)),
            ]
        }
        Shape::Cylinder { r, h } => {
            let (r, h) = (r.0, h.0);
            vec![
                named(FaceRole::Bottom, PI * r * r, (0.0, 0.0, 0.0)),
                named(FaceRole::Top, PI * r * r, (0.0, 0.0, h)),
                named(FaceRole::Wall, 2.0 * PI * r * h, (0.0, 0.0, h / 2.0)),
            ]
        }
        // Each half 2πr², its centroid r/2 from the centre (Archimedes).
        Shape::Sphere { r } => vec![
            named(FaceRole::Upper, 2.0 * PI * r.0 * r.0, (0.0, 0.0, r.0 / 2.0)),
            named(FaceRole::Lower, 2.0 * PI * r.0 * r.0, (0.0, 0.0, -r.0 / 2.0)),
        ],
        Shape::Extrude { ref outer, ref holes, dist, .. } => {
            let d = dist.0;
            let rings: Vec<Vec<Piece>> = std::iter::once(outer).chain(holes).map(Ring::pieces).collect();
            // Signed area and first moment of each ring, made positive,
            // about the outer ring's first point (Sterbenz: corners near
            // it subtract exactly).
            let about = match rings[0][0] {
                Piece::Line { a, .. } | Piece::Arc { a, .. } => a,
                Piece::Circle { c, .. } => c,
            };
            let (mut area, mut moment) = (0.0, DVec2::ZERO);
            for (k, pieces) in rings.iter().enumerate() {
                let (a, m) = ring_moment(pieces, about);
                let sign = if (a > 0.0) == (k == 0) { 1.0 } else { -1.0 };
                area += sign * a;
                moment += m * sign;
            }
            let c = about + moment / area;
            let mut faces = vec![named(FaceRole::Start, area, (c.x, c.y, 0.0)), named(FaceRole::End, area, (c.x, c.y, d))];
            let side = |boundary, piece, p: &Piece| {
                let (a, c) = side_of(p);
                (FaceRole::Side(PieceId::at(boundary, piece)), a * d, c.extend(d / 2.0))
            };
            match sketched(shape) {
                None => {
                    for (k, pieces) in rings.iter().enumerate() {
                        faces.extend(pieces.iter().enumerate().map(|(i, p)| side(k, i, p)));
                    }
                }
                Some(drawn) => {
                    let Ok(sketch::SketchOutline::Closed(_, sources)) = drawn.outline() else { return Err("a built sketch has no closed outline".into()) };
                    let (lines, arcs, circles) = match &drawn {
                        Drawn::Lines(pts, seed) => (sketch_lines(pts, *seed), vec![], vec![]),
                        Drawn::Pieces(pts, bulges, seed) => {
                            let (l, a) = sketch_pieces(pts, bulges, *seed);
                            (l, a, vec![])
                        }
                        Drawn::Circle(c) => (vec![], vec![], vec![*c]),
                    };
                    for (i, s) in sources.iter().enumerate() {
                        let p = match s.curve {
                            sketch::SketchCurve::Line(j) => lines.get(j).map(|l| Piece::Line { a: l.a, b: l.b }),
                            sketch::SketchCurve::Arc(j) => arcs.get(j).map(|a| {
                                // Counter-clockwise from start to end.
                                let (u, w) = (a.start - a.centre, a.end - a.centre);
                                let phi = u.perp_dot(w).atan2(u.dot(w)).rem_euclid(std::f64::consts::TAU);
                                Piece::Arc { a: a.start, b: a.end, c: a.centre, r: (u.length() + w.length()) / 2.0, phi }
                            }),
                            sketch::SketchCurve::Circle(j) => circles.get(j).map(|c| Piece::Circle { c: c.centre, r: c.radius }),
                        };
                        faces.push(side(0, i, &p.ok_or_else(|| format!("outline piece {i} names {s:?}, which was not drawn"))?));
                    }
                }
            }
            faces
        }
    })
}

/// A ring's signed area and first moment ∬ (x − about) dA (positive when
/// it runs counter-clockwise), about a point near the ring so a frame far
/// out keeps its digits (seedab2989180676): the fan of triangles from its first point, each
/// (o, a, b) with area ½ (a − o) × (b − o) at (o + a + b)/3, plus each
/// arc's segment beyond its chord, counted positive when the arc turns
/// counter-clockwise (it then bows out to the right of its chord, out of
/// a counter-clockwise ring).
fn ring_moment(pieces: &[Piece], about: DVec2) -> (f64, DVec2) {
    let o = match pieces[0] {
        Piece::Line { a, .. } | Piece::Arc { a, .. } => a,
        Piece::Circle { c, .. } => c,
    };
    let (mut area, mut moment) = (0.0, DVec2::ZERO);
    for p in pieces {
        match *p {
            Piece::Line { a, b } | Piece::Arc { a, b, .. } => {
                let t = 0.5 * (a - o).perp_dot(b - o);
                area += t;
                moment += ((o - about) + (a - about) + (b - about)) * (t / 3.0);
            }
            Piece::Circle { .. } => {}
        }
        let segment = match *p {
            Piece::Line { .. } => continue,
            Piece::Arc { a, c, r, phi, .. } => {
                let mid = a - c;
                let (s, co) = ((phi / 2.0).sin(), (phi / 2.0).cos());
                let towards = DVec2::new(mid.x * co - mid.y * s, mid.x * s + mid.y * co) / mid.length();
                let f = phi.abs();
                // f − sin f by its series: taken directly it cancels to
                // ~1e-6 of itself on a shallow arc, and the centroid, r
                // from the centre, moved by that much of r (seed8736e4b0b3df:
                // r = 251 m tipped a cap's centroid 4.4e-4 mm; issue #102).
                let tms = theta_minus_sin(f);
                (r * r * tms / 2.0 * phi.signum(), (c - about) + towards * (4.0 * r * (f / 2.0).sin().powi(3) / (3.0 * tms)))
            }
            Piece::Circle { c, r } => (PI * r * r, c - about),
        };
        area += segment.0;
        moment += segment.1 * segment.0;
    }
    (area, moment)
}

/// θ − sin θ, by its series θ³/3! − θ⁵/5! + … when |θ| ≤ 0.5, where the
/// direct difference cancels: at θ = 4e-5 it keeps only ~6 of its digits.
fn theta_minus_sin(t: f64) -> f64 {
    if t.abs() > 0.5 {
        return t - t.sin();
    }
    // Term k is (−1)^k θ^(2k+3) / (2k+3)!; past k = 7 it is under 1e-17 of the first.
    let (mut term, mut sum) = (t * t * t / 6.0, 0.0);
    for k in 0..8 {
        sum += term;
        term *= -t * t / (((2 * k + 4) * (2 * k + 5)) as f64);
    }
    sum
}

/// The side wall a piece sweeps, per unit height: its length and the
/// centroid of the curve in the plane.
fn side_of(p: &Piece) -> (f64, DVec2) {
    match *p {
        Piece::Line { a, b } => (a.distance(b), (a + b) / 2.0),
        Piece::Arc { a, c, r, phi, .. } => {
            let h = phi / 2.0;
            let u = (a - c) / (a - c).length();
            let towards = DVec2::new(u.x * h.cos() - u.y * h.sin(), u.x * h.sin() + u.y * h.cos());
            (r * phi.abs(), c + towards * (r * h.abs().sin() / h.abs()))
        }
        Piece::Circle { c, r } => (std::f64::consts::TAU * r, c),
    }
}

/// The unplaced body's faces against `face_model`: one role each, none
/// twice, exactly the model's roles, each face's area and centroid the
/// model's to 1e-6 of the part's size (the timeline harness's MATCH_REL,
/// which is MASS_PROPS_REL), and the faces' areas adding up to the body's
/// (`body`'s own area, not `m`'s, which is of the body re-centred).
fn check_face_model(shape: &Shape, body: &Body, m: &Measure) -> Result<(), String> {
    let model = face_model(shape)?;
    let got = face_masses(body);
    let mut seen = std::collections::HashSet::new();
    for (f, face) in body.faces.iter().enumerate() {
        let role = face.role.ok_or_else(|| format!("face {f} has no role"))?;
        if !seen.insert(role) {
            return Err(format!("two faces are {role:?}"));
        }
    }
    if seen.len() != model.len() {
        return Err(format!("{} faces with roles, the model has {}", seen.len(), model.len()));
    }
    let size = (m.hi - m.lo).length().max(1.0);
    let tol = tolerance::MASS_PROPS_REL;
    for (role, area, centroid) in &model {
        let Some(f) = body.faces.iter().position(|face| face.role == Some(*role)) else {
            return Err(format!("no face is {role:?}"));
        };
        if got[f].area.is_nan() || !tolerance::measure_eq(got[f].area, *area, tol * area.abs().max(size)) {
            return Err(format!("{role:?}: area {} but the model says {area}", got[f].area));
        }
        let off = got[f].centroid.distance(*centroid);
        if off.is_nan() || off > tol * size {
            return Err(format!("{role:?}: centroid {} but the model says {centroid} ({off:e} off)", got[f].centroid));
        }
    }
    // Both from `body` itself. `m` measured it re-centred (`Placed::new`):
    // other corners (a coordinate near 0 rounds at the part's own scale)
    // and other roundings in each cap's cross products, which cancel from
    // ~2.7e10 mm² to 701 mm² on a long thin frame, so the two bodies' areas
    // differ by more than the sums' agreement promises (issue #241, see
    // `a_thin_frame_far_out_adds_up_on_its_own_body`).
    let total: f64 = got.iter().map(|g| g.area).sum();
    let whole = fission_kernel::mass::mass_properties(body).area;
    if !tolerance::measure_eq(total, whole, 1e-9 * whole) {
        return Err(format!("faces' areas add up to {total}, the body's is {whole}"));
    }
    Ok(())
}

/// The placed body keeps every face's role, and each face's centroid,
/// measured on the baked body, is where the harness's own matrix puts the
/// unplaced face's: catches a move or turn that loses or shuffles roles.
/// Allowed: the rounding `check_position` allows each corner, and
/// MASS_PROPS_REL of the part's size for computing the centroid itself (a
/// thin frame's cap is the difference of two large areas, so its centroid
/// carries their rounding: ~1e-4 mm for a 61 m frame 1.1 µm wide), and the
/// baked corners' own rounding times the face's lever (`face_lever`): far
/// out a corner is stored only to ~1e-8 mm, which on a 1 km strip 1.1 µm
/// wide changes one end's width by 1e-5 of it and tips the centroid ~1 mm
/// along the strip (seed8043b8edca9: the exact centroid of the kernel's
/// corners, worked in fractions, is 1.05 mm from the ideal one, and the
/// kernel's answer is 0.005 mm from it). Areas change by at most the
/// corners' rounding times the part's perimeter.
fn check_faces(s: &Slot) -> Result<(), String> {
    let Some(b) = &s.body else { return Ok(()) };
    let baked = b.baked();
    baked_faces_off(s, b, &baked)?;
    placed_centroids_off(s, &b.face_masses())?;
    check_edge_pairs(&b.body, &baked)
}

/// `check_faces` on the baked body: roles kept, centroids and areas where
/// the harness's matrix puts them, with the allowances above.
fn baked_faces_off(s: &Slot, b: &Placed, baked: &Body) -> Result<(), String> {
    let world = face_masses(baked);
    let local = face_masses(&b.body);
    let now = body_reach(b) + s.affine.translation.abs().max_element();
    let (lo, hi) = baked.bounds();
    let size = (hi - lo).length();
    let delta = 4.0 * tolerance::rounding_slack(now.max(s.reach)) * (s.steps as f64 + 1.0);
    for (f, (w, l)) in world.iter().zip(&local).enumerate() {
        let role = b.body.faces[f].role;
        if baked.faces[f].role != role {
            return Err(format!("face {f} was {role:?} and is now {:?}", baked.faces[f].role));
        }
        let expected = s.affine.transform_point3(s.start_faces[f]);
        let off = expected.distance(w.centroid);
        let allowed = delta + tolerance::MASS_PROPS_REL * size + corner_rounding(s, b, baked, f) * face_lever(s, b, f, l.area);
        if off.is_nan() || off > allowed {
            return Err(format!("face {f} ({role:?}) centroid is at {} but should be at {expected} ({off:e} off, {allowed:e} allowed)", w.centroid));
        }
        if !tolerance::measure_eq(l.area, w.area, 4.0 * size * delta + 1e-9 * l.area) {
            return Err(format!("face {f} ({role:?}) area {} became {}", l.area, w.area));
        }
    }
    Ok(())
}

/// What `Placed::face_masses` gives (step 24d3, measured in the body's own
/// frame, only the centroid carried out) must be where the harness's matrix
/// puts the unplaced face's centroid, allowing only the placement's own
/// rounding (`check_position`'s) and MASS_PROPS_REL of the part's size for
/// the centroid itself; no lever term for corners rounded far out, since
/// no corner is moved. `got` is passed in so a test can hand it broken
/// answers.
fn placed_centroids_off(s: &Slot, got: &[fission_kernel::face_mass::FaceMass]) -> Result<(), String> {
    let Some(b) = &s.body else { return Ok(()) };
    if got.len() != b.body.faces.len() {
        return Err(format!("{} face centroids for {} faces", got.len(), b.body.faces.len()));
    }
    let allowed = placed_centroid_allowance(s, b);
    for (f, m) in got.iter().enumerate() {
        let expected = s.affine.transform_point3(s.start_faces[f]);
        let off = expected.distance(m.centroid);
        if off.is_nan() || off > allowed {
            return Err(format!("face {f} ({:?}) placed centroid is at {} but should be at {expected} ({off:e} off, {allowed:e} allowed)", b.body.faces[f].role, m.centroid));
        }
    }
    Ok(())
}

fn placed_centroid_allowance(s: &Slot, b: &Placed) -> f64 {
    let now = body_reach(b) + s.affine.translation.abs().max_element();
    let (lo, hi) = b.bounds();
    4.0 * tolerance::rounding_slack(now.max(s.reach)) * (s.steps as f64 + 1.0) + tolerance::MASS_PROPS_REL * (hi - lo).length()
}

/// Every edge joins two faces (`edge_faces`, 24c1), the same two its
/// coedges are in, the first the one walking it forwards; and the baked
/// body has the same pairs. Which face walks it forwards is checked by
/// geometry, not by the loops: a face's interior lies to the left of an
/// edge it walks forwards (normal × tangent points into it), so its
/// centroid c satisfies (c − m) · (n × t) > 0 at the edge's midpoint m. That
/// holds for every face the harness makes but an extrude's caps, which need
/// not be convex: a box's rectangles and a cylinder's discs (half the width
/// across), a sphere's halves (r/2 above or below the equator), and every
/// side band, whose centroid is d/2 up from a cap edge and, from an upright,
/// along its piece (a line's midpoint, or an arc's centroid, (1 − cos θ)/θ
/// · r along the tangent where it starts). Measured in the local frame.
fn check_edge_pairs(local: &Body, baked: &Body) -> Result<(), String> {
    let pairs = fission_kernel::edge_faces(local);
    if fission_kernel::edge_faces(baked) != pairs {
        return Err("placing the body changed which faces its edges join".into());
    }
    let centroids: Vec<DVec3> = face_masses(local).iter().map(|m| m.centroid).collect();
    edge_pairs_off(local, &pairs, &centroids)
}

/// How far a face's centroid c can be off the left-hand test's zero by
/// rounding alone: FP_REL of the distances involved. Within it the test
/// says nothing: a side swept from an arc of almost a full turn has its
/// centroid (1 − cos θ)/θ · r along the tangent from the upright, 3e-10 mm
/// for an arc of radius 321 km closing to a 1.1 µm gap (seed5dc4), below
/// the rounding of a centroid 321 km away (~3e-10 here). The other face
/// (that gap's line, 0.55 µm along) must then decide.
fn left_bound(c: DVec3, m: DVec3) -> f64 {
    tolerance::FP_REL * ((c - m).length() + m.length())
}

/// A point inside cylinder face `face`, for the upright edge whose midpoint
/// is `m`: on the face's first arc edge, from the end of the arc nearer
/// `m`, half the arc or a quarter turn in, whichever is less, at m's
/// height. Seen from that upright it lies r·sin(that turn) along the wall,
/// at least r·sin(turn/2) for any arc, where the centroid of a wall of
/// almost a full turn is only (1 − cos θ)/θ · r along (issue #185: two
/// arcs of radius 4.6 m and 27.5 m closing to a 1 µm chord put both walls'
/// centroids ~2e-11 mm from the upright, under rounding). None for any
/// other face, or one with no arc edge.
fn arc_witness(body: &Body, face: usize, m: DVec3) -> Option<DVec3> {
    if !matches!(body.faces[face].surface, Surface::Cylinder { .. }) {
        return None;
    }
    let edge = body.faces[face].loops.iter().flat_map(|l| &l.coedges).map(|c| &body.edges[c.edge]).find(|e| matches!(e.curve, Curve::Circle { .. }))?;
    let Curve::Circle { center, axis, .. } = edge.curve else { return None };
    let (t0, t1) = (edge.t0, edge.t1);
    let at = edge.curve.closest_param(m);
    let apart = |t: f64| {
        let d = (at - t).rem_euclid(TAU);
        d.min(TAU - d)
    };
    let turn = (0.5 * (t1 - t0)).min(0.5 * PI);
    let t = if apart(t0) <= apart(t1) { t0 + turn } else { t1 - turn };
    Some(edge.curve.eval(t) + axis * (m - center).dot(axis))
}

/// `centroids` (each face's, by index) are passed in so a test can move them.
fn edge_pairs_off(body: &Body, pairs: &[Option<[usize; 2]>], centroids: &[DVec3]) -> Result<(), String> {
    if pairs.len() != body.edges.len() {
        return Err(format!("{} edge pairs for {} edges", pairs.len(), body.edges.len()));
    }
    let mut uses = vec![(vec![], vec![]); body.edges.len()];
    for (f, face) in body.faces.iter().enumerate() {
        for c in face.loops.iter().flat_map(|l| &l.coedges) {
            if c.reversed { uses[c.edge].1.push(f) } else { uses[c.edge].0.push(f) }
        }
    }
    for (e, pair) in pairs.iter().enumerate() {
        let Some([f, g]) = *pair else { return Err(format!("edge {e} joins no two faces")) };
        if (uses[e].0.as_slice(), uses[e].1.as_slice()) != (&[f][..], &[g][..]) {
            return Err(format!("edge {e} joins faces {f} > {g}, but its loops say {:?} > {:?}", uses[e].0, uses[e].1));
        }
        let edge = &body.edges[e];
        let mid = 0.5 * (edge.t0 + edge.t1);
        let (m, t) = (edge.curve.eval(mid), edge.curve.tangent(mid));
        let mut decided = false;
        for (face, along) in [(f, t), (g, -t)] {
            if matches!(body.faces[face].role, Some(FaceRole::Start | FaceRole::End)) {
                continue;
            }
            let sense = if body.faces[face].sense { 1.0 } else { -1.0 };
            let n = body.faces[face].surface.normal_at(m) * sense;
            // The centroid, then (a wall the centroid can't decide) a point
            // of the wall a quarter turn in from the edge's end of its arc.
            for c in std::iter::once(centroids[face]).chain(arc_witness(body, face, m)) {
                let left = (c - m).dot(n.cross(along));
                let bound = left_bound(c, m);
                if left.is_nan() || left < -bound {
                    let way = if face == f { "forwards" } else { "backwards" };
                    return Err(format!("edge {e}: face {face} ({:?}) is said to walk it {way}, but lies on its right ({left:e}, {bound:e} allowed; centroid {c}, midpoint {m}, normal {n}, tangent {along})", body.faces[face].role));
                }
                if left > bound {
                    decided = true;
                    break;
                }
            }
        }
        if !decided {
            return Err(format!("edge {e}: neither face's centroid is clearly on its left, so which walks it forwards is not checked"));
        }
    }
    Ok(())
}

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
        || rings().any(Ring::certainly_out_of_reach)
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
        Op::Place { shape, origin, x, normal, .. } => {
            let Shape::Extrude { outer, holes, dist, .. } = shape else { return true };
            len_bad(dist)
                || shape.clone().numbers().into_iter().any(|v| !v.0.is_finite())
                || std::iter::once(outer).chain(holes).flat_map(Ring::coords).any(|v| coord_bad(&Num(v)))
                || !frame_ok(v3(origin), v3(x), v3(normal))
        }
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
        Ok(Err(KernelError::InvalidInput { .. })) => Ok(None),
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
        Ok(Err(KernelError::InvalidInput { .. })) => Ok(None),
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
        Ok(sketch::SketchOutline::Closed(Profile { outer: Boundary::Path { corners, bulges }, .. }, _)) => (corners, bulges),
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
    let circle_source = sketch::Source { curve: sketch::SketchCurve::Circle(0), reversed: false };
    match sketch::sketch_outline(&[], &[c], &[]) {
        Ok(sketch::SketchOutline::Closed(p, sources)) if p == want && sources == [circle_source] => Ok(()),
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
        Ok(sketch::SketchOutline::Closed(Profile { outer: Boundary::Path { corners, .. }, .. }, _)) => corners,
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

// ---------------------------------------------------------------------------
// Building in a frame (step 26b)

/// The harness's own rule for a frame the kernel must take: every part
/// finite, the origin in model space, both axes unit and square to each
/// other within FRAME_SQUARE (`ops::place::frame_placement`'s contract).
fn frame_ok(origin: DVec3, x: DVec3, n: DVec3) -> bool {
    origin.is_finite()
        && x.is_finite()
        && n.is_finite()
        && origin.abs().max_element() <= MAX_COORD
        && (x.length() - 1.0).abs() <= FRAME_SQUARE
        && (n.length() - 1.0).abs() <= FRAME_SQUARE
        && x.dot(n).abs() <= FRAME_SQUARE
}

/// The frame as the harness reads it: local (u, v, w) → origin + u·x̂ +
/// v·(n̂ × x̂) + w·n̂, worked apart from the kernel's quaternion, squared up
/// as the kernel's contract says (the normal's direction kept, x̂ the unit
/// part of x in the plane). Read literally instead, an x axis 58 ulps long
/// (inside FRAME_SQUARE) puts a corner 725 mm out 1.1e-11 mm further than
/// the kernel, which squares it (seed30b, saved).
fn frame_affine(origin: DVec3, x: DVec3, n: DVec3) -> glam::DAffine3 {
    let n = n / n.length();
    let x = x - n * x.dot(n);
    let x = x / x.length();
    glam::DAffine3::from_cols(x, n.cross(x), n, origin)
}

/// A half turn about local x: (u, v, w) → (u, −v, −w).
fn half_turn_x() -> glam::DAffine3 {
    glam::DAffine3::from_cols(DVec3::X, DVec3::NEG_Y, DVec3::NEG_Z, DVec3::ZERO)
}

/// The profile an extrusion shape makes: its rings, or the closed loop its
/// sketch makes (`Err` when the drawing makes none).
fn shape_profile(shape: &Shape) -> Result<Profile, KernelError> {
    let Shape::Extrude { outer, holes, .. } = shape else { panic!("only extrusions are built in a frame") };
    match sketched(shape) {
        Some(drawn) => match drawn.outline()? {
            sketch::SketchOutline::Closed(profile, _) => Ok(profile),
            sketch::SketchOutline::Open(why) => Err(KernelError::InvalidInput { inputs: vec![], message: why.to_string() }),
        },
        None => Ok(Profile { outer: outer.boundary(), holes: holes.iter().map(Ring::boundary).collect() }),
    }
}

/// The harness's own mirror of a plain extrusion across its x axis: each
/// point (x, −y), each bulge negated (written here, not taken from the
/// kernel's `mirrored`).
fn mirror_shape(shape: &Shape) -> Shape {
    let Shape::Extrude { outer, holes, dist, expect, .. } = shape else { panic!("only extrusions are mirrored") };
    let flip = |p: &P2| [p[0], Num(-p[1].0)];
    let ring = |r: &Ring| match r {
        Ring::Path { pts, bulges } => Ring::Path { pts: pts.iter().map(flip).collect(), bulges: bulges.iter().map(|b| Num(-b.0)).collect() },
        Ring::Circle { c, r } => Ring::Circle { c: flip(c), r: *r },
    };
    Shape::Extrude { outer: ring(outer), holes: holes.iter().map(ring).collect(), dist: *dist, expect: *expect, sketch: None }
}

/// Each face of a body built in a frame against the shape's own face model
/// (`face_model`, worked from the shape, not from the kernel), read through
/// the frame literally, with w → −w when flipped: the same role, area and
/// (to rounding at the reach and MASS_PROPS_REL of the size) centroid. The
/// caps face away from the solid: the start cap against the extrude's way
/// (−n, or +n flipped), the end cap along it; a plane side lies along n.
/// This is what says a flipped extrude is the extrude moved back with its
/// start cap still on the sketch plane, without the kernel's mirroring.
fn check_placed_model(shape: &Shape, p: &Placed, frame: glam::DAffine3, flip: bool, m: &Measure) -> Result<(), String> {
    let model = face_model(shape)?;
    let got = p.face_masses();
    let size = (m.hi - m.lo).length().max(1.0);
    let allowed = tolerance::MASS_PROPS_REL * size + 4.0 * tolerance::rounding_slack(reach(m) + frame.translation.abs().max_element());
    let w = if flip { -1.0 } else { 1.0 };
    let n = frame.matrix3.z_axis;
    if p.body.faces.iter().filter(|f| f.role.is_some()).count() != model.len() {
        return Err(format!("{} faces with roles, the model has {}", p.body.faces.len(), model.len()));
    }
    for (role, area, c) in model {
        let Some(f) = p.body.faces.iter().position(|face| face.role == Some(role)) else { return Err(format!("no face is {role:?}")) };
        let expected = frame.transform_point3(DVec3::new(c.x, c.y, w * c.z));
        let off = got[f].centroid.distance(expected);
        if off.is_nan() || off > allowed {
            return Err(format!("{role:?}: placed centroid {} but the model through the frame says {expected} ({off:e} off, {allowed:e} allowed)", got[f].centroid));
        }
        if !tolerance::measure_eq(got[f].area, area, tolerance::MASS_PROPS_REL * area.abs().max(size)) {
            return Err(format!("{role:?}: area {} but the model says {area}", got[f].area));
        }
        if !matches!(p.body.faces[f].surface, Surface::Plane { .. }) {
            continue;
        }
        let normal = p.placement.dir(p.body.face_normal_at(f, DVec3::ZERO));
        let ok = match role {
            FaceRole::Start => normal.distance(-w * n) <= ANGULAR,
            FaceRole::End => normal.distance(w * n) <= ANGULAR,
            _ => normal.dot(n).abs() <= ANGULAR,
        };
        if !ok {
            return Err(format!("{role:?}: faces {normal}, the frame's normal is {n}, flipped {flip}"));
        }
    }
    check_placed_corners(shape, p, frame, w, allowed)
}

/// Step 26f: the view's exact corners and circle centres (what a sketch
/// point snapped to a face's edge lands on) are the model's, through the
/// frame: every corner of every path ring at both ends of the extrude, and
/// every circle ring's centre at both ends, has a view point within
/// `allowed`; a path ring's straight side's middle is its two corners'
/// average. The view is the app's (`view_placed`), so this checks what
/// the app is handed, not the kernel's own placement of it.
fn check_placed_corners(shape: &Shape, p: &Placed, frame: glam::DAffine3, w: f64, allowed: f64) -> Result<(), String> {
    let Shape::Extrude { outer, holes, dist, .. } = shape else { return Ok(()) };
    let v = fission_kernel::view_placed(p).map_err(|e| format!("view_placed refused a placed body: {}", e.message))?;
    let near = |pts: &[[f64; 3]], q: DVec3| pts.iter().any(|x| DVec3::from(*x).distance(q) <= allowed);
    let centres: Vec<[f64; 3]> = v.edge_centres.iter().flatten().copied().collect();
    for ring in std::iter::once(outer).chain(holes) {
        for z in [0.0, w * dist.0] {
            let at = |x: f64, y: f64| frame.transform_point3(DVec3::new(x, y, z));
            match ring {
                Ring::Path { pts, bulges } => {
                    for (i, c) in pts.iter().enumerate() {
                        let q = at(c[0].0, c[1].0);
                        if !near(&v.vertex_points, q) {
                            return Err(format!("corner {i} at z {z} should be at {q}, and no view corner is ({allowed:e} allowed)"));
                        }
                        let straight = bulges.get(i).is_none_or(|b| b.0 == 0.0);
                        let d = &pts[(i + 1) % pts.len()];
                        let mid = at((c[0].0 + d[0].0) / 2.0, (c[1].0 + d[1].0) / 2.0);
                        if straight && !near(&v.edge_middles, mid) {
                            return Err(format!("side {i} at z {z}: its middle should be at {mid}, and no view edge's is"));
                        }
                    }
                }
                Ring::Circle { c, .. } => {
                    let q = at(c[0].0, c[1].0);
                    if !near(&centres, q) {
                        return Err(format!("circle at z {z}: its centre should be at {q}, and no view edge's is"));
                    }
                }
            }
        }
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
                slots.push(Slot { body: None, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], start_faces: vec![], steps: 0, reach: 0.0 });
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
            let m0 = measure(&built, 0.0).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            check_primitive(shape, &m0).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;
            check_face_model(shape, &base, &m0).map_err(|m| fail(m, vec![("primitive".into(), base.clone())]))?;

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
                // Its numbers went through where it was built and through
                // the move, as for Move below (issue #240: a disc built at
                // y = 964 m and moved back to y = 5 mm keeps the rounding
                // of 964 m in its mesh).
                let m1 = measure(p, reach(&m0).max(to.abs().max_element())).map_err(|m| fail(m, vec![("placed".into(), p.baked())]))?;
                check_rigid(&m0, &m1, "placing").map_err(|m| fail(m, vec![("primitive".into(), base.clone()), ("placed".into(), p.baked())]))?;
            }
            record(op, placed.is_some());
            let affine = glam::DAffine3::from_translation(to) * if rot_ok { rotation(ax, an) } else { glam::DAffine3::IDENTITY };
            let start_faces = face_masses(&base).iter().map(|m| m.centroid).collect();
            let mut slot = Slot { body: placed, shape: shape.clone(), affine, start: base.vertices.iter().map(|v| v.point).collect(), start_faces, steps: 1, reach: 0.0 };
            slot.reach = slot.body.as_ref().map_or(0.0, body_reach).max(to.abs().max_element());
            check_position(&slot).map_err(|m| fail(m, slot.body.iter().map(|b| ("placed".to_string(), b.baked())).collect()))?;
            check_faces(&slot).map_err(|m| fail(m, slot.body.iter().map(|b| ("placed".to_string(), b.baked())).collect()))?;
            slots.push(slot);
        }
        Op::Move { target, by } => {
            let Some(body) = slots[*target].body.clone() else { return Ok(()) };
            let by = v3(by);
            let before = measure(&body, slots[*target].reach).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
            let moved = classify_motion(&body, guarded(|| transform::translate(&body, by))).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
            if moved.is_some() && !by.is_finite() {
                return Err(fail("non-finite move accepted".into(), vec![]));
            }
            if by.is_finite() && reach(&before) + by.abs().max_element() < MAX_COORD * 0.5 && moved.is_none() {
                return Err(fail(format!("move by {by} well inside model space was refused"), vec![("before".into(), body.baked())]));
            }
            record(op, moved.is_some());
            if let Some(m) = moved {
                let after = measure(&m, slots[*target].reach.max(by.abs().max_element())).map_err(|e| fail(e, vec![("after".into(), m.baked())]))?;
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
                check_faces(s).map_err(|e| fail(e, both()))?;
            }
        }
        Op::Rotate { target, pivot, axis, angle } => {
            let Some(body) = slots[*target].body.clone() else { return Ok(()) };
            let (pv, ax, an) = (v3(pivot), v3(axis), angle.0);
            let before = measure(&body, slots[*target].reach).map_err(|m| fail(m, vec![("before".into(), body.baked())]))?;
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
                let after = measure(&t, slots[*target].reach).map_err(|e| fail(e, vec![("after".into(), t.baked())]))?;
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
                check_faces(s).map_err(|e| fail(e, both()))?;
            }
        }
        Op::Place { shape, origin, x, normal, flip } => {
            let (o, xa, na, flip) = (v3(origin), v3(x), v3(normal), *flip);
            let frame = Frame { origin: o, x: xa, normal: na };
            // The unplaced extrude, as `Add` judges it: accepted exactly
            // when the generator (or `profile_expect`) says.
            let base = classify(guarded(|| shape.make())).map_err(|m| fail(m, vec![]))?;
            let verdict = match extrude_expect(shape) {
                Expect::Valid => true,
                Expect::Invalid => false,
                Expect::Either => base.is_some(),
            };
            if base.is_some() != verdict {
                return Err(fail(format!("profile valid = {verdict} but the kernel {} it unplaced", if base.is_some() { "accepted" } else { "rejected" }), vec![]));
            }
            let built = match shape_profile(shape) {
                Ok(profile) => guarded(|| place::extrude_in_frame(&profile, match shape { Shape::Extrude { dist, .. } => dist.0, _ => unreachable!() }, &frame, flip)).map_err(|m| fail(m, vec![]))?,
                Err(e) => Err(e),
            };
            let placed = match built {
                Ok((p, _)) => match validate(&p.body) {
                    Ok(()) => Some(p),
                    Err(errs) => return Err(fail(format!("returned an invalid body: {}", errs[0]), vec![("local".into(), p.body)])),
                },
                Err(KernelError::InvalidInput { .. }) => None,
                Err(KernelError::InvalidResult(errs)) => return Err(fail(format!("InvalidResult: {}", errs[0]), vec![])),
            };
            let good_frame = frame_ok(o, xa, na);
            if placed.is_some() && !good_frame {
                return Err(fail(format!("a frame the harness refuses was accepted: origin {o}, x {xa}, normal {na}"), vec![]));
            }
            if placed.is_some() && base.is_none() {
                return Err(fail("a profile refused unplaced was accepted in a frame".into(), vec![]));
            }
            record(op, placed.is_some());
            let Some(base) = base else {
                slots.push(Slot { body: None, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], start_faces: vec![], steps: 0, reach: 0.0 });
                return Ok(());
            };
            let m0 = measure(&Placed::new(base.clone()), 0.0).map_err(|m| fail(m, vec![("unplaced".into(), base.clone())]))?;
            // Every world point is within |origin| + (the local point's
            // distance from the frame's origin) of the world's.
            let surely_inside = o.abs().max_element() + m0.lo.abs().max(m0.hi.abs()).length() < MAX_COORD * 0.5;
            if placed.is_none() && good_frame && surely_inside {
                return Err(fail(format!("a valid frame (origin {o}, x {xa}, normal {na}) and profile, well inside model space, were refused"), vec![("unplaced".into(), base)]));
            }
            let Some(p) = placed else {
                slots.push(Slot { body: None, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], start_faces: vec![], steps: 0, reach: 0.0 });
                return Ok(());
            };
            let world = || vec![("placed".to_string(), p.baked())];
            let m1 = measure(&p, o.abs().max_element().max(reach(&m0))).map_err(|m| fail(m, world()))?;
            check_rigid(&m0, &m1, "placing in a frame").map_err(|m| fail(m, world()))?;
            let affine = frame_affine(o, xa, na);
            check_placed_model(shape, &p, affine, flip, &m1).map_err(|m| fail(m, world()))?;
            // From here the slot is followed like any other: its local body
            // is the extrude of the profile as built (mirrored by the
            // harness's own rule when flipped), carried by the frame (turned
            // a half turn about x first when flipped).
            let (local_shape, affine) = if flip { (mirror_shape(&oracle_shape(shape)), affine * half_turn_x()) } else { (shape.clone(), affine) };
            let local = classify(guarded(|| local_shape.make())).map_err(|m| fail(m, world()))?.ok_or_else(|| fail("the harness's mirror of an accepted profile was refused".into(), world()))?;
            let start_faces = face_masses(&local).iter().map(|m| m.centroid).collect();
            let mut slot = Slot { body: Some(p), shape: local_shape, affine, start: local.vertices.iter().map(|v| v.point).collect(), start_faces, steps: 1, reach: 0.0 };
            slot.reach = slot.body.as_ref().map_or(0.0, body_reach).max(o.abs().max_element());
            check_position(&slot).map_err(|m| fail(m, slot.body.iter().map(|b| ("placed".to_string(), b.baked())).collect()))?;
            check_faces(&slot).map_err(|m| fail(m, slot.body.iter().map(|b| ("placed".to_string(), b.baked())).collect()))?;
            slots.push(slot);
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
            slots.push(Slot { body: placed, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], start_faces: vec![], steps: 0, reach: 0.0 });
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
        Op::Place { shape, origin, x, normal, flip } => {
            let frame = Frame { origin: v3(origin), x: v3(x), normal: v3(normal) };
            let Shape::Extrude { dist, .. } = shape else { unreachable!() };
            let placed = shape_profile(shape).ok().and_then(|profile| guarded(|| place::extrude_in_frame(&profile, dist.0, &frame, *flip)).ok().and_then(Result::ok)).map(|(p, _)| p);
            slots.push(Slot { body: placed, shape: shape.clone(), affine: glam::DAffine3::IDENTITY, start: vec![], start_faces: vec![], steps: 0, reach: 0.0 });
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

/// The shape the kernel was given, for OpenCascade and the exact referee:
/// a drawn sketch's closed outline (`Drawn::outline`) in place of the
/// harness's own corners and bulges. They differ where the drawing rounds:
/// an arc is drawn round its centre, a double, and 100 km out a double
/// resolves only 1.5e-8 mm, so the outline's bulge is the one that centre
/// gives, not the harness's (issues #183, #184: a 0.096 mm arc's bulge
/// 349.26670850809774 drawn as 349.26668292259035, 1.5e-7 of the volume,
/// which the kernel had to 1e-16 of the outline's). Any other shape is
/// itself.
fn oracle_shape(shape: &Shape) -> Shape {
    let (Shape::Extrude { dist, expect, sketch, .. }, Some(drawn)) = (shape, sketched(shape)) else { return shape.clone() };
    let Ok(sketch::SketchOutline::Closed(profile, _)) = drawn.outline() else { return shape.clone() };
    let num = |p: DVec2| [Num(p.x), Num(p.y)];
    let outer = match profile.outer {
        Boundary::Path { corners, bulges } => Ring::Path { pts: corners.into_iter().map(num).collect(), bulges: bulges.into_iter().map(Num).collect() },
        Boundary::Circle { center, radius } => Ring::Circle { c: num(center), r: Num(radius) },
    };
    Shape::Extrude { outer, holes: vec![], dist: *dist, expect: *expect, sketch: *sketch }
}

fn oracle_lines(slots: &[Slot]) -> String {
    let mut out = String::new();
    for s in slots {
        let Some(b) = &s.body else { continue };
        let Ok(m) = measure(b, s.reach) else { continue };
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
        let shape = oracle_shape(&s.shape);
        let (curve_volume_slack, curve_area_slack) = curve_slacks(&shape);
        // The body as the kernel holds it, placed, for OpenCascade to read
        // and check (compare.py, step_check.py). The harness has already
        // validated it, so a refusal is a finding, not a skip.
        let (step, step_refused) = step_file(&world);
        let line = serde_json::json!({
            "shape": shape, "matrix": matrix, "faces": b.body.faces.len(),
            "volume": m.volume, "area": m.area, "exact_volume": m.exact.volume, "exact_area": m.exact.area, "lo": m.lo.to_array(), "hi": m.hi.to_array(), "max_deviation": dev,
            "volume_slack": m.area * delta, "area_slack": m.perimeters * delta,
            "curve_volume_slack": curve_volume_slack, "curve_area_slack": curve_area_slack,
            // For reading disagreements: how far the part has been and how
            // many operations it went through (rounding from there stays).
            "reached": s.reach, "steps": s.steps,
            "step": step, "step_refused": step_refused,
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

/// seedf88c3ef60948: a 68 mm disc drawn at y = −62.75 km on the front plane
/// and placed by an origin at z = +62.75 km lands at the world origin, but
/// its numbers went through 62.75 km, where one unit in the last place is
/// 2⁻²⁷ ≈ 7.45e-9 mm. Its box top (67.99998898436542) sits 3.68e-9 under
/// its top mesh point (67.99998898804188); exactly, with fractions, the arc's
/// top is at (y + origin z) + sagitta = −1.0997e-5 + 67.99999999632352 =
/// 67.99998899926656, so both are a couple of those units low: rounding,
/// not a wrong box.
#[test]
fn bounds_round_at_the_size_they_were_built_at() {
    let lo = DVec3::new(-17.999499999999944, -0.49999998606633145, -0.000011011958129358845);
    let hi = DVec3::new(50.000500000000045, 0.000000013933683734590474, 67.99998898436542);
    let mlo = DVec3::new(-17.98957861165301, -0.49999998606633145, -0.000011011958129358845);
    let mhi = DVec3::new(49.990578611653014, 0.000000013933683734590474, 67.99998898804188);
    let sag = 0.02; // 2·max(DISPLAY_CHORD = 0.01, 34·(1 − cos(π/256)) ≈ 0.0026)
    // At 62.75 km the slack is 6.2751733e7 · 64 · 2⁻⁵² · 4 ≈ 3.57e-6 ≫ 3.68e-9.
    assert_eq!(check_bounds_hold_mesh((lo, hi), (mlo, mhi), sag, 62751732.8929737), Ok(()));
    // At the world size alone, 68 · 64 · 2⁻⁵² · 4 ≈ 3.87e-12 ≪ 3.68e-9: the
    // old reading, which flagged it.
    let e = check_bounds_hold_mesh((lo, hi), (mlo, mhi), sag, 68.0).unwrap_err();
    assert!(e.contains("miss mesh points"), "{e}");
}

/// Issue #240 (seed4e0a16a70d0e): a disc of radius ~1 mm, drawn as one
/// bulge arc (bulge −3636.36…, chord 0.0011 mm) at y = 964 472.99 mm and
/// moved by y = −964 467.99 mm. Exactly, with fractions, the chord lands at
/// y = 4.999989000032656 and the arc's top is the chord plus its sagitta
/// |bulge|·chord/2 = 1.9999998487499886: 6.999988848782644, the box's top
/// to 1.3e-16. The top mesh point is 2.65e-11 higher: it was made at
/// y ≈ 964 475, where one unit in the last place is 2⁻³³ ≈ 1.16e-10, so it
/// is a quarter of a unit off, rounding, not a wrong box.
#[test]
fn a_moved_body_rounds_at_the_size_it_was_built_at() {
    let lo = DVec3::new(0.0005500000000144833, 4.999989000032656, 0.0);
    let hi = DVec3::new(2.0005500000000143, 6.999988848782644, 0.001);
    let mlo = DVec3::new(0.0005500378125036232, 4.999989000032656, 0.0);
    let mhi = DVec3::new(2.0005499621874963, 6.999988848809153, 0.001);
    let sag = 0.02; // 2·max(DISPLAY_CHORD = 0.01, 1·(1 − cos(π/256)) ≈ 7.5e-5)
    // Built at 964 475: slack 964475 · 64 · 2⁻⁵² · 4 ≈ 5.48e-8 ≫ 2.65e-11.
    assert_eq!(check_bounds_hold_mesh((lo, hi), (mlo, mhi), sag, 964474.99486), Ok(()));
    // At the moved body's own size, 7 · 64 · 2⁻⁵² · 4 ≈ 3.98e-13 ≪ 2.65e-11:
    // the old reading (scale 0, so the box's own 7), which flagged it.
    let e = check_bounds_hold_mesh((lo, hi), (mlo, mhi), sag, 7.0).unwrap_err();
    assert!(e.contains("miss mesh points"), "{e}");
}

/// The bounds check's slack at scale 1000 is 1000 · 64 · 2⁻⁵² · 4 =
/// 256000 · 2⁻⁵² ≈ 5.684e-11; a 10 mm cube's box missing a mesh point, or
/// reaching past the mesh beyond the sag, by 0.9× that passes and by 1.1×
/// fails.
#[test]
fn bounds_check_slack_boundaries() {
    let slack = 256000.0 * f64::EPSILON;
    assert_eq!(tolerance::rounding_slack(1000.0) * 4.0, slack);
    let (lo, hi) = (DVec3::ZERO, DVec3::splat(10.0));
    let mesh = |d: f64| (DVec3::ZERO, DVec3::new(10.0, 10.0, 10.0 + d));
    assert_eq!(check_bounds_hold_mesh((lo, hi), mesh(0.9 * slack), 0.0, 1000.0), Ok(()));
    let e = check_bounds_hold_mesh((lo, hi), mesh(1.1 * slack), 0.0, 1000.0).unwrap_err();
    assert!(e.contains("miss mesh points"), "{e}");
    // The box 0.5 past the mesh, with a sag of 0.5 − 0.9·slack or 0.5 − 1.1·slack.
    assert_eq!(check_bounds_hold_mesh((lo, hi), mesh(-0.5), 0.5 - 0.9 * slack, 1000.0), Ok(()));
    let e = check_bounds_hold_mesh((lo, hi), mesh(-0.5), 0.5 - 1.1 * slack, 1000.0).unwrap_err();
    assert!(e.contains("reach more than the chord sag"), "{e}");
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

#[test]
fn piece_reach_by_hand() {
    // Bulge 1 over (x, −1000) → (x, 1000) is a half turn counter-clockwise
    // round (x, 0), radius 1000: the right half, through (x + 1000, 0).
    // Reversed, (x, 1000) → (x, −1000), it is the left half, whose
    // farthest point right is its ends at x.
    let x = 5000.0;
    let right = Piece::new(DVec2::new(x, -1000.0), DVec2::new(x, 1000.0), 1.0);
    let left = Piece::new(DVec2::new(x, 1000.0), DVec2::new(x, -1000.0), 1.0);
    assert_eq!((right.reach(), left.reach()), (6000.0, 5000.0));
    // The same arcs bulging the other way (bulge −1, clockwise) swap.
    assert_eq!(Piece::new(DVec2::new(x, 1000.0), DVec2::new(x, -1000.0), -1.0).reach(), 6000.0);
    // A circle round (−3, 4) of radius 2 reaches x = −5 and y = 6.
    assert_eq!(Piece::Circle { c: DVec2::new(-3.0, 4.0), r: 2.0 }.reach(), 6.0);
}

#[test]
fn certainly_out_of_reach_boundary() {
    // A circle drawn as two half arcs round (cx, 0), radius 1000, its
    // corners at x = cx inside the range; its right side, cx + 1000, at
    // MAX_COORD·(1 + k·1e-9): over by 0.9 of the 1e-9 band (0.09 mm) is
    // too close to call, by 1.1 of it certainly out. Mirrored to −x and
    // turned onto ±y the same.
    for k in [0.9, 1.1] {
        let edge = MAX_COORD * (1.0 + k * 1e-9);
        let cx = edge - 1000.0;
        for (sx, sy, swap) in [(1.0, 1.0, false), (-1.0, 1.0, false), (1.0, 1.0, true), (1.0, -1.0, true)] {
            let p = |x: f64, y: f64| if swap { DVec2::new(y * sy, x * sx) } else { DVec2::new(x * sx, y * sy) };
            // Two corners, both bulges 1: the whole circle, whichever way
            // round the corners lie.
            let ring = Ring::curved(vec![p(cx, -1000.0), p(cx, 1000.0)], vec![1.0, 1.0]);
            assert_eq!(ring.certainly_out_of_reach(), k > 1.0, "k {k}, {ring:?}");
            let shape = Shape::Extrude { outer: ring, holes: vec![], dist: Num(1.0), expect: None, sketch: None };
            // Beyond MAX_COORD at all, the kernel refuses it.
            assert!(shape.make().is_err(), "k {k}");
            assert_eq!(extrude_expect(&shape) == Expect::Invalid, k > 1.0, "k {k}");
        }
    }
}

#[test]
fn a_far_d_is_judged_as_built_by_hand() {
    // Issue #205 (seed 0x9bb83e3bb4e9): a "D" asked for with a 0.0011 mm
    // flat from x = 99674276.6799047 and radius 325722.32. Between 2^26 and
    // 2^27 a double's step is 2^−26 = 1.4901e-8 mm, so the flat is a whole
    // number of steps: 0.0011 / 2^−26 = 73819.75, rounding to 73820 steps
    // = 0.0011000037193298340 mm. The radius is (flat)·β/4, so the bulge
    // worked out from 0.0011 makes a circle 3.38e-6 of itself bigger:
    // 325723.42 mm, whose right side, at the flat's middle plus r =
    // 99674276.68046 + 325723.42 = 100000000.10, is past MAX_COORD.
    let at = DVec2::new(99674276.6799047, 0.0);
    let flat = 73820.0 * 2f64.powi(-26);
    assert_eq!((at + DVec2::new(1.1 * MIN_FEATURE, 0.0)).x - at.x, flat);
    let (asked, c) = (325722.32, 1.1 * MIN_FEATURE);
    let k = 4.0 * asked / c;
    let old_beta = (k + (k * k - 4.0).sqrt()) / 2.0;
    let Piece::Arc { r, .. } = Piece::new(at, at + DVec2::new(c, 0.0), -old_beta) else { panic!() };
    assert!((r / asked - flat / c).abs() < 1e-9, "radius {r} is the flat's {} of the asked", flat / c);
    let issue = Shape::Extrude {
        outer: Ring::curved(vec![at, DVec2::new(99674276.6810047, 0.0)], vec![-1184444800.3065448, 0.0]),
        holes: vec![],
        dist: Num(0.5),
        expect: Some(true),
        sketch: Some(0),
    };
    assert!(issue.make().is_err());
    assert_eq!(extrude_expect(&issue), Expect::Invalid, "the saved verdict is overruled");
    // Built now: β from the flat as built, so the radius is the one asked
    // for and the right side is 99674276.68045 + 325722.32 = 99999999.0005,
    // 0.9995 mm inside: valid, and the kernel agrees, sketched or not.
    let (pts, bulges, expect) = d_profile(asked, c, at);
    let Piece::Arc { r, c: centre, .. } = Piece::new(pts[0], pts[1], bulges[0]) else { panic!() };
    assert!((r - asked).abs() < 1e-9 * asked && (centre.x + r - 99999999.0005).abs() < 1e-3, "{r} {centre}");
    assert_eq!(expect, Some(true));
    for sketch in [None, Some(0), Some(7)] {
        let shape = Shape::Extrude { outer: Ring::curved(pts.clone(), bulges.clone()), holes: vec![], dist: Num(0.5), expect, sketch };
        assert!(shape.make().is_ok(), "{sketch:?}");
    }
}

#[test]
fn far_ds_judged_like_the_kernel() {
    // Seeded (SplitMix64): Ds near the edge of the range, every flat the
    // generator uses and radii from 1 mm to 1 km, their right side, top or
    // left within ±2 mm of MAX_COORD. Whatever the generator calls certain
    // the kernel must agree with, sketched and as a plain profile.
    let mut state = 0x205u64;
    let mut next = || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        (z ^ (z >> 31)) as f64 / u64::MAX as f64
    };
    let flats = [0.5 * LINEAR, 0.9 * MIN_FEATURE, MIN_FEATURE, 1.1 * MIN_FEATURE, 1.0];
    let (mut certain, mut wrong) = (0, vec![]);
    for i in 0..3000 {
        let c = flats[i % flats.len()];
        let radius = 10f64.powf(6.0 * next());
        let miss = (next() - 0.5) * 4.0;
        let at = match i % 3 {
            0 => DVec2::new(MAX_COORD + miss - radius - c / 2.0, (next() - 0.5) * 1e6),
            1 => DVec2::new((next() - 0.5) * 1e6, MAX_COORD + miss - 2.0 * radius),
            _ => DVec2::new(-MAX_COORD - miss + radius - c / 2.0, (next() - 0.5) * 1e6),
        };
        let (pts, bulges, expect) = d_profile(radius, c, at);
        let Some(valid) = expect else { continue };
        certain += 1;
        for sketch in [None, Some(i as u64)] {
            let shape = Shape::Extrude { outer: Ring::curved(pts.clone(), bulges.clone()), holes: vec![], dist: Num(1.0), expect, sketch };
            if shape.make().is_ok() != valid {
                wrong.push(format!("{shape:?}"));
            }
        }
    }
    assert!(certain > 1000, "only {certain} certain");
    assert!(wrong.is_empty(), "{} wrong, first {}", wrong.len(), wrong[0]);
}

#[test]
fn a_thin_frame_far_out_by_hand() {
    // Regression (seedab2989180676, random testing): a 20.5 × 12 frame
    // 1.1 µm wide, 100 km out. Outer x 0..20.5, y −99999999..−99999987;
    // hole x 0.0011..20.4989, y −99999998.9989..−99999987.0011. Both
    // rectangles are symmetric about x = 20.5/2 = 10.25 and
    // y = (−99999999 − 99999987)/2 = −99999993, so the frame between them
    // is too: its caps' centroids are (10.25, −99999993) at z = 0 and 6.
    // Its area is 20.5 × 12 − 20.4978 × 11.9978 = 0.07122... mm², and
    // weighting each ring's first moment about the world origin made two
    // ~2.4e10 numbers cancel to ~7e6, leaving ~4e-6 of rounding over that
    // area: the model put the centroid 5.7e-5 mm off.
    let shape = Shape::Extrude {
        outer: Ring::straight(vec![DVec2::new(0.0, -99999999.0), DVec2::new(20.5, -99999999.0), DVec2::new(20.5, -99999987.0), DVec2::new(0.0, -99999987.0)]),
        holes: vec![Ring::straight(vec![
            DVec2::new(0.0011, -99999998.9989),
            DVec2::new(0.0011, -99999987.0011),
            DVec2::new(20.4989, -99999987.0011),
            DVec2::new(20.4989, -99999998.9989),
        ])],
        dist: Num(6.0),
        expect: None,
        sketch: None,
    };
    let model = face_model(&shape).unwrap();
    // Each coordinate rounds to a few units in the last place of 1e8.
    let slack = tolerance::rounding_slack(1e8);
    for (role, z) in [(FaceRole::Start, 0.0), (FaceRole::End, 6.0)] {
        let &(_, _, c) = model.iter().find(|m| m.0 == role).unwrap();
        let off = c.distance(DVec3::new(10.25, -99999993.0, z));
        assert!(off <= slack, "{role:?} centroid {c} is {off:e} off");
    }
}

/// A slot for `base` placed as `placed`, the harness's matrix `affine`
/// after `steps` operations.
fn placed_slot(base: &Body, placed: Placed, affine: glam::DAffine3, steps: u32) -> Slot {
    let reach = body_reach(&placed).max(affine.translation.abs().max_element());
    let start_faces = face_masses(base).iter().map(|m| m.centroid).collect();
    Slot { body: Some(placed), shape: Shape::Box { w: Num(1.0), d: Num(1.0), h: Num(1.0) }, affine, start: base.vertices.iter().map(|v| v.point).collect(), start_faces, steps, reach }
}

fn face_with(body: &Body, role: FaceRole) -> usize {
    body.faces.iter().position(|f| f.role == Some(role)).unwrap()
}

#[test]
fn face_lever_by_hand() {
    // Box 4 × 1 × 3: its Front is the 4 × 3 rectangle at y = 0, centroid
    // (2, 0, 1.5). Every corner is √(2² + 1.5²) = 2.5 from it, so each
    // edge counts its length times 2.5: (4 + 3 + 4 + 3) × 2.5 / 12 = 35/12.
    let base = primitives::make_box(4.0, 1.0, 3.0).unwrap();
    let s = placed_slot(&base, Placed::new(base.clone()), glam::DAffine3::IDENTITY, 1);
    let b = s.body.as_ref().unwrap();
    let f = face_with(&base, FaceRole::Front);
    assert!(tolerance::rel_eq(face_lever(&s, b, f, 12.0), 35.0 / 12.0, tolerance::FP_REL));
    // Cylinder r = 1: its Top is one full circle round its own centroid,
    // length 2π, every point 0 + 1 from the centroid, over area π: 2.
    let base = primitives::make_cylinder(1.0, 2.0).unwrap();
    let s = placed_slot(&base, Placed::new(base.clone()), glam::DAffine3::IDENTITY, 1);
    let b = s.body.as_ref().unwrap();
    let f = face_with(&base, FaceRole::Top);
    assert!(tolerance::rel_eq(face_lever(&s, b, f, PI), 2.0, tolerance::FP_REL));
}

#[test]
fn corner_rounding_measures_the_gap() {
    // Box 4 × 1 × 3 moved by (1, 0, 0): integers and halves, every sum
    // exact, so the kernel's corners are exactly where the matrix puts
    // them: no rounding on any face.
    let base = primitives::make_box(4.0, 1.0, 3.0).unwrap();
    let placed = transform::translate(&Placed::new(base.clone()), DVec3::X).unwrap();
    let baked = placed.baked();
    let s = placed_slot(&base, placed.clone(), glam::DAffine3::from_translation(DVec3::X), 2);
    for f in 0..baked.faces.len() {
        assert_eq!(corner_rounding(&s, &placed, &baked, f), 0.0);
    }
    // Broken on purpose: the harness's matrix moves by 1 + 1e-3, so every
    // corner the kernel holds is 1e-3 short of it.
    let s = placed_slot(&base, placed.clone(), glam::DAffine3::from_translation(DVec3::new(1.0 + 1e-3, 0.0, 0.0)), 2);
    for f in 0..baked.faces.len() {
        assert!(tolerance::rel_eq(corner_rounding(&s, &placed, &baked, f), 1e-3, tolerance::FP_REL));
    }
    // Circle centres count too: a cylinder's Top has a single corner, on
    // its rim, and its centre is measured the same way.
    let base = primitives::make_cylinder(1.0, 2.0).unwrap();
    let placed = transform::translate(&Placed::new(base.clone()), DVec3::X).unwrap();
    let baked = placed.baked();
    let s = placed_slot(&base, placed.clone(), glam::DAffine3::from_translation(DVec3::new(1.0, 2e-3, 0.0)), 2);
    let top = face_with(&base, FaceRole::Top);
    assert!(tolerance::rel_eq(corner_rounding(&s, &placed, &baked, top), 2e-3, tolerance::FP_REL));
}

#[test]
fn a_long_thin_face_far_out_is_allowed_its_rounding() {
    // Regression (seed8043b8edca9): a box 1 km × 36 mm × 1.1 µm, turned and
    // moved 100 km out. Its Front, 1 km long and 1.1 µm wide, is stored
    // with corners rounded to ~1e-8 mm, which tips its centroid ~1 mm along
    // its length: more than the rounding and size allowances alone.
    // Built turned π about (1, 1, 0), then turned about (0, −7, 0), then
    // moved; the harness's matrix follows the same three steps.
    let base = primitives::make_box(999999.999999, 36.0, 0.0011).unwrap();
    let (flip, pivot) = (DVec3::new(1.0, 1.0, 0.0), DVec3::new(0.0, -7.0, 0.0));
    let axis = DVec3::new(0.0, 0.7231947291110354, -0.9344924436458961);
    let (angle, by) = (9.590236344901994, DVec3::new(0.0, 99999999.0, 0.0));
    let built = transform::rotate(&Placed::new(base.clone()), DVec3::ZERO, flip, PI).unwrap();
    let turned = transform::rotate(&built, pivot, axis, angle).unwrap();
    let placed = transform::translate(&turned, by).unwrap();
    let turn = glam::DAffine3::from_translation(pivot) * rotation(axis, angle) * glam::DAffine3::from_translation(-pivot);
    let affine = glam::DAffine3::from_translation(by) * turn * rotation(flip, PI);
    let mut s = placed_slot(&base, placed.clone(), affine, 3);
    check_faces(&s).unwrap();
    let baked = placed.baked();
    let f = face_with(&base, FaceRole::Front);
    let centroid = face_masses(&baked)[f].centroid;
    let (lo, hi) = baked.bounds();
    let now = body_reach(&placed) + affine.translation.abs().max_element();
    let without = 4.0 * tolerance::rounding_slack(now.max(s.reach)) * 4.0 + tolerance::MASS_PROPS_REL * (hi - lo).length();
    let off = affine.transform_point3(s.start_faces[f]).distance(centroid);
    assert!(off > without, "{off} {without}");
    // The check's edge: an expected centroid 0.9× the allowance away
    // passes, 1.1× fails, whichever way it is off.
    let allowed = without + corner_rounding(&s, &placed, &baked, f) * face_lever(&s, &placed, f, face_masses(&base)[f].area);
    for dir in [DVec3::X, DVec3::Y, DVec3::Z] {
        for (k, pass) in [(0.9, true), (1.1, false)] {
            s.start_faces[f] = affine.inverse().transform_point3(centroid + dir * (k * allowed));
            let got = baked_faces_off(&s, &placed, &baked);
            assert_eq!(got.is_ok(), pass, "{k} × {allowed:e} along {dir}: {got:?}");
        }
    }
}

#[test]
fn placed_face_centroids_need_no_allowance_for_far_corners() {
    // Step 24d3: the same 1 km × 36 mm × 1.1 µm box 100 km out as above,
    // measured in its own frame with only the centroid carried out
    // (`Placed::face_masses`), lands within the placement's own rounding
    // and the size allowance: no lever term.
    let base = primitives::make_box(999999.999999, 36.0, 0.0011).unwrap();
    let (flip, pivot) = (DVec3::new(1.0, 1.0, 0.0), DVec3::new(0.0, -7.0, 0.0));
    let axis = DVec3::new(0.0, 0.7231947291110354, -0.9344924436458961);
    let (angle, by) = (9.590236344901994, DVec3::new(0.0, 99999999.0, 0.0));
    let built = transform::rotate(&Placed::new(base.clone()), DVec3::ZERO, flip, PI).unwrap();
    let turned = transform::rotate(&built, pivot, axis, angle).unwrap();
    let placed = transform::translate(&turned, by).unwrap();
    let turn = glam::DAffine3::from_translation(pivot) * rotation(axis, angle) * glam::DAffine3::from_translation(-pivot);
    let affine = glam::DAffine3::from_translation(by) * turn * rotation(flip, PI);
    let mut s = placed_slot(&base, placed.clone(), affine, 3);
    let good = placed.face_masses();
    placed_centroids_off(&s, &good).unwrap();
    // The allowance by hand: 4 × rounding_slack(reach) × (3 steps + 1) +
    // MASS_PROPS_REL × the box's diagonal, with nothing for the strip's
    // length over its width.
    let (lo, hi) = placed.bounds();
    let reach = (body_reach(&placed) + affine.translation.abs().max_element()).max(s.reach);
    let allowed = 16.0 * tolerance::rounding_slack(reach) + tolerance::MASS_PROPS_REL * (hi - lo).length();
    assert!(tolerance::rel_eq(placed_centroid_allowance(&s, &placed), allowed, tolerance::FP_REL));
    // Planted bugs, each caught: measured on the baked body (the old way,
    // ~1 mm off), the centroid left at home, or carried out twice.
    let f = face_with(&base, FaceRole::Front);
    let baked = face_masses(&placed.baked());
    let home = face_masses(&placed.body);
    let twice: Vec<_> = good.iter().map(|m| FaceMass { centroid: placed.placement.point(m.centroid), ..*m }).collect();
    for (bug, got) in [("baked", baked), ("home", home), ("twice", twice)] {
        let err = placed_centroids_off(&s, &got).expect_err(bug);
        assert!(err.contains("placed centroid"), "{bug}: {err}");
    }
    let err = placed_centroids_off(&s, &good[1..]).unwrap_err();
    assert!(err.contains("5 face centroids for 6 faces"), "{err}");
    // The check's edge: an expected centroid 0.9× the allowance away
    // passes, 1.1× fails, whichever way it is off.
    for dir in [DVec3::X, DVec3::Y, DVec3::Z] {
        for (k, pass) in [(0.9, true), (1.1, false)] {
            s.start_faces[f] = affine.inverse().transform_point3(good[f].centroid + dir * (k * allowed));
            let got = placed_centroids_off(&s, &good);
            assert_eq!(got.is_ok(), pass, "{k} × {allowed:e} along {dir}: {got:?}");
        }
    }
}

#[test]
fn edge_pairs_by_hand_and_broken() {
    // A 1 × 2 × 3 box: 12 edges, each joining two of its six faces, the
    // first walking it forwards. Its bottom face (z = 0, normal −Z) runs
    // counter-clockwise seen from below, so the edge along x at y = 0, z = 0
    // is walked by the bottom one way and by the front (y = 0) the other;
    // the front's centroid (0.5, 0, 1.5) from that edge's midpoint
    // (0.5, 0, 0) is (0, 0, 1.5), and the bottom's is (0, 1, 0): whichever
    // walks it forwards has that offset on its left.
    let b = primitives::make_box(1.0, 2.0, 3.0).unwrap();
    let pairs = fission_kernel::edge_faces(&b);
    edge_pairs_off(&b, &pairs, &mid(&b)).unwrap();
    let (front, bottom) = (face_with(&b, FaceRole::Front), face_with(&b, FaceRole::Bottom));
    let e = pairs.iter().position(|p| matches!(p, Some([f, g]) if [*f, *g] == [front, bottom] || [*f, *g] == [bottom, front])).unwrap();
    let edge = &b.edges[e];
    let t = edge.curve.tangent(0.5 * (edge.t0 + edge.t1));
    // Forwards along +x: the front (normal −Y) has −Y × +X = +Z on its
    // left, towards its centroid; along −x the bottom (−Z) has −Z × −X = +Y.
    let forwards = if t.x > 0.0 { front } else { bottom };
    assert_eq!(pairs[e].unwrap()[0], forwards, "{t}");
    // A cylinder and a sphere pass too; so does every extrude the harness
    // makes (checked in every case).
    for body in [primitives::make_cylinder(2.0, 5.0).unwrap(), primitives::make_sphere(3.0).unwrap()] {
        edge_pairs_off(&body, &fission_kernel::edge_faces(&body), &mid(&body)).unwrap();
    }
    // Planted bugs, each caught by its own check: a pair swapped (the
    // loops), the loops' answer flipped on the body too (the geometry), an
    // edge with no pair, one pair missing, one face twice.
    let mut swapped = pairs.clone();
    swapped[e] = pairs[e].map(|[f, g]| [g, f]);
    assert!(edge_pairs_off(&b, &swapped, &mid(&b)).unwrap_err().contains("its loops say"));
    let mut flipped = b.clone();
    for face in &mut flipped.faces {
        for l in &mut face.loops {
            l.coedges.iter_mut().filter(|c| c.edge == e).for_each(|c| c.reversed = !c.reversed);
        }
    }
    assert!(edge_pairs_off(&flipped, &fission_kernel::edge_faces(&flipped), &mid(&flipped)).unwrap_err().contains("lies on its right"));
    let mut none = pairs.clone();
    none[e] = None;
    assert!(edge_pairs_off(&b, &none, &mid(&b)).unwrap_err().contains("joins no two faces"));
    assert!(edge_pairs_off(&b, &pairs[1..], &mid(&b)).unwrap_err().contains("11 edge pairs for 12 edges"));
    let mut twice = pairs.clone();
    twice[e] = Some([front, front]);
    assert!(edge_pairs_off(&b, &twice, &mid(&b)).unwrap_err().contains("its loops say"));
    // Placing keeps the pairs; a body whose pairs differ is caught.
    assert!(check_edge_pairs(&b, &flipped).unwrap_err().contains("changed which faces"));
    // The rounding allowance's edge: the forward face's centroid moved to
    // k × the allowance on the right of the edge is let through at 0.9 (the
    // other face decides) and caught at 1.1. With the centroid at m + x u,
    // u the unit left direction, the allowance is FP_REL (|x| + |m|), so
    // x = −k FP_REL |m| / (1 − k FP_REL).
    let f = pairs[e].unwrap()[0];
    let edge = &b.edges[e];
    let at = 0.5 * (edge.t0 + edge.t1);
    let (m, t) = (edge.curve.eval(at), edge.curve.tangent(at));
    let sense = if b.faces[f].sense { 1.0 } else { -1.0 };
    let u = (b.faces[f].surface.normal_at(m) * sense).cross(t).normalize();
    for (k, pass) in [(0.9, true), (1.1, false)] {
        let x = -k * tolerance::FP_REL * m.length() / (1.0 - k * tolerance::FP_REL);
        let mut moved = mid(&b);
        moved[f] = m + u * x;
        let got = edge_pairs_off(&b, &pairs, &moved);
        assert_eq!(got.is_ok(), pass, "{k}: {got:?}");
    }
    // Both centroids on the edge: neither decides, and that is reported.
    let mut both = mid(&b);
    let [f, g] = pairs[e].unwrap();
    (both[f], both[g]) = (m, m);
    assert!(edge_pairs_off(&b, &pairs, &both).unwrap_err().contains("neither face"));
    // seed5dc4: a side swept from an arc of radius 321 km closing to a
    // 1.1 µm gap; its centroid is 3e-10 mm left of the upright, within the
    // allowance, so the gap's line side decides.
    let outer = Boundary::Path { corners: vec![DVec2::new(0.0, 0.0), DVec2::new(0.0011, 0.0)], bulges: vec![-1168734181.6392605, 0.0] };
    let body = extrude::extrude(&Profile { outer, holes: vec![] }, 0.5).unwrap();
    edge_pairs_off(&body, &fission_kernel::edge_faces(&body), &mid(&body)).unwrap();
}

/// Issue #241 (seed29088d9f24f1): a 233.68 m × 116.84 m frame at
/// x = −100 km with walls 1 µm wide, extruded 1 µm. Exactly, with
/// fractions from the corners' doubles, each cap is outer − hole =
/// 701.0407900259959 mm² and the sides are both perimeters × 0.001 =
/// 1402.0806311239971 mm², 2804.162211175989 mm² in all. Re-centred, the
/// hole's two corners at y = 0.001 land 3.4e-12 off (y − 58420.03 rounds
/// at 58 m's scale), which takes 8.0e-7 off each cap: 2804.162209570956.
/// Each body's faces add up to its own area, both areas are their exact
/// values to MASS_PROPS_REL, but the faces of one against the area of the
/// other (the old reading) are 1.5e-9 apart, past the sums' 1e-9.
#[test]
fn a_thin_frame_far_out_adds_up_on_its_own_body() {
    let path = |pts: [(f64, f64); 4]| Boundary::Path { corners: pts.iter().map(|&(x, y)| DVec2::new(x, y)).collect(), bulges: vec![] };
    let outer = path([(-99999999.0, 0.0), (-99766318.89347933, 0.0), (-99766318.89347933, 116840.05326033363), (-99999999.0, 116840.05326033363)]);
    let hole = path([(-99999998.999, 0.001), (-99999998.999, 116840.05226033363), (-99766318.89447933, 116840.05226033363), (-99766318.89447933, 0.001)]);
    let raw = extrude::extrude(&Profile { outer, holes: vec![hole] }, 0.001).unwrap();
    let centred = Placed::new(raw.clone());
    assert!(!centred.placement.is_identity(), "far out, so re-centred");
    let sum = |b: &Body| face_masses(b).iter().map(|g| g.area).sum::<f64>();
    let area = |b: &Body| fission_kernel::mass::mass_properties(b).area;
    for (b, exact) in [(&raw, 2804.162211175989), (&centred.body, 2804.1622095709563)] {
        assert!(tolerance::measure_eq(sum(b), area(b), 1e-9 * area(b)), "{} vs {}", sum(b), area(b));
        assert!(tolerance::rel_eq(area(b), exact, tolerance::MASS_PROPS_REL), "{} vs {exact}", area(b));
    }
    let (faces, whole) = (sum(&raw), area(&centred.body));
    assert!(!tolerance::measure_eq(faces, whole, 1e-9 * whole), "{faces} vs {whole}");
}

fn mid(b: &Body) -> Vec<DVec3> {
    face_masses(b).iter().map(|m| m.centroid).collect()
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
    assert!(matches!(far.make(), Err(KernelError::InvalidInput { .. })));
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

#[test]
fn theta_minus_sin_keeps_its_digits_by_hand() {
    // θ − sin θ = θ³/6 − θ⁵/120 + …: at θ = 4e-5, 6.4e-14/6 − 1.024e-22/120
    // = 1.0666666666666667e-14 − 8.53e-25 = 1.06666666658133e-14 (40
    // digits: 1.066666666581333595e-14). Taken directly, 4e-5 − sin 4e-5
    // cancels all but ~6 digits.
    let got = theta_minus_sin(4e-5);
    assert!((got - 1.0666666665813336e-14).abs() <= 4.0 * f64::EPSILON * 1.07e-14, "{got:e}");
    // At 0.3 (series): 0.004479793338660424398 (40 digits). At the switch,
    // 0.5, the series and the direct difference agree, and either side of
    // it the sign is odd: −θ gives −(θ − sin θ).
    assert!((theta_minus_sin(0.3) - 0.004479793338660424).abs() <= 4.0 * f64::EPSILON * 0.0045);
    assert!((theta_minus_sin(0.5) - 0.0205744613957970).abs() <= 4.0 * f64::EPSILON * 0.0206);
    assert!((theta_minus_sin(0.5000001) - (0.5000001 - 0.5000001f64.sin())).abs() <= 1e-14 * 0.0206);
    assert_eq!(theta_minus_sin(-0.3), -theta_minus_sin(0.3));
}

#[test]
fn a_shallow_arcs_segment_centroid_by_hand() {
    // Issue #102. The chord (−1, 0) → (1, 0) and back over an arc of bulge
    // 1e-4: sagitta s = (c/2)·β = 1e-4 mm, radius c(1 + β²)/(4β) =
    // 5000.00005 mm. The cap is the segment alone: area ≈ (2/3)·c·s =
    // 1.3333e-4 mm², centroid on the y axis 2/5 of s above the chord,
    // 4e-5 mm, to first order. Integrated along the boundary by Green's
    // theorem at 50 digits: area 1.333333336000000060e-4, centroid
    // (0, 4.000000003428571606e-5). The old formula put the centroid
    // ~r·1e-8 = 4e-5 mm off, as far as the answer itself: f − sin f at
    // f = 4e-4 kept only ~8 digits.
    let shape = strip_with_bulges(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1e-4], 1.0);
    let model = face_model(&shape).unwrap();
    let &(_, area, c) = model.iter().find(|m| m.0 == FaceRole::Start).unwrap();
    assert!((area - 1.3333333360000001e-4).abs() <= 1e-12 * 1.34e-4, "{area:e}");
    assert!(c.distance(DVec3::new(0.0, 4.0000000034285716e-5, 0.0)) <= 1e-11, "{c}");
    // The random-testing case (seed8736e4b0b3df): a 10 mm strip 2 µm wide
    // with half-circle ends and a top bowed in by 5e-5 mm (r = 251 m). 50
    // digits: cap centroid (5.022398685642168736, −8.499016681667049586);
    // the old formula said y = −8.498580, 4.4e-4 mm off.
    let shape = strip_with_bulges(&[(0.0, -8.5), (0.0, -8.498), (10.044797371284337, -8.498), (10.044797371284337, -8.5)], &[-1.0, 1e-5, -1.0, -0.0], 0.5);
    let model = face_model(&shape).unwrap();
    let &(_, _, c) = model.iter().find(|m| m.0 == FaceRole::Start).unwrap();
    assert!(c.distance(DVec3::new(5.022398685642169, -8.49901668166705, 0.0)) <= 1e-9, "{c}");
}

#[test]
fn an_arc_walls_witness_by_hand() {
    // A pie slice: (0,0) → (1,0), a quarter circle round the origin to
    // (0,1), back to (0,0); bulge tan(π/8) turns π/2. Extruded 2 mm, the
    // arc's wall spans a quarter turn, so the witness for its upright at
    // (1, 0) is half the arc in: (√½, √½), at the upright's height 1.
    let piece = |pts: &[(f64, f64)], bulges: &[f64]| {
        let corners = pts.iter().map(|&(x, y)| DVec2::new(x, y)).collect();
        extrude::extrude(&Profile { outer: Boundary::Path { corners, bulges: bulges.to_vec() }, holes: vec![] }, 2.0).unwrap()
    };
    let wall = |b: &Body| b.faces.iter().position(|f| matches!(f.surface, Surface::Cylinder { .. })).unwrap();
    let pie = piece(&[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)], &[0.0, (PI / 8.0).tan(), 0.0]);
    let h = std::f64::consts::FRAC_1_SQRT_2;
    let w = arc_witness(&pie, wall(&pie), DVec3::new(1.0, 0.0, 1.0)).unwrap();
    assert!(w.distance(DVec3::new(h, h, 1.0)) <= 1e-12, "{w}");
    // A half disc ((−1,0) → (1,0), then bulge 1 back round the top): the
    // wall turns π, so from either upright it is a quarter turn in, (0, 1).
    let half = piece(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1.0]);
    for x in [1.0, -1.0] {
        let w = arc_witness(&half, wall(&half), DVec3::new(x, 0.0, 1.0)).unwrap();
        assert!(w.distance(DVec3::new(0.0, 1.0, 1.0)) <= 1e-12, "from {x}: {w}");
    }
    // Three quarters of a turn, (1, 0) round the origin to (0, −1), bulge
    // tan(3π/8), and the line back: from the upright at (1, 0) a quarter
    // turn in is (0, 1); from the one at (0, −1), (−1, 0). (A witness taken
    // from the wrong end would swap them.)
    let three = piece(&[(1.0, 0.0), (0.0, -1.0)], &[(3.0 * PI / 8.0).tan(), 0.0]);
    for (from, to) in [((1.0, 0.0), (0.0, 1.0)), ((0.0, -1.0), (-1.0, 0.0))] {
        let w = arc_witness(&three, wall(&three), DVec3::new(from.0, from.1, 1.0)).unwrap();
        assert!(w.distance(DVec3::new(to.0, to.1, 1.0)) <= 1e-12, "from {from:?}: {w}");
    }
    // A plane face has none.
    let plane = half.faces.iter().position(|f| matches!(f.role, Some(FaceRole::Side(_))) && matches!(f.surface, Surface::Plane { .. })).unwrap();
    assert!(arc_witness(&half, plane, DVec3::ZERO).is_none());
}

#[test]
fn walls_of_almost_a_full_turn_are_decided_by_their_witness() {
    // Issue #185 (seed3a9e29e38cd7): corners 1 µm apart, joined both ways
    // by arcs of almost a full turn, radii c(1 + β²)/(4|β|) = 4.6 m and
    // 27.5 m. Each wall's centroid is (1 − cos θ)/θ · r ≈ 2e-11 mm along
    // from an upright, inside left_bound's rounding, so the centroids
    // decide nothing there; each wall's witness is r along.
    let corners = vec![DVec2::new(-5.0, 0.0), DVec2::new(-4.999, 0.0)];
    let b = extrude::extrude(&Profile { outer: Boundary::Path { corners, bulges: vec![-18413340.805969886, 110000000.00000001] }, holes: vec![] }, 0.5).unwrap();
    let pairs = fission_kernel::edge_faces(&b);
    let centroids = mid(&b);
    let upright = (0..b.edges.len()).find(|&e| matches!(b.edges[e].curve, Curve::Line { .. })).unwrap();
    let edge = &b.edges[upright];
    let mid_t = 0.5 * (edge.t0 + edge.t1);
    let (m, t) = (edge.curve.eval(mid_t), edge.curve.tangent(mid_t));
    let [f, g] = pairs[upright].unwrap();
    for (face, along) in [(f, t), (g, -t)] {
        let n = b.faces[face].surface.normal_at(m) * if b.faces[face].sense { 1.0 } else { -1.0 };
        let left = (centroids[face] - m).dot(n.cross(along));
        assert!(left.abs() <= left_bound(centroids[face], m), "face {face}: centroid decides ({left:e})");
        let w = arc_witness(&b, face, m).unwrap();
        assert!((w - m).dot(n.cross(along)) > 4000.0, "face {face}: witness {w}");
    }
    edge_pairs_off(&b, &pairs, &centroids).unwrap();
    // Planted: the upright's coedges flipped on the body, so the loops say
    // the other wall walks it forwards. The witness catches it.
    let mut flipped = b.clone();
    for face in &mut flipped.faces {
        for l in &mut face.loops {
            l.coedges.iter_mut().filter(|c| c.edge == upright).for_each(|c| c.reversed = !c.reversed);
        }
    }
    let err = edge_pairs_off(&flipped, &fission_kernel::edge_faces(&flipped), &centroids).unwrap_err();
    assert!(err.contains(&format!("edge {upright}:")) && err.contains("lies on its right"), "{err}");
}

#[test]
fn the_oracle_is_given_the_outline_a_sketch_drew_by_hand() {
    // Issues #183, #184 (seed 67278701118011): a 1.1 µm chord 100 km out,
    // (−22.501324259437055, −99999999) to (−22.500224259437054, −99999999),
    // closed by an arc of bulge 349.26670850809774: chord c = 0.0011000000000010,
    // radius c(1 + β²)/(4β) = 0.0960491322037, sagitta βc/2 = 0.192096689680.
    // Drawn as a sketch arc round its centre, at y = −99999999 + s − r =
    // −99999998.903952442524 (40 digits), which the nearest double puts
    // 7.04e-9 lower. Moving the centre down by δ shortens both r and the
    // centre's height over the chord by δ, so the sagitta the outline works
    // out, (centre − m)·n + r, by 2δ: the bulge by 2δ/s = 7.33e-8 of itself,
    // to 349.26668292259035, and the area (~πr²) by 2δ/r = 1.47e-7. The
    // kernel's volume is the outline's to rounding; OpenCascade and the
    // exact referee were given the harness's bulge instead.
    let shape = Shape::Extrude {
        outer: Ring::curved(vec![DVec2::new(-22.501324259437055, -99999999.0), DVec2::new(-22.500224259437054, -99999999.0)], vec![-349.26670850809774, 0.0]),
        holes: vec![],
        dist: Num(61.5),
        expect: Some(true),
        sketch: Some(11386601276301485740),
    };
    let built = oracle_shape(&shape);
    let Shape::Extrude { outer: Ring::Path { pts, bulges }, holes, dist, .. } = &built else { panic!("{built:?}") };
    assert!(holes.is_empty() && dist.0 == 61.5);
    assert_eq!(bulges.iter().map(|b| b.0).collect::<Vec<_>>(), [0.0, 349.26668292259035]);
    assert_eq!(pts.iter().map(p2).collect::<Vec<_>>(), [DVec2::new(-22.501324259437055, -99999999.0), DVec2::new(-22.500224259437054, -99999999.0)]);
    let Ok(sketch::SketchOutline::Closed(profile, _)) = sketched(&shape).unwrap().outline() else { panic!() };
    let volume = fission_kernel::mass::mass_properties(&extrude::extrude(&profile, 61.5).unwrap()).volume;
    let cap = |s: &Shape| face_model(s).unwrap().iter().find(|m| m.0 == FaceRole::Start).unwrap().1 * 61.5;
    assert!((volume - cap(&built)).abs() <= 1e-12 * volume, "{volume} vs the outline's {}", cap(&built));
    let off = (volume - cap(&shape)).abs() / volume;
    assert!((1.4e-7..1.5e-7).contains(&off), "the harness's own bulge is {off:e} off");
    // The oracle's line for that part carries the outline.
    let body = extrude::extrude(&profile, 61.5).unwrap();
    let mut slot = placed_slot(&body, Placed::new(body.clone()), glam::DAffine3::IDENTITY, 1);
    slot.shape = shape.clone();
    let line: serde_json::Value = serde_json::from_str(oracle_lines(&[slot]).trim()).unwrap();
    assert_eq!(line["shape"]["Extrude"]["outer"]["Path"]["bulges"], serde_json::json!(["0.0", "349.26668292259035"]), "{line}");
    // A shape not drawn as a sketch, or one whose drawing doesn't close, is
    // given as it is.
    let mut plain = shape.clone();
    if let Shape::Extrude { sketch, .. } = &mut plain {
        *sketch = None;
    }
    assert_eq!(oracle_shape(&plain), plain);
    let boxed = Shape::Box { w: Num(1.0), d: Num(2.0), h: Num(3.0) };
    assert_eq!(oracle_shape(&boxed), boxed);
}

#[test]
fn the_oracle_is_given_each_body_as_a_step_file_of_where_it_is() {
    // A 1 × 2 × 3 box moved by (100000, 0, 0): its file is the writer's file
    // of the placed body, so its first corner, (0,0,0) before the move, is
    // written as (100000.0, 0.0, 0.0).
    let base = primitives::make_box(1.0, 2.0, 3.0).unwrap();
    let moved = transform::translate(&Placed::new(base.clone()), DVec3::new(100_000.0, 0.0, 0.0)).unwrap();
    let slot = placed_slot(&base, moved.clone(), glam::DAffine3::from_translation(DVec3::new(100_000.0, 0.0, 0.0)), 1);
    let line: serde_json::Value = serde_json::from_str(oracle_lines(&[slot]).trim()).unwrap();
    let step = line["step"].as_str().unwrap();
    assert_eq!(step, step_write::write(&moved.baked()).unwrap());
    assert!(step.contains("CARTESIAN_POINT('',(100000.0,0.0,0.0))"), "{step}");
    assert!(line["step_refused"].is_null(), "{line}");
}

#[test]
fn a_body_the_writer_refuses_reaches_the_oracle_as_a_refusal() {
    // The oracle must hear about a refusal (compare.py counts it as a
    // finding), not lose the body: a box with one face turned inside out
    // fails validate, so the writer refuses it with words. (The harness
    // never hands oracle_lines an invalid body, so this is step_file alone.)
    let mut base = primitives::make_box(1.0, 1.0, 1.0).unwrap();
    base.faces[0].sense = !base.faces[0].sense;
    let (step, why) = step_file(&base);
    assert!(step.is_none());
    assert_eq!(why.unwrap(), step_write::write(&base).unwrap_err().to_string());
    let (step, why) = step_file(&primitives::make_box(1.0, 1.0, 1.0).unwrap());
    assert!(step.is_some() && why.is_none());
}

#[test]
fn the_planted_step_fault_flips_one_face_and_nothing_else() {
    // FISSION_STEP_FAULT's flip: exactly one line differs, the first
    // ADVANCED_FACE, whose last argument (same_sense) swaps .T. and .F.;
    // flipping again gives the file back.
    let text = step_write::write(&primitives::make_box(1.0, 1.0, 1.0).unwrap()).unwrap();
    let flipped = flip_first_face(&text);
    let diff: Vec<(&str, &str)> = text.lines().zip(flipped.lines()).filter(|(a, b)| a != b).collect();
    assert_eq!(text.lines().count(), flipped.lines().count());
    assert_eq!(diff.len(), 1, "{diff:?}");
    let (was, now) = diff[0];
    let first = text.lines().find(|l| l.contains("= ADVANCED_FACE(")).unwrap();
    assert_eq!(was, first);
    let swap = |l: &str| if let Some(h) = l.strip_suffix(",.T.);") { format!("{h},.F.);") } else { format!("{},.T.);", l.strip_suffix(",.F.);").unwrap()) };
    assert_eq!(now, swap(was));
    assert_eq!(flip_first_face(&flipped), text);
}
