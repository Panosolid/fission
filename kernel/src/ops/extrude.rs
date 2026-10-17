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
//!
//! Mutation testing (`cargo mutants -f src/ops/extrude.rs`) leaves these
//! survivors, all equivalent (no input can tell them apart): `sweep > 0.0`
//! vs `>= 0.0` for an arc's curve axis and its wall's sense (an arc's sweep
//! is never 0: a zero bulge is a line).

use super::profile::{check_profile, Seg};
pub use super::profile::{Boundary, Profile};
use super::{check_length, finish, transform::check_in_model_space, KernelError, Meshed};
use crate::geom::{unit, Curve, Surface};
use crate::topology::{Body, Coedge, Loop, Shell};
use glam::{DVec2, DVec3};
use std::f64::consts::TAU;

/// Extrudes `profile` along +Z by `distance`.
pub fn extrude(profile: &Profile, distance: f64) -> Result<Body, KernelError> {
    extrude_meshed(profile, distance).map(|(body, _)| body)
}

/// `extrude`, also handing back the body's display mesh (`ops::finish`).
pub fn extrude_meshed(profile: &Profile, distance: f64) -> Result<Meshed, KernelError> {
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
    use crate::tolerance::{eq, points_eq, rel_eq, FP_REL, LINEAR, MAX_COORD, MAX_PROFILE_CORNERS, MAX_SIZE, MIN_FEATURE};
    use std::f64::consts::{PI, TAU};

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
    fn near_cusp_corners_keep_the_loop_the_right_way_round() {
        // Issue #75 (random testing, seed 127170467329874). Corners (0,0),
        // (0,2), (1,2), (1,0); bulges −1, 0, −1, 1.1e6. Pieces: a clockwise
        // half circle about (0,1) out to (−1,1), the top line, a clockwise
        // half circle about (1,1) out to (2,1), then from (1,0) back to
        // (0,0) the long way round a circle of r = c(1 + β²)/(4β) =
        // (1 + 1.21e12)/4.4e6 = 275000.0000002 mm about (0.5, 275000),
        // counter-clockwise through σ = 4·atan(1.1e6) = 2π − 3.64e-6.
        // So the loop is a 550 m disc running counter-clockwise with a
        // notch of 2 + π mm² (a 1 × 2 rectangle and two half discs of r = 1)
        // cut into its bottom. At (0,0) the big arc arrives heading
        // (1, −1.8e-6) and the half circle leaves heading (−1, 0): a turn
        // 1.8e-6 rad short of a reversal, clockwise. The two pieces cross
        // again about 2·1.8e-6/(1 − 1/r) = 3.6 nm from the corner, inside
        // LINEAR, so they count as meeting there; that tiny twist is all
        // the local turn sees, and reading the loop's direction from it
        // built the solid inside out.
        // Area = r²(σ − sin σ)/2 − (2 + π), the big arc's segment minus the
        // notch; volume = area · 0.5.
        let corners = v(&[(0.0, 0.0), (0.0, 2.0), (1.0, 2.0), (1.0, 0.0)]);
        let bulges = vec![-1.0, 0.0, -1.0, 1.1e6];
        let beta: f64 = 1.1e6;
        let r = (1.0 + beta * beta) / (4.0 * beta);
        let sigma = 4.0 * beta.atan();
        let area = r * r * (sigma - sigma.sin()) / 2.0 - (2.0 + PI);
        let mut back_corners = corners.clone();
        back_corners.reverse();
        // Run backwards, piece i (from corner i to i + 1 of the reversed
        // list) is forward piece n − 2 − i (mod n) run back: its bulge negated.
        let back_bulges = vec![1.0, 0.0, 1.0, -1.1e6];
        for (c, bl) in [(corners, bulges), (back_corners, back_bulges)] {
            let p = Profile { outer: Boundary::Path { corners: c, bulges: bl }, holes: vec![] };
            let b = extrude(&p, 0.5).unwrap();
            let m = crate::mass::mass_properties(&b);
            assert!(rel_eq(m.volume, area * 0.5, FP_REL), "{} vs {}", m.volume, area * 0.5);
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
    fn a_profile_may_not_reach_out_of_model_space() {
        // A circle of r = 5 centred at x = c reaches x = c + 5. Its centre
        // can be inside ±MAX_COORD while the curve itself pokes out, so the
        // profile check bounds every piece: c + 5 = MAX_COORD − 0.9 × LINEAR
        // is accepted, MAX_COORD + 1.1 × LINEAR refused for that reason.
        let disc = |c: f64| Profile { outer: Boundary::Circle { center: DVec2::new(c, 0.0), radius: 5.0 }, holes: vec![] };
        assert!(extrude(&disc(MAX_COORD - 5.0 - 0.9 * crate::tolerance::LINEAR), 1.0).is_ok());
        match extrude(&disc(MAX_COORD - 5.0 + 1.1 * crate::tolerance::LINEAR), 1.0) {
            Err(KernelError::InvalidInput(m)) => assert!(m.contains("reaches beyond"), "{m}"),
            other => panic!("expected the model-space refusal, got {other:?}"),
        }
    }

    #[test]
    fn an_arc_too_close_to_the_edge_of_model_space_is_refused() {
        // A "D": from A = (x0, y0) counter-clockwise round an arc of bulge
        // β, through its rightmost point, to B = (x0, y1), and the chord
        // back. That point sticks out from the chord by the sagitta
        // (c/2)·β, c = y1 − y0 (from the module notes: r − (c/2)·cot(sweep/2)
        // with r = c(1 + β²)/(4β) and cot(sweep/2) = (1 − β²)/(2β) gives
        // (c/2)(1 + β² − 1 + β²)/(2β)). In exact arithmetic on these doubles
        // that is x0 + (c/2)·β = MAX_COORD + 6.7e-9 (Python, fractions):
        // past model space, so the extrude must be refused. The profile's
        // own bound for that point, centre + r, rounds to MAX_COORD exactly
        // and passes; the body's, centre + r·hypot(x_dir.x, y_dir.x) with
        // the hypot 1 + 2.2e-16, rounds up a step, and the model-space
        // check refuses it. (Found by search: about 1 in 1e4 such arcs
        // falls between the two.)
        let (x0, y0, y1, beta) = (99827566.98656493, -403403.89577761077, 404141.02118983393, 0.4270549162332822);
        let d = Profile { outer: path(&[(x0, y0), (x0, y1)], &[beta, 0.0]), holes: vec![] };
        match extrude(&d, 1.0) {
            Err(KernelError::InvalidInput(m)) => assert!(m.contains("reach"), "{m}"),
            other => panic!("expected the model-space refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_two_corner_loop_with_a_flat_under_linear_is_refused_not_built() {
        // Regression (white-box hunt): a "D" whose flat is 5 nm long, half
        // LINEAR: the long way round a circle of radius 1 from (0, 0) to
        // (5e-6, 0) (bulge β with 1 = c(1 + β²)/(4β), the larger root), then
        // straight back. It passed the profile check and the extrude built
        // a body with 5 nm edges, which `checked` rejected with a panic.
        let c: f64 = 5e-6;
        let k = 4.0 / c;
        let beta = (k + (k * k - 4.0).sqrt()) / 2.0;
        let d = Profile { outer: path(&[(0.0, 0.0), (c, 0.0)], &[-beta, 0.0]), holes: vec![] };
        match extrude(&d, 1.0) {
            Err(KernelError::InvalidInput(m)) => assert!(m.contains("two corners"), "{m}"),
            other => panic!("expected the profile check's refusal, got {other:?}"),
        }
    }

    #[test]
    fn an_arc_walls_seam_is_its_first_upright_edge() {
        // A cylinder's u runs from x_dir. Each arc's wall takes x_dir from
        // the arc's centre to its first corner, so u = 0 is at that corner
        // and the face is u ∈ [0, |sweep|] counter-clockwise, or [2π −
        // |sweep|, 2π] clockwise (its axis is +Z either way): the seam is
        // the wall's own first upright edge, never inside the face.
        // Stadium (see stadium_by_hand): the right end runs (10, 0) → (10,
        // 4) counter-clockwise about (10, 2), r = 2, turning π: u = 0 at
        // (10, 0), u = π/2 at its rightmost point (12, 2), u = π at (10, 4).
        let stadium = Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (0.0, 4.0)], &[0.0, 1.0, 0.0, 1.0]), holes: vec![] };
        let b = extrude(&stadium, 2.0).unwrap();
        let right = b.faces.iter().find(|f| matches!(f.surface, Surface::Cylinder { origin, .. } if origin.x > 5.0)).unwrap();
        assert!(points_eq(right.surface.eval(DVec2::ZERO), DVec3::new(10.0, 0.0, 0.0)));
        assert!(points_eq(right.surface.eval(DVec2::new(PI / 2.0, 1.0)), DVec3::new(12.0, 2.0, 1.0)));
        assert!(points_eq(right.surface.eval(DVec2::new(PI, 2.0)), DVec3::new(10.0, 4.0, 2.0)));
        // The bowed square of concave_arc_by_hand: its top runs (10, 10) →
        // (0, 10) clockwise about (5, 15.25), r = 7.25, turning φ = 4·atan
        // 0.4. u = 0 at (10, 10), and (0, 10) is at u = 2π − φ.
        let bowed = Profile { outer: path(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)], &[0.0, 0.0, -0.4, 0.0]), holes: vec![] };
        let b = extrude(&bowed, 3.0).unwrap();
        let wall = b.faces.iter().find(|f| matches!(f.surface, Surface::Cylinder { .. })).unwrap();
        assert!(points_eq(wall.surface.eval(DVec2::ZERO), DVec3::new(10.0, 10.0, 0.0)));
        let phi = 4.0 * 0.4f64.atan();
        let uv = wall.surface.project(DVec3::new(0.0, 10.0, 0.0));
        assert!(eq(uv.x, TAU - phi) && eq(uv.y, 0.0), "{uv}");
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

    /// Chords on each arc edge of `b` (both caps' copies), from the display mesh.
    fn arc_chords(b: &Body, m: &crate::mesh::Mesh) -> Vec<usize> {
        let arcs = b.edges.iter().enumerate().filter(|(_, e)| matches!(e.curve, Curve::Circle { .. }));
        arcs.map(|(i, _)| m.edge_polylines[i].len() - 1).collect()
    }

    #[test]
    fn a_corner_under_a_shallow_arc_keeps_the_cap_right_side_out() {
        // Regression (crash hunt fuzzing): before the fix the cap meshed
        // inside out and `finish` panicked ("mesh has N open or flipped
        // edges"). Arc from A (743.75, 0) to B (0, 0) with bulge 0.0009
        // turns θ = 4·atan(0.0009) ≈ 0.0036 rad on a radius of
        // 743.75 / (2 sin(θ/2)) ≈ 206.6 km, so it gets one chord (each may
        // turn up to 2π/256 ≈ 0.0245 rad there). Turning counter-clockwise
        // while heading −x it bows to +y, by the sagitta s = (L/2)·bulge =
        // 371.875 · 0.0009 = 0.3346875. Corner C (275, 1e-5) is 1e-5 above
        // the chord y = 0 but 0.3347 − 96.875²/(2r) ≈ 0.312 below the arc,
        // so the one-chord loop A, B, C runs clockwise. One split puts M,
        // the arc's middle (371.875, s), into the loop; chord B–M is at
        // y = s·275/371.875 ≈ 0.2475 over C, so C is outside both halves'
        // slivers and nothing more splits: 2 chords. The meshed cap is
        // triangle A M B less triangle A B C: ½·743.75·(s − 1e-5).
        let p = Profile { outer: path(&[(743.75, 0.0), (0.0, 0.0), (275.0, 1e-5)], &[0.0009, 0.0, 0.0]), holes: vec![] };
        let b = extrude(&p, 10.0).unwrap();
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        assert_eq!(arc_chords(&b, &m), vec![2, 2]);
        let s = 371.875 * 0.0009;
        let v = 0.5 * 743.75 * (s - 1e-5) * 10.0;
        // The middle point is on the arc to rounding, far inside LINEAR.
        assert!((m.signed_volume() - v).abs() <= 0.5 * 743.75 * LINEAR * 10.0, "{} vs {v}", m.signed_volume());
    }

    #[test]
    fn three_shallow_arcs_round_a_thin_wedge_mesh_closed() {
        // Regression, the crash hunt's second case: three arcs of huge
        // radius, each meshed as one chord at first, with the corner
        // (441.875, 48.125) between the third chord and its arc. The mesh
        // drops at most each arc's whole sliver, about (2/3)·chord·sagitta
        // (sagitta = half chord × |bulge|), so it lies within that of the
        // exact volume.
        let corners = [(441.875, -0.4375), (441.875, 48.125), (441.8827, 441.882)];
        let bulges = [0.0009, -0.0001, 0.0009];
        let d = 0.063126;
        let b = extrude(&Profile { outer: path(&corners, &bulges), holes: vec![] }, d).unwrap();
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        let slivers: f64 = (0..3)
            .map(|i| {
                let l = v(&[corners[i]])[0].distance(v(&[corners[(i + 1) % 3]])[0]);
                2.0 / 3.0 * l * (0.5 * l * bulges[i].abs()) * d
            })
            .sum();
        let exact = crate::mass::mass_properties(&b).volume;
        assert!(m.signed_volume() > 0.0 && (m.signed_volume() - exact).abs() <= slivers, "{} vs {exact} ± {slivers}", m.signed_volume());
    }

    #[test]
    fn a_sketch_outline_with_a_corner_under_its_arc_meshes_closed() {
        // Regression, the crash hunt's third case, the outline a sketch gave
        // (`sketch_outline`): the third corner is (−624.1, 1e-297), which
        // the cap's uv snaps to y = 0, and the two arcs after it (both of
        // radius c(1 + β²)/(4β) ≈ 78.75 m, turning 0.0056 and 0.0135 rad,
        // under the 0.0245 rad step) start with one chord each. Bound as in the
        // test above: within each arc's whole sliver of the exact volume.
        let corners = [(-625.0, -624.0), (-624.0, -61.5), (-624.1, 1e-297), (-623.0, 437.5)];
        let bulges = [0.0, 0.0, 0.001388890599666272, 0.003369808984516978];
        let b = extrude(&Profile { outer: path(&corners, &bulges), holes: vec![] }, 1.0).unwrap();
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        let slivers: f64 = (0..4)
            .map(|i| {
                let l = v(&[corners[i]])[0].distance(v(&[corners[(i + 1) % 4]])[0]);
                2.0 / 3.0 * l * (0.5 * l * bulges[i].abs())
            })
            .sum();
        let exact = crate::mass::mass_properties(&b).volume;
        assert!(m.signed_volume() > 0.0 && (m.signed_volume() - exact).abs() <= slivers, "{} vs {exact} ± {slivers}", m.signed_volume());
    }

    #[test]
    fn a_hole_in_the_sliver_under_a_shallow_arc_is_meshed_as_a_hole() {
        // The 743.75 × 10 plate whose top, A (743.75, 0) to B (0, 0), is the
        // arc of the test above (sagitta s = 0.3346875 at x = 371.875), with
        // a triangular hole (360, 0.3), (380, 0.3), (371.875, 0.32) wholly
        // between the arc's first chord (y = 0) and the arc (0.0147 below
        // its top): with one chord the hole sits outside the meshed outline.
        // One split puts M (371.875, s) in; the halves pass over the hole
        // (B–M is at y = s·360/371.875 ≈ 0.324 over (360, 0.3), and both
        // meet at M, 0.0147 over the apex), so 2 chords. Meshed area: the
        // rectangle, triangle A M B, less the hole: 7437.5 + ½·743.75·s −
        // ½·20·0.02.
        let hole = Boundary::polygon(v(&[(360.0, 0.3), (380.0, 0.3), (371.875, 0.32)]));
        let outer = path(&[(743.75, 0.0), (0.0, 0.0), (0.0, -10.0), (743.75, -10.0)], &[0.0009, 0.0, 0.0, 0.0]);
        let b = extrude(&Profile { outer, holes: vec![hole] }, 2.0).unwrap();
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        assert_eq!(arc_chords(&b, &m), vec![2, 2]);
        let s = 371.875 * 0.0009;
        let v = (7437.5 + 0.5 * 743.75 * s - 0.2) * 2.0;
        assert!((m.signed_volume() - v).abs() <= 0.5 * 743.75 * LINEAR * 2.0, "{} vs {v}", m.signed_volume());
    }

    #[test]
    fn a_chord_passing_through_another_arcs_sliver_is_split() {
        // The plate [0, 743.75] × [−50, 0] whose top, A (743.75, 0) to B
        // (0, 0), bows down by s₁ = 371.875·0.0009 (bulge −0.0009: heading
        // −x it turns clockwise), over a hole [10, 733.75] × [−20, −0.3]
        // whose top bows down by s₂ = 0.08 (bulge −0.08/361.875, radius
        // 361.875²/(2·0.08) ≈ 818 m, inside the 1 km limit). Both arcs start
        // with one chord. The hole's chord y = −0.3 crosses the outer
        // arc, which is below −0.3 for 4x(L − x)/L² > 0.3/s₁ ≈ 0.896, i.e.
        // x within 371.875·√(1 − 0.896) ≈ ±120 of the middle, while its ends
        // (10, −0.3) are outside the outer sliver (the arc is at −0.0178
        // there) and no chord crosses another: only the in-and-out test
        // sees it, and both chords split. Then the hole's half chord from
        // (10, −0.3) to (371.875, −0.38) is under the outer arc throughout:
        // the gap, arc minus line, is least where their slopes match,
        // 4s₁(L − 2x)/L² = 0.08/361.875, at x ≈ 326.2, where the arc is at
        // −0.3297 and the line at −0.3699. So 2 chords each. The hole's arc
        // stays 0.045 below the outer one at the middle, a legal wall.
        // Meshed area: 743.75·50 − ½·743.75·s₁ − (723.75·19.7 − ½·723.75·s₂).
        let s2 = 0.08;
        let hole = path(&[(10.0, -0.3), (10.0, -20.0), (733.75, -20.0), (733.75, -0.3)], &[0.0, 0.0, 0.0, -s2 / 361.875]);
        let outer = path(&[(743.75, 0.0), (0.0, 0.0), (0.0, -50.0), (743.75, -50.0)], &[-0.0009, 0.0, 0.0, 0.0]);
        let b = extrude(&Profile { outer, holes: vec![hole] }, 3.0).unwrap();
        let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
        assert_eq!(m.check_closed(), Ok(()));
        assert_eq!(arc_chords(&b, &m), vec![2, 2, 2, 2]);
        let s1 = 371.875 * 0.0009;
        let v = (743.75 * 50.0 - 0.5 * 743.75 * s1 - (723.75 * 19.7 - 0.5 * 723.75 * s2)) * 3.0;
        assert!((m.signed_volume() - v).abs() <= 743.75 * LINEAR * 3.0, "{} vs {v}", m.signed_volume());
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 400,
            failure_persistence: Some(Box::new(proptest::test_runner::FileFailurePersistence::Direct("tests/regressions/extrude-shallow-arcs.txt"))),
            ..ProptestConfig::default()
        })]

        /// Against a simple model: an arc from A (L, 0) to B (0, 0) with a
        /// small bulge, so it starts as one chord along y = 0 bowing to +y by
        /// s = (L/2)·bulge, its height over the chord at x being
        /// √(r² − (x − L/2)²) − (r − s) with r = ((L/2)² + s²)/(2s). Then
        /// either a corner C at fraction f along it and g of that height
        /// (g < 0: below the chord; 0 < g < 1: in the sliver, the crash
        /// case), or a plate under it with a small triangular hole in the
        /// sliver. All of it turned and moved, so no chord is axis-aligned.
        /// The profile rules may refuse it; if not, the mesh must be closed
        /// and right side out, and since the arc bows outwards the mesh
        /// only loses some of its sliver: exact − sliver ≤ mesh ≤ exact,
        /// the sliver being under 0.7·L·s (a parabola's is (2/3)·L·s and a
        /// circle's exceeds it by a factor 1 + O(θ²), θ < 0.03 here).
        #[test]
        fn a_boundary_in_a_shallow_arcs_sliver_meshes_right_side_out(
            len in 10.0..1000.0f64,
            bulge in 1e-5..0.005f64,
            f in 0.05..0.95f64,
            g in -1.0..0.98f64,
            with_hole in any::<bool>(),
            turn in 0.0..TAU,
            shift in (-1e4..1e4f64, -1e4..1e4f64),
            d in 0.01..100.0f64,
        ) {
            let half = 0.5 * len;
            let s = half * bulge;
            let r = (half * half + s * s) / (2.0 * s);
            let height = |x: f64| (r * r - (x - half) * (x - half)).sqrt() - (r - s);
            let (sin, cos) = turn.sin_cos();
            let place = |x: f64, y: f64| (x * cos - y * sin + shift.0, x * sin + y * cos + shift.1);
            let x = f * len;
            let profile = if with_hole {
                let w = 0.05 * len * f.min(1.0 - f);
                let base = 0.3 * height(x - w).min(height(x + w));
                let hole = path(&[place(x - w, base), place(x + w, base), place(x, g.abs() * height(x))], &[]);
                let outer = path(&[place(len, 0.0), place(0.0, 0.0), place(0.0, -0.1 * len), place(len, -0.1 * len)], &[bulge, 0.0, 0.0, 0.0]);
                Profile { outer, holes: vec![hole] }
            } else {
                Profile { outer: path(&[place(len, 0.0), place(0.0, 0.0), place(x, g * height(x))], &[bulge, 0.0, 0.0]), holes: vec![] }
            };
            match extrude(&profile, d) {
                Err(KernelError::InvalidInput(_)) => {}
                Err(e) => prop_assert!(false, "{e:?} for {profile:?}"),
                Ok(b) => {
                    let m = tessellate(&b, &TessOptions::DISPLAY).unwrap();
                    prop_assert_eq!(m.check_closed(), Ok(()));
                    let exact = crate::mass::mass_properties(&b).volume;
                    let slack = 4.0 * len * LINEAR * d;
                    let mesh = m.signed_volume();
                    prop_assert!(mesh <= exact + slack && mesh >= exact - 0.7 * len * s * d - slack, "mesh {mesh} vs exact {exact} for {profile:?}");
                }
            }
        }
    }
}
