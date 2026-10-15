//! Extrusion of a planar polygon profile with holes.
//!
//! The profile lies in the XY plane and is swept along +Z from z = 0 to
//! z = distance. Each profile edge becomes a planar side face, so a profile
//! with n corners in total and h holes gives a solid of genus h with
//! V = 2n, E = 3n, F = n + 2 and R = 2h (one inner loop per hole on each
//! cap): V − E + F − R = 2 − 2h = 2(1 − h).

use super::{check_length, finish, transform::check_in_model_space, KernelError};
use crate::geom::{unit, Surface};
use crate::tolerance::{side, segments_touch, MAX_COORD, MAX_PROFILE_CORNERS, MAX_SIZE, MIN_FEATURE};
use crate::topology::{Body, Coedge, Loop, Shell};
use glam::{DVec2, DVec3};

/// A closed polygon outline and the holes in it. Corners are listed once
/// each (the last joins back to the first), in either direction.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub outer: Vec<DVec2>,
    pub holes: Vec<Vec<DVec2>>,
}

/// Extrudes `profile` along +Z by `distance`.
pub fn extrude(profile: &Profile, distance: f64) -> Result<Body, KernelError> {
    check_length("extrude distance", distance)?;
    let loops = check_profile(profile)?;

    let mut b = Body::default();
    let top = DVec3::new(0.0, 0.0, distance);
    let cap = |origin, normal| Surface::Plane { origin, normal, x_dir: DVec3::X };
    // Outer loop counter-clockwise seen from +Z, holes clockwise: the solid
    // is on the left of every loop seen from above, and on the right of
    // every edge's direction of travel is outside.
    let mut bottom_loops = vec![];
    let mut top_loops = vec![];
    let mut side_faces = vec![];
    for corners in &loops {
        let n = corners.len();
        let lo: Vec<usize> = corners.iter().map(|p| b.add_vertex(p.extend(0.0))).collect();
        let hi: Vec<usize> = corners.iter().map(|p| b.add_vertex(p.extend(distance))).collect();
        let bottom: Vec<usize> = (0..n).map(|i| b.add_line(lo[i], lo[(i + 1) % n])).collect();
        let upper: Vec<usize> = (0..n).map(|i| b.add_line(hi[i], hi[(i + 1) % n])).collect();
        let up: Vec<usize> = (0..n).map(|i| b.add_line(lo[i], hi[i])).collect();
        let fwd = |edge| Coedge { edge, reversed: false };
        let rev = |edge| Coedge { edge, reversed: true };
        // Seen from below the loop's direction flips, so the bottom cap
        // runs it backwards; the top cap runs it as given.
        bottom_loops.push(Loop { coedges: (0..n).rev().map(|i| rev(bottom[i])).collect() });
        top_loops.push(Loop { coedges: upper.iter().map(|&e| fwd(e)).collect() });
        for i in 0..n {
            let j = (i + 1) % n;
            let along = (corners[j] - corners[i]).extend(0.0);
            // Right of the direction of travel: (dy, −dx, 0).
            let outward = unit(DVec3::new(along.y, -along.x, 0.0)).expect("edges are at least MIN_FEATURE long");
            let x_dir = unit(along).expect("edges are at least MIN_FEATURE long");
            // lo_i → lo_j → hi_j → hi_i: counter-clockwise seen from outside.
            let coedges = vec![fwd(bottom[i]), fwd(up[j]), rev(upper[i]), rev(up[i])];
            side_faces.push((Surface::Plane { origin: b.vertices[lo[i]].point, normal: outward, x_dir }, coedges));
        }
    }
    let mut faces = vec![b.add_face(cap(DVec3::ZERO, DVec3::NEG_Z), true, bottom_loops)];
    faces.push(b.add_face(cap(top, DVec3::Z), true, top_loops));
    for (surface, coedges) in side_faces {
        faces.push(b.add_face(surface, true, vec![Loop { coedges }]));
    }
    b.shells.push(Shell { faces });
    check_in_model_space(&b)?;
    finish(b)
}

/// Checks a profile and returns its loops oriented for `extrude`: the outer
/// one counter-clockwise, holes clockwise (seen from +Z).
///
/// Rules, every one a clean `InvalidInput` when broken:
/// - each loop has at least 3 corners, all finite and within MAX_COORD;
///   the profile spans at most MAX_SIZE; at most MAX_PROFILE_CORNERS in all;
/// - no two segments that don't share a corner touch or cross (exact
///   orientation tests), across all loops;
/// - every corner is at least MIN_FEATURE from every segment it isn't an end
///   of. With the line above this makes every edge, wall and gap at least
///   MIN_FEATURE: no zero-length edges, spikes, backtracks or slivers;
/// - every hole is inside the outer loop and outside every other hole.
pub(crate) fn check_profile(profile: &Profile) -> Result<Vec<Vec<DVec2>>, KernelError> {
    let bad = |m: String| Err(KernelError::InvalidInput(m));
    let all: Vec<&Vec<DVec2>> = std::iter::once(&profile.outer).chain(&profile.holes).collect();
    let total: usize = all.iter().map(|l| l.len()).sum();
    if total > MAX_PROFILE_CORNERS {
        return bad(format!("profile has {total} corners; the limit is {MAX_PROFILE_CORNERS}"));
    }
    for (k, l) in all.iter().enumerate() {
        if l.len() < 3 {
            return bad(format!("profile loop {k} has {} corners; at least 3 are needed", l.len()));
        }
        if let Some(p) = l.iter().find(|p| !p.is_finite() || p.abs().max_element() > MAX_COORD) {
            return bad(format!("profile corner {p} is not finite or is beyond {MAX_COORD:e} mm"));
        }
    }
    let (lo, hi) = profile.outer.iter().fold((DVec2::INFINITY, DVec2::NEG_INFINITY), |(lo, hi), &p| (lo.min(p), hi.max(p)));
    if (hi - lo).max_element() > MAX_SIZE {
        return bad(format!("profile spans {:e} mm; the limit is {MAX_SIZE:e} mm", (hi - lo).max_element()));
    }

    // Every segment as (loop, index): corners i and i+1 of that loop.
    let segs: Vec<(usize, usize)> = all.iter().enumerate().flat_map(|(k, l)| (0..l.len()).map(move |i| (k, i))).collect();
    let ends = |(k, i): (usize, usize)| (all[k][i], all[k][(i + 1) % all[k].len()]);
    let shares_corner = |(k, i): (usize, usize), (m, j): (usize, usize)| {
        let n = all[k].len();
        k == m && (i == j || (i + 1) % n == j || (j + 1) % n == i)
    };
    for (s, &a) in segs.iter().enumerate() {
        for &c in &segs[s + 1..] {
            if !shares_corner(a, c) && segments_touch(ends(a), ends(c)) {
                return bad(format!("profile edges {a:?} and {c:?} (loop, index) touch or cross"));
            }
        }
    }
    for (k, l) in all.iter().enumerate() {
        for (i, &p) in l.iter().enumerate() {
            for &s in &segs {
                let n = all[s.0].len();
                if s.0 == k && (s.1 == i || (s.1 + 1) % n == i) {
                    continue;
                }
                let (a, b) = ends(s);
                let d = point_segment_distance(p, a, b);
                if d < MIN_FEATURE {
                    return bad(format!(
                        "profile corner {p} is {d:e} mm from edge {s:?}; features must be at least {MIN_FEATURE} mm"
                    ));
                }
            }
        }
    }
    // No crossings, so each hole is wholly inside or wholly outside any
    // other loop: testing one corner decides it.
    for (h, hole) in profile.holes.iter().enumerate() {
        if !inside(hole[0], &profile.outer) {
            return bad(format!("profile hole {h} is not inside the outer loop"));
        }
        if let Some(o) = profile.holes.iter().enumerate().position(|(g, other)| g != h && inside(hole[0], other)) {
            return bad(format!("profile hole {h} is inside hole {o}; islands need a separate extrude"));
        }
    }
    let oriented = |l: &Vec<DVec2>, ccw: bool| {
        let mut l = l.clone();
        if counter_clockwise(&l) != ccw {
            l.reverse();
        }
        l
    };
    Ok(std::iter::once(oriented(&profile.outer, true)).chain(profile.holes.iter().map(|h| oriented(h, false))).collect())
}

fn point_segment_distance(p: DVec2, a: DVec2, b: DVec2) -> f64 {
    let ab = b - a;
    let t = ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0);
    (p - (a + ab * t)).length()
}

/// Whether `p` is inside the simple polygon `l` (crossing number, with the
/// crossing side decided exactly). `p` must not be on the boundary, which
/// the profile checks guarantee.
fn inside(p: DVec2, l: &[DVec2]) -> bool {
    let mut odd = false;
    for i in 0..l.len() {
        let (a, b) = (l[i], l[(i + 1) % l.len()]);
        // Half-open in y, so a ray through a corner counts once.
        if (a.y > p.y) != (b.y > p.y) {
            let upward = b.y > a.y;
            // Crossing is right of p when p is left of the upward edge.
            if (side(a, b, p) > 0) == upward {
                odd = !odd;
            }
        }
    }
    odd
}

/// Orientation of a simple polygon, exactly: at the lowest (then leftmost)
/// corner the polygon is convex, so the turn there has the polygon's sign.
fn counter_clockwise(l: &[DVec2]) -> bool {
    let n = l.len();
    let i = (0..n).min_by(|&i, &j| l[i].y.total_cmp(&l[j].y).then(l[i].x.total_cmp(&l[j].x))).expect("at least 3 corners");
    side(l[(i + n - 1) % n], l[i], l[(i + 1) % n]) > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{eq, rel_eq, FP_REL};

    fn v(p: &[(f64, f64)]) -> Vec<DVec2> {
        p.iter().map(|&(x, y)| DVec2::new(x, y)).collect()
    }

    fn square(x0: f64, y0: f64, s: f64) -> Vec<DVec2> {
        v(&[(x0, y0), (x0 + s, y0), (x0 + s, y0 + s), (x0, y0 + s)])
    }

    #[test]
    fn square_with_square_hole_by_hand() {
        // 10×10 outer, 4×4 hole at (3,3), extruded 5.
        // Volume (100 − 16)·5 = 420.
        // Area: two caps 2·84 = 168, outer sides 40·5 = 200, hole sides
        // 16·5 = 80: 448.
        // Topology: 8 corners → V = 16, E = 24, F = 2 + 8 = 10, R = 2
        // (the hole on each cap): 16 − 24 + 10 − 2 = 0 = 2(1 − 1), genus 1.
        let p = Profile { outer: square(0.0, 0.0, 10.0), holes: vec![square(3.0, 3.0, 4.0)] };
        let b = extrude(&p, 5.0).unwrap();
        assert_eq!((b.vertices.len(), b.edges.len(), b.faces.len()), (16, 24, 10));
        assert_eq!(b.counts(&b.shells[0]).genus(), Some(1));
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert!(eq(m.signed_volume(), 420.0), "{}", m.signed_volume());
        assert!(eq(m.area(), 448.0), "{}", m.area());
    }

    #[test]
    fn either_winding_gives_the_same_solid() {
        // Same L-shape listed clockwise and counter-clockwise, hole too.
        // L: 6×2 bar plus 2×4 leg = 12 + 8 = 20 area, extruded 3 → 60.
        let l = v(&[(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (2.0, 2.0), (2.0, 6.0), (0.0, 6.0)]);
        let mut back = l.clone();
        back.reverse();
        for outer in [l, back] {
            let m = tessellate(&extrude(&Profile { outer, holes: vec![] }, 3.0).unwrap(), &TessOptions::DISPLAY).unwrap();
            assert!(eq(m.signed_volume(), 60.0), "{}", m.signed_volume());
        }
    }

    #[test]
    fn bad_profiles_are_clean_errors() {
        let ok_outer = square(0.0, 0.0, 10.0);
        let cases: Vec<(&str, Profile)> = vec![
            ("two corners", Profile { outer: v(&[(0.0, 0.0), (1.0, 0.0)]), holes: vec![] }),
            ("bow tie", Profile { outer: v(&[(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.0, 1.0)]), holes: vec![] }),
            ("repeated corner", Profile { outer: v(&[(0.0, 0.0), (1.0, 0.0), (1.0, 0.0), (0.0, 1.0)]), holes: vec![] }),
            ("backtrack", Profile { outer: v(&[(0.0, 0.0), (2.0, 0.0), (1.0, 0.0), (1.0, 1.0)]), holes: vec![] }),
            ("NaN", Profile { outer: v(&[(0.0, 0.0), (f64::NAN, 0.0), (0.0, 1.0)]), holes: vec![] }),
            ("too far", Profile { outer: square(MAX_COORD, 0.0, 1.0), holes: vec![] }),
            ("too big", Profile { outer: square(0.0, 0.0, MAX_SIZE * 1.1), holes: vec![] }),
            ("hole outside", Profile { outer: ok_outer.clone(), holes: vec![square(20.0, 0.0, 1.0)] }),
            ("hole crossing", Profile { outer: ok_outer.clone(), holes: vec![square(9.0, 4.0, 2.0)] }),
            ("hole touching", Profile { outer: ok_outer.clone(), holes: vec![square(0.0, 4.0, 2.0)] }),
            ("nested holes", Profile { outer: ok_outer.clone(), holes: vec![square(1.0, 1.0, 8.0), square(3.0, 3.0, 2.0)] }),
            ("overlapping holes", Profile { outer: ok_outer.clone(), holes: vec![square(1.0, 1.0, 3.0), square(2.0, 2.0, 3.0)] }),
        ];
        for (name, p) in cases {
            assert!(matches!(extrude(&p, 1.0), Err(KernelError::InvalidInput(_))), "{name} was accepted");
        }
        assert!(matches!(extrude(&Profile { outer: ok_outer, holes: vec![] }, 0.0), Err(KernelError::InvalidInput(_))));
        let many = (0..=MAX_PROFILE_CORNERS).map(|k| DVec2::from_angle(k as f64 * 1e-3)).collect();
        assert!(matches!(extrude(&Profile { outer: many, holes: vec![] }, 1.0), Err(KernelError::InvalidInput(_))));
    }

    #[test]
    fn wall_thickness_boundary() {
        // Hole whose left side is k·MIN_FEATURE from the outer's left side:
        // a wall that thin. 1.1× is a legal feature, 0.9× is not.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let gap = k * MIN_FEATURE;
            let p = Profile { outer: square(0.0, 0.0, 1.0), holes: vec![square(gap, 0.25, 0.5)] };
            assert_eq!(extrude(&p, 1.0).is_ok(), legal, "wall {k}×MIN_FEATURE");
        }
    }

    #[test]
    fn edge_length_boundary() {
        // A triangle with one edge k·MIN_FEATURE long; its third corner is
        // far from that edge, so only the edge length is near the limit.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let e = k * MIN_FEATURE;
            let p = Profile { outer: v(&[(0.0, 0.0), (e, 0.0), (0.0, 1.0)]), holes: vec![] };
            assert_eq!(extrude(&p, 1.0).is_ok(), legal, "edge {k}×MIN_FEATURE");
        }
    }

    #[test]
    fn exact_predicates_by_hand() {
        // Segments (0,0)–(2,0) and (1,0)–(1,1): the second starts on the
        // first, so they touch. (3,0)–(4,0) is collinear but past the end.
        let s = |a: (f64, f64), b: (f64, f64)| (DVec2::new(a.0, a.1), DVec2::new(b.0, b.1));
        assert!(segments_touch(s((0.0, 0.0), (2.0, 0.0)), s((1.0, 0.0), (1.0, 1.0))));
        assert!(!segments_touch(s((0.0, 0.0), (2.0, 0.0)), s((3.0, 0.0), (4.0, 0.0))));
        // Point (1,1) to segment (0,0)–(2,0): foot at (1,0), distance 1.
        // Point (3,4) to the same segment: nearest is the end (2,0), √(1+16).
        assert!(eq(point_segment_distance(DVec2::new(1.0, 1.0), DVec2::ZERO, DVec2::new(2.0, 0.0)), 1.0));
        assert!(eq(point_segment_distance(DVec2::new(3.0, 4.0), DVec2::ZERO, DVec2::new(2.0, 0.0)), 17f64.sqrt()));
        // (1,1) is inside the 2×2 square from the origin; (3,1) is not; the
        // square as listed by `square` runs counter-clockwise.
        let sq = square(0.0, 0.0, 2.0);
        assert!(inside(DVec2::new(1.0, 1.0), &sq) && !inside(DVec2::new(3.0, 1.0), &sq));
        assert!(counter_clockwise(&sq));
    }

    #[test]
    fn far_from_the_origin_keeps_its_volume() {
        // Triangle (0,0),(3,0),(0,4) has area 6; extruded 2 → 12, measured
        // relative to the body's own centre even 50 km out.
        let o = DVec2::new(5e7, -5e7);
        let outer = v(&[(0.0, 0.0), (3.0, 0.0), (0.0, 4.0)]).into_iter().map(|p| p + o).collect();
        let m = tessellate(&extrude(&Profile { outer, holes: vec![] }, 2.0).unwrap(), &TessOptions::DISPLAY).unwrap();
        assert!(rel_eq(m.signed_volume(), 12.0, FP_REL), "{}", m.signed_volume());
    }
}
