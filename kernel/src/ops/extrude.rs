//! Extrusion of a planar profile (straight and arc pieces, or circles,
//! with holes) along +Z, from z = 0 to z = distance.
//!
//! Each piece between two corners becomes a side face: planar for a line,
//! part of a cylinder for an arc. A circle loop has no corners: one closed
//! edge on each cap and a cylindrical side face with two loops. Per path
//! loop of n corners: 2n vertices, 3n edges, n side faces; per circle loop:
//! 2 vertices, 2 edges, 1 side face with 2 loops (R + 1). Both add 0 to
//! V − E + F − R, so with the 2 caps and their h inner loops the solid has
//! V − E + F − R = 2 − 2h = 2(1 − h): genus h.

use super::profile::{check_profile, Seg};
pub use super::profile::{Boundary, Profile};
use super::{check_length, finish, transform::check_in_model_space, KernelError};
use crate::geom::{unit, Curve, Surface};
use crate::topology::{Body, Coedge, Loop, Shell};
use glam::{DVec2, DVec3};
use std::f64::consts::TAU;

/// Extrudes `profile` along +Z by `distance`.
pub fn extrude(profile: &Profile, distance: f64) -> Result<Body, KernelError> {
    check_length("extrude distance", distance)?;
    let loops = check_profile(profile)?;

    let mut b = Body::default();
    let top = DVec3::new(0.0, 0.0, distance);
    let cap = |origin, normal| Surface::Plane { origin, normal, x_dir: DVec3::X };
    let fwd = |edge| Coedge { edge, reversed: false };
    let rev = |edge| Coedge { edge, reversed: true };
    // Outer loop counter-clockwise seen from +Z, holes clockwise: the solid
    // is on the left of every piece seen from above, outside on its right.
    let mut bottom_loops = vec![];
    let mut top_loops = vec![];
    let mut side_faces: Vec<(Surface, bool, Vec<Loop>)> = vec![];
    for segs in &loops {
        if let [Seg::Circle { center, radius, ccw }] = segs.as_slice() {
            // Edges run the way the loop does: about +Z when counter-clockwise.
            let axis = if *ccw { DVec3::Z } else { DVec3::NEG_Z };
            let c0 = center.extend(0.0);
            let lo = b.add_vertex(c0 + DVec3::X * *radius);
            let hi = b.add_vertex(c0 + top + DVec3::X * *radius);
            let ring = |c: DVec3| Curve::Circle { center: c, axis, x_dir: DVec3::X, radius: *radius };
            let bottom = b.add_edge(ring(c0), lo, lo, 0.0, TAU);
            let upper = b.add_edge(ring(c0 + top), hi, hi, 0.0, TAU);
            bottom_loops.push(Loop { coedges: vec![rev(bottom)] });
            top_loops.push(Loop { coedges: vec![fwd(upper)] });
            // Outward is away from the axis for the outer loop, towards it
            // for a hole. As for the cylinder primitive: the bottom circle
            // forwards, the top one backwards.
            let wall = Surface::Cylinder { origin: c0, axis: DVec3::Z, x_dir: DVec3::X, radius: *radius };
            side_faces.push((wall, *ccw, vec![Loop { coedges: vec![fwd(bottom)] }, Loop { coedges: vec![rev(upper)] }]));
            continue;
        }
        let corners: Vec<DVec2> = segs.iter().map(|s| s.ends()[0]).collect();
        let n = corners.len();
        let lo: Vec<usize> = corners.iter().map(|p| b.add_vertex(p.extend(0.0))).collect();
        let hi: Vec<usize> = corners.iter().map(|p| b.add_vertex(p.extend(distance))).collect();
        // The piece's curve at height z: a line, or an arc about +Z when it
        // turns counter-clockwise (−Z when clockwise), so its parameter
        // always runs from the piece's start to its end.
        let add_piece = |b: &mut Body, s: &Seg, z: f64, v0: usize, v1: usize| match *s {
            Seg::Arc { a, center, radius, sweep, .. } => {
                let axis = if sweep > 0.0 { DVec3::Z } else { DVec3::NEG_Z };
                let x_dir = unit((a - center).extend(0.0)).expect("arc radius is at least MIN_FEATURE");
                b.add_edge(Curve::Circle { center: center.extend(z), axis, x_dir, radius }, v0, v1, 0.0, sweep.abs())
            }
            _ => b.add_line(v0, v1),
        };
        let bottom: Vec<usize> = (0..n).map(|i| add_piece(&mut b, &segs[i], 0.0, lo[i], lo[(i + 1) % n])).collect();
        let upper: Vec<usize> = (0..n).map(|i| add_piece(&mut b, &segs[i], distance, hi[i], hi[(i + 1) % n])).collect();
        let up: Vec<usize> = (0..n).map(|i| b.add_line(lo[i], hi[i])).collect();
        // Seen from below the loop's direction flips, so the bottom cap
        // runs it backwards; the top cap runs it as given.
        bottom_loops.push(Loop { coedges: (0..n).rev().map(|i| rev(bottom[i])).collect() });
        top_loops.push(Loop { coedges: upper.iter().map(|&e| fwd(e)).collect() });
        for i in 0..n {
            let j = (i + 1) % n;
            // lo_i → lo_j → hi_j → hi_i: counter-clockwise seen from outside.
            let coedges = vec![fwd(bottom[i]), fwd(up[j]), rev(upper[i]), rev(up[i])];
            let (surface, sense) = match segs[i] {
                Seg::Arc { a, center, radius, sweep, .. } => {
                    // Counter-clockwise about its centre, the solid is on the
                    // centre's side, so outward is away from the axis.
                    let x_dir = unit((a - center).extend(0.0)).expect("arc radius is at least MIN_FEATURE");
                    (Surface::Cylinder { origin: center.extend(0.0), axis: DVec3::Z, x_dir, radius }, sweep > 0.0)
                }
                _ => {
                    let along = (corners[j] - corners[i]).extend(0.0);
                    // Right of the direction of travel: (dy, −dx, 0).
                    let outward = unit(DVec3::new(along.y, -along.x, 0.0)).expect("pieces are at least MIN_FEATURE long");
                    let x_dir = unit(along).expect("pieces are at least MIN_FEATURE long");
                    (Surface::Plane { origin: b.vertices[lo[i]].point, normal: outward, x_dir }, true)
                }
            };
            side_faces.push((surface, sense, vec![Loop { coedges }]));
        }
    }
    let mut faces = vec![b.add_face(cap(DVec3::ZERO, DVec3::NEG_Z), true, bottom_loops)];
    faces.push(b.add_face(cap(top, DVec3::Z), true, top_loops));
    for (surface, sense, face_loops) in side_faces {
        faces.push(b.add_face(surface, sense, face_loops));
    }
    b.shells.push(Shell { faces });
    check_in_model_space(&b)?;
    finish(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tessellate::{tessellate, TessOptions};
    use crate::tolerance::{eq, rel_eq, FP_REL, MAX_COORD, MAX_PROFILE_CORNERS, MAX_SIZE, MIN_FEATURE};
    use std::f64::consts::PI;

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
        let p = Profile::polygon(square(0.0, 0.0, 10.0), vec![square(3.0, 3.0, 4.0)]);
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
            let m = tessellate(&extrude(&Profile::polygon(outer, vec![]), 3.0).unwrap(), &TessOptions::DISPLAY).unwrap();
            assert!(eq(m.signed_volume(), 60.0), "{}", m.signed_volume());
        }
    }

    #[test]
    fn bad_profiles_are_clean_errors() {
        let ok_outer = square(0.0, 0.0, 10.0);
        let cases: Vec<(&str, Profile)> = vec![
            ("two corners", Profile::polygon(v(&[(0.0, 0.0), (1.0, 0.0)]), vec![])),
            ("bow tie", Profile::polygon(v(&[(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.0, 1.0)]), vec![])),
            ("repeated corner", Profile::polygon(v(&[(0.0, 0.0), (1.0, 0.0), (1.0, 0.0), (0.0, 1.0)]), vec![])),
            ("backtrack", Profile::polygon(v(&[(0.0, 0.0), (2.0, 0.0), (1.0, 0.0), (1.0, 1.0)]), vec![])),
            ("NaN", Profile::polygon(v(&[(0.0, 0.0), (f64::NAN, 0.0), (0.0, 1.0)]), vec![])),
            ("too far", Profile::polygon(square(MAX_COORD, 0.0, 1.0), vec![])),
            ("too big", Profile::polygon(square(0.0, 0.0, MAX_SIZE * 1.1), vec![])),
            ("hole outside", Profile::polygon(ok_outer.clone(), vec![square(20.0, 0.0, 1.0)])),
            ("hole crossing", Profile::polygon(ok_outer.clone(), vec![square(9.0, 4.0, 2.0)])),
            ("hole touching", Profile::polygon(ok_outer.clone(), vec![square(0.0, 4.0, 2.0)])),
            ("nested holes", Profile::polygon(ok_outer.clone(), vec![square(1.0, 1.0, 8.0), square(3.0, 3.0, 2.0)])),
            ("overlapping holes", Profile::polygon(ok_outer.clone(), vec![square(1.0, 1.0, 3.0), square(2.0, 2.0, 3.0)])),
        ];
        for (name, p) in cases {
            assert!(matches!(extrude(&p, 1.0), Err(KernelError::InvalidInput(_))), "{name} was accepted");
        }
        assert!(matches!(extrude(&Profile::polygon(ok_outer, vec![]), 0.0), Err(KernelError::InvalidInput(_))));
        let many = (0..=MAX_PROFILE_CORNERS).map(|k| DVec2::from_angle(k as f64 * 1e-3)).collect();
        assert!(matches!(extrude(&Profile::polygon(many, vec![]), 1.0), Err(KernelError::InvalidInput(_))));
    }

    #[test]
    fn wall_thickness_boundary() {
        // Hole whose left side is k·MIN_FEATURE from the outer's left side:
        // a wall that thin. 1.1× is a legal feature, 0.9× is not.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let gap = k * MIN_FEATURE;
            let p = Profile::polygon(square(0.0, 0.0, 1.0), vec![square(gap, 0.25, 0.5)]);
            assert_eq!(extrude(&p, 1.0).is_ok(), legal, "wall {k}×MIN_FEATURE");
        }
    }

    #[test]
    fn edge_length_boundary() {
        // A triangle with one edge k·MIN_FEATURE long; its third corner is
        // far from that edge, so only the edge length is near the limit.
        for (k, legal) in [(1.1, true), (0.9, false)] {
            let e = k * MIN_FEATURE;
            let p = Profile::polygon(v(&[(0.0, 0.0), (e, 0.0), (0.0, 1.0)]), vec![]);
            assert_eq!(extrude(&p, 1.0).is_ok(), legal, "edge {k}×MIN_FEATURE");
        }
    }

    fn path(corners: &[(f64, f64)], bulges: &[f64]) -> Boundary {
        Boundary::Path { corners: v(corners), bulges: bulges.to_vec() }
    }

    fn circle(x: f64, y: f64, radius: f64) -> Boundary {
        Boundary::Circle { center: DVec2::new(x, y), radius }
    }

    /// Chords the display mesh puts on an arc of radius r turning φ, from
    /// the tessellation rule: each chord turns at most min(0.2 rad, the
    /// angle whose chord sags 0.01: 2·acos(1 − 0.01/r)).
    fn chords(r: f64, phi: f64) -> f64 {
        (phi.abs() / (0.2f64).min(2.0 * (1.0 - 0.01 / r).acos())).ceil()
    }

    #[test]
    fn circle_profile_is_a_cylinder() {
        // r = 2: 2·acos(1 − 0.005) ≈ 0.20008 > 0.2, so chords turn 0.2 and
        // the circle gets ceil(2π/0.2) = 32 of them. The mesh is a prism on
        // the inscribed 32-gon: V = (32/2)·r²·sin(2π/32)·h. One vertex and
        // one closed edge per cap circle, 3 faces: V 2, E 2, F 3, genus 0.
        let b = extrude(&Profile { outer: circle(0.0, 0.0, 2.0), holes: vec![] }, 3.0).unwrap();
        assert_eq!((b.vertices.len(), b.edges.len(), b.faces.len()), (2, 2, 3));
        assert_eq!(b.counts(&b.shells[0]).genus(), Some(0));
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(chords(2.0, TAU), 32.0);
        let v = 16.0 * 4.0 * (TAU / 32.0).sin() * 3.0;
        assert!(rel_eq(m.signed_volume(), v, FP_REL), "{} vs {v}", m.signed_volume());
        // The same solid as the cylinder primitive.
        let c = tessellate(&crate::ops::primitives::make_cylinder(2.0, 3.0).unwrap(), &TessOptions::DISPLAY).unwrap();
        assert!(rel_eq(m.signed_volume(), c.signed_volume(), FP_REL));
    }

    #[test]
    fn plate_with_a_round_hole_by_hand() {
        // 10×10 square with a round hole r = 2 at its centre, extruded 5.
        // The hole is the inscribed 32-gon (see above) of area
        // 16·4·sin(π/16) and perimeter 32·2·2·sin(π/32).
        // V = (100 − hole)·5; S = 2(100 − hole) + 40·5 + perimeter·5.
        // Topology: square 8 V, 12 E, 4 sides; circle 2 V, 2 E, 1 side;
        // 2 caps: V 10, E 14, F 7. R = 1 per cap + 1 for the bore's second
        // loop = 3: 10 − 14 + 7 − 3 = 0 = 2(1 − 1), genus 1.
        let p = Profile { outer: Boundary::polygon(square(0.0, 0.0, 10.0)), holes: vec![circle(5.0, 5.0, 2.0)] };
        let b = extrude(&p, 5.0).unwrap();
        assert_eq!((b.vertices.len(), b.edges.len(), b.faces.len()), (10, 14, 7));
        assert_eq!(b.counts(&b.shells[0]).genus(), Some(1));
        // The bore faces its axis.
        let bore = b.faces.iter().find(|f| matches!(f.surface, Surface::Cylinder { .. })).unwrap();
        assert!(!bore.sense);
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        let (hole, rim) = (16.0 * 4.0 * (PI / 16.0).sin(), 32.0 * 4.0 * (PI / 32.0).sin());
        assert!(rel_eq(m.signed_volume(), (100.0 - hole) * 5.0, FP_REL), "{}", m.signed_volume());
        assert!(rel_eq(m.area(), 2.0 * (100.0 - hole) + 200.0 + rim * 5.0, FP_REL), "{}", m.area());
    }

    #[test]
    fn stadium_by_hand() {
        // 10 long, 4 wide with half-circle ends (bulge 1), extruded 2.
        // Each end: r = 2 turning π, ceil(π/0.2) = 16 chords; the 16-chord
        // half polygon has area (16/2)·r²·sin(π/16). Exact area would be
        // 40 + π·4; the mesh's is 40 + 2·8·4·sin(π/16).
        // 4 corners: V 8, E 12, F 4 sides (2 flat, 2 round) + 2 caps.
        let p = Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)], &[0.0, 1.0, 0.0, 1.0]), holes: vec![] };
        let b = extrude(&p, 2.0).unwrap();
        assert_eq!((b.vertices.len(), b.edges.len(), b.faces.len()), (8, 12, 6));
        let round: Vec<_> = b.faces.iter().filter(|f| matches!(f.surface, Surface::Cylinder { .. })).collect();
        assert!(round.len() == 2 && round.iter().all(|f| f.sense), "both ends bulge outwards");
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(chords(2.0, PI), 16.0);
        let area = 40.0 + 2.0 * 8.0 * 4.0 * (PI / 16.0).sin();
        assert!(rel_eq(m.signed_volume(), area * 2.0, FP_REL), "{}", m.signed_volume());
        // Bounds are exact: the round ends reach x = −2 and 12.
        let (lo, hi) = b.bounds();
        assert!(eq(lo.x, -2.0) && eq(hi.x, 12.0) && eq(lo.y, 0.0) && eq(hi.y, 4.0) && eq(hi.z, 2.0), "{lo} {hi}");
    }

    #[test]
    fn concave_arc_by_hand() {
        // 10×10 square whose top edge, run (10,10)→(0,10), bows down into
        // it with bulge −0.4: sagitta (c/2)·0.4 = 2, sweep φ = −4·atan 0.4,
        // r = 10(1 + 0.16)/1.6 = 7.25, centre (5, 15.25). The circular
        // segment between chord and arc has area (r²/2)(|φ| − sin|φ|); its
        // n-chord polygon (n from the chord rule) has (r²/2)(n·sin(|φ|/n) −
        // sin|φ|), so the mesh's profile area is 100 minus that.
        let p = Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)], &[0.0, 0.0, -0.4, 0.0]), holes: vec![] };
        let b = extrude(&p, 3.0).unwrap();
        let wall = b.faces.iter().find(|f| matches!(f.surface, Surface::Cylinder { .. })).unwrap();
        assert!(!wall.sense, "a concave wall faces its axis");
        let (r, phi) = (7.25, 4.0 * 0.4f64.atan());
        let n = chords(r, phi);
        let cut = r * r / 2.0 * (n * (phi / n).sin() - phi.sin());
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert!(rel_eq(m.signed_volume(), (100.0 - cut) * 3.0, FP_REL), "{}", m.signed_volume());
        // Exact area 100 − (r²/2)(φ − sin φ) ≈ 86.37: the mesh is within the
        // sag of the arc (≤ 0.01 over its length r·φ ≈ 11).
        let exact = 100.0 - r * r / 2.0 * (phi - phi.sin());
        assert!((m.signed_volume() / 3.0 - exact).abs() <= 0.01 * r * phi);
    }

    #[test]
    fn curved_profiles_validate() {
        // Every curved case from the profile tests that is accepted must
        // make a valid body (`finish` validates; this would panic if not).
        let cases = [
            Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[0.0, 1.0]), holes: vec![] },
            Profile { outer: path(&[(-1.0, 0.0), (1.0, 0.0)], &[0.5, 0.5]), holes: vec![] },
            Profile { outer: path(&[(0.0, 0.0), (2.0, 0.0)], &[1.0, 1.0]), holes: vec![] },
            Profile { outer: circle(0.0, 0.0, 10.0), holes: vec![circle(3.0, 0.0, 1.0), circle(-3.0, 0.0, 1.0)] },
            Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (1.0, 0.5)], &[0.0, 1.0, 0.0]), holes: vec![] },
            Profile { outer: Boundary::polygon(square(-5.0, -5.0, 10.0)), holes: vec![path(&[(-1.0, 0.0), (1.0, 0.0)], &[1.0, 1.0])] },
        ];
        for (k, p) in cases.iter().enumerate() {
            let b = extrude(p, 1.0).unwrap_or_else(|e| panic!("case {k}: {e:?}"));
            let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
            assert_eq!(m.check_closed(), Ok(()), "case {k}");
            assert!(m.signed_volume() > 0.0, "case {k}");
        }
    }

    #[test]
    fn far_from_the_origin_keeps_its_volume() {
        // Triangle (0,0),(3,0),(0,4) has area 6; extruded 2 → 12, measured
        // relative to the body's own centre even 50 km out.
        let o = DVec2::new(5e7, -5e7);
        let outer = v(&[(0.0, 0.0), (3.0, 0.0), (0.0, 4.0)]).into_iter().map(|p| p + o).collect();
        let m = tessellate(&extrude(&Profile::polygon(outer, vec![]), 2.0).unwrap(), &TessOptions::DISPLAY).unwrap();
        assert!(rel_eq(m.signed_volume(), 12.0, FP_REL), "{}", m.signed_volume());
    }
}
