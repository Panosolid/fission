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
        k0 + k1 * t.cos() + k2 * t.sin() + k3 * (2.0 * t).cos() + k4 * (2.0 * t).sin()
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
            k[1] += 2.0 * v * t.cos() / n;
            k[2] += 2.0 * v * t.sin() / n;
            k[3] += 2.0 * v * (2.0 * t).cos() / n;
            k[4] += 2.0 * v * (2.0 * t).sin() / n;
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
    let slope = f.slope_bound();
    if slope == 0.0 {
        // Constant: zero everywhere or nowhere; callers handle "everywhere"
        // (a curve lying in a surface) before asking.
        return vec![];
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
        let steps = (((b - a) / LEAF_WIDTH).ceil() as usize).clamp(1, 64);
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
    out.iter().map(|t| t.rem_euclid(TAU)).collect()
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
    let m = b.hypot(c);
    if m == 0.0 {
        return vec![];
    }
    let phi = c.atan2(b);
    if let Some(k) = known {
        return vec![2.0 * phi - k];
    }
    let s = -a / m;
    if s.abs() <= 1.0 {
        let d = s.acos();
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
            let across = |v: DVec3| v - a * v.dot(a);
            let w = across(center - c);
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
            let (xa, ya) = (across(x), across(y));
            let f = Trig2::fit(|t| (w + (xa * t.cos() + ya * t.sin()) * rho).length_squared() - radius * radius);
            trig_zeros(&f)
        }
    }
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
            // An ellipse: over the cylinder at angle θ, the height h with
            // n·(c + r w(θ) + h a − o) = 0.
            let y = axis.cross(x_dir);
            ring(|t| {
                let w = (x_dir * t.cos() + y * t.sin()) * radius;
                c + w + axis * (-(n.dot(c + w - po)) / na)
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
            let y = axis.cross(x_dir);
            let off = (s - c) - axis * (s - c).dot(axis);
            let h0 = (s - c).dot(axis);
            if off.length() <= LINEAR {
                // Centre on the axis: circles at h0 ± √(R² − r²).
                let d2 = (big_r - radius) * (big_r + radius);
                let hs = if d2 <= 0.0 { vec![h0] } else { vec![h0 + d2.sqrt(), h0 - d2.sqrt()] };
                return hs.into_iter().flat_map(|h| circle_points(c + axis * h, axis, radius)).collect();
            }
            // Over angle θ: h² + 2Bh + C = 0 with d = c + r w(θ) − s,
            // B = a·d, C = |d|² − R².
            around_cylinder(c, axis, x_dir, y, radius, |d| (d.dot(axis), d.length_squared() - big_r * big_r), s)
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
            let y = a1.cross(x_dir);
            around_cylinder(
                c1,
                a1,
                x_dir,
                y,
                r1,
                |d| {
                    let dp = d - a2 * d.dot(a2);
                    (dp.dot(e) / e2, (dp.length() - r2) * (dp.length() + r2) / e2)
                },
                c2,
            )
        }
    }
}

/// Points round a cylinder (origin c, axis a, frame x, y, radius r) on the
/// curve where h² + 2B h + C = 0, with (B, C) = coeffs(c + r w(θ) − other)
/// at each angle θ. The discriminant D(θ) = B² − C is ≥ 0 on each closed
/// piece of the curve, and every piece that is not a whole loop round the
/// cylinder holds a maximum of D, so the angles proposed are D's turning
/// points plus fixed angles (for loops round the cylinder); at each, both
/// heights −B ± √D, or −B, where the surfaces come closest, if D < 0.
fn around_cylinder(
    c: DVec3,
    a: DVec3,
    x: DVec3,
    y: DVec3,
    r: f64,
    coeffs: impl Fn(DVec3) -> (f64, f64),
    other: DVec3,
) -> Vec<DVec3> {
    let w = |t: f64| (x * t.cos() + y * t.sin()) * r;
    let disc = |t: f64| {
        let (b, cc) = coeffs(c + w(t) - other);
        b * b - cc
    };
    let d = Trig2::fit(disc);
    let mut angles = trig_zeros(&d.derivative());
    angles.extend((0..RING_SAMPLES).map(|i| TAU * i as f64 / RING_SAMPLES as f64));
    let mut out = Vec::new();
    for t in angles {
        let (b, cc) = coeffs(c + w(t) - other);
        let base = c + w(t);
        for h in quadratic(b, cc, None) {
            out.push(base + a * h);
        }
    }
    out
}

/// RING_SAMPLES points of the circle with this centre, normal and radius.
fn circle_points(center: DVec3, normal: DVec3, radius: f64) -> Vec<DVec3> {
    let x = crate::geom::any_perpendicular(normal);
    let y = normal.cross(x);
    ring(|t| center + (x * t.cos() + y * t.sin()) * radius)
}

fn ring(p: impl Fn(f64) -> DVec3) -> Vec<DVec3> {
    (0..RING_SAMPLES).map(|i| p(TAU * i as f64 / RING_SAMPLES as f64)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_3};

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
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
            let a = 0.75f64.acos();
            assert!(close(z[0], a, 1e-14) && close(z[1], TAU - a, 1e-14), "{z:?}");
        }
        // Tilted: the unit circle in the plane x = 0 against a rod of
        // radius 0.6 along z. A point (0, cos θ, sin θ) is |cos θ| from the
        // axis: 0.6 at θ = ±acos 0.6 and π ± acos 0.6, four crossings.
        let upright = Curve::Circle { center: DVec3::ZERO, axis: DVec3::X, x_dir: DVec3::Y, radius: 1.0 };
        let thin = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 0.6 };
        let z = sorted(curve_surface(&upright, &thin, &[]));
        let a = 0.6f64.acos();
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
}
