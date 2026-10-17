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

//!
//! Mutation testing (`cargo mutants -f src/ops/profile.rs`) leaves these
//! survivors, all equivalent (no input can tell them apart):
//! - `sweep > 0.0` vs `>= 0.0` (Seg::spans, the arc's side in winding): an arc's sweep is never 0 (a zero bulge is a line).
//! - `* s` vs `/ s` where s is ±1: Seg::tangents (the sweep's sign) and
//!   half_turn (the arc's side of its chord, ±1 from the sweep's sign).
//! - `<` vs `<=` in winding, at ties that put the point on the loop:
//!   (a − p)·(b − p) is 0, for p on the chord's line, only at an end; and
//!   a distance from the centre equal to the radius, on the arc's side of
//!   its chord (anywhere, for a whole circle), is on the piece itself (on
//!   the other side the side test fails first).
//! - `<` vs `<=` in doubles_back: a dot product of 0 means perpendicular
//!   unit tangents, whose cross product is ±1, never within ANGULAR.
//! - `>` vs `>=` in counter_clockwise: a checked loop's area is never 0
//!   (it is at least about its span × MIN_FEATURE / 2).
//! - probe's `c + X·r` vs `c − X·r`: by the time holes are placed every
//!   piece is clear of every other, so any point of a hole's circle
//!   decides whether it is inside a loop.
use super::KernelError;
use crate::tolerance::{segments_touch, side, ANGULAR, LINEAR, MAX_COORD, MAX_PROFILE_CORNERS, MAX_SIZE, MIN_FEATURE};
use glam::DVec2;
use std::f64::consts::{PI, TAU};

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
                // (Another meeting within LINEAR of P, inclusive, is P
                // itself: `ties_at_linear_from_a_shared_corner`.)
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
            Seg::Circle { radius, ccw, .. } => {
                let full = radius * radius * TAU;
                twice += if ccw { full } else { -full };
            }
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
pub(crate) fn bounds(s: &Seg) -> (DVec2, DVec2) {
    let mut pts = s.ends();
    if let Some((c, r)) = s.circle() {
        pts.extend([0.0, 0.25, 0.5, 0.75].map(|k| k * TAU).into_iter().filter(|&t| s.spans(t)).map(|t| c + dir(t) * r));
    }
    pts.iter().fold((DVec2::INFINITY, DVec2::NEG_INFINITY), |(lo, hi), &p| (lo.min(p), hi.max(p)))
}

/// Winding number of a loop around `p`, which must be clear of the loop.
/// Each piece adds the angle it sweeps as seen from p: a straight piece the
/// angle between its ends; an arc the same plus a full turn (in its own
/// direction) when p lies between it and its chord. Each angle takes its
/// sign from the exact side-of-line test, so a point a hair off a chord
/// can't be counted on the wrong side. A point exactly on an arc's chord,
/// between its ends, sees the chord as half a turn either way: the arc
/// itself sweeps half a turn round it, through the arc's side.
fn winding(segs: &[Seg], p: DVec2) -> i64 {
    let angle = |a: DVec2, b: DVec2| {
        let (u, v) = (a - p, b - p);
        f64::from(side(a, b, p)) * u.perp_dot(v).abs().atan2(u.dot(v))
    };
    let mut total = 0.0;
    for s in segs {
        match *s {
            Seg::Line { a, b } => total += angle(a, b),
            Seg::Arc { a, b, center, radius, sweep } => {
                // A counter-clockwise arc lies right of its chord a→b, a
                // clockwise one left (exact; its middle point can round onto
                // the chord or past it when the arc is very flat).
                let arc_side: i8 = if sweep > 0.0 { -1 } else { 1 };
                let p_side = side(a, b, p);
                if p_side == 0 && (a - p).dot(b - p) < 0.0 {
                    // From a (behind p) round to b (ahead): through the left
                    // is clockwise, through the right counter-clockwise.
                    total -= half_turn(arc_side);
                } else {
                    total += angle(a, b);
                    // Between arc and chord: inside the circle, on its side.
                    if p.distance(center) < radius && p_side == arc_side {
                        total += sweep.signum() * TAU;
                    }
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

/// Half a turn counter-clockwise for `side` 1, clockwise for −1.
fn half_turn(side: i8) -> f64 {
    PI * f64::from(side)
}

/// Whether a loop runs counter-clockwise: whether its signed area is
/// positive. The area is a sum over the whole loop, so it can't be swayed
/// by what happens within tolerance of one corner. (A local test, such as
/// the turn at the lowest corner, can: where two pieces nearly double back
/// they may cross again within LINEAR of the corner, which counts as
/// meeting there, and the turn then reads that twist instead of the loop;
/// `near_cusp_corners_keep_the_loop_the_right_way_round`, issue #75.) For
/// a checked loop the sign is safe: pieces stay MIN_FEATURE apart away
/// from shared corners, so a loop spanning L encloses about L·MIN_FEATURE/2
/// at least (500 mm² at 1 km), while the sum's rounding, with every term
/// taken from the first corner, is about n·(L² + L·MAX_COORD)·1e-16 (0.02
/// mm² for 2,000 corners at 1 km, 100 km out; `orientation_of_slivers`).
fn counter_clockwise(segs: &[Seg]) -> bool {
    signed_area(segs) > 0.0
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
/// - every piece's ends (a line's length, an arc's chord) at least
///   MIN_FEATURE apart, as in a sketch (so a loop of two corners has them
///   at least MIN_FEATURE apart);
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
                // The clearance rule below ignores where pieces meet, so it
                // can't see a piece whose ends are close: in a loop of two
                // corners both pieces end at both corners, and a piece
                // shorter than LINEAR has its ends within LINEAR of the
                // corners its neighbours share (a triangle 5 nm across). So
                // length is a rule of its own, the same as for sketch lines
                // and arc chords. Closer than MIN_FEATURE, a straight piece
                // is shorter than a feature may be (under LINEAR, too short
                // to be an edge at all) or two arcs pinch to a neck.
                for i in 0..n {
                    let gap = corners[i].distance(corners[(i + 1) % n]);
                    if gap < MIN_FEATURE {
                        return bad(if n == 2 {
                            format!("profile loop {k} has its two corners {gap:e} mm apart; features must be at least {MIN_FEATURE} mm")
                        } else {
                            format!("profile loop {k}, piece {i} has its ends {gap} mm apart; they must be at least {MIN_FEATURE} mm apart")
                        });
                    }
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
            if doubles_back(t_in, t_out) {
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

/// Whether a corner arriving along unit tangent `t_in` and leaving along
/// `t_out` turns straight back (a cusp).
fn doubles_back(t_in: DVec2, t_out: DVec2) -> bool {
    t_in.dot(t_out) < 0.0 && t_in.perp_dot(t_out).abs() <= ANGULAR
}

/// A point on a loop: its first corner, or a circle's point along +X.
fn probe(segs: &[Seg]) -> DVec2 {
    match segs[0] {
        Seg::Circle { center, radius, .. } => center + DVec2::X * radius,
        s => s.ends()[0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::{eq, rel_eq, FP_REL};
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
            // Not a half circle (sin φ ≠ 0): the bowed square of
            // concave_arc_by_hand, 100 − (r²/2)(φ − sin φ), sides 30 + rφ.
            let (r, phi) = (7.25, 4.0 * 0.4f64.atan());
            let bowed = pieces(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)], &[0.0, 0.0, -0.4, 0.0]);
            assert!(near(signed_area(&moved(&bowed)), k * k * (100.0 - r * r / 2.0 * (phi - phi.sin()))), "bowed, {k}");
            assert!(near(perimeter(&moved(&bowed)), k * (30.0 + r * phi)), "bowed, {k}");
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
    fn short_piece_boundary() {
        // A circle of radius 10 with a gap of g at the bottom, closed by a
        // straight piece from b = (−g/2, 0) back to a = (g/2, 0). The arc
        // a → b goes the long way round, counter-clockwise: for radius r
        // and chord c, r = c(1 + β²)/(4β) gives cβ² − 4rβ + c = 0, whose
        // larger root is β = (2r + √(4r² − c²))/c (β > 1: more than a half
        // circle). Both pieces join the same two corners, g apart (the
        // arc's chord, the line's length); nothing else is near anything,
        // so only a rule on piece length can refuse it.
        let keyhole = |g: f64| {
            let beta = (20.0 + (400.0 - g * g).sqrt()) / g;
            Profile { outer: path(&[(g / 2.0, 0.0), (-g / 2.0, 0.0)], &[beta, 0.0]), holes: vec![] }
        };
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let g = k * MIN_FEATURE;
            assert_eq!(check_profile(&keyhole(g)).is_ok(), legal, "closing piece {k}×MIN_FEATURE long");
        }
        assert!(refused(keyhole(0.9 * MIN_FEATURE)).contains("two corners"));
        // Exactly MIN_FEATURE is allowed: the corners ±MIN_FEATURE/2 are
        // exact, so the length is (a correctly rounded √(x²) is x).
        assert!(check_profile(&keyhole(MIN_FEATURE)).is_ok());
        // Fuzzing found these: pieces shorter than LINEAR, whose ends all
        // count as the corners they share, so no clearance was measured.
        // Every corner of a triangle at one point panicked in extrude; a
        // triangle 5 nm across, and the keyhole with a 5 nm gap, made
        // invalid bodies.
        assert!(refused(Profile::polygon(vec![p(1.9375, 1.9375); 3], vec![])).contains("piece 0 has its ends 0 mm apart"));
        assert!(refused(Profile::polygon(vec![p(0.0, 0.0), p(5e-6, 0.0), p(0.0, 5e-6)], vec![])).contains("piece 0 has its ends"));
        assert!(refused(keyhole(5e-6)).contains("two corners"));
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

    /// The bulge of an arc of radius `r` on a chord `c`, the long way round:
    /// from r = c(1 + β²)/(4β), β² − (4r/c)·β + 1 = 0, whose larger root is
    /// β = (k + √(k² − 4))/2 with k = 4r/c (the smaller, 1/β, is the short
    /// way round the same circle).
    fn long_way(r: f64, c: f64) -> f64 {
        let k = 4.0 * r / c;
        (k + (k * k - 4.0).sqrt()) / 2.0
    }

    #[test]
    fn two_corners_closer_than_min_feature_are_refused() {
        // Regression (white-box hunt): a loop of two corners c apart, the
        // long way round a circle of radius 1 and the straight line back
        // (a "D" with a flat c long). Both pieces end at both corners, so
        // the clearance check, which ignores where pieces meet, never
        // measured c: a 0.5 µm flat was accepted, and below LINEAR the
        // extrude built a body with a too-short edge and panicked.
        // The flat is a straight piece, so it must be MIN_FEATURE long:
        // c = 1.1 × and exactly MIN_FEATURE are legal, 0.9 × is not.
        let d = |c: f64| Profile { outer: path(&[(0.0, 0.0), (c, 0.0)], &[-long_way(1.0, c), 0.0]), holes: vec![] };
        for (c, legal) in [(1.1 * MIN_FEATURE, true), (MIN_FEATURE, true), (0.9 * MIN_FEATURE, false), (5e-6, false), (1e-150, false)] {
            match check_profile(&d(c)) {
                Ok(_) => assert!(legal, "a flat {c:e} mm long was accepted"),
                Err(KernelError::InvalidInput(m)) => {
                    assert!(!legal, "a flat {c:e} mm long was refused: {m}");
                    assert!(m.contains("two corners"), "{m}");
                }
                Err(e) => panic!("{e:?}"),
            }
        }
        // Two arcs instead (two circles of radius 1 meeting through a gap
        // c wide: a figure of eight whose neck is c), and the D as a hole.
        let eight = |c: f64| Profile { outer: path(&[(0.0, 0.0), (c, 0.0)], &[-long_way(1.0, c), -long_way(1.0, c)]), holes: vec![] };
        let hole = |c: f64| Profile { outer: Boundary::polygon(square(-5.0, -5.0, 10.0)), holes: vec![d(c).outer] };
        for make in [&eight as &dyn Fn(f64) -> Profile, &hole] {
            assert!(check_profile(&make(1.1 * MIN_FEATURE)).is_ok());
            assert!(refused(make(0.9 * MIN_FEATURE)).contains("two corners"));
        }
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
    fn centres_count_as_one_up_to_a_thousandth_of_linear() {
        // Whole circles r = 1 about the origin and r = 0.5 about (−k·t, 0),
        // t = LINEAR·1e-3 = 1e-8 mm, the "same centre" limit. The true gap
        // is narrowest on the −x side, where the small circle leans:
        // 1 − (0.5 + k·t) = 0.5 − k·t. Up to and including the limit (k =
        // 0.9, 1) the centres count as one and the gap is read at each
        // circle's +x point: the big one's (1, 0) is 1 + k·t from the small
        // centre, so 0.5 + k·t outside the small circle; the small one's
        // (0.5 − k·t, 0) is 0.5 + k·t inside the big one. That reading is
        // 2k·t ≤ 2e-8 mm high, 500 × below LINEAR. Past the limit (k = 1.1)
        // each circle's point facing the other's centre gives the true
        // 0.5 − k·t. The readings differ by 4e-8 of 0.5: FP_REL tells them
        // apart.
        let t = LINEAR * 1e-3;
        // The tie at k = 1 is exact: the offset's length is t itself.
        assert_eq!(DVec2::new(-t, 0.0).length(), t);
        let big = Seg::Circle { center: DVec2::ZERO, radius: 1.0, ccw: true };
        for (k, want) in [(0.9, 0.5 + 0.9 * t), (1.0, 0.5 + t), (1.1, 0.5 - 1.1 * t)] {
            let small = Seg::Circle { center: p(-k * t, 0.0), radius: 0.5, ccw: true };
            for (s, u) in [(&big, &small), (&small, &big)] {
                let got = clearance(s, u, &[]);
                assert!(rel_eq(got, want, FP_REL), "{k}×: {got} vs {want}");
            }
        }
    }

    #[test]
    fn a_nearly_concentric_arc_is_measured_only_where_it_is() {
        // The left half of the unit circle, (0, 1) → (0, −1) counter-
        // clockwise through (−1, 0), and a whole circle r = 0.5 about (δ,
        // 0), δ = LINEAR·1e-3 / 2: centres close enough to count as one. A
        // point of the arc at angle θ is √(1 − 2δ cos θ + δ²) from that
        // centre, and cos θ ≤ 0 on the arc, so its ends are nearest: gap
        // √(1 + δ²) − 0.5 = 0.5 (δ² = 2.5e-17 is below rounding). The big
        // circle's +x point (1, 0) is only 1 − δ − 0.5 from the small one,
        // but it isn't on the arc and mustn't count (δ/0.5 = 1e-8 >
        // FP_REL).
        let d = LINEAR * 1e-3 / 2.0;
        let arc = Seg::from_bulge(p(0.0, 1.0), p(0.0, -1.0), 1.0).unwrap();
        let ring = Seg::Circle { center: p(d, 0.0), radius: 0.5, ccw: true };
        for (s, t) in [(&arc, &ring), (&ring, &arc)] {
            let got = clearance(s, t, &[]);
            assert!(rel_eq(got, 0.5, FP_REL), "{got}");
        }
    }

    #[test]
    fn ties_at_linear_from_a_shared_corner() {
        // Two pieces sharing a corner P meet again k·LINEAR from it: within
        // LINEAR, inclusive, that is P itself (as for `clearance`, whose
        // near_shared is ≤ LINEAR), so they don't cross; at 1.1 × LINEAR
        // they do. Exact placements only (a turned copy can't keep the
        // tie), so `crossing` directly, both ways round. Points a hair (h²/8
        // or less) off their circles don't matter: these tests use angles.
        for (k, expect) in [(0.9, false), (1.0, false), (1.1, true)] {
            let h = k * LINEAR;
            // Two counter-clockwise arcs of the unit circle sharing P = (0,
            // −1): s is the tiny one from Q = (−h, −1) to P; t runs from P
            // almost all the way round, ending LINEAR/2 short of P, so it
            // passes over Q. They overlap from Q to P, h long, and only Q
            // (an end of s, on t) shows it. |Q − P| = |(−h, 0)| = h exactly.
            let (q, pp) = (p(-h, -1.0), p(0.0, -1.0));
            assert_eq!(q.distance(pp), h);
            let s = Seg::Arc { a: q, b: pp, center: DVec2::ZERO, radius: 1.0, sweep: pp.to_angle() - q.to_angle() };
            let short = LINEAR / 2.0;
            let t = Seg::Arc { a: pp, b: dir(-FRAC_PI_2 - short), center: DVec2::ZERO, radius: 1.0, sweep: TAU - short };
            assert_eq!(crossing(&s, &t, &[pp]), expect, "two arcs of one circle, {k}×");
            assert_eq!(crossing(&t, &s, &[pp]), expect, "two arcs of one circle, the other way round, {k}×");
            // A line from P = (−h/2, −1) along u = (1, 0), the unit circle's
            // tangent at its bottom, and the arc from P counter-clockwise
            // round the bottom. The circle meets the line again after s =
            // −2u·(P − c) = −2·(−h/2) = h, at (h/2, −1), on the arc.
            let pp = p(-h / 2.0, -1.0);
            let line = Seg::Line { a: pp, b: p(1.0, -1.0) };
            let end = 1.0 - FRAC_PI_2;
            let arc = Seg::Arc { a: pp, b: dir(end), center: DVec2::ZERO, radius: pp.length(), sweep: end - pp.to_angle() };
            assert_eq!(crossing(&line, &arc, &[pp]), expect, "a line and an arc, {k}×");
            assert_eq!(crossing(&arc, &line, &[pp]), expect, "an arc and a line, {k}×");
            // Circles of equal radius about (0, 0) and (2, 0), both through
            // P = (1, h/2): they meet again at P mirrored in the line of
            // centres, (1, −h/2), h from P. s runs up the first circle
            // through its angle 0 to P; t leaves P counter-clockwise on the
            // second, through its angle π. Both pass (1, −h/2).
            let pp = p(1.0, h / 2.0);
            let (c2, r) = (p(2.0, 0.0), pp.length());
            let s = Seg::Arc { a: dir(-0.5) * r, b: pp, center: DVec2::ZERO, radius: r, sweep: pp.to_angle() + 0.5 };
            let t = Seg::Arc { a: pp, b: c2 + dir(PI + 0.5) * r, center: c2, radius: r, sweep: PI + 0.5 - (pp - c2).to_angle() };
            assert_eq!(crossing(&s, &t, &[pp]), expect, "two circles, {k}×");
            assert_eq!(crossing(&t, &s, &[pp]), expect, "two circles, the other way round, {k}×");
        }
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
        // Nearly concentric (centres 9e-4 apart, under a micrometre) yet
        // crossing: radii 5 and 5.0005 meet where x = (8.1e-7 + 25 −
        // 25.00500025)/1.8e-3 = −2.7774, y = ±√(25 − 2.7774²) = ±4.158
        // (about ±123.7° on both). Only "the same centre" (within
        // LINEAR·1e-3 = 1e-8) may be treated as concentric.
        let near = |r: f64, cx: f64, from: f64, to: f64| {
            let (a, b) = (from.to_radians(), to.to_radians());
            Seg::Arc { a: p(cx, 0.0) + dir(a) * r, b: p(cx, 0.0) + dir(b) * r, center: p(cx, 0.0), radius: r, sweep: b - a }
        };
        assert_crossing(&near(5.0, 0.0, 100.0, 140.0), &near(5.0005, 9e-4, 140.0, 100.0), &[], true);
        assert_crossing(&near(5.0, 0.0, 100.0, 120.0), &near(5.0005, 9e-4, 140.0, 100.0), &[], false);
        // Equal radii (5) with centres 9e-4 apart are two circles, not one:
        // they meet only where x = 4.5e-4, at about ±90°. An arc from 0° to
        // 90° on the first and one from 30° to 60° on the second never
        // reach that, so they don't cross (taken as one circle, the second's
        // ends would look like an overlap).
        assert_crossing(&near(5.0, 0.0, 0.0, 90.0), &near(5.0, 9e-4, 30.0, 60.0), &[], false);
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

    /// A loop's pieces straight from corners and bulges (no reorienting).
    fn pieces(corners: &[(f64, f64)], bulges: &[f64]) -> Vec<Seg> {
        let n = corners.len();
        (0..n)
            .map(|i| {
                let (a, b) = (corners[i], corners[(i + 1) % n]);
                Seg::from_bulge(p(a.0, a.1), p(b.0, b.1), bulges.get(i).copied().unwrap_or(0.0)).unwrap()
            })
            .collect()
    }

    /// Hand-drawn loops, each listed counter-clockwise (inside on the left),
    /// with points whose winding number is known: 1 inside, 0 outside.
    /// A named loop and points with their winding numbers.
    type Drawn = (&'static str, Vec<Seg>, Vec<((f64, f64), i64)>);

    fn drawn_loops() -> Vec<Drawn> {
        let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        vec![
            // A "D": chord (−1,0)→(1,0), then the upper unit half circle back.
            // (−0.95, 0.05) is 0.951 from the centre and above the chord.
            ("D", pieces(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1.0]), vec![
                ((0.0, 0.5), 1), ((0.9, 0.3), 1), ((-0.95, 0.05), 1), ((0.0, -0.5), 0), ((0.0, 1.5), 0), ((2.0, 0.1), 0),
            ]),
            // A square whose top edge bows in (bulge −0.4): centre (5,
            // 15.25), r = 7.25, lowest at (5, 8). Above x = 1 the arc is at
            // y = 15.25 − √(7.25² − 4²) = 9.2033.
            ("bowed square", pieces(&square, &[0.0, 0.0, -0.4, 0.0]), vec![
                ((5.0, 7.0), 1), ((1.0, 9.0), 1), ((5.0, 9.0), 0), ((1.0, 9.5), 0), ((5.0, 10.5), 0), ((-1.0, 5.0), 0),
            ]),
            // A lens: (−1,0)→(1,0) with bulge ½ (centre (0, 0.75), r = 1.25,
            // lowest at (0, −0.5)), and back with bulge ½ (centre (0, −0.75),
            // highest at (0, 0.5)). (0.9, 0) is √(0.81 + 0.5625) = 1.17 from
            // both centres: inside.
            ("lens", pieces(&[(-1.0, 0.0), (1.0, 0.0)], &[0.5, 0.5]), vec![
                ((0.0, 0.0), 1), ((0.0, 0.45), 1), ((0.9, 0.0), 1), ((0.0, 0.55), 0), ((0.0, -0.55), 0), ((1.1, 0.0), 0),
            ]),
            // A stadium 10 × 4 with half circles of r = 2 on its ends.
            ("stadium", pieces(&[(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)], &[0.0, 1.0, 0.0, 1.0]), vec![
                ((-1.5, 2.0), 1), ((11.5, 2.0), 1), ((5.0, 3.9), 1), ((-2.5, 2.0), 0), ((-1.5, 0.5), 0), ((5.0, 4.1), 0),
            ]),
            // An L: the notch's corner (3, 3) is the only one turning right.
            ("L", pieces(&[(0.0, 0.0), (10.0, 0.0), (10.0, 3.0), (3.0, 3.0), (3.0, 10.0), (0.0, 10.0)], &[]), vec![
                ((1.0, 9.0), 1), ((9.0, 1.0), 1), ((5.0, 5.0), 0), ((11.0, 1.0), 0),
            ]),
            // A 1 × 10 strip whose right side bows in (bulge −0.04): centre
            // (1, 5) + (−10, 0)·(1 − 0.0016)/(−0.16) = (63.4, 5), r =
            // 10·1.0016/0.16 = 62.6, so at y = 5 the side is at x = 0.8. Its
            // circle's bottom is far below the strip: turned so the arc
            // passes other directions (−130° at a turn of 0.87, 0° at π), a
            // wrong "does it pass its circle's bottom" test would take that
            // point as the lowest and read the concave arc's clockwise turn.
            ("bowed strip", pieces(&[(0.0, 0.0), (1.0, 0.0), (1.0, 10.0), (0.0, 10.0)], &[0.0, -0.04, 0.0, 0.0]), vec![
                ((0.5, 5.0), 1), ((0.75, 5.0), 1), ((0.85, 5.0), 0), ((1.1, 5.0), 0),
            ]),
            // A triangle with a straight-through corner (5, 0) on its base.
            ("triangle", pieces(&[(0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (5.0, 5.0)], &[]), vec![((5.0, 1.0), 1), ((5.0, -1.0), 0)]),
            ("circle", vec![Seg::Circle { center: p(1.0, 2.0), radius: 3.0, ccw: true }], vec![((1.0, 4.9), 1), ((1.0, 5.1), 0)]),
        ]
    }

    #[test]
    fn orientation_of_slivers() {
        // The area sign at the edge of the range, where its rounding is
        // largest and the area smallest (counter_clockwise's comment).
        // Listed counter-clockwise, check_profile keeps the outer loop as
        // given; listed clockwise, it reverses it.
        let o = p(MAX_COORD - MAX_SIZE, MAX_COORD - 1001.0);
        // A 1 km sliver triangle 100 km out, its short side 1.1·MIN_FEATURE:
        // area = base·height/2 = 1e6 · 1.1e-3 / 2 = 550 mm².
        let w = 1.1 * MIN_FEATURE;
        let tri = vec![o, o + p(MAX_SIZE, 0.0), o + p(MAX_SIZE, w)];
        // A comb along the same kilometre, also 100 km out: a strip
        // 2·MIN_FEATURE high with 490 teeth (1,963 corners, near the limit)
        // of width half the pitch p = 1e6/490 and height 1000, so the area
        // is 1e6 · 2e-3 + 490 · (p/2) · 1000 = 2000 + 1e6 · 1000 / 2 = 500,002,000.
        let teeth = 490;
        let pitch = MAX_SIZE / teeth as f64;
        let base = 2.0 * MIN_FEATURE;
        let mut comb = vec![o + p(MAX_SIZE, 0.0), o + p(MAX_SIZE, base)];
        for i in (0..teeth).rev() {
            let x = i as f64 * pitch;
            comb.extend([o + p(x + pitch / 2.0, base), o + p(x + pitch / 2.0, base + 1000.0), o + p(x, base + 1000.0)]);
            if i > 0 {
                comb.push(o + p(x, base));
            }
        }
        comb.push(o);
        assert!(comb.len() <= MAX_PROFILE_CORNERS);
        for (name, corners, area) in [("sliver", tri, 550.0), ("comb", comb, 500_002_000.0)] {
            let loops = ok(Profile::polygon(corners.clone(), vec![]));
            // Rounding: about n·(L² + L·MAX_COORD)·1e-16, under 0.03 mm².
            assert!((signed_area(&loops[0]) - area).abs() < 0.03, "{name}: {}", signed_area(&loops[0]));
            assert_eq!(loops[0][0].ends()[0], corners[0], "{name} kept as given");
            let mut back = corners.clone();
            back.reverse();
            let loops = ok(Profile::polygon(back, vec![]));
            assert!((signed_area(&loops[0]) - area).abs() < 0.03, "{name} reversed: {}", signed_area(&loops[0]));
        }
    }

    #[test]
    fn which_way_loops_run_by_hand() {
        // Turned to eight directions (so a different point is lowest each
        // time, and at 0 and π ties along a level edge), scaled and moved:
        // listed as drawn they run counter-clockwise, reversed clockwise.
        for (name, segs, _) in drawn_loops() {
            for (i, angle) in [0.0, FRAC_PI_2, PI, 0.4, 0.87, 1.1, 2.6, 3.9, 5.6].into_iter().enumerate() {
                // Small scales too: a radius under 1 makes r and 1/r differ
                // the other way.
                let (k, shift) = [(1.0, p(0.0, 0.0)), (3.7, p(-250.5, 1e4)), (0.031, p(7.5, -3.25))][i % 3];
                let moved: Vec<Seg> = segs.iter().map(|q| placed(q, angle, k, shift)).collect();
                assert!(counter_clockwise(&moved), "{name} turned {angle}");
                assert!(!counter_clockwise(&reversed(&moved)), "{name} turned {angle}, reversed");
            }
        }
        let cw = [Seg::Circle { center: p(1.0, 2.0), radius: 3.0, ccw: false }];
        assert!(!counter_clockwise(&cw));
    }

    #[test]
    fn winding_numbers_by_hand() {
        // The points listed with each drawn loop, placed with it in odd ways;
        // run the other way round, every winding number changes sign.
        for (name, segs, points) in drawn_loops() {
            for (angle, k, shift) in [(0.0, 1.0, p(0.0, 0.0)), (0.7, 2.3, p(3.7, -1.3)), (2.9, 0.031, p(-120.5, 44.25)), (-1.3, 17.0, p(1e4, -2e4))] {
                let f = |q: DVec2| DVec2::from_angle(angle).rotate(q) * k + shift;
                let moved: Vec<Seg> = segs.iter().map(|q| placed(q, angle, k, shift)).collect();
                for &((x, y), w) in &points {
                    assert_eq!(winding(&moved, f(p(x, y))), w, "{name} at ({x}, {y}), turned {angle}");
                    assert_eq!(winding(&reversed(&moved), f(p(x, y))), -w, "{name} reversed at ({x}, {y}), turned {angle}");
                }
            }
        }
    }

    #[test]
    fn a_hole_starting_on_an_arcs_chord_is_inside() {
        // Regression: a lens (−10,0)→(10,0) with bulges ½ and ½ (half as
        // thick as long: 5 above and below the middle) and a square hole
        // whose first corner is (0, 0), on both arcs' chord. Seen from
        // there each chord is half a turn either way; the old winding
        // number took the chords' angles as found (+π and −π) and called
        // the hole outside.
        let lens = path(&[(-10.0, 0.0), (10.0, 0.0)], &[0.5, 0.5]);
        let hole = Boundary::polygon(square(0.0, 0.0, 1.0));
        assert_eq!(ok(Profile { outer: lens, holes: vec![hole] }).len(), 2);
    }

    #[test]
    fn a_very_flat_arc_lies_on_its_sweeps_side() {
        // Regression (found closing mutation survivors): which side of its
        // chord an arc lies on was read off the arc's middle point, which
        // for a very flat arc rounds onto the chord or past it. Here the
        // bottom edge starts with a clockwise arc (0,0)→(0.00508,0), bulge
        // −1.27e-9: radius = c(1 + β²)/(4|β|) ≈ 0.00508/5.08e-9 = 1e6 mm,
        // sagitta = |β|·c/2 ≈ 3.2e-12 mm below the chord. The 10×10 loop
        // lies in y ≥ −3.2e-12, so the square hole 4..6 × −6..−4 is wholly
        // outside it: winding 0 at every hole point, and the profile is
        // refused. The old code gave −1 there (an extra −2π from "between
        // arc and chord" on the wrong side), accepted the hole, and the
        // extrude then failed validation.
        let outer = path(&[(0.0, 0.0), (0.00508, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)], &[-1.2700001270000003e-9, 0.0, 0.0, 0.0, 0.0]);
        let segs = ok(Profile { outer: outer.clone(), holes: vec![] }).remove(0);
        for (x, y) in [(4.0, -6.0), (6.0, -4.0), (5.0, -5.0), (0.002, -1.0)] {
            assert_eq!(winding(&segs, p(x, y)), 0, "({x}, {y}) is below the loop");
        }
        // Points inside stay inside, including one just above the arc.
        for (x, y) in [(5.0, 5.0), (0.002, 1e-6)] {
            assert_eq!(winding(&segs, p(x, y)), 1, "({x}, {y}) is inside the loop");
        }
        let hole = Boundary::polygon(square(4.0, -6.0, 2.0));
        refused(Profile { outer, holes: vec![hole] });
    }

    #[test]
    fn profile_limits_exactly() {
        // Exactly MAX_PROFILE_CORNERS corners is allowed, one more is not:
        // a regular polygon of radius 1000 (sides 2·1000·sin(π/n) ≈ 3.1).
        let polygon = |n: usize| {
            Boundary::polygon((0..n).map(|i| dir(i as f64 * TAU / n as f64) * 1000.0).collect())
        };
        assert!(check_profile(&Profile { outer: polygon(MAX_PROFILE_CORNERS), holes: vec![] }).is_ok());
        assert!(check_profile(&Profile { outer: polygon(MAX_PROFILE_CORNERS + 1), holes: vec![] }).is_err());
        // A square exactly MAX_SIZE across is allowed.
        assert!(check_profile(&Profile { outer: Boundary::polygon(square(0.0, 0.0, MAX_SIZE)), holes: vec![] }).is_ok());
        // A square hole exactly MIN_FEATURE from the outer edge x = 0 (and
        // far from the others): the distance from (0.001, 1) to that edge
        // is exactly 0.001. "At least MIN_FEATURE" allows it.
        let hole = Boundary::polygon(vec![p(MIN_FEATURE, 1.0), p(MIN_FEATURE, 2.0), p(1.0, 2.0), p(1.0, 1.0)]);
        assert!(check_profile(&Profile { outer: Boundary::polygon(square(0.0, 0.0, 10.0)), holes: vec![hole] }).is_ok());
        // A small round hole (r = 0.1) near the outer's right edge is inside:
        // its test point must be on the hole, not 1/r = 10 away from it.
        let small = Boundary::Circle { center: p(9.5, 5.0), radius: 0.1 };
        assert!(check_profile(&Profile { outer: Boundary::polygon(square(0.0, 0.0, 10.0)), holes: vec![small] }).is_ok());
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
