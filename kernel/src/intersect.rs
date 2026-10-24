//! Where the kernel's curves and surfaces meet: lines and circles against
//! planes, cylinders and spheres, against each other, and the closed curves
//! where two surfaces cross.
//!
//! Every function here proposes candidate points (or curve parameters). It
//! never decides on its own that two things touch: the caller measures each
//! candidate (its distance to both, and where it lies on their faces or
//! edges) and only that decides. So a candidate may be a little off, or
//! not a meeting at all, without harm; what matters is that every meeting
//! gets a candidate. Near-misses get one too (the closest approach), so a
//! touch within tolerance is measured rather than missed.
//!
//! Where a meeting point is already known (two edges or an edge and a face
//! sharing a vertex), it is divided out ("deflated") and only the others
//! are proposed. A tangent join, like a slot's straight side meeting its
//! round end, is then a known root rather than a cluster of near-roots that
//! stay within tolerance for millimetres when the radius is kilometres.
//!
//! Known limit: one near-double root (a near-tangency) costs `trig_zeros`
//! ~13,000 of its MAX_ZERO_EVALS = 20,000 evaluations, so a polynomial with
//! two of them runs out of budget, and a close pair of zeros can then be
//! proposed as one point. The cost stays bounded; the caller's measuring
//! still sees the proposed point.
//!
//! Mutation testing (`cargo mutants -f src/intersect.rs`) leaves these
//! survivors, all equivalent (no input can tell them apart):
//! - `s > 1` → `s >= 1` in `trig1_zeros`: s = 1 is taken by the branch
//!   before (|s| ≤ 1).
//! - `||` → `&&` in `bisect`'s stop test, which only ends the loop early:
//!   once a and b are neighbouring doubles, every further step leaves them
//!   as they are (the midpoint rounds to one of them, where f's sign is
//!   already known and not 0), and the 80-step cap ends it with the same
//!   answer.
//! - `b − a` → `b + a` or `b / a` in `grid_steps`: 64 steps where the
//!   real count is fewer, which is only in a run narrower than
//!   63·LEAF_WIDTH, and such a run holds at most one zero. (Two zeros
//!   s ≤ 6.3e-5 apart have a turning point between them where |f| ≤
//!   slope_bound·s²/4 ≈ 1e-9·slope_bound; as |f″| ≤ 2·slope_bound, |f|
//!   stays under a leaf's bound, slope_bound·LEAF_WIDTH/2 or so, for
//!   ~6e-4 either side, so their run is that wide.) Both grids then see
//!   the one sign change, and bisect it to the same zero, up to the
//!   rounding noise where f's computed sign flips back and forth: checked
//!   on 20,000 polynomials (random, near-tangent and with near-double
//!   zeros), the same number of zeros every time, 141 of ~40,000 differing
//!   in value, by at most 1.3e-14 rad.
//!
//! The circles walked round (the plane–cylinder ellipse, `around_cylinder`,
//! `circle_points`) are evaluated by `Curve::eval`, and the part of a
//! vector across an axis by `across`, each tested wherever it is used:
//! written out in place, a slip in them (walking a circle the other way
//! round, or mirrored, or a centred ball taken for an off-centre one) would
//! only change which points of the same curves are proposed, and go
//! unseen.

use crate::fmath;
use crate::geom::{Curve, Surface};
use crate::tolerance::{ANGULAR, LINEAR};
use glam::DVec3;
use std::f64::consts::{PI, TAU};

/// f(θ) = k0 + k1 cos θ + k2 sin θ + k3 cos 2θ + k4 sin 2θ, a trigonometric
/// polynomial of degree 2. Distances (squared) from a point moving round a
/// circle to a cylinder's axis have this form, and so do the discriminants
/// of surface intersections parametrised round a cylinder.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trig2(pub [f64; 5]);

/// Samples used by `Trig2::fit`: 8 equally spaced angles determine every
/// harmonic up to the third exactly, so a degree-2 polynomial is recovered.
const FIT_SAMPLES: usize = 8;

/// Width (radians) below which `trig_zeros` stops splitting an interval it
/// cannot rule out and refines the zero inside it instead.
const LEAF_WIDTH: f64 = 1e-6;

/// Most evaluations `trig_zeros` spends ruling intervals out. Ordinary
/// polynomials need a few hundred; one that is nearly zero everywhere (two
/// almost coincident surfaces) would need millions, so it stops here and
/// proposes what is left. Bounds the cost for every input.
const MAX_ZERO_EVALS: usize = 20_000;

/// Points proposed round each closed intersection curve.
const RING_SAMPLES: usize = 8;

impl Trig2 {
    pub fn eval(&self, t: f64) -> f64 {
        let [k0, k1, k2, k3, k4] = self.0;
        k0 + k1 * fmath::cos(t) + k2 * fmath::sin(t) + k3 * fmath::cos(2.0 * t) + k4 * fmath::sin(2.0 * t)
    }

    /// f′: cos → −sin, sin → cos, and the double angles double.
    pub fn derivative(&self) -> Trig2 {
        let [_, k1, k2, k3, k4] = self.0;
        Trig2([0.0, k2, -k1, 2.0 * k4, -2.0 * k3])
    }

    /// The most |f′| can be: |k1| + |k2| + 2(|k3| + |k4|).
    pub fn slope_bound(&self) -> f64 {
        let [_, k1, k2, k3, k4] = self.0;
        k1.abs() + k2.abs() + 2.0 * (k3.abs() + k4.abs())
    }

    /// The coefficients of a function known to be of this form, from its
    /// values at 8 equally spaced angles (a discrete Fourier transform).
    pub fn fit(f: impl Fn(f64) -> f64) -> Trig2 {
        let n = FIT_SAMPLES as f64;
        let mut k = [0.0; 5];
        for j in 0..FIT_SAMPLES {
            let t = TAU * j as f64 / n;
            let v = f(t);
            k[0] += v / n;
            k[1] += 2.0 * v * fmath::cos(t) / n;
            k[2] += 2.0 * v * fmath::sin(t) / n;
            k[3] += 2.0 * v * fmath::cos(2.0 * t) / n;
            k[4] += 2.0 * v * fmath::sin(2.0 * t) / n;
        }
        Trig2(k)
    }
}

/// Angles in [0, 2π) where f may be zero or nearly so: every zero of f, and
/// the smallest |f| wherever f comes close to zero without crossing it.
///
/// An interval [a, b] is ruled out when |f(mid)| exceeds the most f can
/// change over half its width (slope_bound · (b − a)/2): then f has no zero
/// in it. Others are split until LEAF_WIDTH wide; runs of neighbouring
/// leaves are then refined, by bisection where f changes sign and by
/// golden-section search for the smallest |f| where it doesn't.
pub fn trig_zeros(f: &Trig2) -> Vec<f64> {
    trig_zeros_counted(f).0
}

/// `trig_zeros`, and how many evaluations it spent ruling intervals out.
fn trig_zeros_counted(f: &Trig2) -> (Vec<f64>, usize) {
    let slope = f.slope_bound();
    if slope == 0.0 {
        // Constant: zero everywhere or nowhere; callers handle "everywhere"
        // (a curve lying in a surface) before asking.
        return (vec![], 0);
    }
    let mut leaves: Vec<(f64, f64)> = Vec::new();
    let mut evals = 0usize;
    let mut stack: Vec<(f64, f64)> = (0..64).rev().map(|i| (TAU * i as f64 / 64.0, TAU * (i + 1) as f64 / 64.0)).collect();
    while let Some((a, b)) = stack.pop() {
        let mid = 0.5 * (a + b);
        evals += 1;
        if f.eval(mid).abs() > slope * (b - a) / 2.0 {
            continue;
        }
        if b - a <= LEAF_WIDTH || evals >= MAX_ZERO_EVALS {
            leaves.push((a, b));
        } else {
            // Right half first so the left is popped first: leaves come out
            // in increasing order.
            stack.push((mid, b));
            stack.push((a, mid));
        }
    }
    // Neighbouring leaves form one run.
    let mut runs: Vec<(f64, f64)> = Vec::new();
    for (a, b) in leaves {
        match runs.last_mut() {
            Some(run) if a <= run.1 => run.1 = b,
            _ => runs.push((a, b)),
        }
    }
    let mut out = Vec::new();
    for (a, b) in runs {
        let mut found = false;
        // Look for sign changes on a fine grid across the run.
        let steps = grid_steps(a, b);
        let mut prev = (a, f.eval(a));
        for i in 1..=steps {
            let t = a + (b - a) * i as f64 / steps as f64;
            let v = f.eval(t);
            if prev.1 == 0.0 {
                out.push(prev.0);
                found = true;
            } else if prev.1.signum() != v.signum() && v != 0.0 {
                out.push(bisect(f, prev.0, t));
                found = true;
            }
            prev = (t, v);
        }
        if prev.1 == 0.0 {
            out.push(prev.0);
            found = true;
        }
        if !found {
            out.push(golden_min_abs(f, a, b));
        }
    }
    (out.iter().map(|t| t.rem_euclid(TAU)).collect(), evals)
}

/// Steps of the grid `trig_zeros` lays across a run [a, b] to look for
/// sign changes: at most LEAF_WIDTH apart, but no more than 64.
fn grid_steps(a: f64, b: f64) -> usize {
    (((b - a) / LEAF_WIDTH).ceil() as usize).clamp(1, 64)
}

/// A zero of f between a and b, where f(a) and f(b) differ in sign.
fn bisect(f: &Trig2, mut a: f64, mut b: f64) -> f64 {
    let fa = f.eval(a);
    for _ in 0..80 {
        let m = 0.5 * (a + b);
        if m <= a || m >= b {
            break;
        }
        let fm = f.eval(m);
        if fm == 0.0 {
            return m;
        }
        if fm.signum() == fa.signum() {
            a = m;
        } else {
            b = m;
        }
    }
    0.5 * (a + b)
}

/// Where |f| is smallest on [a, b] (golden-section search; |f| has one dip
/// across a run this narrow).
fn golden_min_abs(f: &Trig2, mut a: f64, mut b: f64) -> f64 {
    let g = (5f64.sqrt() - 1.0) / 2.0;
    for _ in 0..80 {
        let (x1, x2) = (b - g * (b - a), a + g * (b - a));
        if f.eval(x1).abs() <= f.eval(x2).abs() {
            b = x2;
        } else {
            a = x1;
        }
    }
    0.5 * (a + b)
}

/// Angles where f(θ) = a + b cos θ + c sin θ is zero, or, if it never is,
/// where |f| is least. Writing b cos θ + c sin θ = m cos(θ − φ), m = |(b, c)|,
/// φ = atan2(c, b): zeros at φ ± acos(−a/m). Given a zero `known`, the
/// other is its mirror image in φ: 2φ − known.
fn trig1_zeros(a: f64, b: f64, c: f64, known: Option<f64>) -> Vec<f64> {
    let m = fmath::hypot(b, c);
    if m == 0.0 {
        return vec![];
    }
    let phi = fmath::atan2(c, b);
    if let Some(k) = known {
        return vec![2.0 * phi - k];
    }
    let s = -a / m;
    if s.abs() <= 1.0 {
        let d = fmath::acos(s);
        vec![phi + d, phi - d]
    } else if s > 1.0 {
        vec![phi]
    } else {
        vec![phi + PI]
    }
}

/// Parameters where t² + 2bt + c = 0, or, with no real roots, where it is
/// least (t = −b). Given a root `known`, the other is −2b − known (the
/// roots sum to −2b). Computed without cancellation: q = −(b + sign(b)√d),
/// roots q and c/q.
fn quadratic(b: f64, c: f64, known: Option<f64>) -> Vec<f64> {
    if let Some(k) = known {
        return vec![-2.0 * b - k];
    }
    let d = b * b - c;
    if d < 0.0 {
        return vec![-b];
    }
    let q = -(b + b.signum() * d.sqrt());
    if q == 0.0 {
        return vec![0.0];
    }
    vec![q, c / q]
}

fn circle_frame(axis: DVec3, x_dir: DVec3) -> (DVec3, DVec3) {
    (x_dir, axis.cross(x_dir))
}

/// Parameters along `curve` where it may meet `surface`, as described at
/// the top. `known` lists parameters of points already known to be on
/// both (at most two). Not for a curve lying in the surface: the caller
/// checks that first, and asks where the curve lies instead.
pub fn curve_surface(curve: &Curve, surface: &Surface, known: &[f64]) -> Vec<f64> {
    match (curve.clone(), surface.clone()) {
        (Curve::Line { origin, dir }, Surface::Plane { origin: po, normal, .. }) => {
            let dn = dir.dot(normal);
            if dn.abs() <= ANGULAR || !known.is_empty() {
                // Parallel (and not in it), or its one meeting is known.
                return vec![];
            }
            vec![-(origin - po).dot(normal) / dn]
        }
        (Curve::Line { origin, dir }, Surface::Cylinder { origin: c, axis, radius, .. }) => {
            // |o⊥ + t d⊥|² = r², with ⊥ the part across the axis:
            // A t² + 2B t + C = 0, A = |d⊥|², B = o⊥·d⊥, C = |o⊥|² − r².
            let d = dir - axis * dir.dot(axis);
            let o = (origin - c) - axis * (origin - c).dot(axis);
            let a = d.length_squared();
            if a <= ANGULAR * ANGULAR {
                return vec![];
            }
            line_quadratic(o.dot(d) / a, (o.length_squared() - radius * radius) / a, known)
        }
        (Curve::Line { origin, dir }, Surface::Sphere { center, radius, .. }) => {
            // |o + t d − s|² = R² with |d| = 1: t² + 2B t + C = 0.
            let o = origin - center;
            line_quadratic(o.dot(dir), o.length_squared() - radius * radius, known)
        }
        (Curve::Circle { center, axis, x_dir, radius: rho }, Surface::Plane { origin: po, normal, .. }) => {
            // n·(P(θ) − o) = n·(c − o) + ρ n·x cos θ + ρ n·y sin θ.
            let (x, y) = circle_frame(axis, x_dir);
            circle_trig1(normal.dot(center - po), rho * normal.dot(x), rho * normal.dot(y), known)
        }
        (Curve::Circle { center, axis, x_dir, radius: rho }, Surface::Sphere { center: s, radius, .. }) => {
            // |P(θ) − s|² − R² = |c − s|² + ρ² − R² + 2ρ(c − s)·x cos θ + 2ρ(c − s)·y sin θ.
            let (x, y) = circle_frame(axis, x_dir);
            let w = center - s;
            let a = (w.length() - radius) * (w.length() + radius) + rho * rho;
            circle_trig1(a, 2.0 * rho * w.dot(x), 2.0 * rho * w.dot(y), known)
        }
        (Curve::Circle { center, axis, x_dir, radius: rho }, Surface::Cylinder { origin: c, axis: a, radius, .. }) => {
            let (x, y) = circle_frame(axis, x_dir);
            let w = across(center - c, a);
            if axis.cross(a).length() <= ANGULAR {
                // The circle lies across the axis: in its plane, the
                // cylinder is a circle about the axis, and
                // |w + ρ(x cos θ + y sin θ)|² − r² = |w|² + ρ² − r² + 2ρ w·x cos θ + 2ρ w·y sin θ.
                let a0 = (w.length() - radius) * (w.length() + radius) + rho * rho;
                return circle_trig1(a0, 2.0 * rho * w.dot(x), 2.0 * rho * w.dot(y), known);
            }
            // Tilted: the squared distance to the axis is a degree-2
            // trigonometric polynomial in θ. No deflation here: a shared
            // vertex's own candidates are dropped by the caller's distance
            // test. (No body can have such a pair until booleans.)
            let (xa, ya) = (across(x, a), across(y, a));
            let f = Trig2::fit(|t| (w + (xa * fmath::cos(t) + ya * fmath::sin(t)) * rho).length_squared() - radius * radius);
            trig_zeros(&f)
        }
    }
}

/// The part of v across a unit axis (less its part along it).
fn across(v: DVec3, axis: DVec3) -> DVec3 {
    v - axis * v.dot(axis)
}

fn line_quadratic(b: f64, c: f64, known: &[f64]) -> Vec<f64> {
    match known {
        [] => quadratic(b, c, None),
        [k] => quadratic(b, c, Some(*k)),
        _ => vec![],
    }
}

fn circle_trig1(a: f64, b: f64, c: f64, known: &[f64]) -> Vec<f64> {
    match known {
        [] => trig1_zeros(a, b, c, None),
        [k] => trig1_zeros(a, b, c, Some(*k)),
        _ => vec![],
    }
}

/// Points on `a` where it may meet `b` (unbounded curves), as described at
/// the top. `known` lists points already known to be on both. Curves lying
/// on one another are the caller's to handle (it compares the edges'
/// ends and middles instead).
pub fn curve_curve(a: &Curve, b: &Curve, known: &[DVec3]) -> Vec<DVec3> {
    match (a.clone(), b.clone()) {
        (Curve::Line { origin: o1, dir: d1 }, Curve::Line { origin: o2, dir: d2 }) => {
            // Closest points of two skew lines; they meet only there, so a
            // known meeting point is the only one.
            let n = d1.cross(d2);
            if n.length() <= ANGULAR || !known.is_empty() {
                return vec![];
            }
            // (o1 + s d1 − o2 − u d2) is perpendicular to both directions:
            // s = ((o2 − o1) × d2)·n / |n|².
            let s = (o2 - o1).cross(d2).dot(n) / n.length_squared();
            vec![o1 + d1 * s]
        }
        (Curve::Line { .. }, Curve::Circle { .. }) => curve_curve(b, a, known),
        (Curve::Circle { center: c, axis: z, radius: rho, .. }, Curve::Line { origin: o, dir: d }) => {
            if d.dot(z).abs() <= ANGULAR {
                if (o - c).dot(z).abs() > LINEAR {
                    return vec![]; // parallel to the circle's plane, off it
                }
                // In the plane: s² + 2(o − c)·d s + |o − c|² − ρ² = 0.
                let oc = o - c;
                let ks: Vec<f64> = known.iter().map(|k| (*k - o).dot(d)).collect();
                let cc = (oc.length() - rho) * (oc.length() + rho);
                return line_quadratic(oc.dot(d), cc, &ks).into_iter().map(|s| o + d * s).collect();
            }
            if !known.is_empty() {
                return vec![]; // it crosses the plane once, at the known point
            }
            vec![o + d * (-(o - c).dot(z) / d.dot(z))]
        }
        (Curve::Circle { center: c1, axis: z1, radius: r1, .. }, Curve::Circle { center: c2, axis: z2, radius: r2, .. }) => {
            if z1.cross(z2).length() <= ANGULAR {
                if (c2 - c1).dot(z1).abs() > LINEAR {
                    return vec![]; // parallel planes
                }
                return coplanar_circles(c1, z1, r1, c2, r2, known);
            }
            // The planes meet in a line L: from c1, across plane 1 along
            // m = z1 × l to plane 2, then along l.
            let l = z1.cross(z2).normalize();
            let m = z1.cross(l);
            let q = c1 + m * ((c2 - c1).dot(z2) / m.dot(z2));
            let mut out = Vec::new();
            for (c, r) in [(c1, r1), (c2, r2)] {
                // |q + σ l − c|² = r²: σ² + 2(q − c)·l σ + |q − c|² − r² = 0.
                let qc = q - c;
                let ks: Vec<f64> = known.iter().map(|k| (*k - q).dot(l)).collect();
                let cc = (qc.length() - r) * (qc.length() + r);
                out.extend(line_quadratic(qc.dot(l), cc, &ks).into_iter().map(|s| q + l * s));
            }
            out
        }
    }
}

/// Two circles in one plane (normal z): the points they share, or where
/// they come closest. Given a shared point, the other is its mirror image
/// in the line through both centres.
fn coplanar_circles(c1: DVec3, z: DVec3, r1: f64, c2: DVec3, r2: f64, known: &[DVec3]) -> Vec<DVec3> {
    let dist = c1.distance(c2);
    if dist <= LINEAR {
        return vec![]; // concentric: never meet, or are one circle
    }
    let u = (c2 - c1) / dist;
    match known {
        [] => {
            // Along u, the common chord is at x = (D² + r1² − r2²)/(2D) from c1.
            let x = (dist * dist + (r1 - r2) * (r1 + r2)) / (2.0 * dist);
            let h2 = (r1 - x) * (r1 + x);
            let v = z.cross(u);
            if h2 <= 0.0 {
                // Apart or nested: closest along the line of centres.
                return vec![c1 + u * r1, c1 - u * r1];
            }
            let h = h2.sqrt();
            vec![c1 + u * x + v * h, c1 + u * x - v * h]
        }
        [k] => {
            let r = *k - c1;
            vec![c1 + u * (2.0 * r.dot(u)) - r]
        }
        _ => vec![],
    }
}

/// Points where two surfaces may meet along a closed curve, or touch at a
/// point: a few on each closed curve of their intersection. Open
/// intersection curves (lines) are not sampled: a line crossing a face
/// must leave it through an edge, which the edge checks see. Coincident
/// surfaces give none (the edge checks handle overlapping faces).
pub fn closed_meetings(a: &Surface, b: &Surface) -> Vec<DVec3> {
    use Surface::*;
    match (a.clone(), b.clone()) {
        (Plane { .. }, Plane { .. }) => vec![],
        (Cylinder { .. } | Sphere { .. }, Plane { .. }) | (Sphere { .. }, Cylinder { .. }) => closed_meetings(b, a),
        (Plane { origin: po, normal: n, .. }, Cylinder { origin: c, axis, x_dir, radius }) => {
            let na = n.dot(axis);
            if na.abs() <= ANGULAR {
                return vec![]; // parallel to the axis: lines
            }
            // An ellipse: over the point p(θ) = c + r w(θ) of the
            // cylinder's circle at its origin, the height h with
            // n·(p(θ) + h a − o) = 0.
            let base = Curve::Circle { center: c, axis, x_dir, radius };
            ring(|t| {
                let p = base.eval(t);
                p + axis * (-(n.dot(p - po)) / na)
            })
        }
        (Plane { origin: po, normal: n, .. }, Sphere { center, radius, .. }) => {
            let d = n.dot(center - po);
            let foot = center - n * d;
            let rho2 = (radius - d.abs()) * (radius + d.abs());
            if rho2 <= 0.0 {
                return vec![foot]; // touching (or apart: the caller measures)
            }
            circle_points(foot, n, rho2.sqrt())
        }
        (Sphere { center: c1, radius: r1, .. }, Sphere { center: c2, radius: r2, .. }) => {
            let dist = c1.distance(c2);
            if dist <= LINEAR {
                return vec![];
            }
            let u = (c2 - c1) / dist;
            let x = (dist * dist + (r1 - r2) * (r1 + r2)) / (2.0 * dist);
            let rho2 = (r1 - x) * (r1 + x);
            if rho2 <= 0.0 {
                // Touching or apart: the nearest point of sphere 1 to c2
                // (or the farthest, for one inside the other).
                return vec![c1 + u * r1, c1 - u * r1];
            }
            circle_points(c1 + u * x, u, rho2.sqrt())
        }
        (Cylinder { origin: c, axis, x_dir, radius }, Sphere { center: s, radius: big_r, .. }) => {
            let sc = s - c;
            let (off, h0) = (across(sc, axis), sc.dot(axis));
            if off.length() <= LINEAR {
                // Centre on the axis: circles at h0 ± √(R² − r²).
                let d2 = (big_r - radius) * (big_r + radius);
                let hs = if d2 <= 0.0 { vec![h0] } else { vec![h0 + d2.sqrt(), h0 - d2.sqrt()] };
                return hs.into_iter().flat_map(|h| circle_points(c + axis * h, axis, radius)).collect();
            }
            // Over angle θ: h² + 2Bh + C = 0 with d = c + r w(θ) − s,
            // B = a·d, C = |d|² − R².
            let base = Curve::Circle { center: c, axis, x_dir, radius };
            around_cylinder(&base, axis, |d| (d.dot(axis), d.length_squared() - big_r * big_r), s)
        }
        (Cylinder { origin: c1, axis: a1, x_dir, radius: r1 }, Cylinder { origin: c2, axis: a2, radius: r2, .. }) => {
            let e = a1 - a2 * a1.dot(a2);
            let e2 = e.length_squared();
            if e2 <= ANGULAR * ANGULAR {
                return vec![]; // parallel axes: lines, or one cylinder
            }
            // A point c1 + r1 w(θ) + h a1 is at distance r2 from axis 2 when
            // |d⊥ + h e|² = r2², d = c1 + r1 w − c2, ⊥ across a2, e = a1⊥:
            // h² + 2Bh + C = 0, B = d⊥·e/|e|², C = (|d⊥|² − r2²)/|e|².
            let base = Curve::Circle { center: c1, axis: a1, x_dir, radius: r1 };
            around_cylinder(
                &base,
                a1,
                |d| {
                    let dp = d - a2 * d.dot(a2);
                    (dp.dot(e) / e2, (dp.length() - r2) * (dp.length() + r2) / e2)
                },
                c2,
            )
        }
    }
}

/// Points round a cylinder (axis a) on the curve where h² + 2B h + C = 0,
/// with (B, C) = coeffs(p(θ) − other) at each point p(θ) = c + r w(θ) of
/// `base`, the cylinder's circle at its origin c. The discriminant D(θ) = B² − C is ≥ 0 on each closed
/// piece of the curve, and every piece that is not a whole loop round the
/// cylinder holds a maximum of D, so the angles proposed are D's turning
/// points plus fixed angles (for loops round the cylinder); at each, both
/// heights −B ± √D, or −B, where the surfaces come closest, if D < 0.
fn around_cylinder(base: &Curve, a: DVec3, coeffs: impl Fn(DVec3) -> (f64, f64), other: DVec3) -> Vec<DVec3> {
    let disc = |t: f64| {
        let (b, cc) = coeffs(base.eval(t) - other);
        b * b - cc
    };
    let d = Trig2::fit(disc);
    let mut angles = trig_zeros(&d.derivative());
    angles.extend((0..RING_SAMPLES).map(|i| TAU * i as f64 / RING_SAMPLES as f64));
    let mut out = Vec::new();
    for t in angles {
        let p = base.eval(t);
        let (b, cc) = coeffs(p - other);
        for h in quadratic(b, cc, None) {
            out.push(p + a * h);
        }
    }
    out
}

/// RING_SAMPLES points of the circle with this centre, normal and radius.
fn circle_points(center: DVec3, normal: DVec3, radius: f64) -> Vec<DVec3> {
    let circle = Curve::Circle { center, axis: normal, x_dir: crate::geom::any_perpendicular(normal), radius };
    ring(|t| circle.eval(t))
}

fn ring(p: impl Fn(f64) -> DVec3) -> Vec<DVec3> {
    (0..RING_SAMPLES).map(|i| p(TAU * i as f64 / RING_SAMPLES as f64)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::MAX_SIZE;
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_3};

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn the_modelling_range_leaves_room_for_rounding() {
        // The range (MAX_SIZE) and tolerance (LINEAR) were chosen from
        // examples/precision_budget.rs; this keeps them honest if either
        // changes. Random lines and circles crossing planes, cylinders and
        // spheres, all about MAX_SIZE across, near their own origin (a
        // body's local frame). A found meeting must lie within LINEAR/10 of
        // the surface, leaving room for the several intersections a boolean
        // chains. Along the curve a point is only known to d / sin(angle):
        // crossings steeper than 0.6° (sin > 0.01) must stay within
        // LINEAR/10 too, and 0.06° to 0.6° within LINEAR. Measured here
        // (4842 meetings): 7.5e-9, 3.5e-8 and 3.9e-6, so shallow crossings
        // have only ~2.5× headroom and booleans must treat them with care.
        // This fails for 10 nm at 10 km (shallow 3.1e-5), 1 nm at 1 km
        // (shallow 3.9e-6) and 1 nm at 10 km (steep 6.3e-7). Shallower
        // crossings need tangent handling, whatever the tolerance (step 36).
        let mut seed = 0x5eedu64;
        let mut f = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut unit = || loop {
            let v = DVec3::new(f() * 2.0 - 1.0, f() * 2.0 - 1.0, f() * 2.0 - 1.0);
            if v.length() > 0.1 && v.length() < 1.0 {
                return v.normalize();
            }
        };
        let size = MAX_SIZE;
        let (mut worst, mut steep, mut shallow, mut meetings) = (0.0f64, 0.0f64, 0.0f64, 0);
        for i in 0..3000 {
            let (a, b) = (unit(), unit());
            let (pa, pb) = (a.cross(unit()).normalize(), b.cross(unit()).normalize());
            let (p, c, k) = (unit() * size * 0.3, unit() * size * 0.3, 0.2 + (i % 7) as f64 / 7.0);
            let curve = if i % 2 == 0 {
                Curve::Line { origin: p, dir: a }
            } else {
                Curve::Circle { center: p, axis: a, x_dir: pa, radius: size * k }
            };
            let surface = match i % 3 {
                0 => Surface::Plane { origin: c, normal: b, x_dir: pb },
                1 => Surface::Cylinder { origin: c, axis: b, x_dir: pb, radius: size * k },
                _ => Surface::Sphere { center: c, axis: b, x_dir: pb, radius: size * k },
            };
            for t in curve_surface(&curve, &surface, &[]) {
                let x = curve.eval(t);
                let d = surface.distance(x);
                if d >= size * 1e-9 {
                    continue; // a near miss's closest approach, not a meeting
                }
                meetings += 1;
                worst = worst.max(d);
                let speed = match curve {
                    Curve::Line { .. } => 1.0,
                    Curve::Circle { radius, .. } => radius,
                };
                let h = 1e-6 * size / speed;
                let tangent = (curve.eval(t + h) - curve.eval(t - h)).normalize();
                let normal = match &surface {
                    Surface::Plane { normal, .. } => *normal,
                    Surface::Cylinder { origin, axis, .. } => {
                        let q = x - *origin;
                        (q - *axis * q.dot(*axis)).normalize()
                    }
                    Surface::Sphere { center, .. } => (x - *center).normalize(),
                };
                let sin = tangent.dot(normal).abs();
                if sin > 1e-2 {
                    steep = steep.max(d / sin);
                } else if sin > 1e-3 {
                    shallow = shallow.max(d / sin);
                }
            }
        }
        assert!(meetings > 3000, "only {meetings} meetings: the sample tests too little");
        assert!(worst <= LINEAR / 10.0, "a meeting {worst:e} off the surface");
        assert!(steep <= LINEAR / 10.0, "a steep crossing slides {steep:e}");
        assert!(shallow <= LINEAR, "a shallow crossing slides {shallow:e}");
    }

    /// Sorted angles in [0, 2π), for comparing sets.
    fn sorted(mut v: Vec<f64>) -> Vec<f64> {
        for t in &mut v {
            *t = t.rem_euclid(TAU);
        }
        v.sort_by(f64::total_cmp);
        v
    }

    #[test]
    fn fit_recovers_the_coefficients() {
        let f = Trig2([1.0, -2.0, 3.0, 0.5, -4.0]);
        let g = Trig2::fit(|t| f.eval(t));
        for (a, b) in f.0.iter().zip(g.0) {
            assert!(close(*a, b, 1e-14), "{:?}", g.0);
        }
        // d/dθ of 3 sin θ + 0.5 cos 2θ is 3 cos θ − sin 2θ.
        assert_eq!(Trig2([0.0, 0.0, 3.0, 0.5, 0.0]).derivative().0, [0.0, 3.0, 0.0, 0.0, -1.0]);
    }

    #[test]
    fn zeros_by_hand() {
        // cos θ − ½ = 0 at π/3 and 5π/3.
        let z = sorted(trig_zeros(&Trig2([-0.5, 1.0, 0.0, 0.0, 0.0])));
        assert_eq!(z.len(), 2, "{z:?}");
        assert!(close(z[0], FRAC_PI_3, 1e-12) && close(z[1], 5.0 * FRAC_PI_3, 1e-12), "{z:?}");
        // 2 + cos θ is never 0, and comes no nearer than 1: nothing proposed.
        assert_eq!(trig_zeros(&Trig2([2.0, 1.0, 0.0, 0.0, 0.0])), Vec::<f64>::new());
        // cos 2θ − 1 touches 0 at 0 and π without crossing: both found (as
        // the least |f| in each run).
        let z = sorted(trig_zeros(&Trig2([-1.0, 0.0, 0.0, 1.0, 0.0])));
        assert!(z.iter().any(|&t| close(t, PI, 1e-5)), "{z:?}");
        assert!(z.iter().any(|&t| !(1e-5..=TAU - 1e-5).contains(&t)), "{z:?}");
        // sin 2θ: four crossings, 0, π/2, π, 3π/2.
        let z = sorted(trig_zeros(&Trig2([0.0, 0.0, 0.0, 0.0, 1.0])));
        for want in [FRAC_PI_2, PI, 3.0 * FRAC_PI_2] {
            assert!(z.iter().any(|&t| close(t, want, 1e-12)), "{want} in {z:?}");
        }
        // A function that is nearly zero everywhere stops at the budget
        // rather than splitting forever.
        let flat = trig_zeros(&Trig2([1e-300, 1e-300, 0.0, 0.0, 0.0]));
        assert!(flat.len() < MAX_ZERO_EVALS, "{}", flat.len());
    }

    #[test]
    fn quadratic_roots_keep_their_digits() {
        // t² − 2e8 t + 1 = 0: roots 1e8 ± √(1e16 − 1) ≈ 2e8 and 1/(2e8) =
        // 5e-9 (their product is 1). Subtracting the near-equal 1e8 and
        // √(1e16 − 1) would lose the small one; via c/q it keeps every digit.
        let r = quadratic(-1e8, 1.0, None);
        assert!(close(r[0], 2e8, 1e-6) && close(r[1], 5e-9, 1e-22), "{r:?}");
        // Knowing one root: the other is −2b − known.
        assert_eq!(quadratic(-2.0, 3.0, Some(1.0)), vec![3.0]);
        // No real roots: the least point, −b.
        assert_eq!(quadratic(1.0, 5.0, None), vec![-1.0]);
    }

    #[test]
    fn a_line_through_a_ball_and_a_rod() {
        // From (−2, 0, 0) along x through the unit ball: in at t = 1, out at 3.
        let line = Curve::Line { origin: DVec3::new(-2.0, 0.0, 0.0), dir: DVec3::X };
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        assert_eq!(sorted(curve_surface(&line, &ball, &[])), vec![1.0, 3.0]);
        assert_eq!(curve_surface(&line, &ball, &[1.0]), vec![3.0]);
        assert_eq!(curve_surface(&line, &ball, &[1.0, 3.0]), Vec::<f64>::new());
        // The line y = ½, z = 7 through the unit rod along z: x = ±√¾, so
        // t = 2 ∓ √¾.
        let line = Curve::Line { origin: DVec3::new(-2.0, 0.5, 7.0), dir: DVec3::X };
        let rod = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let t = sorted(curve_surface(&line, &rod, &[]));
        let h = 0.75f64.sqrt();
        assert!(close(t[0], 2.0 - h, 1e-15) && close(t[1], 2.0 + h, 1e-15), "{t:?}");
        // Along the rod's axis: never crosses it (it lies in it or misses).
        let along = Curve::Line { origin: DVec3::new(1.0, 0.0, 0.0), dir: DVec3::Z };
        assert_eq!(curve_surface(&along, &rod, &[]), Vec::<f64>::new());
        // Through the plane x = 3 once, at t = 5.
        let wall = Surface::Plane { origin: DVec3::new(3.0, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y };
        assert_eq!(curve_surface(&Curve::Line { origin: DVec3::new(-2.0, 0.0, 0.0), dir: DVec3::X }, &wall, &[]), vec![5.0]);
    }

    #[test]
    fn a_circle_through_a_plane_a_ball_and_rods() {
        let unit = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        // Plane x = ½: cos θ = ½, θ = ±π/3; knowing π/3 gives −π/3.
        let wall = Surface::Plane { origin: DVec3::new(0.5, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y };
        let z = sorted(curve_surface(&unit, &wall, &[]));
        // (Within rounding: a few units in the last place of 5.2.)
        assert!(close(z[0], FRAC_PI_3, 1e-14) && close(z[1], 5.0 * FRAC_PI_3, 1e-14), "{z:?}");
        let other = curve_surface(&unit, &wall, &[FRAC_PI_3]);
        assert!(close(other[0].rem_euclid(TAU), 5.0 * FRAC_PI_3, 1e-14), "{other:?}");
        // Unit ball at (1.5, 0, 0): |P − s|² = 1 − 3 cos θ + 2.25 = 1, so
        // cos θ = ¾. A unit rod along z through (1.5, 0) gives the same
        // (the circle lies across it).
        let ball = Surface::Sphere { center: DVec3::new(1.5, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let rod = Surface::Cylinder { origin: DVec3::new(1.5, 0.0, -4.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        for s in [ball, rod] {
            let z = sorted(curve_surface(&unit, &s, &[]));
            let a = fmath::acos(0.75f64);
            assert!(close(z[0], a, 1e-14) && close(z[1], TAU - a, 1e-14), "{z:?}");
        }
        // Tilted: the unit circle in the plane x = 0 against a rod of
        // radius 0.6 along z. A point (0, cos θ, sin θ) is |cos θ| from the
        // axis: 0.6 at θ = ±acos 0.6 and π ± acos 0.6, four crossings.
        let upright = Curve::Circle { center: DVec3::ZERO, axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 };
        let thin = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.6 };
        let z = sorted(curve_surface(&upright, &thin, &[]));
        let a = fmath::acos(0.6f64);
        let want = sorted(vec![a, PI - a, PI + a, TAU - a]);
        assert_eq!(z.len(), 4, "{z:?}");
        for (got, w) in z.iter().zip(want) {
            assert!(close(*got, w, 1e-12), "{z:?}");
        }
    }

    #[test]
    fn curves_meeting_by_hand() {
        // The x axis and the vertical line through (2, 1): closest at (2, 0, 0).
        let x_axis = Curve::Line { origin: DVec3::new(-5.0, 0.0, 0.0), dir: DVec3::X };
        let post = Curve::Line { origin: DVec3::new(2.0, 1.0, 3.0), dir: DVec3::Z };
        assert_eq!(curve_curve(&x_axis, &post, &[]), vec![DVec3::new(2.0, 0.0, 0.0)]);
        // Unit circles about 0 and (1, 0) in one plane meet at (½, ±√3/2):
        // the common chord is x = (1 + 1 − 1)/2 = ½.
        let c1 = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let c2 = Curve::Circle { center: DVec3::X, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let h = 3f64.sqrt() / 2.0;
        let pts = curve_curve(&c1, &c2, &[]);
        for want in [DVec3::new(0.5, h, 0.0), DVec3::new(0.5, -h, 0.0)] {
            assert!(pts.iter().any(|p| p.distance(want) < 1e-15), "{pts:?}");
        }
        // Knowing (½, √3/2), the other is its mirror image in the x axis.
        let other = curve_curve(&c1, &c2, &[DVec3::new(0.5, h, 0.0)]);
        assert!(other[0].distance(DVec3::new(0.5, -h, 0.0)) < 1e-15, "{other:?}");
        // The line y = ½ in the plane of c1 meets it at x = ±√¾.
        let chord = Curve::Line { origin: DVec3::new(-3.0, 0.5, 0.0), dir: DVec3::X };
        let pts = curve_curve(&chord, &c1, &[]);
        let r = 0.75f64.sqrt();
        for want in [DVec3::new(r, 0.5, 0.0), DVec3::new(-r, 0.5, 0.0)] {
            assert!(pts.iter().any(|p| p.distance(want) < 1e-14), "{pts:?}");
        }
        // c1 and the unit circle in the plane x = ½ about (½, 0, 0): the
        // planes meet in the line x = ½, z = 0, which crosses c1 at
        // y = ±√¾ and the other circle at y = ±1. Both pairs are proposed;
        // they share no point (measuring decides that).
        let c3 = Curve::Circle { center: DVec3::new(0.5, 0.0, 0.0), axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 };
        let pts = curve_curve(&c1, &c3, &[]);
        for want in [r, -r, 1.0, -1.0] {
            assert!(pts.iter().any(|p| p.distance(DVec3::new(0.5, want, 0.0)) < 1e-15), "{want}: {pts:?}");
        }
    }

    #[test]
    fn closed_meetings_by_hand() {
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        // The plane z = 0.6 cuts the unit ball in a circle of radius 0.8.
        let plane = Surface::Plane { origin: DVec3::new(0.0, 0.0, 0.6), normal: DVec3::Z, x_dir: DVec3::X };
        let pts = closed_meetings(&plane, &ball);
        assert_eq!(pts.len(), RING_SAMPLES);
        assert!(pts.iter().all(|p| close(p.z, 0.6, 1e-15) && close(p.truncate().length(), 0.8, 1e-15)));
        // Spread evenly round it, not bunched on one arc: 8 unit vectors at
        // multiples of π/4 sum to zero, so the points' mean is the circle's
        // centre (0, 0, 0.6). Points bunched within 1 rad would put it ~0.7
        // of the radius out.
        let mean = pts.iter().sum::<DVec3>() / pts.len() as f64;
        assert!(mean.distance(DVec3::new(0.0, 0.0, 0.6)) <= 1e-15, "{mean}");
        // Either order gives the same.
        assert_eq!(closed_meetings(&ball, &plane), pts);
        // Two unit balls 1.2 apart meet on the same circle.
        let ball2 = Surface::Sphere { center: DVec3::new(0.0, 0.0, 1.2), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        assert!(closed_meetings(&ball, &ball2).iter().all(|p| close(p.z, 0.6, 1e-15) && close(p.truncate().length(), 0.8, 1e-15)));
        // A plane tangent to the ball: just the touching point.
        let lid = Surface::Plane { origin: DVec3::Z, normal: DVec3::Z, x_dir: DVec3::X };
        assert_eq!(closed_meetings(&lid, &ball), vec![DVec3::Z]);
        // Rods of radius 1 along z and ½ along x: points with x² + y² = 1
        // and y² + z² = ¼, on both loops (x > 0 and x < 0).
        let big = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let small = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::X, x_dir: DVec3::Y, radius: 0.5 };
        let pts = closed_meetings(&small, &big);
        let on: Vec<&DVec3> = pts.iter().filter(|p| close(p.x * p.x + p.y * p.y, 1.0, 1e-12)).collect();
        assert!(on.iter().all(|p| close(p.y * p.y + p.z * p.z, 0.25, 1e-12)));
        assert!(on.iter().any(|p| p.x > 0.5) && on.iter().any(|p| p.x < -0.5), "{pts:?}");
        // A rod of radius 0.3 through (0.2, 0) along z and the unit ball:
        // points with |p| = 1 on both loops (z > 0 and z < 0).
        let rod = Surface::Cylinder { origin: DVec3::new(0.2, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 };
        let on: Vec<DVec3> = closed_meetings(&rod, &ball).into_iter().filter(|p| close(p.length(), 1.0, 1e-12)).collect();
        assert!(on.iter().any(|p| p.z > 0.9) && on.iter().any(|p| p.z < -0.9), "{on:?}");
        // The same rod centred on the ball's axis meets it in two circles
        // at z = ±√(1 − 0.09).
        let centred = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 };
        let pts = closed_meetings(&centred, &ball);
        assert_eq!(pts.len(), 2 * RING_SAMPLES);
        assert!(pts.iter().all(|p| close(p.z.abs(), 0.91f64.sqrt(), 1e-15) && close(p.truncate().length(), 0.3, 1e-15)));
        // Parallel rods, or a plane along a rod, meet in lines: none.
        assert_eq!(closed_meetings(&big, &centred), Vec::<DVec3>::new());
        let side = Surface::Plane { origin: DVec3::ZERO, normal: DVec3::X, x_dir: DVec3::Y };
        assert_eq!(closed_meetings(&side, &big), Vec::<DVec3>::new());
    }

    /// An awkward similarity: turned about a skew axis, scaled by 3.7 and
    /// moved off the origin. Hand cases sit at the origin with unit sizes,
    /// where `c − o` and `c + o`, `x·r` and `x/r` agree; carried through
    /// this, they don't.
    fn awkward() -> Transform {
        Transform::rotation(DVec3::new(0.3, -1.0, 0.6), 1.1)
            .then(Transform::uniform_scale(3.7))
            .then(Transform::translation(DVec3::new(12.5, -7.0, 3.25)))
    }

    use crate::geom::Transform;

    /// Each wanted point has a proposed point within 1e-12 of the scene's
    /// size, and there are no more proposed points than wanted ones.
    fn proposes(got: &[DVec3], want: &[DVec3], label: &str) {
        for w in want {
            assert!(got.iter().any(|g| g.distance(*w) <= 1e-12 * w.length().max(1.0)), "{label}: {w} not in {got:?}");
        }
        assert!(got.len() <= want.len(), "{label}: extra points {got:?}, want {want:?}");
    }

    /// The hand cases of the curve–surface tests, each as (curve, surface,
    /// known parameter or none, the meeting points).
    /// (label, curve, surface, a known parameter, the meeting points).
    type SurfaceCase = (&'static str, Curve, Surface, Option<f64>, Vec<DVec3>);
    /// (label, curve, curve, known points, the meeting points).
    type CurveCase = (&'static str, Curve, Curve, Vec<DVec3>, Vec<DVec3>);

    fn curve_surface_cases() -> Vec<SurfaceCase> {
        let h = 0.75f64.sqrt();
        let s7 = 7f64.sqrt() / 4.0;
        let unit = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let rod = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let x_line = Curve::Line { origin: DVec3::new(-2.0, 0.0, 0.0), dir: DVec3::X };
        vec![
            // Through the unit ball: in at (−1, 0, 0), out at (1, 0, 0).
            ("line–ball", x_line.clone(), ball.clone(), None, vec![-DVec3::X, DVec3::X]),
            ("line–ball, one known", x_line.clone(), ball.clone(), Some(1.0), vec![DVec3::X]),
            // y = ½, z = 7 through the unit rod: x = ±√¾.
            (
                "line–rod",
                Curve::Line { origin: DVec3::new(-2.0, 0.5, 7.0), dir: DVec3::X },
                rod.clone(),
                None,
                vec![DVec3::new(-h, 0.5, 7.0), DVec3::new(h, 0.5, 7.0)],
            ),
            ("line–plane", x_line.clone(), Surface::Plane { origin: DVec3::new(3.0, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y }, None, vec![DVec3::new(3.0, 0.0, 0.0)]),
            // Its one meeting known: nothing else.
            ("line–plane, known", x_line, Surface::Plane { origin: DVec3::new(3.0, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y }, Some(5.0), vec![]),
            // Unit circle and the plane x = ½: (½, ±√3/2, 0); knowing the
            // first (θ = π/3) leaves the second.
            ("circle–plane", unit.clone(), Surface::Plane { origin: DVec3::new(0.5, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y }, None, vec![DVec3::new(0.5, h, 0.0), DVec3::new(0.5, -h, 0.0)]),
            ("circle–plane, known", unit.clone(), Surface::Plane { origin: DVec3::new(0.5, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y }, Some(FRAC_PI_3), vec![DVec3::new(0.5, -h, 0.0)]),
            // Unit circle and the unit ball, or rod, about (1.5, 0): cos θ = ¾,
            // sin θ = ±√7/4.
            ("circle–ball", unit.clone(), Surface::Sphere { center: DVec3::new(1.5, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, None, vec![DVec3::new(0.75, s7, 0.0), DVec3::new(0.75, -s7, 0.0)]),
            ("circle–ball, known", unit.clone(), Surface::Sphere { center: DVec3::new(1.5, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, Some(fmath::acos(0.75f64)), vec![DVec3::new(0.75, -s7, 0.0)]),
            ("circle–rod across", unit.clone(), Surface::Cylinder { origin: DVec3::new(1.5, 0.0, -4.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, None, vec![DVec3::new(0.75, s7, 0.0), DVec3::new(0.75, -s7, 0.0)]),
            ("circle–rod across, known", unit, Surface::Cylinder { origin: DVec3::new(1.5, 0.0, -4.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, Some(fmath::acos(0.75f64)), vec![DVec3::new(0.75, -s7, 0.0)]),
            // The unit circle in x = 0 and a rod of radius 0.6 along z:
            // (0, ±0.6, ±0.8).
            (
                "circle–rod tilted",
                Curve::Circle { center: DVec3::ZERO, axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 },
                Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.6 },
                None,
                vec![DVec3::new(0.0, 0.6, 0.8), DVec3::new(0.0, -0.6, 0.8), DVec3::new(0.0, 0.6, -0.8), DVec3::new(0.0, -0.6, -0.8)],
            ),
        ]
    }

    #[test]
    fn curve_surface_cases_anywhere() {
        for tf in [Transform::IDENTITY, awkward()] {
            for (label, c, s, known, want) in curve_surface_cases() {
                let (c2, s2) = (c.transformed(&tf), s.transformed(&tf));
                let known: Vec<f64> = known.into_iter().map(|t| c.transform_param(t, &tf)).collect();
                let got: Vec<DVec3> = curve_surface(&c2, &s2, &known).into_iter().map(|t| c2.eval(t)).collect();
                let want: Vec<DVec3> = want.iter().map(|p| tf.point(*p)).collect();
                proposes(&got, &want, label);
            }
        }
    }

    #[test]
    fn curve_surface_near_misses_propose_the_closest_point() {
        // No meeting: the closest approach is proposed, so the caller can
        // measure how near it comes. The line y = 2 misses the unit ball;
        // nearest at (0, 2, 0). The circle round (0, 0, 0) of radius 1 in the
        // plane x = 0 against the plane x = 3: parallel, nothing. The unit
        // circle and the plane x = 2 (never reached): its nearest point
        // (1, 0, 0); the plane x = −2: (−1, 0, 0).
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let unit = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        for tf in [Transform::IDENTITY, awkward()] {
            let line = Curve::Line { origin: DVec3::new(-5.0, 2.0, 0.0), dir: DVec3::X }.transformed(&tf);
            let got: Vec<DVec3> = curve_surface(&line, &ball.transformed(&tf), &[]).into_iter().map(|t| line.eval(t)).collect();
            proposes(&got, &[tf.point(DVec3::new(0.0, 2.0, 0.0))], "line misses ball");
            let c = unit.transformed(&tf);
            for (x, want) in [(2.0, DVec3::X), (-2.0, -DVec3::X)] {
                let wall = Surface::Plane { origin: DVec3::new(x, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y }.transformed(&tf);
                let got: Vec<DVec3> = curve_surface(&c, &wall, &[]).into_iter().map(|t| c.eval(t)).collect();
                proposes(&got, &[tf.point(want)], "circle misses plane");
            }
            // Parallel and apart: nothing proposed is on the wall (exactly
            // parallel proposes nothing; rounding in the turned frame may
            // make it "nearly parallel", and a nearest point then).
            let upright = Curve::Circle { center: DVec3::ZERO, axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 }.transformed(&tf);
            let wall = Surface::Plane { origin: DVec3::new(3.0, 0.0, 0.0), normal: DVec3::X, x_dir: DVec3::Y }.transformed(&tf);
            assert!(curve_surface(&upright, &wall, &[]).into_iter().all(|t| wall.distance(upright.eval(t)) > 1.0));
        }
    }

    #[test]
    fn curve_curve_cases_anywhere() {
        let h = 3f64.sqrt() / 2.0;
        let r = 0.75f64.sqrt();
        let c1 = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let c2 = Curve::Circle { center: DVec3::X, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let c3 = Curve::Circle { center: DVec3::new(0.5, 0.0, 0.0), axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 };
        let chord = Curve::Line { origin: DVec3::new(-3.0, 0.5, 0.0), dir: DVec3::X };
        // Through (0.6, 0.8, 0) on c1, crossing its plane there.
        let pin = Curve::Line { origin: DVec3::new(0.6, 0.8, -1.0), dir: DVec3::Z };
        let cases: Vec<CurveCase> = vec![
            ("skew lines", Curve::Line { origin: DVec3::new(-5.0, 0.0, 0.0), dir: DVec3::X }, Curve::Line { origin: DVec3::new(2.0, 1.0, 3.0), dir: DVec3::Z }, vec![], vec![DVec3::new(2.0, 0.0, 0.0)]),
            ("crossing lines, known", Curve::Line { origin: DVec3::new(-5.0, 0.0, 0.0), dir: DVec3::X }, Curve::Line { origin: DVec3::new(2.0, 0.0, 3.0), dir: DVec3::Z }, vec![DVec3::new(2.0, 0.0, 0.0)], vec![]),
            ("circles", c1.clone(), c2.clone(), vec![], vec![DVec3::new(0.5, h, 0.0), DVec3::new(0.5, -h, 0.0)]),
            ("circles, known", c1.clone(), c2.clone(), vec![DVec3::new(0.5, h, 0.0)], vec![DVec3::new(0.5, -h, 0.0)]),
            ("chord", chord.clone(), c1.clone(), vec![], vec![DVec3::new(r, 0.5, 0.0), DVec3::new(-r, 0.5, 0.0)]),
            ("chord, known", c1.clone(), chord, vec![DVec3::new(r, 0.5, 0.0)], vec![DVec3::new(-r, 0.5, 0.0)]),
            ("pin", pin.clone(), c1.clone(), vec![], vec![DVec3::new(0.6, 0.8, 0.0)]),
            ("pin, known", c1.clone(), pin, vec![DVec3::new(0.6, 0.8, 0.0)], vec![]),
            (
                "circles across",
                c1.clone(),
                c3.clone(),
                vec![],
                vec![DVec3::new(0.5, r, 0.0), DVec3::new(0.5, -r, 0.0), DVec3::new(0.5, 1.0, 0.0), DVec3::new(0.5, -1.0, 0.0)],
            ),
            // Sharing (½, √¾, 0) (on c1, and on c4 below): the others on the
            // line x = ½, z = 0 are c1's (½, −√¾, 0) and c4's (½, −√¾, 0) too
            // (c4 = the circle in x = ½ about (½, 0, 0) of radius 1... no:
            // radius √¾, so it passes through both).
            (
                "circles across, known",
                c1.clone(),
                Curve::Circle { center: DVec3::new(0.5, 0.0, 0.0), axis: DVec3::X, x_dir: DVec3::Y, radius: r },
                vec![DVec3::new(0.5, r, 0.0)],
                vec![DVec3::new(0.5, -r, 0.0)],
            ),
        ];
        for tf in [Transform::IDENTITY, awkward()] {
            for (label, a, b, known, want) in &cases {
                let known: Vec<DVec3> = known.iter().map(|p| tf.point(*p)).collect();
                let got = curve_curve(&a.transformed(&tf), &b.transformed(&tf), &known);
                let want: Vec<DVec3> = want.iter().map(|p| tf.point(*p)).collect();
                // "circles across, known" proposes c1's and c4's other point,
                // which are the same point: both count.
                let mut got = got;
                got.dedup_by(|x, y| x.distance(*y) <= 1e-12 * x.length().max(1.0));
                proposes(&got, &want, label);
            }
            // Off each other's planes: a line parallel to c1's plane 1 above,
            // and a circle in the parallel plane z = 1: nothing.
            let above = Curve::Line { origin: DVec3::new(-3.0, 0.0, 1.0), dir: DVec3::X }.transformed(&tf);
            assert_eq!(curve_curve(&c1.transformed(&tf), &above, &[]), Vec::<DVec3>::new());
            let lid = Curve::Circle { center: DVec3::Z, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }.transformed(&tf);
            assert_eq!(curve_curve(&c1.transformed(&tf), &lid, &[]), Vec::<DVec3>::new());
        }
    }

    #[test]
    fn closed_meetings_anywhere() {
        // Every proposed point is on both surfaces (when they cross), and
        // each loop gets points, in any position.
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let cases: Vec<(&str, Surface, Surface, usize)> = vec![
            ("plane–ball", Surface::Plane { origin: DVec3::new(0.0, 0.0, 0.6), normal: DVec3::Z, x_dir: DVec3::X }, ball.clone(), RING_SAMPLES),
            ("balls", ball.clone(), Surface::Sphere { center: DVec3::new(0.0, 0.0, 1.2), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, RING_SAMPLES),
            (
                "plane–rod",
                Surface::Plane { origin: DVec3::new(0.0, 0.0, 0.3), normal: DVec3::new(0.0, 0.6, 0.8), x_dir: DVec3::X },
                Surface::Cylinder { origin: DVec3::new(0.2, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.5 },
                RING_SAMPLES,
            ),
            ("centred rod–ball", Surface::Cylinder { origin: DVec3::new(0.0, 0.0, -3.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 }, ball.clone(), 2 * RING_SAMPLES),
            ("rod–ball", Surface::Cylinder { origin: DVec3::new(0.2, 0.0, -3.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 }, ball.clone(), 4),
            ("rods", Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 }, Surface::Cylinder { origin: DVec3::new(0.0, 0.1, 0.2), axis: DVec3::X, x_dir: DVec3::Y, radius: 0.5 }, 4),
        ];
        for tf in [Transform::IDENTITY, awkward()] {
            for (label, a, b, least) in &cases {
                let (a, b) = (a.transformed(&tf), b.transformed(&tf));
                let pts = closed_meetings(&a, &b);
                let on: Vec<&DVec3> = pts.iter().filter(|p| a.distance(**p) <= 1e-12 * 20.0 && b.distance(**p) <= 1e-12 * 20.0).collect();
                assert!(on.len() >= *least, "{label}: {} of {} on both", on.len(), pts.len());
                // Swapped, as good (two cylinders are then walked round the
                // other one, so the points differ).
                let swapped = closed_meetings(&b, &a);
                let on = swapped.iter().filter(|p| a.distance(**p) <= 1e-12 * 20.0 && b.distance(**p) <= 1e-12 * 20.0).count();
                assert!(on >= *least, "{label} swapped: {on} of {}", swapped.len());
            }
        }
    }

    #[test]
    fn closed_meetings_find_both_loops() {
        // A rod of radius ½ along x through a rod of radius 1 along z
        // crosses it in two loops, at x ≈ +1 and x ≈ −1; a rod of radius
        // 0.3 along z through (0.2, 0) crosses the unit ball in two loops,
        // z ≈ ±0.95. Points of each loop are proposed.
        let big = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let small = Surface::Cylinder { origin: DVec3::new(0.0, 0.1, 0.2), axis: DVec3::X, x_dir: DVec3::Y, radius: 0.5 };
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let rod = Surface::Cylinder { origin: DVec3::new(0.2, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 };
        for (a, b, side) in [(&small, &big, DVec3::X), (&big, &small, DVec3::X), (&rod, &ball, DVec3::Z)] {
            let on: Vec<DVec3> = closed_meetings(a, b).into_iter().filter(|p| a.distance(*p) <= 1e-12 && b.distance(*p) <= 1e-12).collect();
            assert!(on.iter().any(|p| p.dot(side) > 0.9) && on.iter().any(|p| p.dot(side) < -0.9), "{on:?}");
        }
        // Rods crossing at a slant (not square): still two loops.
        let slant = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::new(0.6, 0.0, 0.8), x_dir: DVec3::Y, radius: 0.4 };
        let on: Vec<DVec3> = closed_meetings(&slant, &big).into_iter().filter(|p| slant.distance(*p) <= 1e-12 && big.distance(*p) <= 1e-12).collect();
        assert!(on.iter().any(|p| p.x > 0.5) && on.iter().any(|p| p.x < -0.5), "{on:?}");
    }

    #[test]
    fn trig_parts_by_hand() {
        // Derivative of 1 − 2 cos θ + 3 sin θ + ½ cos 2θ − 4 sin 2θ:
        // 2 sin θ + 3 cos θ − sin 2θ − 8 cos 2θ.
        assert_eq!(Trig2([1.0, -2.0, 3.0, 0.5, -4.0]).derivative().0, [0.0, 3.0, 2.0, -8.0, -1.0]);
        // Most slope: |−2| + |3| + 2(|½| + |−4|) = 14.
        assert_eq!(Trig2([1.0, -2.0, 3.0, 0.5, -4.0]).slope_bound(), 14.0);
        // a + m cos(θ − φ) with no zero: least |f| where cos is 1 if a < −m
        // (θ = φ), −1 if a > m (θ = φ + π). Here φ = atan2(4, 3), m = 5.
        let phi = fmath::atan2(4f64, 3.0);
        assert_eq!(trig1_zeros(-7.0, 3.0, 4.0, None), vec![phi]);
        assert_eq!(trig1_zeros(7.0, 3.0, 4.0, None), vec![phi + PI]);
        // With zeros: −2.5 + 5 cos(θ − φ): θ = φ ± π/3.
        let z = trig1_zeros(-2.5, 3.0, 4.0, None);
        assert!(close(z[0], phi + FRAC_PI_3, 1e-15) && close(z[1], phi - FRAC_PI_3, 1e-15), "{z:?}");
    }

    #[test]
    fn zeros_of_lopsided_polynomials() {
        // 0.3 + cos(θ − 0.4) = 0 at θ = 0.4 ± acos(−0.3): written out,
        // 0.3 + cos 0.4 cos θ + sin 0.4 sin θ.
        let f = Trig2([0.3, fmath::cos(0.4f64), fmath::sin(0.4f64), 0.0, 0.0]);
        let want = sorted(vec![0.4 + fmath::acos(-0.3f64), 0.4 - fmath::acos(-0.3f64)]);
        let z = sorted(trig_zeros(&f));
        assert_eq!(z.len(), 2, "{z:?}");
        assert!(close(z[0], want[0], 1e-12) && close(z[1], want[1], 1e-12), "{z:?} vs {want:?}");
        // A big sin θ term: −1 + 2 sin θ + 0.7 cos 2θ. As a quadratic in
        // s = sin θ (cos 2θ = 1 − 2s²): −0.3 + 2s − 1.4s² = 0, s = (2 −
        // √(4 − 1.68))/2.8 = 0.1703 (the other root is > 1), so θ = asin s
        // and π − asin s.
        let f = Trig2([-1.0, 0.0, 2.0, 0.7, 0.0]);
        let s = (2.0 - 2.32f64.sqrt()) / 2.8;
        let want = sorted(vec![fmath::asin(s), PI - fmath::asin(s)]);
        let z = sorted(trig_zeros(&f));
        assert_eq!(z.len(), 2, "{z:?}");
        assert!(close(z[0], want[0], 1e-12) && close(z[1], want[1], 1e-12), "{z:?} vs {want:?}");
    }

    #[test]
    fn zeros_close_together_and_touching() {
        // cos(θ − 2) − (1 − 1e-12): two zeros 2 ± √(2e-12) ≈ 2 ± 1.414e-6,
        // closer than LEAF_WIDTH · 3. Both found, and nothing else.
        let (c, s) = (fmath::cos(2f64), fmath::sin(2f64));
        let f = Trig2([-(1.0 - 1e-12), c, s, 0.0, 0.0]);
        let z = sorted(trig_zeros(&f));
        let d = (2e-12f64).sqrt();
        assert_eq!(z.len(), 2, "{z:?}");
        assert!(close(z[0], 2.0 - d, 1e-9) && close(z[1], 2.0 + d, 1e-9), "{z:?}");
        // cos(θ − 2) − (1 + 1e-12) never reaches 0; it comes closest at θ = 2:
        // one candidate there.
        let f = Trig2([-(1.0 + 1e-12), c, s, 0.0, 0.0]);
        let z = trig_zeros(&f);
        assert_eq!(z.len(), 1, "{z:?}");
        assert!(close(z[0], 2.0, 1e-6), "{z:?}");
    }

    #[test]
    fn zero_finding_cost_is_bounded() {
        // An ordinary polynomial is settled in a few thousand evaluations
        // (64 starting intervals, then ~20 halvings near each zero); one
        // that is nearly 0 everywhere stops at the budget.
        // cos θ − ½: 64, then 4 per halving (two intervals by each zero)
        // for the 17 halvings from 2π/64 down to LEAF_WIDTH: 132.
        let (_, n) = trig_zeros_counted(&Trig2([-0.5, 1.0, 0.0, 0.0, 0.0]));
        assert_eq!(n, 64 + 4 * 17);
        // (1 − cos θ)² = 3/2 − 2 cos θ + ½ cos 2θ ≈ θ⁴/4 near 0, under
        // slope_bound · LEAF_WIDTH/2 = 3e-6/2 for |θ| up to (6e-6)^¼ ≈ 0.05:
        // ~10^5 leaves. It stops at the budget, plus one look at each
        // interval still waiting: at most the 64 starting ones and one kept
        // half per halving (17). It still proposes a point near 0.
        let (z, n) = trig_zeros_counted(&Trig2([1.5, -2.0, 0.0, 0.5, 0.0]));
        assert!((MAX_ZERO_EVALS..=MAX_ZERO_EVALS + 64 + 17).contains(&n), "{n}");
        assert!(z.iter().any(|&t| !(0.06..=TAU - 0.06).contains(&t)), "{z:?}");
        // Far from zero everywhere: only the 64 starting intervals.
        assert_eq!(trig_zeros_counted(&Trig2([3.0, 1.0, 0.0, 0.0, 0.0])).1, 64);
    }

    #[test]
    fn generic_angles_and_radii_by_hand() {
        // The cases above mostly use unit radii and right angles, where
        // ρ·k and ρ/k, x/a and x·a agree. These don't: each has a radius
        // other than 1 and an angle other than 0° or 90°, worked by hand.
        let close_all = |got: Vec<DVec3>, want: Vec<DVec3>, label: &str| proposes(&got, &want, label);
        for tf in [Transform::IDENTITY, awkward()] {
            let at = |p: DVec3| tf.point(p);
            let params = |c: &Curve, s: &Surface| -> Vec<DVec3> {
                let (c, s) = (c.transformed(&tf), s.transformed(&tf));
                curve_surface(&c, &s, &[]).into_iter().map(|t| c.eval(t)).collect()
            };
            // Circle of radius 2 round the origin in z = 0, and the plane
            // 0.6x + 0.8y = 0.6 (unit normal n, 0.6 from the origin): the
            // chord's middle is 0.6n = (0.36, 0.48), half-length
            // √(2² − 0.6²) = √3.64, along (−0.8, 0.6).
            let big = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 2.0 };
            let slanted = Surface::Plane { origin: DVec3::new(1.0, 0.0, 0.0), normal: DVec3::new(0.6, 0.8, 0.0), x_dir: DVec3::Z };
            let k = 3.64f64.sqrt();
            let chord = |sg: f64| at(DVec3::new(0.36 - 0.8 * k * sg, 0.48 + 0.6 * k * sg, 0.0));
            close_all(params(&big, &slanted), vec![chord(1.0), chord(-1.0)], "circle of radius 2–slanted plane");
            // The same circle and a ball of radius 1.5 about s = (2, 1, 0),
            // or a rod of radius 1.5 along z through it: in z = 0, circles
            // of radii 2 and 1.5 with centres √5 apart. Along u = s/√5 the
            // common chord is at a = (5 + 4 − 2.25)/(2√5) = 6.75/(2√5),
            // half-length √(4 − a²), along v = (−1, 2, 0)/√5.
            let r5 = 5f64.sqrt();
            let (u, v) = (DVec3::new(2.0, 1.0, 0.0) / r5, DVec3::new(-1.0, 2.0, 0.0) / r5);
            let a = 6.75 / (2.0 * r5);
            let hh = (4.0 - a * a).sqrt();
            let want = vec![at(u * a + v * hh), at(u * a - v * hh)];
            let ball = Surface::Sphere { center: DVec3::new(2.0, 1.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.5 };
            close_all(params(&big, &ball), want.clone(), "circle of radius 2–ball of radius 1.5");
            let rod = Surface::Cylinder { origin: DVec3::new(2.0, 1.0, -3.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.5 };
            close_all(params(&big, &rod), want, "circle of radius 2–rod across");
            // A unit circle in x = 0 about (0, 0.3, 0.2) and a rod of radius
            // 0.6 along z: x² + y² = (0.3 + cos θ)² = 0.36, so cos θ = 0.3
            // (y = 0.6, z = 0.2 ± √0.91) or cos θ = −0.9 (y = −0.6,
            // z = 0.2 ± √0.19).
            let upright = Curve::Circle { center: DVec3::new(0.0, 0.3, 0.2), axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 };
            let thin = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.6 };
            let (p, q) = (0.91f64.sqrt(), 0.19f64.sqrt());
            close_all(
                params(&upright, &thin),
                vec![at(DVec3::new(0.0, 0.6, 0.2 + p)), at(DVec3::new(0.0, 0.6, 0.2 - p)), at(DVec3::new(0.0, -0.6, 0.2 + q)), at(DVec3::new(0.0, -0.6, 0.2 - q))],
                "off-centre circle–rod tilted",
            );
            // A line from (−2, 0.5, 0) along (0.6, 0, 0.8) through the unit
            // rod along z: x² = 1 − 0.25 at x = ±√¾, so t = (x + 2)/0.6 and
            // z = 0.8t.
            let line = Curve::Line { origin: DVec3::new(-2.0, 0.5, 0.0), dir: DVec3::new(0.6, 0.0, 0.8) };
            let unit_rod = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
            let x = 0.75f64.sqrt();
            let on = |x: f64| at(DVec3::new(x, 0.5, 0.8 * (x + 2.0) / 0.6));
            close_all(params(&line, &unit_rod), vec![on(x), on(-x)], "slanted line–rod");
            // A line along the rod's axis tilted by φ = 1e-5 rad leaves the
            // unit rod where |t| sin φ = 1: t = ±1/sin φ, 100 m away. Not
            // "parallel" (that is only within ANGULAR).
            let phi = 1e-5f64;
            let steep = Curve::Line { origin: DVec3::ZERO, dir: DVec3::new(fmath::sin(phi), 0.0, fmath::cos(phi)) };
            let t = 1.0 / fmath::sin(phi);
            // The meeting is ill-conditioned (|d across the axis| = 1e-5, so
            // a rounding of 1e-16 in the turned direction moves t by 1e-11 of
            // itself); along the line that barely leaves the rod, so 1e-9 of
            // the distance is plenty for the caller's measuring.
            let got = params(&steep, &unit_rod);
            for w in [at(DVec3::new(1.0, 0.0, t * fmath::cos(phi))), at(DVec3::new(-1.0, 0.0, -t * fmath::cos(phi)))] {
                assert!(got.iter().any(|g| g.distance(w) <= 1e-9 * w.length()), "nearly upright line–rod: {w} not in {got:?}");
            }
            assert_eq!(got.len(), 2);

            let meet = |a: &Curve, b: &Curve| curve_curve(&a.transformed(&tf), &b.transformed(&tf), &[]);
            // The x axis and the line through (2, 1, 3) along (0.6, 0, 0.8)
            // (not square to it): closest where (2 + 0.6u − s) = 0 and
            // 0.6(2 + 0.6u − s) + 0.8(3 + 0.8u) = 0, so u = −3.75 and
            // s = 2 − 2.25 = −0.25: the point (−0.25, 0, 0).
            let x_axis = Curve::Line { origin: DVec3::new(-5.0, 0.0, 0.0), dir: DVec3::X };
            let leaning = Curve::Line { origin: DVec3::new(2.0, 1.0, 3.0), dir: DVec3::new(0.6, 0.0, 0.8) };
            close_all(meet(&x_axis, &leaning), vec![at(DVec3::new(-0.25, 0.0, 0.0))], "skew lines at a slant");
            // The unit circle in z = 0, and a unit circle in the plane through
            // the line y = ½, z = 0 tilted 60° (normal (0, −√3/2, ½)),
            // centred 0.4 up that plane from the line, at (0, 0.7, 0.4·√3/2).
            // On the line (x, ½, 0): the first has x² = ¾, the second
            // x² + 0.2² + 0.12 = 1, x² = 0.84.
            let flat = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
            let s3 = 3f64.sqrt() / 2.0;
            let tilted = Curve::Circle { center: DVec3::new(0.0, 0.7, 0.4 * s3), axis: DVec3::new(0.0, -s3, 0.5), x_dir: DVec3::X, radius: 1.0 };
            let (p, q) = (0.75f64.sqrt(), 0.84f64.sqrt());
            close_all(
                meet(&flat, &tilted),
                [p, -p, q, -q].iter().map(|&x| at(DVec3::new(x, 0.5, 0.0))).collect(),
                "circles in planes at 60°",
            );
            // The unit circle and one of radius 0.8 about (1.2, 0, 0) in the
            // same plane: the chord at x = (1.44 + 1 − 0.64)/2.4 = 0.75,
            // y = ±√(1 − 0.5625) (and (0.75 − 1.2)² + 0.4375 = 0.64).
            let small = Curve::Circle { center: DVec3::new(1.2, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.8 };
            let y = 0.4375f64.sqrt();
            close_all(meet(&flat, &small), vec![at(DVec3::new(0.75, y, 0.0)), at(DVec3::new(0.75, -y, 0.0))], "unequal coplanar circles");
        }
    }

    #[test]
    fn zeros_in_a_long_run_stay_apart() {
        // cos(θ − c) − (1 − 2e-12): zeros c ± √(4e-12) = c ± 2e-6, wherever
        // c is. Near c, |f| ≈ (θ − c)²/2 stays under slope_bound ·
        // LEAF_WIDTH/2 for about ±1e-3, so ~2700 neighbouring leaves form
        // one run round c, and its middle grid point falls between them.
        for c in [1.0, 2.0, 3.0, TAU - 1.0] {
            let f = Trig2([-(1.0 - 2e-12), fmath::cos(c), fmath::sin(c), 0.0, 0.0]);
            let z = sorted(trig_zeros(&f));
            assert_eq!(z.len(), 2, "c = {c}: {z:?}");
            assert!(close(z[0], c - 2e-6, 1e-9) && close(z[1], c + 2e-6, 1e-9), "c = {c}: {z:?}");
        }
        // (1 + 1e-12) − cos(2(θ − ½)) never reaches 0 and comes closest
        // twice, at ½ and ½ + π: two runs, one candidate each. Written out,
        // cos(2θ − 1) = cos 1 cos 2θ + sin 1 sin 2θ.
        let z = sorted(trig_zeros(&Trig2([1.0 + 1e-12, 0.0, 0.0, -fmath::cos(1.0), -fmath::sin(1.0)])));
        assert_eq!(z.len(), 2, "{z:?}");
        assert!(close(z[0], 0.5, 1e-6) && close(z[1], 0.5 + PI, 1e-6), "{z:?}");
        // A near-touch away from θ = 2 (where (a + b)/2 and ab/2 agree):
        // cos(θ − 1.3) − (1 + 1e-12) comes closest at θ = 1.3.
        let z = trig_zeros(&Trig2([-(1.0 + 1e-12), fmath::cos(1.3f64), fmath::sin(1.3f64), 0.0, 0.0]));
        assert_eq!(z.len(), 1, "{z:?}");
        assert!(close(z[0], 1.3, 1e-6), "{z:?}");
    }

    #[test]
    fn closed_meetings_by_hand_off_the_axes() {
        // Points proposed on each closed crossing curve, distinct ones, all
        // on both surfaces where the curve goes all round.
        let distinct_on_both = |a: &Surface, b: &Surface, pts: &[DVec3], tol: f64| {
            let mut on: Vec<DVec3> = pts.iter().copied().filter(|p| a.distance(*p) <= tol && b.distance(*p) <= tol).collect();
            on.sort_by(|p, q| p.x.total_cmp(&q.x).then(p.y.total_cmp(&q.y)).then(p.z.total_cmp(&q.z)));
            on.dedup_by(|p, q| p.distance(*q) <= 1e-6);
            on
        };
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let big = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        for tf in [Transform::IDENTITY, awkward()] {
            let tol = 1e-12 * 20.0;
            let at = |p: DVec3| tf.point(p);
            // Balls of radii 1 and 0.7, centres 1.2 apart: the circle at
            // x = (1.44 + 1 − 0.49)/2.4 = 0.8125 along the line of centres,
            // radius √(1 − 0.8125²). Every point proposed is on it.
            let (a, b) = (ball.transformed(&tf), Surface::Sphere { center: DVec3::new(0.0, 0.0, 1.2), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.7 }.transformed(&tf));
            let pts = closed_meetings(&a, &b);
            let (mid, rho) = (at(DVec3::new(0.0, 0.0, 0.8125)), (1.0 - 0.8125f64 * 0.8125).sqrt() * tf.scale());
            for p in &pts {
                assert!((p.distance(mid) - rho).abs() <= tol && a.distance(*p) <= tol && b.distance(*p) <= tol, "{p}");
            }
            assert_eq!(distinct_on_both(&a, &b, &pts, tol).len(), RING_SAMPLES);
            // A rod of radius 0.3 along z through (0.2, 0) and the unit
            // ball: the rod is inside the ball's shadow (0.2 + 0.3 < 1), so
            // the crossing is two loops all round the rod, and at every
            // angle walked both heights are on both surfaces.
            let (rod, b) = (Surface::Cylinder { origin: DVec3::new(0.2, 0.0, -3.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 }.transformed(&tf), ball.transformed(&tf));
            let pts = closed_meetings(&rod, &b);
            assert!(pts.iter().all(|p| rod.distance(*p) <= tol && b.distance(*p) <= tol), "{pts:?}");
            assert!(distinct_on_both(&rod, &b, &pts, tol).len() >= 2 * RING_SAMPLES);
            // A ball of radius 0.05 sitting on the unit rod's wall at angle
            // π/8, between the angles walked anyway (multiples of π/4): its
            // loop spans ±0.05 rad, and only the discriminant's turning
            // point finds it. There, at the ball's centre, the heights are
            // ±0.05: (cos π/8, sin π/8, ±0.05).
            let u = DVec3::new(fmath::cos(PI / 8.0), fmath::sin(PI / 8.0), 0.0);
            let (rod, b) = (big.transformed(&tf), Surface::Sphere { center: u, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.05 }.transformed(&tf));
            proposes_among(&closed_meetings(&rod, &b), &[at(u + DVec3::Z * 0.05), at(u - DVec3::Z * 0.05)], "small ball on a rod");
            // A rod of radius 0.05 along u through the origin crosses the
            // unit rod's wall in small loops at angles π/8 and 9π/8; at π/8
            // the point u + hz is 0.05 from the thin rod's axis when
            // h = ±0.05.
            let thin = Surface::Cylinder { origin: u * -3.0, axis: u, x_dir: DVec3::Z, radius: 0.05 }.transformed(&tf);
            proposes_among(&closed_meetings(&rod, &thin), &[at(u + DVec3::Z * 0.05), at(u - DVec3::Z * 0.05), at(-u + DVec3::Z * 0.05), at(-u - DVec3::Z * 0.05)], "thin rod through a rod");
            // Rods whose axes are only 1e-5 rad apart (not parallel: that is
            // within ANGULAR): radius 0.5 through (0.6, 0, 0) leaning along
            // x, against the unit rod along z. They cross (the thin one's
            // wall reaches x = 1.1 near z = 0); some point is on both.
            let leaning = Surface::Cylinder { origin: DVec3::new(0.6, 0.0, 0.0), axis: DVec3::new(fmath::sin(1e-5f64), 0.0, fmath::cos(1e-5f64)), x_dir: DVec3::Y, radius: 0.5 }.transformed(&tf);
            let pts = closed_meetings(&rod, &leaning);
            assert!(!distinct_on_both(&rod, &leaning, &pts, 1e-9).is_empty(), "nearly parallel rods: {pts:?}");
            // Rods at a slant (axes 36.9° apart, so |a1 across a2|² = 0.36,
            // not 1): radius 0.4 along (0.6, 0, 0.8) inside the unit rod
            // along z, crossing its wall in two loops all round the thin
            // one: walking round the thin rod, every height is on both.
            let slant = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::new(0.6, 0.0, 0.8), x_dir: DVec3::Y, radius: 0.4 }.transformed(&tf);
            let pts = closed_meetings(&slant, &rod);
            assert!(pts.iter().all(|p| slant.distance(*p) <= 1e-9 && rod.distance(*p) <= 1e-9), "{pts:?}");
            assert!(distinct_on_both(&slant, &rod, &pts, 1e-9).len() >= 2 * RING_SAMPLES);
        }
    }

    #[test]
    fn a_tilted_circle_off_the_rods_axis_by_hand() {
        // The unit circle about (0.2, 0, 0) with axis (0.6, 0, 0.8) and
        // x_dir y: its frame's second direction is axis × y = (−0.8, 0, 0.6),
        // so P(θ) = (0.2 − 0.8 sin θ, cos θ, 0.6 sin θ). Against a rod
        // along z of radius √0.79, with s = sin θ:
        // (0.2 − 0.8s)² + 1 − s² = 0.79, i.e. 0.36s² + 0.32s − 0.23 = 0,
        // s = (−0.32 ± √(0.1024 + 0.3312))/0.72 = (−0.32 ± 0.68)/0.72: ½ (the
        // other root is below −1). So θ = π/6 and 5π/6, at (−0.2, ±√3/2, 0.3).
        // Not symmetric under θ → −θ (both parts of the frame cross the
        // rod's axis), so a sign slip between them moves the crossings.
        let tilted = Curve::Circle { center: DVec3::new(0.2, 0.0, 0.0), axis: DVec3::new(0.6, 0.0, 0.8), x_dir: DVec3::Y, radius: 1.0 };
        let rod = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.79f64.sqrt() };
        let h = 3f64.sqrt() / 2.0;
        for tf in [Transform::IDENTITY, awkward()] {
            let c = tilted.transformed(&tf);
            let got: Vec<DVec3> = curve_surface(&c, &rod.transformed(&tf), &[]).into_iter().map(|t| c.eval(t)).collect();
            proposes(&got, &[tf.point(DVec3::new(-0.2, h, 0.3)), tf.point(DVec3::new(-0.2, -h, 0.3))], "tilted circle off the rod's axis");
        }
    }

    #[test]
    fn a_lopsided_small_loop_by_hand() {
        // A rod of radius 0.05 along v = (0.8, 0, 0.6) through q = (0, ½, 0),
        // walked round from the unit rod along z. It pierces the unit rod's
        // wall in two small loops, near θ = π/6 and 5π/6 (where sin θ = ½).
        // Neither loop is symmetric about its own angle (the thin rod meets
        // the wall at a slant), so only the right discriminant turns inside
        // it; a loop ±0.06 rad wide lies between the fixed angles walked
        // (multiples of π/4). At θ = π/6, P − q = (cos θ, 0, h), whose
        // distance² from the thin axis is cos²θ + h² − (0.8 cos θ + 0.6h)²
        // = (0.6 cos θ − 0.8h)² = 0.05², so h = 0.75 cos θ ± 0.0625. The
        // discriminant is greatest there: with s = sin θ it is
        // (0.05² − (s − ½)²)/0.64, the cos²θ parts cancelling.
        let big = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let thin = Surface::Cylinder { origin: DVec3::new(0.0, 0.5, 0.0), axis: DVec3::new(0.8, 0.0, 0.6), x_dir: DVec3::Y, radius: 0.05 };
        let (c, s) = (fmath::cos(PI / 6.0), 0.5);
        let want = [DVec3::new(c, s, 0.75 * c + 0.0625), DVec3::new(c, s, 0.75 * c - 0.0625)];
        for tf in [Transform::IDENTITY, awkward()] {
            let pts = closed_meetings(&big.transformed(&tf), &thin.transformed(&tf));
            proposes_among(&pts, &want.map(|p| tf.point(p)), "lopsided small loop");
        }
    }

    #[test]
    fn a_rod_and_ball_mirrored_through_the_origin_by_hand() {
        // The rod's origin c = (0.2, 0, 0) and the ball's centre s = −c, so
        // s + c = 0 while s − c = (−0.4, 0, 0): mixing them up would take
        // the ball for one centred on the rod. The rod (radius 0.3 along z)
        // lies inside the unit ball's shadow (0.4 + 0.3 < 1), so it crosses
        // in two loops all round the rod, and every point proposed is on
        // both. At angle 0 the rod's wall is at x = 0.5, 0.7 from the
        // centre: z = ±√(1 − 0.49) = ±√0.51.
        let rod = Surface::Cylinder { origin: DVec3::new(0.2, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 0.3 };
        let ball = Surface::Sphere { center: DVec3::new(-0.2, 0.0, 0.0), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let pts = closed_meetings(&rod, &ball);
        assert!(pts.iter().all(|p| rod.distance(*p) <= 1e-12 && ball.distance(*p) <= 1e-12), "{pts:?}");
        let z = 0.51f64.sqrt();
        proposes_among(&pts, &[DVec3::new(0.5, 0.0, z), DVec3::new(0.5, 0.0, -z)], "mirrored rod–ball");
    }

    #[test]
    fn a_flat_discriminant_is_walked_at_the_fixed_angles() {
        // When the discriminant is the same at every angle (a loop all
        // round the cylinder at a constant height, as for a ball centred on
        // the axis), it has no turning points and only the fixed angles
        // are sure to give points: kπ/4 for k = 0..8, each at both heights
        // (fitting a constant leaves rounding-sized harmonics, so others may
        // be proposed too). Here
        // h² − 1 = 0 (B = 0, C = −1) round the unit rod along z: the points
        // (cos kπ/4, sin kπ/4, ±1).
        let base = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        let pts = around_cylinder(&base, DVec3::Z, |_| (0.0, -1.0), DVec3::ZERO);
        let mut want = Vec::new();
        for k in 0..RING_SAMPLES {
            let t = PI * k as f64 / 4.0;
            want.extend([DVec3::new(fmath::cos(t), fmath::sin(t), 1.0), DVec3::new(fmath::cos(t), fmath::sin(t), -1.0)]);
        }
        proposes_among(&pts, &want, "flat discriminant");
    }

    #[test]
    fn a_touch_is_a_double_root() {
        // The line y = 1 from (−2, 1, 0) along x grazes the unit ball at
        // (0, 1, 0), t = 2: B = o·d = −2, C = |o|² − 1 = 4, so d = B² − C
        // = 0 and t² − 4t + 4 = (t − 2)². A touch is a double root: like a
        // crossing, it gives two roots (sum −2B = 4, product C = 4), here
        // both 2, and knowing one leaves the other, −2B − 2 = 2.
        assert_eq!(quadratic(-2.0, 4.0, None), vec![2.0, 2.0]);
        let line = Curve::Line { origin: DVec3::new(-2.0, 1.0, 0.0), dir: DVec3::X };
        let ball = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        assert_eq!(curve_surface(&line, &ball, &[]), vec![2.0, 2.0]);
        assert_eq!(curve_surface(&line, &ball, &[2.0]), vec![2.0]);
        // Crossing, y = 0.6: x = ±0.8, t = 2 ∓ 0.8 (sum 4, product 3.36 =
        // C = 4 + 0.36 − 1). Missing, y = 1.5: no roots, the nearest point
        // t = −B = 2.
        let r = quadratic(-2.0, 3.36, None);
        assert!(r.len() == 2 && close(r[0], 2.8, 1e-14) && close(r[1], 1.2, 1e-14), "{r:?}");
        assert_eq!(quadratic(-2.0, 5.25, None), vec![2.0]);
    }

    #[test]
    fn a_curve_within_linear_of_a_circle_s_plane_is_in_it() {
        // Parallel to the unit circle's plane z = 0 and h above it: the
        // line y = ½, and the unit circle about (1, 0, h). In the plane
        // they would meet the circle at (±√¾, ½) and (½, ±√¾). Within
        // LINEAR (0.9× and exactly 1×, as everywhere) counts as in the
        // plane: they are met as if coplanar, at points 1 from the centres,
        // for the caller to measure as touching (each within h of both).
        // The line's: x² + ¼ + h² = 1, so (±√(¾ − h²), ½, h). The circles':
        // halfway along the line of centres (1, 0, h), whose length is
        // √(1 + h²), and √(1 − (1 + h²)/4) across it, along y:
        // (½, ±√((3 − h²)/4)/√(1 + h²), h/2). At 1.1× they are apart:
        // nothing.
        let c1 = Curve::Circle { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        for k in [0.9, 1.0, 1.1] {
            let h = k * LINEAR;
            let line = Curve::Line { origin: DVec3::new(-3.0, 0.5, h), dir: DVec3::X };
            let c2 = Curve::Circle { center: DVec3::new(1.0, 0.0, h), axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
            let (x, y) = ((0.75 - h * h).sqrt(), ((3.0 - h * h) / 4.0).sqrt() / (1.0 + h * h).sqrt());
            for (other, want) in [(&line, [DVec3::new(x, 0.5, h), DVec3::new(-x, 0.5, h)]), (&c2, [DVec3::new(0.5, y, h / 2.0), DVec3::new(0.5, -y, h / 2.0)])] {
                let got = curve_curve(&c1, other, &[]);
                if k > 1.0 {
                    assert_eq!(got, Vec::<DVec3>::new(), "{k}× LINEAR off the plane");
                } else {
                    assert_eq!(got.len(), 2, "{k}×: {got:?}");
                    for w in want {
                        assert!(got.iter().any(|g| g.distance(w) <= 1e-12), "{k}×: {w} not in {got:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn an_interval_is_ruled_out_only_past_its_bound() {
        // f = k0 + cos θ, slope bound 1, with k0 chosen so that at the
        // middle m of the 12th starting interval [11, 12]·2π/64, f(m)
        // equals the bound (width/2 = 2π/128) exactly. Exactly, in
        // doubles: the ends lie in [1, 2), so their difference and its half
        // are multiples of 2^-53; cos m ≈ 0.4276 lies in [¼, ½), a multiple
        // of 2^-54; so k0 = bound − cos m ≈ −0.3785 is a double, and
        // f(m) = k0 + cos m = bound. Both sides are rounded, so only a
        // bigger |f(mid)| rules an interval out: this one is split, and its
        // halves are ruled out (at m ∓ 2π/256, f = bound + cos(m ∓ 2π/256)
        // − cos m ≈ 0.0711 and 0.0268, above their bound 2π/256 ≈ 0.0245).
        // So it costs 2 evaluations more than with k0 a hair bigger, which
        // rules the interval out at once. Either way the zeros are where
        // cos θ = −k0: ±acos(0.3785) ≈ ±1.1827 (outside the interval).
        let (a, b) = (TAU * 11.0 / 64.0, TAU * 12.0 / 64.0);
        let m = 0.5 * (a + b);
        let bound = (b - a) / 2.0;
        let k0 = bound - fmath::cos(m);
        let tie = Trig2([k0, 1.0, 0.0, 0.0, 0.0]);
        assert_eq!(tie.eval(m), bound, "the tie is exact");
        let above = Trig2([k0 + 1e-15, 1.0, 0.0, 0.0, 0.0]);
        assert!(above.eval(m) > bound);
        let ((z_tie, n_tie), (z_above, n_above)) = (trig_zeros_counted(&tie), trig_zeros_counted(&above));
        assert_eq!(n_tie, n_above + 2);
        let want = sorted(vec![fmath::acos(-k0), TAU - fmath::acos(-k0)]);
        for z in [sorted(z_tie), sorted(z_above)] {
            assert_eq!(z.len(), 2, "{z:?}");
            assert!(close(z[0], want[0], 1e-12) && close(z[1], want[1], 1e-12), "{z:?} vs {want:?}");
        }
        assert!(close(want[0], 1.1827, 1e-4), "{want:?}");
    }

    /// Each wanted point is among those proposed (others may be too).
    fn proposes_among(got: &[DVec3], want: &[DVec3], label: &str) {
        for w in want {
            assert!(got.iter().any(|g| g.distance(*w) <= 1e-12 * w.length().max(1.0) * 20.0), "{label}: {w} not in {got:?}");
        }
    }
}
