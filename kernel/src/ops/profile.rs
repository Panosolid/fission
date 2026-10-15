//! Planar profiles: closed outlines of straight segments and circular arcs,
//! or full circles, in the XY plane, and the rules that make one valid.
//!
//! An arc between two corners is given by its bulge, as in DXF files:
//! tan(sweep / 4), where sweep is the signed angle the arc turns through
//! (positive counter-clockwise). 0 is straight, ±1 a half circle. From the
//! chord a→b of length c, with β the bulge:
//!   radius r = c (1 + β²) / (4|β|),
//!   centre   = midpoint + perp(b − a) (1 − β²) / (4β),
//! because the centre sits on the chord's perpendicular bisector at
//! (c/2)·cot(sweep/2) to the left, and cot(sweep/2) = (1 − β²)/(2β).

use super::KernelError;
use crate::tolerance::{segments_touch, side, ANGULAR, LINEAR, MAX_COORD, MAX_PROFILE_CORNERS, MAX_SIZE, MIN_FEATURE};
use glam::DVec2;
use std::f64::consts::TAU;

/// One closed outline of a profile.
#[derive(Clone, Debug, PartialEq)]
pub enum Boundary {
    /// Corners joined by straight segments or arcs; the last corner joins
    /// back to the first. `bulges` is empty (all straight) or has one entry
    /// per corner: entry i shapes the piece from corner i to corner i + 1.
    Path { corners: Vec<DVec2>, bulges: Vec<f64> },
    /// A full circle.
    Circle { center: DVec2, radius: f64 },
}

impl Boundary {
    pub fn polygon(corners: Vec<DVec2>) -> Self {
        Boundary::Path { corners, bulges: vec![] }
    }
}

/// An outline and the holes in it, each in either direction.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub outer: Boundary,
    pub holes: Vec<Boundary>,
}

impl Profile {
    pub fn polygon(outer: Vec<DVec2>, holes: Vec<Vec<DVec2>>) -> Self {
        Profile { outer: Boundary::polygon(outer), holes: holes.into_iter().map(Boundary::polygon).collect() }
    }
}

/// One piece of a checked loop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Line { a: DVec2, b: DVec2 },
    /// From `a` to `b` about `center`, turning `sweep` radians (positive
    /// counter-clockwise), 0 < |sweep| < 2π.
    Arc { a: DVec2, b: DVec2, center: DVec2, radius: f64, sweep: f64 },
    /// A whole circle, run counter-clockwise when `ccw`.
    Circle { center: DVec2, radius: f64, ccw: bool },
}

fn perp(v: DVec2) -> DVec2 {
    DVec2::new(-v.y, v.x)
}

/// Unit vector at angle `t`.
fn dir(t: f64) -> DVec2 {
    DVec2::new(t.cos(), t.sin())
}

impl Seg {
    /// The arc for a bulge, or a line for bulge 0. None if the arc's radius
    /// is outside [MIN_FEATURE, MAX_SIZE] (or not finite).
    pub fn from_bulge(a: DVec2, b: DVec2, bulge: f64) -> Option<Seg> {
        if bulge == 0.0 {
            return Some(Seg::Line { a, b });
        }
        let c = a.distance(b);
        let radius = c * (1.0 + bulge * bulge) / (4.0 * bulge.abs());
        if !(MIN_FEATURE..=MAX_SIZE).contains(&radius) {
            return None;
        }
        let center = (a + b) * 0.5 + perp(b - a) * ((1.0 - bulge * bulge) / (4.0 * bulge));
        Some(Seg::Arc { a, b, center, radius, sweep: 4.0 * bulge.atan() })
    }

    /// End points (none for a circle).
    pub fn ends(&self) -> Vec<DVec2> {
        match *self {
            Seg::Line { a, b } | Seg::Arc { a, b, .. } => vec![a, b],
            Seg::Circle { .. } => vec![],
        }
    }

    fn circle(&self) -> Option<(DVec2, f64)> {
        match *self {
            Seg::Line { .. } => None,
            Seg::Arc { center, radius, .. } | Seg::Circle { center, radius, .. } => Some((center, radius)),
        }
    }

    /// Whether the direction from the centre at angle `t` falls on the arc.
    fn spans(&self, t: f64) -> bool {
        match *self {
            Seg::Line { .. } => false,
            Seg::Circle { .. } => true,
            Seg::Arc { a, center, sweep, .. } => {
                let start = (a - center).to_angle();
                let turned = if sweep > 0.0 { (t - start).rem_euclid(TAU) } else { (start - t).rem_euclid(TAU) };
                turned <= sweep.abs()
            }
        }
    }

    /// Whether point `p` (assumed on the circle) lies on the arc.
    fn spans_point(&self, p: DVec2) -> bool {
        self.circle().is_some_and(|(c, _)| self.spans((p - c).to_angle()))
    }

    /// Closest point of the piece to `p`.
    pub fn closest(&self, p: DVec2) -> DVec2 {
        match *self {
            Seg::Line { a, b } => {
                let ab = b - a;
                a + ab * ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0)
            }
            Seg::Arc { a, b, center, radius, .. } => {
                let d = p - center;
                if d != DVec2::ZERO && self.spans(d.to_angle()) {
                    center + d * (radius / d.length())
                } else if p.distance_squared(a) <= p.distance_squared(b) {
                    a
                } else {
                    b
                }
            }
            Seg::Circle { center, radius, .. } => {
                let d = p - center;
                center + if d == DVec2::ZERO { DVec2::X * radius } else { d * (radius / d.length()) }
            }
        }
    }

    pub fn distance(&self, p: DVec2) -> f64 {
        p.distance(self.closest(p))
    }

    /// Unit direction of travel leaving the start, and arriving at the end.
    fn tangents(&self) -> (DVec2, DVec2) {
        match *self {
            Seg::Line { a, b } => {
                let d = (b - a).normalize();
                (d, d)
            }
            Seg::Arc { a, b, center, sweep, .. } => {
                let s = sweep.signum();
                (perp((a - center).normalize()) * s, perp((b - center).normalize()) * s)
            }
            Seg::Circle { .. } => (DVec2::ZERO, DVec2::ZERO),
        }
    }

    /// Points on `self` where the distance to `other` can have a minimum or
    /// maximum: its ends, and where its normal is also the other's normal.
    /// Taken from both pieces of a pair, they include every local minimum
    /// of the distance between them. (A line needs nothing beyond its ends:
    /// where the closest pair is inside both pieces, the circle's point is
    /// one of its own candidates below, and the line's point is the
    /// nearest point to it.)
    fn critical_points(&self, other: &Seg) -> Vec<DVec2> {
        let mut out = self.ends();
        match (self.circle(), other.circle()) {
            // Around a circle, distance to a line is extreme where the
            // circle's normal is the line's normal.
            (Some((c, r)), None) => {
                if let Seg::Line { a, b } = *other {
                    let n = perp((b - a).normalize());
                    out.extend([c + n * r, c - n * r].into_iter().filter(|&p| self.spans_point(p)));
                }
            }
            // Between circles, a pair of points inside both pieces where the
            // distance is least (or a neck: a local least) lies on the line
            // of centres, one point from {c1 ± u·r1}, the other from
            // {c2 ± u·r2}, u = (c2 − c1)/|c2 − c1|. The pair facing away
            // from each other, c1 − u·r1 and c2 + u·r2, is d + r1 + r2
            // apart, the farthest any two points of the circles can be, so
            // never a least. Every other pair has a facing point (c1 + u·r1,
            // or c2 − u·r2 = c2 + (−u)·r2 from the other side), and one is
            // enough: its distance to the other piece is at most the pair's.
            // Concentric circles are the same distance apart all round
            // their overlap, which ends at an end of one of the pieces (a
            // candidate already), unless both are whole circles: then any
            // point will do.
            (Some((c, r)), Some((oc, _))) => {
                let d = oc - c;
                if d.length() > LINEAR * 1e-3 {
                    let facing = c + d.normalize() * r;
                    out.extend(Some(facing).filter(|&p| self.spans_point(p)));
                } else if out.is_empty() && other.ends().is_empty() {
                    out.push(c + DVec2::X * r);
                }
            }
            (None, _) => {}
        }
        out
    }
}

/// Whether two pieces cross or overlap anywhere other than at the points
/// they share (corners joining them in a loop).
fn crossing(s: &Seg, t: &Seg, shared: &[DVec2]) -> bool {
    let away = |x: DVec2| shared.iter().all(|&p| x.distance(p) > LINEAR);
    match (*s, *t) {
        (Seg::Line { a, b }, Seg::Line { a: c, b: d }) => shared.is_empty() && segments_touch((a, b), (c, d)),
        (Seg::Line { a, b }, other) | (other, Seg::Line { a, b }) => {
            let (c, r) = other.circle().expect("not a line");
            match shared {
                // (`> LINEAR` versus `>= LINEAR` below differ only when the
                // other root is exactly 1 nm away: not a case anyone can build.)
                // Sharing an end P (on both): the line meets the circle again
                // at distance −2u·(P − c) from P along the line's direction
                // u, the other root of |P + s u − c|² = r² besides s = 0.
                // No square root, so tangency gives s ≈ 0 rather than noise.
                [p] => {
                    let far = if a.distance(*p) <= b.distance(*p) { b } else { a };
                    let len = far.distance(*p);
                    let u = (far - *p) / len;
                    let s_other = -2.0 * u.dot(*p - c);
                    let x = *p + u * s_other;
                    // Up to and including the line's far end: ending on the
                    // circle there is touching it.
                    s_other > LINEAR && s_other <= len && other.spans_point(x)
                }
                [] => {
                    let len = a.distance(b);
                    let u = (b - a) / len;
                    let w = a - c;
                    let half_b = u.dot(w);
                    let disc = half_b * half_b - (w.length_squared() - r * r);
                    disc >= 0.0
                        && [-half_b - disc.sqrt(), -half_b + disc.sqrt()]
                            .into_iter()
                            .any(|s| (0.0..=len).contains(&s) && other.spans_point(a + u * s))
                }
                // A line and a circle meet at most twice: both are shared.
                _ => false,
            }
        }
        (s, t) => {
            let ((c1, r1), (c2, r2)) = (s.circle().expect("arc"), t.circle().expect("arc"));
            let d = c2 - c1;
            if d.length() <= LINEAR * 1e-3 && (r1 - r2).abs() <= LINEAR {
                // The same circle: they overlap unless they only touch at ends.
                return match (s, t) {
                    // Overlap shows as an end of one inside the other, or (when
                    // every end is shared) as the same arc run back the other
                    // way. Two arcs turning the same way between the same two
                    // points of one circle add up to exactly a full turn.
                    (Seg::Arc { sweep: s1, .. }, Seg::Arc { sweep: s2, .. }) => {
                        let probes = [s.ends(), t.ends()].concat();
                        probes.iter().any(|&p| away(p) && s.spans_point(p) && t.spans_point(p))
                            || (s1.signum() != s2.signum() && !shared.is_empty())
                    }
                    _ => true,
                };
            }
            match shared {
                // Two circles through P meet again at P mirrored in the line
                // of centres (exact up to rounding, no square root). Their
                // centres are apart: both pass through P, so concentric ones
                // would have equal radii and be the same circle, above.
                [p] => {
                    let foot = c1 + d * ((*p - c1).dot(d) / d.length_squared());
                    let x = foot * 2.0 - *p;
                    x.distance(*p) > LINEAR && s.spans_point(x) && t.spans_point(x)
                }
                [] => {
                    let dist = d.length();
                    if dist > r1 + r2 || dist < (r1 - r2).abs() || dist <= LINEAR * 1e-3 {
                        return false;
                    }
                    let along = (dist * dist + r1 * r1 - r2 * r2) / (2.0 * dist);
                    let h = (r1 * r1 - along * along).max(0.0).sqrt();
                    let u = d / dist;
                    [c1 + u * along + perp(u) * h, c1 + u * along - perp(u) * h]
                        .into_iter()
                        .any(|x| s.spans_point(x) && t.spans_point(x))
                }
                _ => false,
            }
        }
    }
}

/// Smallest distance between two pieces, ignoring where they meet at the
/// points they share: 0 if they cross. Every local minimum of the distance
/// from one to the other is at one of the critical points, so a "neck"
/// (pieces coming back close after meeting at a corner) is caught too.
pub fn clearance(s: &Seg, t: &Seg, shared: &[DVec2]) -> f64 {
    if crossing(s, t, shared) {
        return 0.0;
    }
    let near_shared = |x: DVec2| shared.iter().any(|&p| x.distance(p) <= LINEAR);
    let mut best = f64::INFINITY;
    for (u, v) in [(s, t), (t, s)] {
        for x in u.critical_points(v) {
            if !near_shared(x) {
                best = best.min(v.distance(x));
            }
        }
    }
    best
}

/// Area enclosed by a loop, positive counter-clockwise: the shoelace sum
/// over its corners (relative to the first, to keep digits far from the
/// origin) plus, for each arc, the circular segment between it and its
/// chord, (r²/2)(sweep − sin sweep).
pub fn signed_area(segs: &[Seg]) -> f64 {
    let o = segs.iter().find_map(|s| s.ends().first().copied()).unwrap_or(DVec2::ZERO);
    let mut twice = 0.0;
    for s in segs {
        match *s {
            Seg::Line { a, b } => twice += (a - o).perp_dot(b - o),
            Seg::Arc { a, b, radius, sweep, .. } => {
                twice += (a - o).perp_dot(b - o) + radius * radius * (sweep - sweep.sin());
            }
            Seg::Circle { radius, ccw, .. } => twice += radius * radius * TAU * if ccw { 1.0 } else { -1.0 },
        }
    }
    twice / 2.0
}

/// Length of a loop.
pub fn perimeter(segs: &[Seg]) -> f64 {
    segs.iter()
        .map(|s| match *s {
            Seg::Line { a, b } => a.distance(b),
            Seg::Arc { radius, sweep, .. } => radius * sweep.abs(),
            Seg::Circle { radius, .. } => radius * TAU,
        })
        .sum()
}

/// Axis-aligned bounds of a piece: its ends plus whichever of the circle's
/// four axis extremes the arc passes through.
fn bounds(s: &Seg) -> (DVec2, DVec2) {
    let mut pts = s.ends();
    if let Some((c, r)) = s.circle() {
        pts.extend([0.0, 0.25, 0.5, 0.75].map(|k| k * TAU).into_iter().filter(|&t| s.spans(t)).map(|t| c + dir(t) * r));
    }
    pts.iter().fold((DVec2::INFINITY, DVec2::NEG_INFINITY), |(lo, hi), &p| (lo.min(p), hi.max(p)))
}

/// Winding number of a loop around `p`, which must be clear of the loop.
/// Each piece adds the angle it sweeps as seen from p: a straight piece the
/// angle between its ends; an arc the same plus a full turn (in its own
/// direction) when p lies between it and its chord.
fn winding(segs: &[Seg], p: DVec2) -> i64 {
    let angle = |a: DVec2, b: DVec2| (a - p).perp_dot(b - p).atan2((a - p).dot(b - p));
    let mut total = 0.0;
    for s in segs {
        match *s {
            Seg::Line { a, b } => total += angle(a, b),
            Seg::Arc { a, b, center, radius, sweep } => {
                total += angle(a, b);
                // Between arc and chord: inside the circle and on the arc's
                // side of the chord (the side its middle is on).
                let mid = center + dir((a - center).to_angle() + sweep / 2.0) * radius;
                let arc_side = side(a, b, mid);
                if p.distance(center) < radius && side(a, b, p) == arc_side {
                    total += TAU * sweep.signum();
                }
            }
            Seg::Circle { center, radius, ccw } => {
                if p.distance(center) < radius {
                    total += if ccw { TAU } else { -TAU };
                }
            }
        }
    }
    (total / TAU).round() as i64
}

/// Whether a loop runs counter-clockwise. At the loop's lowest point the
/// region lies above, so the loop runs left to right there: at a corner,
/// the turn decides (exactly, for two straight pieces); along a curve or a
/// straight-through corner, the direction of travel.
fn counter_clockwise(segs: &[Seg]) -> bool {
    if let [Seg::Circle { ccw, .. }] = segs {
        return *ccw;
    }
    // Lowest point: a corner, or an arc's bottom.
    let mut best: Option<(DVec2, usize, bool)> = None; // (point, piece, is the start corner of piece)
    let lower = |p: DVec2, q: DVec2| p.y < q.y || (p.y == q.y && p.x < q.x);
    for (i, s) in segs.iter().enumerate() {
        let a = s.ends()[0];
        if best.is_none_or(|(q, _, _)| lower(a, q)) {
            best = Some((a, i, true));
        }
        if let Seg::Arc { center, radius, .. } = *s {
            let bottom = center - DVec2::Y * radius;
            if s.spans(-TAU / 4.0) && best.is_none_or(|(q, _, _)| lower(bottom, q)) {
                best = Some((bottom, i, false));
            }
        }
    }
    let (_, i, corner) = best.expect("a path has corners");
    let s = &segs[i];
    if !corner {
        let Seg::Arc { sweep, .. } = *s else { unreachable!() };
        return sweep > 0.0;
    }
    let prev = &segs[(i + segs.len() - 1) % segs.len()];
    if let (Seg::Line { a: p0, .. }, Seg::Line { a: p1, b: p2 }) = (*prev, *s) {
        let turn = side(p0, p1, p2);
        if turn != 0 {
            return turn > 0;
        }
    }
    let (t_in, t_out) = (prev.tangents().1, s.tangents().0);
    let turn = t_in.perp_dot(t_out);
    if turn.abs() > ANGULAR {
        turn > 0.0
    } else {
        t_out.x > 0.0
    }
}

fn reversed(segs: &[Seg]) -> Vec<Seg> {
    segs.iter()
        .rev()
        .map(|s| match *s {
            Seg::Line { a, b } => Seg::Line { a: b, b: a },
            Seg::Arc { a, b, center, radius, sweep } => Seg::Arc { a: b, b: a, center, radius, sweep: -sweep },
            Seg::Circle { center, radius, ccw } => Seg::Circle { center, radius, ccw: !ccw },
        })
        .collect()
}

/// Checks a profile and returns its loops as pieces, the outer one
/// counter-clockwise and holes clockwise (seen from +Z).
///
/// Rules, every one a clean `InvalidInput` when broken:
/// - at most MAX_PROFILE_CORNERS corners in all (a circle counts as one);
///   a path has at least 2 corners (3 if all straight), all finite and
///   within MAX_COORD, and one bulge per corner (or none), all finite;
/// - circle and arc radii are within [MIN_FEATURE, MAX_SIZE]; arcs and
///   circles stay within MAX_COORD; the outer loop spans at most MAX_SIZE;
/// - no corner where the outline doubles back on itself (a cusp);
/// - any two pieces, in any loops, are at least MIN_FEATURE apart, apart
///   from where they meet at a shared corner; this also rules out crossings,
///   zero-length pieces, slivers and necks;
/// - every hole is inside the outer loop and outside every other hole.
pub fn check_profile(profile: &Profile) -> Result<Vec<Vec<Seg>>, KernelError> {
    let bad = |m: String| Err(KernelError::InvalidInput(m));
    let all: Vec<&Boundary> = std::iter::once(&profile.outer).chain(&profile.holes).collect();
    let total: usize = all
        .iter()
        .map(|b| match b {
            Boundary::Path { corners, .. } => corners.len(),
            Boundary::Circle { .. } => 1,
        })
        .sum();
    if total > MAX_PROFILE_CORNERS {
        return bad(format!("profile has {total} corners; the limit is {MAX_PROFILE_CORNERS}"));
    }
    let in_space = |p: DVec2| p.is_finite() && p.abs().max_element() <= MAX_COORD;
    let mut loops: Vec<Vec<Seg>> = Vec::new();
    for (k, b) in all.iter().enumerate() {
        let segs = match b {
            Boundary::Circle { center, radius } => {
                if !(MIN_FEATURE..=MAX_SIZE).contains(radius) {
                    return bad(format!("circle radius {radius} must be within [{MIN_FEATURE}, {MAX_SIZE:e}] mm"));
                }
                vec![Seg::Circle { center: *center, radius: *radius, ccw: true }]
            }
            Boundary::Path { corners, bulges } => {
                let n = corners.len();
                if !bulges.is_empty() && bulges.len() != n {
                    return bad(format!("profile loop {k} has {n} corners but {} bulges", bulges.len()));
                }
                if let Some(p) = corners.iter().find(|p| !in_space(**p)) {
                    return bad(format!("profile corner {p} is not finite or is beyond {MAX_COORD:e} mm"));
                }
                if let Some(x) = bulges.iter().find(|x| !x.is_finite()) {
                    return bad(format!("profile bulge {x} is not finite"));
                }
                let curved = bulges.iter().any(|&x| x != 0.0);
                if n < 2 || (n < 3 && !curved) {
                    return bad(format!("profile loop {k} has {n} corners; at least 3 are needed (2 with an arc)"));
                }
                let mut segs = Vec::with_capacity(n);
                for i in 0..n {
                    let bulge = bulges.get(i).copied().unwrap_or(0.0);
                    match Seg::from_bulge(corners[i], corners[(i + 1) % n], bulge) {
                        Some(s) => segs.push(s),
                        None => {
                            return bad(format!(
                                "profile loop {k}, piece {i}: arc radius must be within [{MIN_FEATURE}, {MAX_SIZE:e}] mm"
                            ))
                        }
                    }
                }
                segs
            }
        };
        for s in &segs {
            let (lo, hi) = bounds(s);
            if !in_space(lo) || !in_space(hi) {
                return bad(format!("profile loop {k} reaches beyond {MAX_COORD:e} mm"));
            }
        }
        loops.push(segs);
    }
    let (lo, hi) = loops[0].iter().map(bounds).fold((DVec2::INFINITY, DVec2::NEG_INFINITY), |(lo, hi), (l, h)| (lo.min(l), hi.max(h)));
    if (hi - lo).max_element() > MAX_SIZE {
        return bad(format!("profile spans {:e} mm; the limit is {MAX_SIZE:e} mm", (hi - lo).max_element()));
    }
    // Cusps: arriving at a corner and leaving straight back the way it came.
    for (k, segs) in loops.iter().enumerate() {
        for i in 0..segs.len() {
            let (s, t) = (&segs[i], &segs[(i + 1) % segs.len()]);
            if matches!(s, Seg::Circle { .. }) {
                continue;
            }
            let (t_in, t_out) = (s.tangents().1, t.tangents().0);
            if t_in.dot(t_out) < 0.0 && t_in.perp_dot(t_out).abs() <= ANGULAR {
                return bad(format!("profile loop {k} doubles back on itself at {}", s.ends()[1]));
            }
        }
    }
    // Clearance between every two pieces.
    let pieces: Vec<(usize, usize, &Seg)> =
        loops.iter().enumerate().flat_map(|(k, l)| l.iter().enumerate().map(move |(i, s)| (k, i, s))).collect();
    for (m, &(k, i, s)) in pieces.iter().enumerate() {
        for &(kk, j, t) in &pieces[m + 1..] {
            let shared: Vec<DVec2> = if k == kk {
                let n = loops[k].len();
                let mut sh = vec![];
                if (i + 1) % n == j {
                    sh.push(s.ends()[1]);
                }
                if (j + 1) % n == i {
                    sh.push(t.ends()[1]);
                }
                sh
            } else {
                vec![]
            };
            let gap = clearance(s, t, &shared);
            if gap < MIN_FEATURE {
                return bad(format!(
                    "profile pieces ({k}, {i}) and ({kk}, {j}) (loop, piece) are {gap:e} mm apart; features must be at least {MIN_FEATURE} mm"
                ));
            }
        }
    }
    // No crossings and everything clear, so each hole is wholly inside or
    // outside each other loop: one point of it decides.
    let probe = |segs: &[Seg]| match segs[0] {
        Seg::Circle { center, radius, .. } => center + DVec2::X * radius,
        s => s.ends()[0],
    };
    for h in 1..loops.len() {
        let p = probe(&loops[h]);
        if winding(&loops[0], p) == 0 {
            return bad(format!("profile hole {} is not inside the outer loop", h - 1));
        }
        if let Some(o) = (1..loops.len()).find(|&g| g != h && winding(&loops[g], p) != 0) {
            return bad(format!("profile hole {} is inside hole {}; islands need a separate extrude", h - 1, o - 1));
        }
    }
    Ok(loops
        .iter()
        .enumerate()
        .map(|(k, segs)| if counter_clockwise(segs) == (k == 0) { segs.clone() } else { reversed(segs) })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::eq;
    use std::f64::consts::{FRAC_PI_2, PI};

    fn p(x: f64, y: f64) -> DVec2 {
        DVec2::new(x, y)
    }

    fn square(x0: f64, y0: f64, s: f64) -> Vec<DVec2> {
        vec![p(x0, y0), p(x0 + s, y0), p(x0 + s, y0 + s), p(x0, y0 + s)]
    }

    fn path(corners: &[(f64, f64)], bulges: &[f64]) -> Boundary {
        Boundary::Path { corners: corners.iter().map(|&(x, y)| p(x, y)).collect(), bulges: bulges.to_vec() }
    }

    fn ok(profile: Profile) -> Vec<Vec<Seg>> {
        check_profile(&profile).unwrap_or_else(|e| panic!("{e:?}"))
    }

    fn refused(profile: Profile) -> String {
        match check_profile(&profile) {
            Err(KernelError::InvalidInput(m)) => m,
            other => panic!("accepted: {other:?}"),
        }
    }

    /// Upper half of the unit circle, (1,0) → (−1,0) counter-clockwise.
    fn upper_half() -> Seg {
        Seg::from_bulge(p(1.0, 0.0), p(-1.0, 0.0), 1.0).unwrap()
    }

    /// Turned by `angle`, scaled by `k` > 0 about the origin, then moved by
    /// `shift`. Turning and scaling keep every arc's sweep.
    fn placed(seg: &Seg, angle: f64, k: f64, shift: DVec2) -> Seg {
        let f = |q: DVec2| DVec2::from_angle(angle).rotate(q) * k + shift;
        match *seg {
            Seg::Line { a, b } => Seg::Line { a: f(a), b: f(b) },
            Seg::Arc { a, b, center, radius, sweep } => Seg::Arc { a: f(a), b: f(b), center: f(center), radius: radius * k, sweep },
            Seg::Circle { center, radius, ccw } => Seg::Circle { center: f(center), radius: radius * k, ccw },
        }
    }

    /// Asserts `crossing` gives `expect` for the pieces as given and for
    /// turned, scaled and moved copies of them, either way round. Whether
    /// two pieces cross can't depend on where they are, and odd placements
    /// stop round numbers (centres at the origin, points on the axes) from
    /// hiding a wrong formula that happens to agree at them.
    #[track_caller]
    fn assert_crossing(s: &Seg, t: &Seg, shared: &[DVec2], expect: bool) {
        for (angle, k, shift) in [(0.0, 1.0, p(0.0, 0.0)), (0.7, 2.3, p(3.7, -1.3)), (2.9, 0.031, p(-120.5, 44.25)), (-1.3, 17.0, p(1e4, -2e4))] {
            let f = |q: DVec2| DVec2::from_angle(angle).rotate(q) * k + shift;
            let (s2, t2) = (placed(s, angle, k, shift), placed(t, angle, k, shift));
            let shared2: Vec<DVec2> = shared.iter().map(|&q| f(q)).collect();
            assert_eq!(crossing(&s2, &t2, &shared2), expect, "turned {angle}, scaled {k}, moved {shift}: {s2:?} / {t2:?}");
            assert_eq!(crossing(&t2, &s2, &shared2), expect, "the other way round, turned {angle}, scaled {k}, moved {shift}");
        }
    }

    #[test]
    fn polygon_predicates_by_hand() {
        // Moved here from extrude.rs with the profile code (same values).
        // Segments (0,0)–(2,0) and (1,0)–(1,1): the second starts on the
        // first, so they touch. (3,0)–(4,0) is collinear but past the end.
        let s = |a: (f64, f64), b: (f64, f64)| (p(a.0, a.1), p(b.0, b.1));
        assert!(segments_touch(s((0.0, 0.0), (2.0, 0.0)), s((1.0, 0.0), (1.0, 1.0))));
        assert!(!segments_touch(s((0.0, 0.0), (2.0, 0.0)), s((3.0, 0.0), (4.0, 0.0))));
        // Point (1,1) to segment (0,0)–(2,0): foot at (1,0), distance 1.
        // Point (3,4) to the same segment: nearest is the end (2,0), √(1+16).
        let line = Seg::Line { a: DVec2::ZERO, b: p(2.0, 0.0) };
        assert!(eq(line.distance(p(1.0, 1.0)), 1.0));
        assert!(eq(line.distance(p(3.0, 4.0)), 17f64.sqrt()));
        // (1,1) is inside the 2×2 square from the origin; (3,1) is not; the
        // square as listed runs counter-clockwise.
        let sq = ok(Profile::polygon(square(0.0, 0.0, 2.0), vec![])).remove(0);
        assert_eq!((winding(&sq, p(1.0, 1.0)), winding(&sq, p(3.0, 1.0))), (1, 0));
        assert!(counter_clockwise(&sq));
    }

    #[test]
    fn bulges_become_arcs_by_hand() {
        // Bulge 1 on the chord (0,0)→(2,0): sweep 4·atan 1 = π, a half
        // circle; r = c(1 + 1)/4 = 1; centre = midpoint (1,0) since
        // 1 − β² = 0. Counter-clockwise from angle π it passes angle 3π/2,
        // the point (1,−1): it bulges below the chord.
        let Seg::Arc { center, radius, sweep, .. } = Seg::from_bulge(p(0.0, 0.0), p(2.0, 0.0), 1.0).unwrap() else { panic!() };
        assert!(eq(radius, 1.0) && eq(sweep, PI) && eq(center.x, 1.0) && eq(center.y, 0.0));
        // Bulge tan(π/8): a quarter turn. The chord of 2 subtends 90°, so
        // r = 2/√2 = √2, and the centre is 1 to the left of the midpoint:
        // r·cos 45° = 1, so (1, 1).
        let Seg::Arc { center, radius, sweep, .. } = Seg::from_bulge(p(0.0, 0.0), p(2.0, 0.0), (PI / 8.0).tan()).unwrap() else { panic!() };
        assert!(eq(radius, 2f64.sqrt()) && eq(sweep, FRAC_PI_2) && eq(center.x, 1.0) && eq(center.y, 1.0));
        // Negative bulge: the same quarter circle mirrored, centre (1, −1).
        let Seg::Arc { center, sweep, .. } = Seg::from_bulge(p(0.0, 0.0), p(2.0, 0.0), -(PI / 8.0).tan()).unwrap() else { panic!() };
        assert!(eq(sweep, -FRAC_PI_2) && eq(center.y, -1.0));
        // Radius limits: chord 2·MIN_FEATURE as a half circle has r =
        // MIN_FEATURE (allowed); 1.8·MIN_FEATURE gives 0.9× (refused). A
        // bulge of 1e-9 on a chord of 100 gives r ≈ 100/(4e-9) = 2.5e10 >
        // MAX_SIZE (refused, too flat to be an arc).
        let m = MIN_FEATURE;
        assert!(Seg::from_bulge(p(0.0, 0.0), p(2.2 * m, 0.0), 1.0).is_some());
        assert!(Seg::from_bulge(p(0.0, 0.0), p(1.8 * m, 0.0), 1.0).is_none());
        assert!(Seg::from_bulge(p(0.0, 0.0), p(100.0, 0.0), 1e-9).is_none());
        assert!(Seg::from_bulge(p(0.0, 0.0), p(1.0, 0.0), 0.0) == Some(Seg::Line { a: p(0.0, 0.0), b: p(1.0, 0.0) }));
    }

    #[test]
    fn distance_to_an_arc_by_hand() {
        let arc = upper_half();
        // (0,3) is straight above the centre, on the arc's side: 3 − 1 = 2.
        assert!(eq(arc.distance(p(0.0, 3.0)), 2.0));
        // (0,−3) is below, off the arc: nearest is an end, √(1 + 9).
        assert!(eq(arc.distance(p(0.0, -3.0)), 10f64.sqrt()));
        // (2,2) at 45°: on the arc's span, √8 − 1.
        assert!(eq(arc.distance(p(2.0, 2.0)), 8f64.sqrt() - 1.0));
        // The arc spans (0,1) but not (0,−1).
        assert!(arc.spans_point(p(0.0, 1.0)) && !arc.spans_point(p(0.0, -1.0)));
    }

    #[test]
    fn clearance_by_hand() {
        let arc = upper_half();
        // Line y = 2 from x = −2 to 2 over the unit half circle: closest at
        // the top, (0,1) to (0,2): 1.
        assert!(eq(clearance(&arc, &Seg::Line { a: p(-2.0, 2.0), b: p(2.0, 2.0) }, &[]), 1.0));
        // A vertical line through the arc crosses it at (0,1): 0.
        assert_eq!(clearance(&arc, &Seg::Line { a: p(0.0, 0.0), b: p(0.0, 5.0) }, &[]), 0.0);
        // Unit circles 3 apart: gap 3 − 2 = 1. Concentric radii 1 and 1.5:
        // 0.5. Overlapping circles (centres 1 apart): 0.
        let c = |x: f64, r: f64| Seg::Circle { center: p(x, 0.0), radius: r, ccw: true };
        assert!(eq(clearance(&c(0.0, 1.0), &c(3.0, 1.0), &[]), 1.0));
        assert!(eq(clearance(&c(0.0, 1.0), &c(0.0, 1.5), &[]), 0.5));
        assert_eq!(clearance(&c(0.0, 1.0), &c(1.0, 1.0), &[]), 0.0);
        // Hairpin: line (0,0)→(10,0), then a half circle from (10,0) back to
        // (1, d). They meet at (10,0) (shared, ignored); the arc's far end
        // (1, d) is d above the line, and nothing else is closer.
        for d in [0.5, 2.0] {
            let line = Seg::Line { a: p(0.0, 0.0), b: p(10.0, 0.0) };
            let bend = Seg::from_bulge(p(10.0, 0.0), p(1.0, d), 1.0).unwrap();
            assert!(eq(clearance(&line, &bend, &[p(10.0, 0.0)]), d), "d = {d}");
        }
        // Lines meeting at a corner, ignoring the corner: the far ends.
        // (0,0)→(4,0) and (4,0)→(4,3): (0,0) is 4 from the second, (4,3)
        // is 3 from the first.
        let (l1, l2) = (Seg::Line { a: p(0.0, 0.0), b: p(4.0, 0.0) }, Seg::Line { a: p(4.0, 0.0), b: p(4.0, 3.0) });
        assert!(eq(clearance(&l1, &l2, &[p(4.0, 0.0)]), 3.0));
    }

    #[test]
    fn areas_and_winding_with_arcs_by_hand() {
        // A "D": the chord (−1,0)→(1,0) and the upper unit half circle back.
        // Area π/2 (half the unit disc); perimeter 2 + π.
        let d = Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1.0]), holes: vec![] };
        let segs = ok(d).remove(0);
        assert!(eq(signed_area(&segs), FRAC_PI_2) && eq(perimeter(&segs), 2.0 + PI));
        // Inside at (0, 0.5); outside above the arc and below the chord.
        assert_eq!([(0.0, 0.5), (0.0, 1.5), (0.0, -0.5), (0.9, 0.3)].map(|(x, y)| winding(&segs, p(x, y))), [1, 0, 0, 1]);
        // Listed the other way round (bulge −1 on the first piece, which
        // is the same upper half circle run clockwise): still accepted and
        // returned counter-clockwise, area +π/2.
        let back = Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[-1.0, 0.0]), holes: vec![] };
        let segs = ok(back).remove(0);
        assert!(eq(signed_area(&segs), FRAC_PI_2));
        // A circle of radius 2 as a hole comes back clockwise: −4π.
        let holed = Profile { outer: Boundary::polygon(square(-5.0, -5.0, 10.0)), holes: vec![Boundary::Circle { center: DVec2::ZERO, radius: 2.0 }] };
        let loops = ok(holed);
        assert!(eq(signed_area(&loops[0]), 100.0) && eq(signed_area(&loops[1]), -4.0 * PI));
        // A stadium 10 long, 4 wide: 40 + π·2² (two half discs).
        let slot = Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)], &[0.0, 1.0, 0.0, 1.0]), holes: vec![] };
        let slot = ok(slot).remove(0);
        assert!(eq(signed_area(&slot), 40.0 + 4.0 * PI));
        // Turned, scaled by k and moved, every area grows by k² and every
        // length by k (round numbers like a first corner at the origin or a
        // radius of 1 could hide a wrong sign or a + for a ×).
        let d = ok(Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1.0]), holes: vec![] }).remove(0);
        for (angle, k, shift) in [(0.7, 2.3, p(3.7, -1.3)), (2.9, 0.031, p(-120.5, 44.25)), (-1.3, 17.0, p(1e4, -2e4))] {
            let moved = |segs: &[Seg]| segs.iter().map(|q| placed(q, angle, k, shift)).collect::<Vec<_>>();
            let near = |a: f64, b: f64| crate::tolerance::rel_eq(a, b, 1e-9);
            assert!(near(signed_area(&moved(&d)), k * k * FRAC_PI_2) && near(perimeter(&moved(&d)), k * (2.0 + PI)), "D, {k}");
            assert!(near(signed_area(&moved(&slot)), k * k * (40.0 + 4.0 * PI)), "slot, {k}");
            // Stadium perimeter: two sides of 10, two half circles of r = 2.
            assert!(near(perimeter(&moved(&slot)), k * (20.0 + 4.0 * PI)), "slot, {k}");
            assert!(near(signed_area(&moved(&loops[1])), -k * k * 4.0 * PI) && near(perimeter(&moved(&loops[1])), k * 4.0 * PI));
        }
    }

    #[test]
    fn arc_bounds_by_hand() {
        // The upper unit half circle spans x ∈ [−1, 1], y ∈ [0, 1]; a full
        // circle would reach y = −1.
        let (lo, hi) = bounds(&upper_half());
        assert_eq!((lo, hi), (p(-1.0, 0.0), p(1.0, 1.0)));
        // A quarter from (1,0) to (0,1): just the box between its ends.
        let (lo, hi) = bounds(&Seg::from_bulge(p(1.0, 0.0), p(0.0, 1.0), (PI / 8.0).tan()).unwrap());
        assert!(eq(lo.x, 0.0) && eq(lo.y, 0.0) && eq(hi.x, 1.0) && eq(hi.y, 1.0));
    }

    #[test]
    fn thin_lens_boundary() {
        // Two arcs between (−1,0) and (1,0), bulging apart by sagitta s
        // each. Sagitta = (c/2)·bulge = bulge here (c = 2), so the lens is
        // 2·bulge thick at its middle; that thickness is the clearance.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let b = k * MIN_FEATURE / 2.0;
            let lens = Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[b, b]), holes: vec![] };
            assert_eq!(check_profile(&lens).is_ok(), legal, "lens {k}×MIN_FEATURE thick");
        }
    }

    #[test]
    fn slot_radius_boundary() {
        // Stadium of width w: its round ends have radius w/2, which must
        // be at least MIN_FEATURE, so w = 2.2·MIN_FEATURE is legal and
        // 1.8·MIN_FEATURE is not (radius 0.9×).
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let w = 2.0 * k * MIN_FEATURE;
            let slot = Profile { outer: path(&[(0.0, 0.0), (1.0, 0.0), (1.0, w), (0.0, w)], &[0.0, 1.0, 0.0, 1.0]), holes: vec![] };
            assert_eq!(check_profile(&slot).is_ok(), legal, "radius {k}×MIN_FEATURE");
        }
    }

    #[test]
    fn hairpin_gap_boundary() {
        // Line out to (10,0), half circle back to (1, d), straight home to
        // the start: the arc's end is d above the first line.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let d = k * MIN_FEATURE;
            let pin = Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (1.0, d)], &[0.0, 1.0, 0.0]), holes: vec![] };
            assert_eq!(check_profile(&pin).is_ok(), legal, "gap {k}×MIN_FEATURE");
        }
    }

    #[test]
    fn round_hole_wall_boundary() {
        // Circle of radius 10, round hole of radius 1 whose edge is k·MIN
        // from the outer circle: centre at 10 − 1 − k·MIN.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let x = 9.0 - k * MIN_FEATURE;
            let p = Profile {
                outer: Boundary::Circle { center: DVec2::ZERO, radius: 10.0 },
                holes: vec![Boundary::Circle { center: p(x, 0.0), radius: 1.0 }],
            };
            assert_eq!(check_profile(&p).is_ok(), legal, "wall {k}×MIN_FEATURE");
        }
    }

    #[test]
    fn circle_radius_boundary() {
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let c = Profile { outer: Boundary::Circle { center: DVec2::ZERO, radius: k * MIN_FEATURE }, holes: vec![] };
            assert_eq!(check_profile(&c).is_ok(), legal, "radius {k}×MIN_FEATURE");
        }
        let big = Profile { outer: Boundary::Circle { center: DVec2::ZERO, radius: 0.55 * MAX_SIZE }, holes: vec![] };
        assert!(refused(big).contains("spans"), "a circle 1.1× MAX_SIZE across");
    }

    #[test]
    fn crossing_and_overlapping_curves_are_refused() {
        let sq = || Boundary::polygon(square(-5.0, -5.0, 10.0));
        let circle = |x: f64, y: f64, r: f64| Boundary::Circle { center: p(x, y), radius: r };
        // A round hole poking through the outer square's side (x = 5).
        assert!(refused(Profile { outer: sq(), holes: vec![circle(4.5, 0.0, 1.0)] }).contains("apart"));
        // Two round holes overlapping, and one tangent to the other.
        assert!(refused(Profile { outer: sq(), holes: vec![circle(0.0, 0.0, 1.0), circle(1.5, 0.0, 1.0)] }).contains("apart"));
        assert!(refused(Profile { outer: sq(), holes: vec![circle(0.0, 0.0, 1.0), circle(2.0, 0.0, 1.0)] }).contains("apart"));
        // A hole inside a hole, and a hole outside the outline.
        assert!(refused(Profile { outer: sq(), holes: vec![circle(0.0, 0.0, 3.0), circle(0.0, 0.0, 1.0)] }).contains("inside hole"));
        assert!(refused(Profile { outer: sq(), holes: vec![circle(20.0, 0.0, 1.0)] }).contains("not inside"));
        // The square's top edge (5,5)→(−5,5) bowed down into it by bulge b
        // (negative: clockwise, so it dips below the chord).
        // b = −0.5: sweep 4·atan 0.5 ≈ 106°, r = 10(1 + 0.25)/(4·0.5) =
        // 6.25, centre (0, 5) + (0, −10)·(1 − 0.25)/(4·−0.5) = (0, 8.75);
        // lowest point y = 2.5, well clear of the bottom: accepted.
        // b = −1: a half circle of radius 5 about (0,5). It leaves (5,5)
        // heading straight down, back along the side it arrived on (it is
        // tangent to x = 5 there): a zero-angle corner, refused as a cusp.
        // b = −1.5: sweep ≈ 225°, r ≈ 5.42 about (0, 2.92): it bulges past
        // x = ±5 and crosses the sides.
        let bowl = |b: f64| Profile { outer: path(&[(-5.0, -5.0), (5.0, -5.0), (5.0, 5.0), (-5.0, 5.0)], &[0.0, 0.0, b, 0.0]), holes: vec![] };
        assert!(check_profile(&bowl(-0.5)).is_ok());
        assert!(refused(bowl(-1.0)).contains("doubles back"));
        assert!(refused(bowl(-1.5)).contains("apart"));
    }

    #[test]
    fn a_cusp_is_refused() {
        // Line (0,0)→(2,0) arriving heading +x; then a quarter circle about
        // (2,1) run clockwise, which leaves (2,0) heading −x: straight back.
        let cusp = Profile { outer: path(&[(0.0, 0.0), (2.0, 0.0), (1.0, 1.0)], &[0.0, -(PI / 8.0).tan(), 0.0]), holes: vec![] };
        assert!(refused(cusp).contains("doubles back"));
        // Counter-clockwise instead it leaves heading +x, smoothly: fine.
        let smooth = Profile { outer: path(&[(0.0, 0.0), (2.0, 0.0), (3.0, 1.0), (0.0, 1.0)], &[0.0, (PI / 8.0).tan(), 0.0, 0.0]), holes: vec![] };
        assert!(check_profile(&smooth).is_ok());
    }

    #[test]
    fn malformed_paths_are_refused() {
        let msg = |b: Boundary| refused(Profile { outer: b, holes: vec![] });
        assert!(msg(path(&[(0.0, 0.0), (1.0, 0.0)], &[])).contains("at least 3"));
        assert!(msg(path(&[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)], &[0.0, 0.0])).contains("bulges"));
        assert!(msg(path(&[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)], &[0.0, f64::NAN, 0.0])).contains("not finite"));
        assert!(msg(path(&[(0.0, 0.0), (1.0, 0.0), (0.0, f64::INFINITY)], &[])).contains("not finite"));
        assert!(msg(Boundary::Circle { center: p(MAX_COORD, 0.0), radius: 1.0 }).contains("beyond"));
        assert!(msg(Boundary::Circle { center: DVec2::ZERO, radius: f64::NAN }).contains("radius"));
        // Two half circles between the same points, the same way round:
        // the same arc out and back.
        assert!(msg(path(&[(0.0, 0.0), (2.0, 0.0)], &[1.0, -1.0])).contains("doubles back"));
        // Two half circles making a full circle is a valid 2-corner loop.
        assert!(check_profile(&Profile { outer: path(&[(0.0, 0.0), (2.0, 0.0)], &[1.0, 1.0]), holes: vec![] }).is_ok());
    }

    /// Points along a piece, `n` steps apart, and the step length.
    fn samples(s: &Seg, n: usize) -> (Vec<DVec2>, f64) {
        match *s {
            Seg::Line { a, b } => ((0..=n).map(|k| a.lerp(b, k as f64 / n as f64)).collect(), a.distance(b) / n as f64),
            Seg::Arc { a, center, radius, sweep, .. } => {
                let t0 = (a - center).to_angle();
                ((0..=n).map(|k| center + dir(t0 + sweep * k as f64 / n as f64) * radius).collect(), radius * sweep.abs() / n as f64)
            }
            Seg::Circle { center, radius, .. } => ((0..n).map(|k| center + dir(TAU * k as f64 / n as f64) * radius).collect(), radius * TAU / n as f64),
        }
    }

    fn any_piece() -> impl Strategy<Value = Seg> {
        let pt = || (-3.0..3.0f64, -3.0..3.0f64).prop_map(|(x, y)| p(x, y));
        prop_oneof![
            (pt(), pt()).prop_filter("long enough", |(a, b)| a.distance(*b) > 0.1).prop_map(|(a, b)| Seg::Line { a, b }),
            (pt(), pt(), -3.0..3.0f64)
                .prop_filter_map("a proper arc", |(a, b, bulge)| (a.distance(b) > 0.1 && bulge.abs() > 0.05).then(|| Seg::from_bulge(a, b, bulge)).flatten()),
            (pt(), 0.1..2.0f64).prop_map(|(center, radius)| Seg::Circle { center, radius, ccw: true }),
        ]
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 400,
            failure_persistence: Some(Box::new(proptest::test_runner::FileFailurePersistence::Direct("tests/regressions/profile-clearance.txt"))),
            ..ProptestConfig::default()
        })]

        /// The exact clearance between two separate pieces against brute
        /// force: sample both densely and take the closest pair. That pair
        /// can't be closer than the true minimum, and is at most half a
        /// sample step on each piece further. So clearance must lie in
        /// [brute − (h₁ + h₂)/2, brute]. A missed crossing (true distance 0
        /// reported as positive) or a missing candidate point breaks the
        /// upper bound; a wrong formula breaks one or the other.
        #[test]
        fn clearance_matches_brute_force(s in any_piece(), t in any_piece()) {
            let ((ps, hs), (pt, ht)) = (samples(&s, 600), samples(&t, 600));
            let brute = ps.iter().flat_map(|a| pt.iter().map(move |b| a.distance(*b))).fold(f64::INFINITY, f64::min);
            let c = clearance(&s, &t, &[]);
            prop_assert!(c <= brute + 1e-9, "clearance {c} > brute force {brute} for {s:?} / {t:?}");
            prop_assert!(c >= brute - (hs + ht) / 2.0 - 1e-9, "clearance {c} < brute force {brute} − steps for {s:?} / {t:?}");
        }
    }
    #[test]
    fn distance_from_a_circles_centre() {
        // Every point of a circle of radius 2 is 2 from its centre.
        let c = Seg::Circle { center: p(1.0, 1.0), radius: 2.0, ccw: true };
        assert!(eq(c.distance(p(1.0, 1.0)), 2.0));
        assert!(eq(c.distance(p(1.0, 4.0)), 1.0));
    }

    #[test]
    fn nearly_concentric_circles() {
        // Radii 1 and 1.5, centres 5e-4 apart: the gap is narrowest on the
        // side the inner circle leans towards, 1.5 − 1 − 5e-4 = 0.4995.
        let inner = Seg::Circle { center: p(0.0, 0.0), radius: 1.0, ccw: true };
        let outer = Seg::Circle { center: p(5e-4, 0.0), radius: 1.5, ccw: true };
        assert!(eq(clearance(&inner, &outer, &[]), 0.4995), "{}", clearance(&inner, &outer, &[]));
    }

    #[test]
    fn a_line_crossing_an_arc_once_by_hand() {
        // The upper unit half circle, and short vertical segments on x = 0
        // that reach its top (0, 1) from inside or outside: each crosses
        // once, at the root −h ± √disc of |a + s·u|² = 1 that lies on it.
        let arc = upper_half();
        let seg = |y0: f64, y1: f64| Seg::Line { a: p(0.0, y0), b: p(0.0, y1) };
        // Up from (0, 0.9): roots −1.9 and 0.1; only 0.1 is on the 0.3 long
        // segment (the "+" root).
        assert_crossing(&arc, &seg(0.9, 1.2), &[], true);
        // Down from (0, 1.1): roots 0.1 and 2.1; the "−" root.
        assert_crossing(&arc, &seg(1.1, 0.8), &[], true);
        // Inside, not reaching it; outside, not reaching it.
        assert_crossing(&arc, &seg(0.5, 0.9), &[], false);
        assert_crossing(&arc, &seg(1.1, 1.5), &[], false);
        // An arc only from 80° to 100°: the segment up from (0, −0.5) meets
        // the circle at (0, 1) (90°: on it) after 1.5.
        let narrow = Seg::Arc { a: dir(80f64.to_radians()), b: dir(100f64.to_radians()), center: DVec2::ZERO, radius: 1.0, sweep: 20f64.to_radians() };
        assert_crossing(&narrow, &seg(-0.5, 1.5), &[], true);
        // …while one meeting the circle at 60° misses it.
        assert_crossing(&narrow, &Seg::Line { a: p(0.5, 0.0), b: p(0.5, 2.0) }, &[], false);
    }

    #[test]
    fn a_line_and_an_arc_from_one_corner_by_hand() {
        // They share P = (1, 0) on the unit circle. A line leaving P at 60°
        // below −x, u = (−½, −√3/2), meets the circle again after
        // s = −2·u·(P − c) = −2·(−½) = 1, at (½, −√3/2) (angle −60°).
        let s3 = 3f64.sqrt() / 2.0;
        let line = |len: f64| Seg::Line { a: p(1.0 - 0.5 * len, -s3 * len), b: p(1.0, 0.0) };
        // The lower half circle run clockwise from P to (−1, 0) passes −60°.
        let lower = Seg::from_bulge(p(1.0, 0.0), p(-1.0, 0.0), -1.0).unwrap();
        assert_crossing(&line(2.0), &lower, &[p(1.0, 0.0)], true);
        // A line only 0.9 long stops short of it.
        assert_crossing(&line(0.9), &lower, &[p(1.0, 0.0)], false);
        // The upper half doesn't pass −60°.
        let upper = Seg::from_bulge(p(1.0, 0.0), p(-1.0, 0.0), 1.0).unwrap();
        assert_crossing(&line(2.0), &upper, &[p(1.0, 0.0)], false);
    }

    #[test]
    fn two_arcs_from_one_corner_by_hand() {
        // Unit circles about (0, 0) and (1, 1) meet at (1, 0) and (0, 1).
        // s: the first circle's upper half, run clockwise from (−1, 0) to
        // P = (1, 0), through (0, 1). t leaves P on the second circle.
        let s = Seg::from_bulge(p(-1.0, 0.0), p(1.0, 0.0), -1.0).unwrap();
        let shared = [p(1.0, 0.0)];
        // Clockwise from P (−90° about (1, 1)) for 180°, to (1, 2): passes
        // 180°, the point (0, 1). They cross there.
        let t_cw = Seg::from_bulge(p(1.0, 0.0), p(1.0, 2.0), -1.0).unwrap();
        assert_crossing(&s, &t_cw, &shared, true);
        // Counter-clockwise from P a quarter turn to (2, 1): never reaches
        // (0, 1). (0, 1) is on s's span but not t's.
        let t_ccw = Seg::from_bulge(p(1.0, 0.0), p(2.0, 1.0), (PI / 8.0).tan()).unwrap();
        assert_crossing(&s, &t_ccw, &shared, false);
    }

    #[test]
    fn two_separate_arcs_by_hand() {
        // Circles r = 5 about (0, 0) and (8, 0) meet where x = (64 + 25 −
        // 25)/16 = 4 along the line of centres, y = ±√(25 − 16) = ±3: at
        // (4, 3) (37° on the first, 143° on the second) and (4, −3) (−37°,
        // 217°).
        let arc = |cx: f64, r: f64, from: f64, to: f64| {
            let (a, b) = (from.to_radians(), to.to_radians());
            Seg::Arc { a: p(cx, 0.0) + dir(a) * r, b: p(cx, 0.0) + dir(b) * r, center: p(cx, 0.0), radius: r, sweep: b - a }
        };
        // 0°..90° and 90°..180°: both pass (4, 3).
        assert_crossing(&arc(0.0, 5.0, 0.0, 90.0), &arc(8.0, 5.0, 90.0, 180.0), &[], true);
        // 0°..90° and 180°..270°: the second passes only (4, −3).
        assert_crossing(&arc(0.0, 5.0, 0.0, 90.0), &arc(8.0, 5.0, 180.0, 270.0), &[], false);
        // −90°..0° and 180°..270°: both pass (4, −3) (the "−h" point).
        assert_crossing(&arc(0.0, 5.0, -90.0, 0.0), &arc(8.0, 5.0, 180.0, 270.0), &[], true);
        // Run clockwise instead (negative sweeps): the same points.
        assert_crossing(&arc(0.0, 5.0, 0.0, -90.0), &arc(8.0, 5.0, 270.0, 180.0), &[], true);
        // Circles that don't meet: centres 10.5 apart (> 5 + 5), and a
        // circle of 2 about (1, 0) inside the first (1 < 5 − 2).
        assert_crossing(&arc(0.0, 5.0, -90.0, 90.0), &arc(10.5, 5.0, 90.0, 270.0), &[], false);
        assert_crossing(&arc(0.0, 5.0, -90.0, 90.0), &arc(1.0, 2.0, -90.0, 90.0), &[], false);
        // Touching, exactly (identity placement only: a turned copy can't
        // keep an exact tie). Outside: centres 10 = 5 + 5 apart, meeting at
        // (5, 0); inside: a circle of 3 about (2, 0), 2 = 5 − 3 from the
        // first's centre, meeting at (5, 0) too. Touching is not allowed.
        let none: [DVec2; 0] = [];
        assert!(crossing(&arc(0.0, 5.0, -90.0, 90.0), &arc(10.0, 5.0, 90.0, 270.0), &none));
        assert!(crossing(&arc(0.0, 5.0, -90.0, 90.0), &arc(2.0, 3.0, -90.0, 90.0), &none));
    }

    #[test]
    fn touching_a_line_exactly_by_hand() {
        // Circle r = 5 about the origin, upper half run counter-clockwise.
        let upper = Seg::from_bulge(p(5.0, 0.0), p(-5.0, 0.0), 1.0).unwrap();
        // The line y = 5 touches it at (0, 5): |a − c|² − r² = 125 − 25 =
        // 100 = (u·(a − c))², so the discriminant is exactly 0.
        assert!(crossing(&upper, &Seg::Line { a: p(-10.0, 5.0), b: p(10.0, 5.0) }, &[]));
        // y = 3 from (−10, 3) to (10, 3) meets it at x = ±4.
        assert_crossing(&upper, &Seg::Line { a: p(-10.0, 3.0), b: p(10.0, 3.0) }, &[], true);
        // From the shared corner P = (4, 3) leftwards, u = (−1, 0): the other
        // meeting is s = −2u·P = 8 along, at (−4, 3) (143°, on the upper
        // half). A line 10 long passes it; one 7 long stops short; one
        // exactly 8 long ends on the arc, which touches it there.
        let ps = [p(4.0, 3.0)];
        let upper_from_p = Seg::from_bulge(p(4.0, 3.0), p(-5.0, 0.0), (((180.0f64 - 36.869_897_645_844_02) / 4.0).to_radians()).tan()).unwrap();
        assert_crossing(&upper_from_p, &Seg::Line { a: p(-6.0, 3.0), b: p(4.0, 3.0) }, &ps, true);
        assert_crossing(&upper_from_p, &Seg::Line { a: p(4.0, 3.0), b: p(-3.0, 3.0) }, &ps, false);
        assert!(crossing(&upper_from_p, &Seg::Line { a: p(4.0, 3.0), b: p(-4.0, 3.0) }, &ps));
    }

    #[test]
    fn nested_and_concentric_clearance_by_hand() {
        let arc = |c: DVec2, r: f64, from: f64, to: f64| {
            let (a, b) = (from.to_radians(), to.to_radians());
            Seg::Arc { a: c + dir(a) * r, b: c + dir(b) * r, center: c, radius: r, sweep: b - a }
        };
        let gap = |s: &Seg, t: &Seg| clearance(s, t, &[]);
        // A circle of 2 about (1, 0) inside one of 5 about the origin: the
        // gap is narrowest along +x, from (3, 0) to (5, 0): 2. The point on
        // the small one faces away from the big one's centre; the pair is
        // found from the big one's point facing the small one's centre.
        let (big, small) = (arc(DVec2::ZERO, 5.0, -30.0, 30.0), arc(p(1.0, 0.0), 2.0, -30.0, 30.0));
        assert!(eq(gap(&big, &small), 2.0), "{}", gap(&big, &small));
        // With the big arc only from 10° to 40°, its nearest point is its
        // end at 10°, x = 5(cos 10°, sin 10°): |x − (1, 0)|² = 25 + 1 −
        // 10·cos 10° grows with the angle. That direction from (1, 0) is
        // atan(0.868/3.924) ≈ 12.5°, on the small arc: gap |x − (1,0)| − 2.
        let near = arc(DVec2::ZERO, 5.0, 10.0, 40.0);
        let want = (26.0 - 10.0 * 10f64.to_radians().cos()).sqrt() - 2.0;
        assert!(eq(gap(&near, &small), want), "{} vs {want}", gap(&near, &small));
        // Concentric, radii 5 and 5.5: 0.5 apart wherever both are, here
        // from 30° to 60° (inside the first arc, 0° to 90°).
        let inner = arc(DVec2::ZERO, 5.0, 0.0, 90.0);
        assert!(eq(gap(&inner, &arc(DVec2::ZERO, 5.5, 30.0, 60.0)), 0.5));
        // No overlap (100° to 120°): nearest are the ends 10° apart,
        // √(25 + 30.25 − 55·cos 10°) by the cosine rule.
        let want = (55.25 - 55.0 * 10f64.to_radians().cos()).sqrt();
        assert!(eq(gap(&inner, &arc(DVec2::ZERO, 5.5, 100.0, 120.0)), want));
        // Two whole concentric circles have no ends at all: still 0.5.
        let whole = |r: f64| Seg::Circle { center: p(2.0, -1.0), radius: r, ccw: true };
        assert!(eq(gap(&whole(5.0), &whole(5.5)), 0.5));
    }

    #[test]
    fn arcs_of_one_circle_by_hand() {
        // A = (1, 0), B = (0, −1) on the unit circle. Counter-clockwise from
        // A to B is 270° (bulge tan 67.5°), from B back to A is 90°
        // (bulge tan 22.5°): together exactly the circle, no overlap.
        let (a, b) = (p(1.0, 0.0), p(0.0, -1.0));
        let (big, small) = ((67.5f64).to_radians().tan(), (22.5f64).to_radians().tan());
        let ab = Seg::from_bulge(a, b, big).unwrap();
        assert_crossing(&ab, &Seg::from_bulge(b, a, small).unwrap(), &[a, b], false);
        // From B back to A the long way, clockwise 270° (bulge −tan 67.5°):
        // the same arc run back, every end shared. Overlap.
        assert_crossing(&ab, &Seg::from_bulge(b, a, -big).unwrap(), &[a, b], true);
        // Carrying on counter-clockwise from B for 180° ends at (0, 1),
        // which the first arc passes through (at 90°). Overlap.
        assert_crossing(&ab, &Seg::from_bulge(b, p(0.0, 1.0), 1.0).unwrap(), &[b], true);
        // Out and straight back along the same arc (opposite turns,
        // sharing its far end): overlap.
        let q = Seg::from_bulge(a, p(0.0, 1.0), (PI / 8.0).tan()).unwrap();
        let back = Seg::from_bulge(p(0.0, 1.0), a, -(PI / 8.0).tan()).unwrap();
        assert_crossing(&q, &back, &[p(0.0, 1.0)], true);
        // Two separate quarter arcs of the circle run opposite ways, sharing
        // nothing: (1,0)→(0,1) and (0,−1)→(−1,0) clockwise. No overlap.
        let other = Seg::from_bulge(p(0.0, -1.0), p(-1.0, 0.0), -(PI / 8.0).tan()).unwrap();
        assert_crossing(&q, &other, &[], false);
    }
}
