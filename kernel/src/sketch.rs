//! Sketch geometry on a plane: the first part of the kernel's 2D curve
//! library (roadmap K1), used by the sketcher (step 21) and, later, Vector,
//! Laser and Layout. Coordinates are the sketch plane's own x and y, in mm.
//!
//! - `snap_to_grid`: the nearest node of a square grid. A node is k·s for a
//!   whole number k = round(p / s) (halves round away from zero). When s is
//!   1/n for a whole n (0.1, 0.25, 0.5…) the node is computed as k / n
//!   instead, which is the double nearest the decimal value: 3 / 10 gives
//!   0.3 exactly as typed, where 3 × 0.1 gives 0.30000000000000004. Either
//!   way the same k always gives bit-identical nodes, so lines drawn to the
//!   same node share their end exactly.
//! - `check_lines`: the rules for a sketch's lines (finite, within MAX_COORD,
//!   length within [MIN_FEATURE, MAX_SIZE], at most MAX_PROFILE_CORNERS).
//! - `check_circles`: the rules for a sketch's circles (step 22b): radius
//!   within [MIN_FEATURE, MAX_SIZE / 2], so the diameter, the span a
//!   profile may have, is at most MAX_SIZE; the whole circle (centre ± r in
//!   both coordinates) within MAX_COORD.
//! - `check_arcs`: the rules for a sketch's arcs (step 23a). An arc runs
//!   counter-clockwise round its centre from its start to its end (as in
//!   Fusion), so it is three points and nothing else: the ends at least
//!   MIN_FEATURE apart (closer is a speck or a whole circle, which is a
//!   circle); the centre within LINEAR of the line midway between the ends
//!   (their perpendicular bisector), so it is the same distance from both;
//!   the radius (the mean of those distances) within [MIN_FEATURE,
//!   MAX_SIZE], the profile's arc rule; and the arc itself within
//!   MAX_COORD. `Arc::bulge` turns it into the profile's bulge, whose arc
//!   passes through both ends exactly (they are corners shared with other
//!   pieces) round the point of the bisector nearest the centre. So the
//!   centre's distance from the bisector is how far that arc strays from
//!   the circle round the centre, and that is what the rule bounds. The
//!   ends' difference in distance from the centre would not do: for a
//!   nearly whole arc on a short chord c, a centre d off the bisector
//!   changes it by only about d·c / r, while the far side of the arc moves
//!   by d.
//! - `sketch_outline`: the one closed outline the lines, circles and arcs
//!   make, or why they make none. A sketch of exactly one circle and
//!   nothing else is that circle's outline (`Boundary::Circle`). A circle
//!   together with anything else is several loops until regions (step 26),
//!   after the other curves' own loose ends and branches, which are
//!   reported first. Lines and arcs are pieces with two ends each (lines
//!   first, then arcs, in the order given). Two ends are joined when they
//!   are within LINEAR of each other (a corner); every corner must join
//!   exactly two ends. The loop is walked from piece 0 in its own
//!   direction, each piece entered at the end that meets the previous one,
//!   and each corner is the end of the piece being entered, so the result
//!   is the same however the pieces are ordered after piece 0, and a line
//!   or arc drawn backwards is simply walked the other way (an arc walked
//!   from its end gets its bulge negated: the same arc, turning
//!   clockwise). The loop then goes through the profile rules
//!   (`ops::profile::check_profile`: no crossings, touching or slivers),
//!   so a closed sketch is exactly a profile the extrude accepts (a lone
//!   circle goes through the same check). Several
//!   separate loops, and loops inside loops, wait for profile detection
//!   (step 26); until then they are reported, not guessed at.
//!
//! Cost: joining ends sorts them by x and compares each with the ends
//! less than LINEAR further along, so it is O(n log n) for spread-out
//! pieces and O(n²) at worst (every end within LINEAR in x), with n capped
//! at MAX_PROFILE_CORNERS, the same bound as the profile check.
use crate::ops::profile::{bounds, check_profile, Boundary, Profile, Seg};
use crate::ops::KernelError;
use crate::tolerance::{LINEAR, MAX_COORD, MAX_PROFILE_CORNERS, MAX_SIZE, MIN_FEATURE};
use glam::DVec2;
use std::fmt;

/// One straight line of a sketch, from `a` to `b`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    pub a: DVec2,
    pub b: DVec2,
}

/// One circle of a sketch, round `centre` with radius `radius`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Circle {
    pub centre: DVec2,
    pub radius: f64,
}

/// One arc of a sketch (step 23a): from `start` to `end`, counter-clockwise
/// round `centre`, which is midway between them (`check_arcs`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Arc {
    pub start: DVec2,
    pub end: DVec2,
    pub centre: DVec2,
}

impl Arc {
    /// The mean of the two ends' distances from the centre.
    pub fn radius(&self) -> f64 {
        (self.start.distance(self.centre) + self.end.distance(self.centre)) / 2.0
    }

    /// The bulge `ops::profile` takes for this arc: tan(φ/4) for the angle
    /// φ it turns through, which is positive (counter-clockwise).
    ///
    /// Worked from the sagitta s, how far the arc's middle stands off its
    /// chord's midpoint m. With half-chord h and x = φ/2, h = r sin x and
    /// s = r (1 − cos x), so s / h = (1 − cos x) / sin x = tan(x / 2) =
    /// tan(φ/4): the bulge is 2s / c for chord length c. A counter-clockwise
    /// arc's middle is r from the centre along the chord's right-hand
    /// normal n (the arc bows out to the right of start → end), so
    /// s = (centre − m)·n + r. Unlike tan(φ/4) from an angle, this keeps
    /// its digits for every sweep: s is off by a few roundings of r and m
    /// at most, and that is how far the arc is off, whatever φ is. Near a
    /// full turn tan(φ/4) is near its pole: for a 1 km radius on a 1 µm
    /// chord, the last digit of φ would move the arc by about a millimetre.
    pub fn bulge(&self) -> f64 {
        let d = self.end - self.start;
        let c = d.length();
        let n = DVec2::new(d.y, -d.x) / c;
        let s = (self.centre - (self.start + self.end) * 0.5).dot(n) + self.radius();
        2.0 * s / c
    }

    /// The profile's piece for this arc.
    fn seg(&self) -> Seg {
        Seg::Arc { a: self.start, b: self.end, center: self.centre, radius: self.radius(), sweep: 4.0 * self.bulge().atan() }
    }
}

/// The nearest node of a square grid with spacing `spacing` to `p`.
/// The spacing must be within [MIN_FEATURE, MAX_SIZE], `p` finite and
/// within MAX_COORD, and the node too.
pub fn snap_to_grid(p: DVec2, spacing: f64) -> Result<DVec2, KernelError> {
    if !(MIN_FEATURE..=MAX_SIZE).contains(&spacing) {
        return Err(KernelError::InvalidInput(format!(
            "grid spacing must be between {MIN_FEATURE} and {MAX_SIZE} mm, got {spacing}"
        )));
    }
    if !in_range(p) {
        return Err(KernelError::InvalidInput(format!("point ({}, {}) is outside the modelling range", p.x, p.y)));
    }
    let inverse = 1.0 / spacing;
    let decimal = inverse.fract() == 0.0 && 1.0 / inverse == spacing;
    // Adding +0 turns a −0 node (rounded up from just below zero) into +0,
    // so the node at zero has one bit pattern however it is reached.
    let node = |v: f64| {
        let k = (v / spacing).round();
        (if decimal { k / inverse } else { k * spacing }) + 0.0
    };
    let snapped = DVec2::new(node(p.x), node(p.y));
    if !in_range(snapped) {
        return Err(KernelError::InvalidInput(format!(
            "the grid node nearest ({}, {}) is outside the modelling range",
            p.x, p.y
        )));
    }
    Ok(snapped)
}

/// Finite and within MAX_COORD of the origin in both coordinates.
fn in_range(p: DVec2) -> bool {
    p.is_finite() && p.abs().max_element() <= MAX_COORD
}

/// The rules every sketch's lines follow; the first broken one is named
/// with the line's number (from 1, as a person counts).
pub fn check_lines(lines: &[Line]) -> Result<(), KernelError> {
    if lines.len() > MAX_PROFILE_CORNERS {
        return Err(KernelError::InvalidInput(format!(
            "a sketch has at most {MAX_PROFILE_CORNERS} lines, got {}",
            lines.len()
        )));
    }
    for (i, line) in lines.iter().enumerate() {
        let n = i + 1;
        if !in_range(line.a) || !in_range(line.b) {
            return Err(KernelError::InvalidInput(format!("line {n} has an end outside the modelling range")));
        }
        let length = line.a.distance(line.b);
        if !(MIN_FEATURE..=MAX_SIZE).contains(&length) {
            return Err(KernelError::InvalidInput(format!(
                "line {n} must be between {MIN_FEATURE} and {MAX_SIZE} mm long, got {length}"
            )));
        }
    }
    Ok(())
}

/// The rules every sketch's circles follow; the first broken one is named
/// with the circle's number (from 1, counting circles only).
pub fn check_circles(circles: &[Circle]) -> Result<(), KernelError> {
    for (i, c) in circles.iter().enumerate() {
        let n = i + 1;
        let most = MAX_SIZE / 2.0;
        if !(MIN_FEATURE..=most).contains(&c.radius) {
            return Err(KernelError::InvalidInput(format!(
                "circle {n}'s radius must be between {MIN_FEATURE} and {most} mm, got {}",
                c.radius
            )));
        }
        if !in_range(c.centre - c.radius) || !in_range(c.centre + c.radius) {
            return Err(KernelError::InvalidInput(format!("circle {n} reaches outside the modelling range")));
        }
    }
    Ok(())
}

/// The rules every sketch's arcs follow (module comment); the first broken
/// one is named with the arc's number (from 1, counting arcs only).
pub fn check_arcs(arcs: &[Arc]) -> Result<(), KernelError> {
    for (i, arc) in arcs.iter().enumerate() {
        let n = i + 1;
        let bad = |m: String| Err(KernelError::InvalidInput(format!("arc {n} {m}")));
        if !in_range(arc.start) || !in_range(arc.end) || !in_range(arc.centre) {
            return bad("has a point outside the modelling range".into());
        }
        let chord = arc.start.distance(arc.end);
        if chord < MIN_FEATURE {
            return bad(format!("has its ends {chord} mm apart; they must be at least {MIN_FEATURE} mm apart"));
        }
        let off = (arc.centre - (arc.start + arc.end) * 0.5).dot(arc.end - arc.start) / chord;
        if off.abs() > LINEAR {
            return bad(format!(
                "has its centre {} mm off the line midway between its ends; it must be within {LINEAR} mm of it, the same distance from both",
                off.abs()
            ));
        }
        let radius = arc.radius();
        if !(MIN_FEATURE..=MAX_SIZE).contains(&radius) {
            return bad(format!("has radius {radius}; it must be between {MIN_FEATURE} and {MAX_SIZE} mm"));
        }
        let (lo, hi) = bounds(&arc.seg());
        if !in_range(lo) || !in_range(hi) {
            return bad("reaches outside the modelling range".into());
        }
    }
    Ok(())
}

/// Why a sketch's curves make no outline yet. None of these is an error: a
/// sketch is open while it is being drawn.
#[derive(Clone, Debug, PartialEq)]
pub enum Open {
    /// No lines, arcs or circles yet.
    Empty,
    /// A line or arc end joined to no other.
    LooseEnd { at: DVec2 },
    /// More than two line or arc ends meet at one corner.
    Branch { at: DVec2, ends: usize },
    /// Every corner joins two ends, but the curves make several loops
    /// (each circle is one).
    SeveralLoops { loops: usize },
    /// One loop, but not a valid profile (it crosses or touches itself, a
    /// sliver, a line doubling back…): the profile check's reason.
    NotAProfile { reason: String },
}

impl fmt::Display for Open {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Open::Empty => write!(f, "the sketch has no lines, arcs or circles yet"),
            Open::LooseEnd { at } => write!(f, "the end at ({}, {}) is not joined to another line or arc", at.x, at.y),
            Open::Branch { at, ends } => {
                write!(f, "{ends} ends meet at ({}, {}); every corner of an outline joins exactly two", at.x, at.y)
            }
            Open::SeveralLoops { loops } => {
                write!(f, "the sketch makes {loops} separate loops; for now a sketch makes one outline")
            }
            Open::NotAProfile { reason } => write!(f, "the curves close up but are not a valid outline: {reason}"),
        }
    }
}

/// What a sketch's curves make.
#[derive(Clone, Debug, PartialEq)]
pub enum SketchOutline {
    /// One closed loop that passes the profile rules: ready to extrude.
    Closed(Profile),
    Open(Open),
}

/// A line or an arc as the walk sees it: two ends and the bulge from `a`
/// to `b` (0 for a line).
#[derive(Clone, Copy)]
struct Piece {
    a: DVec2,
    b: DVec2,
    bulge: f64,
}

/// The one closed outline `lines`, `circles` and `arcs` make, or why they
/// make none (see the module comment). More than MAX_PROFILE_CORNERS of
/// them together, or any breaking `check_lines`, `check_circles` or
/// `check_arcs`, is an error.
pub fn sketch_outline(lines: &[Line], circles: &[Circle], arcs: &[Arc]) -> Result<SketchOutline, KernelError> {
    let count = lines.len() + circles.len() + arcs.len();
    if count > MAX_PROFILE_CORNERS {
        return Err(KernelError::InvalidInput(format!(
            "a sketch has at most {MAX_PROFILE_CORNERS} lines, arcs and circles, got {count}"
        )));
    }
    check_lines(lines)?;
    check_circles(circles)?;
    check_arcs(arcs)?;
    let pieces: Vec<Piece> = lines
        .iter()
        .map(|l| Piece { a: l.a, b: l.b, bulge: 0.0 })
        .chain(arcs.iter().map(|arc| Piece { a: arc.start, b: arc.end, bulge: arc.bulge() }))
        .collect();
    if pieces.is_empty() {
        return match circles {
            [] => Ok(SketchOutline::Open(Open::Empty)),
            [c] => profiled(Profile { outer: Boundary::Circle { center: c.centre, radius: c.radius }, holes: vec![] }),
            _ => Ok(SketchOutline::Open(Open::SeveralLoops { loops: circles.len() })),
        };
    }
    let partner = match join_ends(&pieces) {
        Ok(p) => p,
        Err(open) => return Ok(SketchOutline::Open(open)),
    };
    // Walk from piece 0's start; `end` is 0 for a piece's `a`, 1 for its
    // `b`. A piece entered at its `b` is walked backwards, so its bulge
    // changes sign (+ 0.0 keeps a line's 0 from becoming −0).
    let mut corners = Vec::with_capacity(pieces.len());
    let mut bulges = Vec::with_capacity(pieces.len());
    let mut seen = vec![false; pieces.len()];
    let (mut piece, mut entered) = (0, 0);
    while !seen[piece] {
        seen[piece] = true;
        corners.push(end_point(&pieces, 2 * piece + entered));
        let bulge = pieces[piece].bulge;
        bulges.push(if entered == 0 { bulge } else { -bulge + 0.0 });
        let leaving = 2 * piece + 1 - entered;
        let next = partner[leaving];
        (piece, entered) = (next / 2, next % 2);
    }
    let loops = 1 + count_loops(&partner, seen) + circles.len();
    if loops > 1 {
        return Ok(SketchOutline::Open(Open::SeveralLoops { loops }));
    }
    if bulges.iter().all(|&b| b == 0.0) {
        bulges.clear();
    }
    profiled(Profile { outer: Boundary::Path { corners, bulges }, holes: vec![] })
}

/// The profile as a closed outline if it passes the profile rules, else
/// open with their reason.
fn profiled(profile: Profile) -> Result<SketchOutline, KernelError> {
    match check_profile(&profile) {
        Ok(_) => Ok(SketchOutline::Closed(profile)),
        Err(KernelError::InvalidInput(reason)) => Ok(SketchOutline::Open(Open::NotAProfile { reason })),
        Err(e) => Err(e),
    }
}

/// End `e` of the pieces: piece e / 2, its `a` when e is even, else its `b`.
fn end_point(pieces: &[Piece], e: usize) -> DVec2 {
    let piece = pieces[e / 2];
    if e.is_multiple_of(2) { piece.a } else { piece.b }
}

/// For every end, the one other end it joins. Ends within LINEAR form a
/// corner; a corner of one end is loose, of three or more a branch. The
/// problem reported is the one at the lowest-numbered end, so the answer
/// doesn't depend on how the sort breaks ties.
fn join_ends(pieces: &[Piece]) -> Result<Vec<usize>, Open> {
    let count = 2 * pieces.len();
    let mut order: Vec<usize> = (0..count).collect();
    order.sort_by(|&i, &j| end_point(pieces, i).x.total_cmp(&end_point(pieces, j).x));
    let mut near: Vec<Vec<usize>> = vec![vec![]; count];
    for (k, &i) in order.iter().enumerate() {
        let p = end_point(pieces, i);
        for &j in &order[k + 1..] {
            let q = end_point(pieces, j);
            if q.x - p.x > LINEAR {
                break;
            }
            if p.distance(q) <= LINEAR {
                near[i].push(j);
                near[j].push(i);
            }
        }
    }
    for (e, others) in near.iter().enumerate() {
        let at = end_point(pieces, e);
        match others.len() {
            0 => return Err(Open::LooseEnd { at }),
            1 => {}
            n => return Err(Open::Branch { at, ends: n + 1 }),
        }
    }
    Ok(near.iter().map(|others| others[0]).collect())
}

/// How many loops the pieces not yet `seen` make (every end has a partner).
fn count_loops(partner: &[usize], mut seen: Vec<bool>) -> usize {
    let mut loops = 0;
    for start in 0..seen.len() {
        if seen[start] {
            continue;
        }
        loops += 1;
        let (mut piece, mut entered) = (start, 0);
        while !seen[piece] {
            seen[piece] = true;
            let next = partner[2 * piece + 1 - entered];
            (piece, entered) = (next / 2, next % 2);
        }
    }
    loops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::profile::Boundary;

    fn v(x: f64, y: f64) -> DVec2 {
        DVec2::new(x, y)
    }

    fn line(a: (f64, f64), b: (f64, f64)) -> Line {
        Line { a: v(a.0, a.1), b: v(b.0, b.1) }
    }

    /// The lines joining `pts` in order and back to the first.
    fn ring(pts: &[(f64, f64)]) -> Vec<Line> {
        (0..pts.len()).map(|i| line(pts[i], pts[(i + 1) % pts.len()])).collect()
    }

    fn corners(outline: SketchOutline) -> Vec<DVec2> {
        match outline {
            SketchOutline::Closed(Profile { outer: Boundary::Path { corners, bulges }, holes }) => {
                assert!(bulges.is_empty() && holes.is_empty());
                corners
            }
            other => panic!("expected a closed outline, got {other:?}"),
        }
    }

    fn open(lines: &[Line]) -> Open {
        match sketch_outline(lines, &[], &[]).unwrap() {
            SketchOutline::Open(o) => o,
            other => panic!("expected an open sketch, got {other:?}"),
        }
    }

    fn circle(x: f64, y: f64, radius: f64) -> Circle {
        Circle { centre: v(x, y), radius }
    }

    /// What the lines and circles make, when they make no outline.
    fn open_with(lines: &[Line], circles: &[Circle]) -> Open {
        match sketch_outline(lines, circles, &[]).unwrap() {
            SketchOutline::Open(o) => o,
            other => panic!("expected an open sketch, got {other:?}"),
        }
    }

    fn invalid(r: Result<impl fmt::Debug, KernelError>) -> String {
        match r {
            Err(KernelError::InvalidInput(m)) => m,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    // ---- snap_to_grid

    #[test]
    fn snaps_to_the_nearest_node_worked_by_hand() {
        // Grid 5: (12.4, -7.6) / 5 = (2.48, -1.52), rounded (2, -2), times 5 = (10, -10).
        assert_eq!(snap_to_grid(v(12.4, -7.6), 5.0).unwrap(), v(10.0, -10.0));
        // Grid 5, (12.6, -7.4): 2.52 → 3 and -1.48 → -1, so (15, -5).
        assert_eq!(snap_to_grid(v(12.6, -7.4), 5.0).unwrap(), v(15.0, -5.0));
        // Halves round away from zero: 2.5 / 5 = 0.5 → 1; -2.5 / 5 = -0.5 → -1.
        assert_eq!(snap_to_grid(v(2.5, -2.5), 5.0).unwrap(), v(5.0, -5.0));
        // A node stays where it is, and the origin is a node of every grid.
        assert_eq!(snap_to_grid(v(15.0, 0.0), 5.0).unwrap(), v(15.0, 0.0));
        assert_eq!(snap_to_grid(v(0.4, -0.4), 1.0).unwrap(), v(0.0, 0.0));
        // A spacing that isn't 1/n: 3: 7.4 / 3 = 2.47 → 2 → 6; -7.6 / 3 = -2.53 → -3 → -9.
        assert_eq!(snap_to_grid(v(7.4, -7.6), 3.0).unwrap(), v(6.0, -9.0));
        // 0.3 spacing (1/0.3 = 3.33…, not whole): 1.0 / 0.3 = 3.33 → 3, node 3 × 0.3.
        assert_eq!(snap_to_grid(v(1.0, 0.0), 0.3).unwrap(), v(3.0 * 0.3, 0.0));
        // 1.3 (1/1.3 = 0.769…, not whole) takes k × s: 6.02 / 1.3 = 4.63 → 5,
        // and 5 × 1.3 is 6.5 exactly, where 5 / (1/1.3) would be 6.500000000000001.
        assert_ne!(5.0 / (1.0 / 1.3), 6.5);
        assert_eq!(snap_to_grid(v(6.02, 0.0), 1.3).unwrap(), v(6.5, 0.0));
    }

    #[test]
    fn decimal_spacings_give_the_typed_decimal() {
        // 0.31 / 0.1 = 3.1 → 3, node 3 / 10: the double nearest 0.3, which is
        // what typing "0.3" gives. 3 × 0.1 would be 0.30000000000000004.
        assert_ne!(3.0 * 0.1, 0.3);
        assert_eq!(snap_to_grid(v(0.31, 0.69), 0.1).unwrap(), v(0.3, 0.7));
        // 0.25 = 1/4: 1.13 / 0.25 = 4.52 → 5, so 5 / 4 = 1.25; -0.6 / 0.25 = -2.4 → -2, -0.5.
        assert_eq!(snap_to_grid(v(1.13, -0.6), 0.25).unwrap(), v(1.25, -0.5));
        // 0.001 (the smallest spacing) = 1/1000: 2.0004 → 2000 / 1000 = 2.
        assert_eq!(snap_to_grid(v(2.0004, 0.0123), 0.001).unwrap(), v(2.0, 0.012));
    }

    #[test]
    fn the_same_node_is_bit_identical_however_it_is_reached() {
        // Two pointer positions either side of the node 0.7 on a 0.1 grid
        // snap to the same bits, so two lines drawn there share their end.
        let a = snap_to_grid(v(0.66, 0.74), 0.1).unwrap();
        let b = snap_to_grid(v(0.74, 0.66), 0.1).unwrap();
        assert_eq!(a.x.to_bits(), b.y.to_bits());
        assert_eq!(a.x.to_bits(), 0.7f64.to_bits());
    }

    #[test]
    fn the_node_at_zero_is_plus_zero_from_either_side() {
        // Regression (step 22a): (−0.3 / 10).round() is −0, so a click just
        // below the x axis snapped to (x, −0) and one just above to (x, +0):
        // equal as numbers but not bit-identical, against the rule above
        // (and a saved file writes −0 as 0, so it opened different).
        for spacing in [10.0, 0.1, 0.3] {
            for p in [v(-0.03, 0.03), v(0.03, -0.03), v(-0.0, -0.0)] {
                let s = snap_to_grid(p, spacing).unwrap();
                assert_eq!((s.x.to_bits(), s.y.to_bits()), (0, 0), "{p} on a {spacing} grid gave {s}");
            }
        }
    }

    #[test]
    fn spacing_limits_at_0_9_and_1_1() {
        assert!(snap_to_grid(v(1.0, 1.0), MIN_FEATURE).is_ok());
        assert!(snap_to_grid(v(1.0, 1.0), MAX_SIZE).is_ok());
        assert!(snap_to_grid(v(1.0, 1.0), 1.1 * MIN_FEATURE).is_ok());
        assert!(snap_to_grid(v(1.0, 1.0), 0.9 * MAX_SIZE).is_ok());
        for bad in [0.9 * MIN_FEATURE, 1.1 * MAX_SIZE, 0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(invalid(snap_to_grid(v(1.0, 1.0), bad)).contains("grid spacing"), "{bad}");
        }
    }

    #[test]
    fn points_outside_the_range_are_refused() {
        assert!(snap_to_grid(v(MAX_COORD, -MAX_COORD), 1.0).is_ok());
        for p in [v(1.1 * MAX_COORD, 0.0), v(0.0, -1.1 * MAX_COORD), v(f64::NAN, 0.0), v(0.0, f64::NEG_INFINITY)] {
            assert!(invalid(snap_to_grid(p, 1.0)).contains("outside the modelling range"), "{p}");
        }
        // In range, but the nearest node of a 700 m grid is past MAX_COORD:
        // 1e8 / 7e5 = 142.86 → 143, and 143 × 7e5 = 1.001e8.
        let m = invalid(snap_to_grid(v(MAX_COORD, 0.0), 7e5));
        assert!(m.contains("grid node nearest"), "{m}");
        // The y coordinate is checked on its own: x snaps to 0.
        let m = invalid(snap_to_grid(v(0.0, -MAX_COORD), 7e5));
        assert!(m.contains("grid node nearest"), "{m}");
    }

    // ---- check_lines

    #[test]
    fn line_lengths_at_0_9_and_1_1_of_the_limits() {
        let at = |len: f64| check_lines(&[line((0.0, 0.0), (len, 0.0))]);
        assert!(at(1.1 * MIN_FEATURE).is_ok());
        assert!(at(0.9 * MAX_SIZE).is_ok());
        assert!(at(MIN_FEATURE).is_ok());
        assert!(at(MAX_SIZE).is_ok());
        assert!(invalid(at(0.9 * MIN_FEATURE)).contains("line 1 must be between"));
        assert!(invalid(at(1.1 * MAX_SIZE)).contains("line 1 must be between"));
        assert!(invalid(at(0.0)).contains("line 1 must be between"));
    }

    #[test]
    fn bad_ends_name_the_line() {
        let good = line((0.0, 0.0), (1.0, 0.0));
        for bad in [line((f64::NAN, 0.0), (1.0, 0.0)), line((0.0, 0.0), (1.0, f64::INFINITY)), line((1.1 * MAX_COORD, 0.0), (1.1 * MAX_COORD - 1.0, 0.0))] {
            assert_eq!(invalid(check_lines(&[good, bad])), "line 2 has an end outside the modelling range");
        }
        // Ends exactly at MAX_COORD are inside.
        assert!(check_lines(&[line((MAX_COORD, 0.0), (MAX_COORD - 1.0, 0.0))]).is_ok());
        assert!(check_lines(&[line((-MAX_COORD + 1.0, 0.0), (-MAX_COORD, 0.0))]).is_ok());
    }

    #[test]
    fn at_most_max_profile_corners_lines() {
        let many = |n: usize| (0..n).map(|i| line((i as f64, 0.0), (i as f64, 1.0))).collect::<Vec<_>>();
        assert!(check_lines(&many(MAX_PROFILE_CORNERS)).is_ok());
        assert!(invalid(check_lines(&many(MAX_PROFILE_CORNERS + 1))).contains("at most 2000 lines"));
        assert!(invalid(sketch_outline(&many(MAX_PROFILE_CORNERS + 1), &[], &[])).contains("at most"));
    }

    // ---- sketch_outline

    #[test]
    fn a_square_drawn_in_order_closes_worked_by_hand() {
        // 10 × 10 square drawn (0,0) → (10,0) → (10,10) → (0,10) → back:
        // four corners, walked from line 1's start, so the corners are the
        // points in the order drawn. Its area by the shoelace formula is
        // ½|Σ x_i y_{i+1} − x_{i+1} y_i| = ½(0 + 100 + 100 + 0) = 100.
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let got = corners(sketch_outline(&ring(&pts), &[], &[]).unwrap());
        assert_eq!(got, pts.iter().map(|&(x, y)| v(x, y)).collect::<Vec<_>>());
        let segs = check_profile(&Profile::polygon(got, vec![])).unwrap();
        assert!((crate::ops::profile::signed_area(&segs[0]).abs() - 100.0).abs() <= crate::tolerance::AREA);
    }

    #[test]
    fn order_and_direction_of_the_lines_do_not_matter() {
        // The same triangle with lines 2 and 3 swapped and line 2 drawn
        // backwards: still walked from line 1, (0,0) → (4,0), then the line
        // that meets (4,0), entered there, then the last.
        let lines = [line((0.0, 0.0), (4.0, 0.0)), line((0.0, 3.0), (0.0, 0.0)), line((0.0, 3.0), (4.0, 0.0))];
        assert_eq!(corners(sketch_outline(&lines, &[], &[]).unwrap()), vec![v(0.0, 0.0), v(4.0, 0.0), v(0.0, 3.0)]);
        // Line 1 itself reversed walks the loop the other way round.
        let lines = [line((4.0, 0.0), (0.0, 0.0)), line((0.0, 3.0), (0.0, 0.0)), line((0.0, 3.0), (4.0, 0.0))];
        assert_eq!(corners(sketch_outline(&lines, &[], &[]).unwrap()), vec![v(4.0, 0.0), v(0.0, 0.0), v(0.0, 3.0)]);
    }

    #[test]
    fn ends_join_within_linear_at_0_9_and_1_1() {
        // A triangle whose last line stops short of the start by d.
        let tri = |d: f64| vec![line((0.0, 0.0), (4.0, 0.0)), line((4.0, 0.0), (0.0, 3.0)), line((0.0, 3.0), (d, 0.0))];
        // 0.9 LINEAR: the ends join, and the corner is line 1's start.
        assert_eq!(corners(sketch_outline(&tri(0.9 * LINEAR), &[], &[]).unwrap())[0], v(0.0, 0.0));
        // 1.1 LINEAR: a gap; the lowest-numbered loose end is line 1's start.
        assert_eq!(open(&tri(1.1 * LINEAR)), Open::LooseEnd { at: v(0.0, 0.0) });
        // The same along y, so the distance (not just x) decides.
        let tri_y = |d: f64| vec![line((0.0, 0.0), (4.0, 0.0)), line((4.0, 0.0), (0.0, 3.0)), line((0.0, 3.0), (0.0, d))];
        assert!(matches!(sketch_outline(&tri_y(0.9 * LINEAR), &[], &[]).unwrap(), SketchOutline::Closed(_)));
        assert_eq!(open(&tri_y(1.1 * LINEAR)), Open::LooseEnd { at: v(0.0, 0.0) });
        // Diagonal: 0.8 LINEAR in x and in y is 1.13 LINEAR apart.
        let d = 0.8 * LINEAR;
        let diag = vec![line((0.0, 0.0), (4.0, 0.0)), line((4.0, 0.0), (0.0, 3.0)), line((0.0, 3.0), (d, d))];
        assert_eq!(open(&diag), Open::LooseEnd { at: v(0.0, 0.0) });
    }

    #[test]
    fn ends_just_past_linear_in_x_are_not_compared() {
        // The sweep stops once x is more than LINEAR further on, but an end
        // exactly LINEAR along in x and level is still joined.
        let tri = |d: f64| vec![line((d, 0.0), (4.0, 0.0)), line((4.0, 0.0), (0.0, 3.0)), line((0.0, 3.0), (0.0, 0.0))];
        assert!(matches!(sketch_outline(&tri(LINEAR), &[], &[]).unwrap(), SketchOutline::Closed(_)));
        assert_eq!(open(&tri(1.1 * LINEAR)), Open::LooseEnd { at: v(1.1 * LINEAR, 0.0) });
    }

    #[test]
    fn open_sketches_say_why() {
        assert_eq!(open(&[]), Open::Empty);
        // One line: its start is the lowest-numbered loose end.
        assert_eq!(open(&[line((1.0, 2.0), (3.0, 2.0))]), Open::LooseEnd { at: v(1.0, 2.0) });
        // Three sides of a square: line 1's start is loose (and so is line 3's end).
        let three = [line((0.0, 0.0), (5.0, 0.0)), line((5.0, 0.0), (5.0, 5.0)), line((5.0, 5.0), (0.0, 5.0))];
        assert_eq!(open(&three), Open::LooseEnd { at: v(0.0, 0.0) });
        // The same three with line 1 reversed: its start (5,0) is joined, its end
        // (0,0) is end 1, the lowest loose one.
        let three = [line((5.0, 0.0), (0.0, 0.0)), line((5.0, 0.0), (5.0, 5.0)), line((5.0, 5.0), (0.0, 5.0))];
        assert_eq!(open(&three), Open::LooseEnd { at: v(0.0, 0.0) });
    }

    #[test]
    fn a_square_with_a_tail_is_a_branch() {
        // A square plus a line from (10,0) outwards: three ends meet at (10,0).
        let mut lines = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        lines.push(line((10.0, 0.0), (20.0, 0.0)));
        assert_eq!(open(&lines), Open::Branch { at: v(10.0, 0.0), ends: 3 });
        // A figure of eight through (0,0): two triangles sharing a corner, four ends.
        let mut eight = ring(&[(0.0, 0.0), (4.0, 1.0), (4.0, -1.0)]);
        eight.extend(ring(&[(0.0, 0.0), (-4.0, 1.0), (-4.0, -1.0)]));
        assert_eq!(open(&eight), Open::Branch { at: v(0.0, 0.0), ends: 4 });
        assert_eq!(Open::Branch { at: v(0.0, 0.0), ends: 4 }.to_string(), "4 ends meet at (0, 0); every corner of an outline joins exactly two");
    }

    #[test]
    fn separate_loops_are_counted() {
        // Two squares apart, then a third; each closed, so 2 and 3 loops.
        let mut lines = ring(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]);
        lines.extend(ring(&[(5.0, 0.0), (6.0, 0.0), (6.0, 1.0), (5.0, 1.0)]));
        assert_eq!(open(&lines), Open::SeveralLoops { loops: 2 });
        lines.extend(ring(&[(9.0, 0.0), (8.0, 1.0), (8.0, 0.0)]));
        assert_eq!(open(&lines), Open::SeveralLoops { loops: 3 });
        // A square inside a square is also two loops until step 26.
        let mut nested = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        nested.extend(ring(&[(2.0, 2.0), (2.0, 8.0), (8.0, 8.0), (8.0, 2.0)]));
        assert_eq!(open(&nested), Open::SeveralLoops { loops: 2 });
        // Loops counted after the first: lines interleaved, the second loop's
        // lines out of order and one reversed.
        let lines = [
            line((0.0, 0.0), (1.0, 0.0)),
            line((5.0, 1.0), (6.0, 0.0)),
            line((1.0, 0.0), (0.0, 1.0)),
            line((5.0, 0.0), (6.0, 0.0)),
            line((0.0, 1.0), (0.0, 0.0)),
            line((5.0, 1.0), (5.0, 0.0)),
            line((9.0, 0.0), (10.0, 0.0)),
            line((10.0, 0.0), (9.0, 1.0)),
            line((9.0, 1.0), (9.0, 0.0)),
        ];
        assert_eq!(open(&lines), Open::SeveralLoops { loops: 3 });
    }

    #[test]
    fn a_loop_that_breaks_the_profile_rules_says_so() {
        // A bow tie: four corners, every corner joins two ends, but lines 1
        // and 3 cross at (5,5).
        let bow = ring(&[(0.0, 0.0), (10.0, 10.0), (10.0, 0.0), (0.0, 10.0)]);
        let Open::NotAProfile { reason } = open(&bow) else { panic!() };
        assert!(reason.contains("apart"), "{reason}");
        // Two lines back and forth between the same two points: a loop of two
        // corners, refused by the profile check.
        let twice = [line((0.0, 0.0), (5.0, 0.0)), line((5.0, 0.0), (0.0, 0.0))];
        assert!(matches!(open(&twice), Open::NotAProfile { .. }));
        // A sliver: a triangle 0.9 MIN_FEATURE tall over a 10 mm base.
        let sliver = ring(&[(0.0, 0.0), (10.0, 0.0), (5.0, 0.9 * MIN_FEATURE)]);
        assert!(matches!(open(&sliver), Open::NotAProfile { .. }));
        // 1.1 MIN_FEATURE tall: the tip is 1.1 MIN_FEATURE from the base, so
        // it is accepted.
        let thin = ring(&[(0.0, 0.0), (10.0, 0.0), (5.0, 1.1 * MIN_FEATURE)]);
        assert!(matches!(sketch_outline(&thin, &[], &[]).unwrap(), SketchOutline::Closed(_)));
    }

    #[test]
    fn bad_lines_are_errors_not_open_sketches() {
        let mut lines = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]);
        lines[1].b.x = f64::NAN;
        assert_eq!(invalid(sketch_outline(&lines, &[], &[])), "line 2 has an end outside the modelling range");
    }

    // ---- circles (step 22b)

    #[test]
    fn one_circle_is_a_closed_outline_worked_by_hand() {
        // A circle round (3, -4) of radius 5, and nothing else: the outline
        // is that circle, unchanged (no corners to walk), with no holes.
        let got = sketch_outline(&[], &[circle(3.0, -4.0, 5.0)], &[]).unwrap();
        let want = Profile { outer: Boundary::Circle { center: v(3.0, -4.0), radius: 5.0 }, holes: vec![] };
        assert_eq!(got, SketchOutline::Closed(want.clone()));
        // It passes the profile rules: one loop, area π·5² = 25π (the
        // profile's own signed area, counter-clockwise).
        let loops = check_profile(&want).unwrap();
        assert_eq!(loops.len(), 1);
        assert!(crate::tolerance::rel_eq(crate::ops::profile::signed_area(&loops[0]), 25.0 * std::f64::consts::PI, 1e-12));
    }

    #[test]
    fn circle_radius_at_0_9_and_1_1_of_the_limits() {
        // Smallest: MIN_FEATURE. Largest: MAX_SIZE / 2 = 500000 mm, a
        // diameter of exactly MAX_SIZE, the most a profile may span.
        let at = |r: f64| sketch_outline(&[], &[circle(0.0, 0.0, r)], &[]);
        let closed = |r: f64| matches!(at(r), Ok(SketchOutline::Closed(_)));
        assert!(closed(1.1 * MIN_FEATURE) && closed(MIN_FEATURE));
        assert!(closed(0.9 * MAX_SIZE / 2.0) && closed(MAX_SIZE / 2.0));
        for bad in [0.9 * MIN_FEATURE, 1.1 * MAX_SIZE / 2.0, 0.0, -5.0, f64::NAN, f64::INFINITY] {
            assert_eq!(invalid(at(bad)), format!("circle 1's radius must be between 0.001 and 500000 mm, got {bad}"));
        }
        // check_circles names which circle.
        assert!(invalid(check_circles(&[circle(0.0, 0.0, 1.0), circle(5.0, 0.0, 0.9 * MIN_FEATURE)])).starts_with("circle 2's radius"));
    }

    #[test]
    fn a_circle_must_fit_in_the_modelling_range_at_0_9_and_1_1() {
        // The circle reaches centre ± r along each axis. With its centre
        // MAX_COORD − 1.1·r from the origin it stops 0.1·r inside the range;
        // at MAX_COORD − 0.9·r it pokes 0.1·r out. Radii 0.5 and 2 (one
        // below 1, one above) so c·r or c / r in place of c ± r is caught.
        for r in [0.5, 2.0] {
            for (axis, sign) in [(DVec2::X, 1.0), (DVec2::X, -1.0), (DVec2::Y, 1.0), (DVec2::Y, -1.0)] {
                let at = |k: f64| check_circles(&[Circle { centre: axis * sign * (MAX_COORD - k * r), radius: r }]);
                assert!(at(1.1).is_ok() && at(1.0).is_ok(), "r {r}, {axis} × {sign}");
                assert_eq!(invalid(at(0.9)), "circle 1 reaches outside the modelling range", "r {r}, {axis} × {sign}");
            }
        }
        // A centre that isn't a number reaches nowhere in the range.
        for bad in [circle(f64::NAN, 0.0, 1.0), circle(0.0, f64::INFINITY, 1.0), circle(f64::NEG_INFINITY, 0.0, 1.0)] {
            assert_eq!(invalid(sketch_outline(&[], &[bad], &[])), "circle 1 reaches outside the modelling range");
        }
    }

    #[test]
    fn a_circle_with_anything_else_is_several_loops() {
        let square = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        // Two circles apart, or one inside the other (a washer, a region
        // at step 26): each circle is a loop.
        assert_eq!(open_with(&[], &[circle(0.0, 0.0, 1.0), circle(5.0, 0.0, 1.0)]), Open::SeveralLoops { loops: 2 });
        assert_eq!(open_with(&[], &[circle(0.0, 0.0, 5.0), circle(0.0, 0.0, 2.0)]), Open::SeveralLoops { loops: 2 });
        // A square and a circle (inside it or not): 1 + 1 loops; with a
        // second square, 3; with a second circle as well, 4.
        assert_eq!(open_with(&square, &[circle(5.0, 5.0, 2.0)]), Open::SeveralLoops { loops: 2 });
        assert_eq!(open_with(&square, &[circle(50.0, 5.0, 2.0)]), Open::SeveralLoops { loops: 2 });
        let mut two = square.clone();
        two.extend(ring(&[(20.0, 0.0), (30.0, 0.0), (30.0, 10.0)]));
        assert_eq!(open_with(&two, &[circle(5.0, 5.0, 2.0)]), Open::SeveralLoops { loops: 3 });
        assert_eq!(open_with(&two, &[circle(5.0, 5.0, 2.0), circle(50.0, 0.0, 1.0)]), Open::SeveralLoops { loops: 4 });
        // A loop of lines that would fail the profile rules is still
        // counted as one loop: the circle makes it several either way.
        let bow = ring(&[(0.0, 0.0), (10.0, 10.0), (10.0, 0.0), (0.0, 10.0)]);
        assert_eq!(open_with(&bow, &[circle(50.0, 0.0, 1.0)]), Open::SeveralLoops { loops: 2 });
        // The lines' own problems come first: a loose end or a branch is
        // what to fix, whatever circles there are.
        assert_eq!(open_with(&square[..3], &[circle(50.0, 0.0, 1.0)]), Open::LooseEnd { at: v(0.0, 0.0) });
        let mut eight = ring(&[(0.0, 0.0), (4.0, 1.0), (4.0, -1.0)]);
        eight.extend(ring(&[(0.0, 0.0), (-4.0, 1.0), (-4.0, -1.0)]));
        assert_eq!(open_with(&eight, &[circle(50.0, 0.0, 1.0)]), Open::Branch { at: v(0.0, 0.0), ends: 4 });
        // Without the circle the square closes, so the count is the circle's.
        assert!(matches!(sketch_outline(&square, &[], &[]).unwrap(), SketchOutline::Closed(_)));
    }

    #[test]
    fn at_most_max_profile_corners_lines_and_circles_together() {
        // 2000 in all is allowed, 2001 is not, however they are split.
        let lines = |n: usize| (0..n).map(|i| line((i as f64, 0.0), (i as f64, 1.0))).collect::<Vec<_>>();
        let circles = |n: usize| (0..n).map(|i| circle(i as f64 * 3.0, 10.0, 1.0)).collect::<Vec<_>>();
        assert!(sketch_outline(&lines(MAX_PROFILE_CORNERS - 2), &circles(2), &[]).is_ok());
        assert!(sketch_outline(&[], &circles(MAX_PROFILE_CORNERS), &[]).is_ok());
        let want = "a sketch has at most 2000 lines, arcs and circles, got 2001";
        assert_eq!(invalid(sketch_outline(&lines(MAX_PROFILE_CORNERS - 1), &circles(2), &[])), want);
        assert_eq!(invalid(sketch_outline(&[], &circles(MAX_PROFILE_CORNERS + 1), &[])), want);
    }

    #[test]
    fn bad_circles_are_errors_after_bad_lines() {
        let square = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        assert_eq!(invalid(sketch_outline(&square, &[circle(0.0, 0.0, 1.0), circle(0.0, 0.0, 0.0)], &[])), "circle 2's radius must be between 0.001 and 500000 mm, got 0");
        let mut bad = square.clone();
        bad[3].a.y = f64::NAN;
        assert_eq!(invalid(sketch_outline(&bad, &[circle(0.0, 0.0, 0.0)], &[])), "line 4 has an end outside the modelling range");
    }

    #[test]
    fn messages_in_plain_words() {
        assert_eq!(Open::Empty.to_string(), "the sketch has no lines, arcs or circles yet");
        assert_eq!(Open::LooseEnd { at: v(1.5, -2.0) }.to_string(), "the end at (1.5, -2) is not joined to another line or arc");
        assert_eq!(Open::SeveralLoops { loops: 2 }.to_string(), "the sketch makes 2 separate loops; for now a sketch makes one outline");
        assert_eq!(
            Open::NotAProfile { reason: "x".into() }.to_string(),
            "the curves close up but are not a valid outline: x"
        );
    }

    // ---- arcs (step 23a)

    fn arc(start: (f64, f64), end: (f64, f64), centre: (f64, f64)) -> Arc {
        Arc { start: v(start.0, start.1), end: v(end.0, end.1), centre: v(centre.0, centre.1) }
    }

    /// The corners and bulges of a closed outline that is a path.
    fn path(outline: SketchOutline) -> (Vec<DVec2>, Vec<f64>) {
        match outline {
            SketchOutline::Closed(Profile { outer: Boundary::Path { corners, bulges }, holes }) => {
                assert!(holes.is_empty());
                (corners, bulges)
            }
            other => panic!("expected a closed path, got {other:?}"),
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-14 * a.abs().max(1.0)
    }

    /// The area inside a closed outline, by the profile's own signed area.
    fn area(outline: SketchOutline) -> f64 {
        let SketchOutline::Closed(profile) = outline else { panic!("expected a closed outline, got {outline:?}") };
        crate::ops::profile::signed_area(&check_profile(&profile).unwrap()[0]).abs()
    }

    #[test]
    fn an_arcs_bulge_worked_by_hand() {
        // Quarter circle (1,0) → (0,1) round the origin: it turns 90°, so the
        // bulge is tan(90°/4) = tan 22.5° = √2 − 1. By the sagitta: chord √2,
        // midpoint (½, ½), the arc's middle (√½, √½), so s = 1 − √½ and
        // 2s / c = 2(1 − √½)/√2 = √2 − 1.
        assert!(close(arc((1.0, 0.0), (0.0, 1.0), (0.0, 0.0)).bulge(), 2f64.sqrt() - 1.0));
        // Half circle (5,0) → (−5,0): turns 180°, tan 45° = 1.
        assert!(close(arc((5.0, 0.0), (-5.0, 0.0), (0.0, 0.0)).bulge(), 1.0));
        // Three quarters (1,0) → (0,−1) counter-clockwise: 270°, tan 67.5° = √2 + 1.
        assert!(close(arc((1.0, 0.0), (0.0, -1.0), (0.0, 0.0)).bulge(), 2f64.sqrt() + 1.0));
        // (−4,0) → (4,0) round (0,3), radius 5 (a 3-4-5 triangle): counter-
        // clockwise from (−4,0) it passes below the centre, through (0,−2),
        // so its sagitta is 5 − 3 = 2 over a chord of 8: bulge 2·2/8 = ½.
        // By the angle: it turns 2·atan(4/3) = 106.26°, and tan 26.57° = ½.
        assert!(close(arc((-4.0, 0.0), (4.0, 0.0), (0.0, 3.0)).bulge(), 0.5));
        // The same ends round (0,−3): now the long way, through (0,−8), so
        // s = 3 + 5 = 8 and the bulge is 2·8/8 = 2; it turns 360° − 106.26°
        // = 253.74°, and tan 63.43° = 2.
        assert!(close(arc((-4.0, 0.0), (4.0, 0.0), (0.0, -3.0)).bulge(), 2.0));
        // The profile's arc for that bulge has the same centre and radius.
        let Some(Seg::Arc { center, radius, .. }) = Seg::from_bulge(v(-4.0, 0.0), v(4.0, 0.0), 2.0) else { panic!() };
        assert!(center.distance(v(0.0, -3.0)) <= 1e-14 && close(radius, 5.0));
    }

    #[test]
    fn a_pie_slice_closes_worked_by_hand() {
        // (0,0) → (10,0), a quarter arc round the origin to (0,10), then back
        // down to (0,0): corners in that order, bulges 0, √2 − 1, 0. Its area
        // is a quarter of π·10² = 25π.
        let lines = [line((0.0, 0.0), (10.0, 0.0)), line((0.0, 10.0), (0.0, 0.0))];
        let arcs = [arc((10.0, 0.0), (0.0, 10.0), (0.0, 0.0))];
        let (corners, bulges) = path(sketch_outline(&lines, &[], &arcs).unwrap());
        assert_eq!(corners, vec![v(0.0, 0.0), v(10.0, 0.0), v(0.0, 10.0)]);
        assert_eq!(bulges.len(), 3);
        assert!(bulges[0] == 0.0 && close(bulges[1], 2f64.sqrt() - 1.0) && bulges[2] == 0.0, "{bulges:?}");
        assert!(crate::tolerance::rel_eq(area(sketch_outline(&lines, &[], &arcs).unwrap()), 25.0 * std::f64::consts::PI, 1e-12));
    }

    #[test]
    fn an_arc_walked_backwards_turns_the_other_way() {
        // A half disc: (−5,0) → (5,0), then the half circle back over the
        // top. Walked from the line's start, the arc is entered at its own
        // start: bulge +1. Area ½π·5² = 12.5π.
        let half = [arc((5.0, 0.0), (-5.0, 0.0), (0.0, 0.0))];
        let (corners, bulges) = path(sketch_outline(&[line((-5.0, 0.0), (5.0, 0.0))], &[], &half).unwrap());
        assert_eq!((corners, bulges), (vec![v(-5.0, 0.0), v(5.0, 0.0)], vec![0.0, 1.0]));
        // The line drawn the other way: the walk goes (5,0) → (−5,0) and
        // enters the arc at its end, so it is walked clockwise: bulge −1.
        // The same half disc, so the same area. The line's 0 stays +0.
        let back = sketch_outline(&[line((5.0, 0.0), (-5.0, 0.0))], &[], &half).unwrap();
        let (corners, bulges) = path(back.clone());
        assert_eq!((corners, bulges.clone()), (vec![v(5.0, 0.0), v(-5.0, 0.0)], vec![0.0, -1.0]));
        assert_eq!(bulges[0].to_bits(), 0);
        assert!(crate::tolerance::rel_eq(area(back), 12.5 * std::f64::consts::PI, 1e-12));
        // Two half circles make a whole one: area 25π. With no lines, the
        // walk starts at arc 1.
        let both = [arc((5.0, 0.0), (-5.0, 0.0), (0.0, 0.0)), arc((-5.0, 0.0), (5.0, 0.0), (0.0, 0.0))];
        let (corners, bulges) = path(sketch_outline(&[], &[], &both).unwrap());
        assert_eq!((corners, bulges), (vec![v(5.0, 0.0), v(-5.0, 0.0)], vec![1.0, 1.0]));
        assert!(crate::tolerance::rel_eq(area(sketch_outline(&[], &[], &both).unwrap()), 25.0 * std::f64::consts::PI, 1e-12));
    }

    #[test]
    fn arc_ends_join_within_linear_at_0_9_and_1_1() {
        // The pie slice with its second line starting d above the arc's end.
        let at = |d: f64| {
            let lines = [line((0.0, 0.0), (10.0, 0.0)), line((0.0, 10.0 + d), (0.0, 0.0))];
            sketch_outline(&lines, &[], &[arc((10.0, 0.0), (0.0, 10.0), (0.0, 0.0))]).unwrap()
        };
        assert!(matches!(at(0.9 * LINEAR), SketchOutline::Closed(_)));
        // Ends numbered lines first: line 2's start (end 2) is the lowest loose one.
        assert_eq!(at(1.1 * LINEAR), SketchOutline::Open(Open::LooseEnd { at: v(0.0, 10.0 + 1.1 * LINEAR) }));
    }

    #[test]
    fn open_sketches_with_arcs_say_why() {
        // One arc: its start is loose.
        assert_eq!(open_with(&[], &[]), Open::Empty);
        let quarter = arc((10.0, 0.0), (0.0, 10.0), (0.0, 0.0));
        assert_eq!(sketch_outline(&[], &[], &[quarter]).unwrap(), SketchOutline::Open(Open::LooseEnd { at: v(10.0, 0.0) }));
        // Three arcs from (5,0): a branch of three ends.
        let three = [arc((5.0, 0.0), (-5.0, 0.0), (0.0, 0.0)), arc((-5.0, 0.0), (5.0, 0.0), (0.0, 0.0)), arc((5.0, 0.0), (9.0, 0.0), (7.0, 0.0))];
        assert_eq!(sketch_outline(&[], &[], &three).unwrap(), SketchOutline::Open(Open::Branch { at: v(5.0, 0.0), ends: 3 }));
        // A pie slice and a circle, or two separate half discs: two loops.
        let pie = [line((0.0, 0.0), (10.0, 0.0)), line((0.0, 10.0), (0.0, 0.0))];
        assert_eq!(sketch_outline(&pie, &[circle(50.0, 0.0, 1.0)], &[quarter]).unwrap(), SketchOutline::Open(Open::SeveralLoops { loops: 2 }));
        let discs = [line((-5.0, 0.0), (5.0, 0.0)), line((15.0, 0.0), (25.0, 0.0))];
        let tops = [arc((5.0, 0.0), (-5.0, 0.0), (0.0, 0.0)), arc((25.0, 0.0), (15.0, 0.0), (20.0, 0.0))];
        assert_eq!(sketch_outline(&discs, &[], &tops).unwrap(), SketchOutline::Open(Open::SeveralLoops { loops: 2 }));
        // The same half circle twice: the loop goes over and straight back
        // along itself, which the profile rules refuse.
        let twice = [arc((5.0, 0.0), (-5.0, 0.0), (0.0, 0.0)); 2];
        assert!(matches!(sketch_outline(&[], &[], &twice).unwrap(), SketchOutline::Open(Open::NotAProfile { .. })));
    }

    #[test]
    fn an_arcs_centre_is_midway_between_its_ends_within_linear_at_0_9_and_1_1() {
        // The centre moved k·LINEAR along the chord from where it belongs,
        // off the line midway between the ends: a quarter, a half and a
        // nearly whole arc (radius 10, ends 1 mm apart).
        let gap = (0.05f64).asin(); // half the angle 1 mm of chord takes at radius 10
        let shapes = [(v(5.0, 0.0), v(0.0, 5.0)), (v(5.0, 0.0), v(-5.0, 0.0)), (DVec2::from_angle(gap) * 10.0, DVec2::from_angle(-gap) * 10.0)];
        for (start, end) in shapes {
            let along = (end - start).normalize();
            let at = |k: f64| check_arcs(&[Arc { start, end, centre: along * k * LINEAR }]);
            assert!(at(0.9).is_ok() && at(-0.9).is_ok(), "{start} → {end}");
            for k in [1.1, -1.1] {
                let m = invalid(at(k));
                let off: f64 = m.strip_prefix("arc 1 has its centre ").and_then(|rest| rest.split(' ').next()).unwrap().parse().unwrap();
                assert!((off - 1.1 * LINEAR).abs() < 1e-15, "{m}");
                assert!(m.ends_with("mm off the line midway between its ends; it must be within 0.00001 mm of it, the same distance from both"), "{m}");
            }
        }
        // Why not compare the ends' distances from the centre instead: on
        // the nearly whole arc, 1.1 LINEAR off moves them apart by only
        // 2 × 1.1·LINEAR × (c/2)/r = 1.1e-6 mm, a tenth of LINEAR, though
        // the far side of the arc is 1.1 LINEAR off the circle.
        let (start, end) = shapes[2];
        let centre = (end - start).normalize() * 1.1 * LINEAR;
        assert!((start.distance(centre) - end.distance(centre)).abs() < 0.2 * LINEAR);
        // Far off: an end on another circle altogether.
        assert!(invalid(check_arcs(&[arc((5.0, 0.0), (0.0, 7.0), (0.0, 0.0))])).contains("mm off the line midway"));
    }

    #[test]
    fn arc_radius_at_0_9_and_1_1_of_the_limits() {
        // Half circles (so the ends are 2r apart, never too close) of radius
        // r round the origin: MIN_FEATURE to MAX_SIZE, the profile's rule.
        let at = |r: f64| check_arcs(&[arc((r, 0.0), (-r, 0.0), (0.0, 0.0))]);
        for good in [MIN_FEATURE, 1.1 * MIN_FEATURE, 0.9 * MAX_SIZE, MAX_SIZE] {
            assert!(at(good).is_ok(), "{good}");
        }
        for bad in [0.9 * MIN_FEATURE, 1.1 * MAX_SIZE] {
            assert_eq!(invalid(at(bad)), format!("arc 1 has radius {bad}; it must be between 0.001 and 1000000 mm"));
        }
        // A speck of an arc: radius 0.9 MIN_FEATURE, a quarter turn, ends
        // 1.27 MIN_FEATURE apart: refused for its radius.
        let r = 0.9 * MIN_FEATURE;
        assert!(invalid(check_arcs(&[arc((r, 0.0), (0.0, r), (0.0, 0.0))])).contains("has radius 0.0009"));
    }

    #[test]
    fn arc_ends_at_least_min_feature_apart_at_0_9_and_1_1() {
        // Radius 10, ends k·MIN_FEATURE apart either side of (10,0): either
        // nearly a whole circle (start just above the x axis, round the long
        // way to just below) or a tiny sliver of one (the other way).
        let r = 10.0;
        let half_angle = |k: f64| (k * MIN_FEATURE / (2.0 * r)).asin();
        let ends = |k: f64| (v(r * half_angle(k).cos(), r * half_angle(k).sin()), v(r * half_angle(k).cos(), -r * half_angle(k).sin()));
        for k in [0.9, 1.1] {
            let (above, below) = ends(k);
            let nearly_whole = check_arcs(&[Arc { start: above, end: below, centre: DVec2::ZERO }]);
            let sliver = check_arcs(&[Arc { start: below, end: above, centre: DVec2::ZERO }]);
            if k < 1.0 {
                for m in [invalid(nearly_whole), invalid(sliver)] {
                    assert!(m.starts_with("arc 1 has its ends 0.0009") && m.ends_with("mm apart; they must be at least 0.001 mm apart"), "{m}");
                }
            } else {
                assert!(nearly_whole.is_ok() && sliver.is_ok());
            }
        }
    }

    #[test]
    fn an_arc_must_stay_in_the_modelling_range_at_0_9_and_1_1() {
        // Half circles of radius r on a chord k·r below MAX_COORD: the upper
        // half reaches MAX_COORD + (1 − k)·r, so 0.1·r out at k = 0.9 and
        // 0.1·r in at 1.1; its ends and centre are inside either way, so it
        // is the arc's own extent that decides. The lower half of the same
        // circle stays inside: the arc counts, not its whole circle.
        for r in [0.5, 2.0] {
            let y = |k: f64| MAX_COORD - k * r;
            let upper = |k: f64| check_arcs(&[arc((r, y(k)), (-r, y(k)), (0.0, y(k)))]);
            let lower = |k: f64| check_arcs(&[arc((-r, y(k)), (r, y(k)), (0.0, y(k)))]);
            assert!(upper(1.1).is_ok() && lower(0.9).is_ok(), "r {r}");
            assert_eq!(invalid(upper(0.9)), "arc 1 reaches outside the modelling range", "r {r}");
            // The same sideways: a right half reaching past x = MAX_COORD.
            let right = |k: f64| check_arcs(&[arc((MAX_COORD - k * r, -r), (MAX_COORD - k * r, r), (MAX_COORD - k * r, 0.0))]);
            assert!(right(1.1).is_ok(), "r {r}");
            assert_eq!(invalid(right(0.9)), "arc 1 reaches outside the modelling range", "r {r}");
        }
        // A point that isn't a number, or is past MAX_COORD, names the arc.
        let good = arc((1.0, 0.0), (0.0, 1.0), (0.0, 0.0));
        for bad in [arc((f64::NAN, 0.0), (0.0, 1.0), (0.0, 0.0)), arc((1.0, 0.0), (0.0, f64::INFINITY), (0.0, 0.0)), arc((1.0, 0.0), (0.0, 1.0), (1.1 * MAX_COORD, 0.0))] {
            assert_eq!(invalid(check_arcs(&[good, bad])), "arc 2 has a point outside the modelling range");
        }
        // Bad arcs are errors from sketch_outline too, after bad circles.
        assert_eq!(invalid(sketch_outline(&[], &[circle(0.0, 0.0, 0.0)], &[arc((f64::NAN, 0.0), (0.0, 1.0), (0.0, 0.0))])), "circle 1's radius must be between 0.001 and 500000 mm, got 0");
        assert_eq!(invalid(sketch_outline(&[], &[], &[good, arc((f64::NAN, 0.0), (0.0, 1.0), (0.0, 0.0))])), "arc 2 has a point outside the modelling range");
    }

    #[test]
    fn at_most_max_profile_corners_counting_arcs() {
        let arcs = |n: usize| (0..n).map(|i| arc((i as f64 * 3.0 + 1.0, 0.0), (i as f64 * 3.0 - 1.0, 0.0), (i as f64 * 3.0, 0.0))).collect::<Vec<_>>();
        let lines = |n: usize| (0..n).map(|i| line((i as f64, 10.0), (i as f64, 11.0))).collect::<Vec<_>>();
        assert!(sketch_outline(&lines(MAX_PROFILE_CORNERS - 2), &[], &arcs(2)).is_ok());
        assert_eq!(invalid(sketch_outline(&lines(MAX_PROFILE_CORNERS - 1), &[], &arcs(2))), "a sketch has at most 2000 lines, arcs and circles, got 2001");
        assert_eq!(invalid(sketch_outline(&[], &[circle(0.0, 50.0, 1.0)], &arcs(MAX_PROFILE_CORNERS))), "a sketch has at most 2000 lines, arcs and circles, got 2001");
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 2000,
            failure_persistence: Some(Box::new(proptest::test_runner::FileFailurePersistence::Direct("tests/regressions/sketch-arcs.txt"))),
            ..ProptestConfig::default()
        })]

        /// Against a simple model of an arc: a chord and how far the arc on
        /// it turns, φ. Its ends a and b sit at angles θ and θ + φ on a
        /// circle of radius r (placed with cos and sin, so rounded), and the
        /// model puts its centre on the line midway between those ends, r
        /// cos(φ/2) to the left of a → b (to the right past a half turn,
        /// where the cosine is negative), and its middle on the same line,
        /// the sagitta 2r·sin²(φ/4) = r(1 − cos(φ/2)) to the right of the
        /// chord's midpoint. The profile's arc for the bulge `Arc::bulge`
        /// gives must turn counter-clockwise and pass through that middle
        /// within rounding of the sizes involved. Two arcs on one chord are
        /// furthest apart at their middles, so this bounds how far the whole
        /// arc is off. Its radius and centre are not compared: for a shallow
        /// arc they hang on the sagitta's last digits (found while writing
        /// this: a 2.3° arc of radius 1 came back with radius 1 − 2e-13, its
        /// middle within 1e-16), and the extrude builds its circle from them
        /// and the ends together, so only the curve itself has to agree.
        /// Sweeps run from a millionth of a turn to a millionth short of a
        /// whole one, radii over MIN_FEATURE to MAX_SIZE, centres anywhere a
        /// kilometre round.
        #[test]
        fn an_arcs_bulge_matches_a_model_of_it(
            cx in -1e6..1e6f64, cy in -1e6..1e6f64,
            log_r in -2.99..5.99f64,
            theta in 0.0..std::f64::consts::TAU,
            turn in 1e-6..(1.0 - 1e-6),
        ) {
            let (c, r): (DVec2, f64) = (v(cx, cy), 10f64.powf(log_r));
            let phi: f64 = turn * std::f64::consts::TAU;
            let (start, end) = (c + DVec2::from_angle(theta) * r, c + DVec2::from_angle(theta + phi) * r);
            let chord = end - start;
            prop_assume!(chord.length() >= MIN_FEATURE);
            let (mid, left) = ((start + end) / 2.0, DVec2::new(-chord.y, chord.x) / chord.length());
            let a = Arc { start, end, centre: mid + left * (r * (phi / 2.0).cos()) };
            let model_middle = mid - left * (2.0 * r * (phi / 4.0).sin().powi(2));
            prop_assert!(check_arcs(&[a]).is_ok(), "{a:?}: {:?}", check_arcs(&[a]));
            let Some(Seg::Arc { center, radius, sweep, .. }) = Seg::from_bulge(a.start, a.end, a.bulge()) else {
                return Err(TestCaseError::fail(format!("no arc for {a:?}")));
            };
            let slack = crate::tolerance::rounding_slack(c.abs().max_element() + r);
            prop_assert!(sweep > 0.0, "{a:?} turns {sweep}");
            let middle = center + DVec2::from_angle((a.start - center).to_angle() + sweep / 2.0) * radius;
            prop_assert!(middle.distance(model_middle) <= slack, "{a:?}: middle {middle} vs {model_middle}");
        }
    }
}
