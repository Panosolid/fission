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
//! - `sketch_outline`: the one closed outline the lines make, or why they
//!   make none. Two line ends are joined when they are within LINEAR of
//!   each other (a corner); every corner must join exactly two ends. The
//!   loop is walked from line 0 in its own direction, each line entered at
//!   the end that meets the previous one, and each corner is the end of the
//!   line being entered, so the result is the same however the lines are
//!   ordered after line 0, and a line drawn backwards is simply walked the
//!   other way. The loop then goes through the profile rules
//!   (`ops::profile::check_profile`: no crossings, touching or slivers),
//!   so a closed sketch is exactly a profile the extrude accepts. Several
//!   separate loops, and loops inside loops, wait for profile detection
//!   (step 26); until then they are reported, not guessed at.
//!
//! Cost: joining ends sorts them by x and compares each with the ends
//! less than LINEAR further along, so it is O(n log n) for spread-out
//! lines and O(n²) at worst (every end within LINEAR in x), with n capped
//! at MAX_PROFILE_CORNERS, the same bound as the profile check.
use crate::ops::profile::{check_profile, Profile};
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

/// Why a sketch's lines make no outline yet. None of these is an error: a
/// sketch is open while it is being drawn.
#[derive(Clone, Debug, PartialEq)]
pub enum Open {
    /// No lines yet.
    Empty,
    /// A line end joined to no other.
    LooseEnd { at: DVec2 },
    /// More than two line ends meet at one corner.
    Branch { at: DVec2, ends: usize },
    /// Every corner joins two ends, but the lines make several loops.
    SeveralLoops { loops: usize },
    /// One loop, but not a valid profile (it crosses or touches itself, a
    /// sliver, a line doubling back…): the profile check's reason.
    NotAProfile { reason: String },
}

impl fmt::Display for Open {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Open::Empty => write!(f, "the sketch has no lines yet"),
            Open::LooseEnd { at } => write!(f, "the line end at ({}, {}) is not joined to another line", at.x, at.y),
            Open::Branch { at, ends } => {
                write!(f, "{ends} line ends meet at ({}, {}); every corner of an outline joins exactly two", at.x, at.y)
            }
            Open::SeveralLoops { loops } => {
                write!(f, "the lines make {loops} separate loops; for now a sketch makes one outline")
            }
            Open::NotAProfile { reason } => write!(f, "the lines close up but are not a valid outline: {reason}"),
        }
    }
}

/// What a sketch's lines make.
#[derive(Clone, Debug, PartialEq)]
pub enum SketchOutline {
    /// One closed loop that passes the profile rules: ready to extrude.
    Closed(Profile),
    Open(Open),
}

/// The one closed outline `lines` make, or why they make none (see the
/// module comment). Lines that break `check_lines` are an error.
pub fn sketch_outline(lines: &[Line]) -> Result<SketchOutline, KernelError> {
    check_lines(lines)?;
    if lines.is_empty() {
        return Ok(SketchOutline::Open(Open::Empty));
    }
    let partner = match join_ends(lines) {
        Ok(p) => p,
        Err(open) => return Ok(SketchOutline::Open(open)),
    };
    // Walk from line 0's start; `end` is 0 for a line's `a`, 1 for its `b`.
    let mut corners = Vec::with_capacity(lines.len());
    let mut seen = vec![false; lines.len()];
    let (mut line, mut entered) = (0, 0);
    while !seen[line] {
        seen[line] = true;
        corners.push(end_point(lines, 2 * line + entered));
        let leaving = 2 * line + 1 - entered;
        let next = partner[leaving];
        (line, entered) = (next / 2, next % 2);
    }
    let unseen = seen.iter().filter(|s| !**s).count();
    if unseen > 0 {
        return Ok(SketchOutline::Open(Open::SeveralLoops { loops: 1 + count_loops(lines, &partner, seen) }));
    }
    let profile = Profile::polygon(corners, vec![]);
    match check_profile(&profile) {
        Ok(_) => Ok(SketchOutline::Closed(profile)),
        Err(KernelError::InvalidInput(reason)) => Ok(SketchOutline::Open(Open::NotAProfile { reason })),
        Err(e) => Err(e),
    }
}

/// End `e` of the lines: line e / 2, its `a` when e is even, else its `b`.
fn end_point(lines: &[Line], e: usize) -> DVec2 {
    let line = lines[e / 2];
    if e.is_multiple_of(2) { line.a } else { line.b }
}

/// For every end, the one other end it joins. Ends within LINEAR form a
/// corner; a corner of one end is loose, of three or more a branch. The
/// problem reported is the one at the lowest-numbered end, so the answer
/// doesn't depend on how the sort breaks ties.
fn join_ends(lines: &[Line]) -> Result<Vec<usize>, Open> {
    let count = 2 * lines.len();
    let mut order: Vec<usize> = (0..count).collect();
    order.sort_by(|&i, &j| end_point(lines, i).x.total_cmp(&end_point(lines, j).x));
    let mut near: Vec<Vec<usize>> = vec![vec![]; count];
    for (k, &i) in order.iter().enumerate() {
        let p = end_point(lines, i);
        for &j in &order[k + 1..] {
            let q = end_point(lines, j);
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
        let at = end_point(lines, e);
        match others.len() {
            0 => return Err(Open::LooseEnd { at }),
            1 => {}
            n => return Err(Open::Branch { at, ends: n + 1 }),
        }
    }
    Ok(near.iter().map(|others| others[0]).collect())
}

/// How many loops the lines not yet `seen` make (every end has a partner).
fn count_loops(lines: &[Line], partner: &[usize], mut seen: Vec<bool>) -> usize {
    let mut loops = 0;
    for start in 0..lines.len() {
        if seen[start] {
            continue;
        }
        loops += 1;
        let (mut line, mut entered) = (start, 0);
        while !seen[line] {
            seen[line] = true;
            let next = partner[2 * line + 1 - entered];
            (line, entered) = (next / 2, next % 2);
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
        match sketch_outline(lines).unwrap() {
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
        assert!(invalid(sketch_outline(&many(MAX_PROFILE_CORNERS + 1))).contains("at most"));
    }

    // ---- sketch_outline

    #[test]
    fn a_square_drawn_in_order_closes_worked_by_hand() {
        // 10 × 10 square drawn (0,0) → (10,0) → (10,10) → (0,10) → back:
        // four corners, walked from line 1's start, so the corners are the
        // points in the order drawn. Its area by the shoelace formula is
        // ½|Σ x_i y_{i+1} − x_{i+1} y_i| = ½(0 + 100 + 100 + 0) = 100.
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let got = corners(sketch_outline(&ring(&pts)).unwrap());
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
        assert_eq!(corners(sketch_outline(&lines).unwrap()), vec![v(0.0, 0.0), v(4.0, 0.0), v(0.0, 3.0)]);
        // Line 1 itself reversed walks the loop the other way round.
        let lines = [line((4.0, 0.0), (0.0, 0.0)), line((0.0, 3.0), (0.0, 0.0)), line((0.0, 3.0), (4.0, 0.0))];
        assert_eq!(corners(sketch_outline(&lines).unwrap()), vec![v(4.0, 0.0), v(0.0, 0.0), v(0.0, 3.0)]);
    }

    #[test]
    fn ends_join_within_linear_at_0_9_and_1_1() {
        // A triangle whose last line stops short of the start by d.
        let tri = |d: f64| vec![line((0.0, 0.0), (4.0, 0.0)), line((4.0, 0.0), (0.0, 3.0)), line((0.0, 3.0), (d, 0.0))];
        // 0.9 LINEAR: the ends join, and the corner is line 1's start.
        assert_eq!(corners(sketch_outline(&tri(0.9 * LINEAR)).unwrap())[0], v(0.0, 0.0));
        // 1.1 LINEAR: a gap; the lowest-numbered loose end is line 1's start.
        assert_eq!(open(&tri(1.1 * LINEAR)), Open::LooseEnd { at: v(0.0, 0.0) });
        // The same along y, so the distance (not just x) decides.
        let tri_y = |d: f64| vec![line((0.0, 0.0), (4.0, 0.0)), line((4.0, 0.0), (0.0, 3.0)), line((0.0, 3.0), (0.0, d))];
        assert!(matches!(sketch_outline(&tri_y(0.9 * LINEAR)).unwrap(), SketchOutline::Closed(_)));
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
        assert!(matches!(sketch_outline(&tri(LINEAR)).unwrap(), SketchOutline::Closed(_)));
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
        assert_eq!(Open::Branch { at: v(0.0, 0.0), ends: 4 }.to_string(), "4 line ends meet at (0, 0); every corner of an outline joins exactly two");
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
        assert!(matches!(sketch_outline(&thin).unwrap(), SketchOutline::Closed(_)));
    }

    #[test]
    fn bad_lines_are_errors_not_open_sketches() {
        let mut lines = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]);
        lines[1].b.x = f64::NAN;
        assert_eq!(invalid(sketch_outline(&lines)), "line 2 has an end outside the modelling range");
    }

    #[test]
    fn messages_in_plain_words() {
        assert_eq!(Open::Empty.to_string(), "the sketch has no lines yet");
        assert_eq!(Open::LooseEnd { at: v(1.5, -2.0) }.to_string(), "the line end at (1.5, -2) is not joined to another line");
        assert_eq!(Open::SeveralLoops { loops: 2 }.to_string(), "the lines make 2 separate loops; for now a sketch makes one outline");
        assert_eq!(
            Open::NotAProfile { reason: "x".into() }.to_string(),
            "the lines close up but are not a valid outline: x"
        );
    }
}
