//! Bodies built in a frame (step 26b): a sketch on the front or side plane,
//! or on a face, is drawn in its own 2D coordinates, and its extrude is built
//! there, along +Z from z = 0, then placed where the frame says.
//!
//! A frame is an origin, an x axis and a normal, all in world coordinates;
//! its y axis is normal × x, so a frame is always right-handed and placing
//! by it is a rigid motion, never a reflection: a sketch's (u, v) lands at
//! origin + u·x + v·y, and its +Z at the normal. The placement is kept apart
//! from the geometry (`Placed`), so the body's shape, volume and area are
//! exactly those of the same extrude unplaced; only where it is carries the
//! placement's rounding.
//!
//! A frame whose axes are not unit length or not square to each other
//! (within `FRAME_SQUARE`) is refused, never squared up quietly: it is the
//! caller's bug. One within it is squared up keeping the normal's direction
//! (the plane is the caller's), the x axis taking its part in that plane.
//!
//! A flipped extrude (Fusion's Flip, Ben's answer 2) goes the other way from
//! the same sketch plane: the same solid as the extrude moved back by its
//! distance, but with its start cap still on the sketch plane and its end
//! cap the far one, as a downward extrude's are. It is built as an ordinary
//! extrude in the frame seen from behind (normal reversed, x kept, so y
//! reversed too: a half turn about x), of the profile mirrored across x
//! (v → −v, each bulge negated), which puts every sketch point back where it
//! was drawn; so every rule about an extrude's faces and edges (roles, which
//! face an edge lists first) holds for it in its own frame unchanged. Its
//! profile is checked as given first, so a refusal names the caller's own
//! coordinates, not the mirrored ones.

use super::extrude::{extrude_meshed, Boundary, Profile};
use super::profile::check_profile;
use super::{check_length, Input, KernelError};
use crate::geom::Placement;
use crate::mesh::Mesh;
use crate::placed::Placed;
use crate::tolerance::{FRAME_SQUARE, MAX_COORD};
use glam::{DMat3, DQuat, DVec2, DVec3};

/// Where a sketch's plane is: its origin, x axis and normal in world
/// coordinates (y = normal × x).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: DVec3,
    pub x: DVec3,
    pub normal: DVec3,
}

impl Frame {
    /// The world's XY plane: sketch coordinates are world coordinates.
    pub const XY: Frame = Frame { origin: DVec3::ZERO, x: DVec3::X, normal: DVec3::Z };

    /// The frame's y axis, normal × x.
    pub fn y(&self) -> DVec3 {
        self.normal.cross(self.x)
    }
}

/// The rigid motion a frame stands for: local (u, v, w) → origin + u·x +
/// v·y + w·normal. Refuses (naming the parts at fault) a frame with a part
/// that isn't finite, an origin outside model space (like a rotation's
/// pivot), an axis whose length is more than `FRAME_SQUARE` from 1, or axes
/// whose dot product is more than `FRAME_SQUARE` from 0.
pub fn frame_placement(frame: &Frame) -> Result<Placement, KernelError> {
    let param = |name| Input::Param { name };
    let parts = [("origin", frame.origin), ("x", frame.x), ("normal", frame.normal)];
    let not_finite: Vec<Input> = parts.iter().filter(|(_, v)| !v.is_finite()).map(|&(name, _)| param(name)).collect();
    if !not_finite.is_empty() {
        return Err(KernelError::InvalidInput { inputs: not_finite, message: "a frame's origin, x axis and normal must be finite".into() });
    }
    if frame.origin.abs().max_element() > MAX_COORD {
        return Err(KernelError::invalid(param("origin"), format!("frame origin {} is outside model space (±{MAX_COORD:e} mm)", frame.origin)));
    }
    for (name, what, v) in [("x", "x axis", frame.x), ("normal", "normal", frame.normal)] {
        // A finite vector's length can still overflow (1e300 each way) or
        // vanish; both are far from 1 and refused.
        let len = v.length();
        if (len - 1.0).abs() > FRAME_SQUARE {
            return Err(KernelError::invalid(param(name), format!("frame {what} {v} has length {len}; it must be a unit vector (within {FRAME_SQUARE:e})")));
        }
    }
    let cos = frame.x.dot(frame.normal);
    if cos.abs() > FRAME_SQUARE {
        return Err(KernelError::InvalidInput {
            inputs: vec![param("x"), param("normal")],
            message: format!("frame x axis {} and normal {} are not square to each other (their dot product is {cos:e}; at most {FRAME_SQUARE:e})", frame.x, frame.normal),
        });
    }
    // Squared up: the normal keeps its direction, x keeps its part in the plane.
    let n = frame.normal / frame.normal.length();
    let x = frame.x - n * frame.x.dot(n);
    let x = x / x.length();
    let rotation = DQuat::from_mat3(&DMat3::from_cols(x, n.cross(x), n)).normalize();
    Ok(Placement { rotation, shift: frame.origin })
}

/// A placement seen from behind: a half turn about its own x axis first
/// (local (u, v, w) → (u, −v, −w)), so the normal and y reverse and x stays.
/// The quaternion product with i only moves and negates components: no
/// rounding.
pub fn flipped(p: Placement) -> Placement {
    Placement { rotation: p.rotation * DQuat::from_xyzw(1.0, 0.0, 0.0, 0.0), shift: p.shift }
}

/// The profile mirrored across its x axis: (u, v) → (u, −v), each bulge
/// negated (a mirrored arc bends the other way). Exact: only signs change.
/// Its loops run the other way round, which the extrude accepts like any
/// clockwise outline, keeping each piece's number as given.
pub fn mirrored(profile: &Profile) -> Profile {
    let flip = |c: &DVec2| DVec2::new(c.x, -c.y);
    let mirror = |b: &Boundary| match b {
        Boundary::Path { corners, bulges } => Boundary::Path { corners: corners.iter().map(flip).collect(), bulges: bulges.iter().map(|b| -b).collect() },
        Boundary::Circle { center, radius } => Boundary::Circle { center: flip(center), radius: *radius },
    };
    Profile { outer: mirror(&profile.outer), holes: profile.holes.iter().map(mirror).collect() }
}

/// A checked body placed by `placement`: re-centred first when it was built
/// far from its own origin (`Placed::with_mesh`), then carried by the
/// placement, and refused when any of it would leave model space. The mesh
/// is the local geometry's.
pub fn place(meshed: super::Meshed, placement: Placement) -> Result<(Placed, Mesh), KernelError> {
    let (home, mesh) = Placed::with_mesh(meshed.0, meshed.1);
    let placed = Placed { placement: home.placement.then(placement), body: home.body };
    Ok((super::transform::checked_place(placed)?, mesh))
}

/// `profile` (in the frame's own 2D coordinates) extruded by `distance`
/// along the frame's normal, or against it when `flip` (see the top of this
/// file), placed by the frame. Returns the placed body and its local mesh.
/// Checks the frame first, then the extrude's inputs as `extrude` does.
pub fn extrude_in_frame(profile: &Profile, distance: f64, frame: &Frame, flip: bool) -> Result<(Placed, Mesh), KernelError> {
    let placement = frame_placement(frame)?;
    if !flip {
        return place(extrude_meshed(profile, distance)?, placement);
    }
    // The inputs as given first, in extrude's order, so a refusal reads in
    // the caller's coordinates.
    check_length("distance", "extrude distance", distance)?;
    check_profile(profile)?;
    place(extrude_meshed(&mirrored(profile), distance)?, flipped(placement))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::face_mass::face_masses;
    use crate::fmath;
    use crate::mass::mass_properties;
    use crate::ops::extrude::extrude;
    use crate::tessellate::TessOptions;
    use crate::tolerance::{measure_eq, points_eq, rounding_slack, rel_eq, FP_REL, LINEAR};
    use crate::topology::FaceRole;

    fn rect(w: f64, h: f64) -> Profile {
        Profile::polygon(vec![DVec2::new(0.0, 0.0), DVec2::new(w, 0.0), DVec2::new(w, h), DVec2::new(0.0, h)], vec![])
    }

    /// The front plane (XZ) as the naming model frames it: sketch (x, y)
    /// reads as world (x, z), so x = +X and y = +Z, and the normal is
    /// −Y (then y = n × x = (−Y) × X = Z).
    const FRONT: Frame = Frame { origin: DVec3::ZERO, x: DVec3::X, normal: DVec3::NEG_Y };
    /// The side plane (YZ): x = +Y, normal = +X, so y = X × Y = Z.
    const SIDE: Frame = Frame { origin: DVec3::ZERO, x: DVec3::Y, normal: DVec3::X };

    /// Every world vertex of `p` matches one of `expected` and the other way
    /// round (an extrude's vertex order is its own business).
    fn corners_are(p: &Placed, expected: &[DVec3]) {
        let got: Vec<DVec3> = (0..p.body.vertices.len()).map(|k| p.vertex(k)).collect();
        assert_eq!(got.len(), expected.len(), "{got:?}");
        for e in expected {
            assert!(got.iter().any(|g| points_eq(*g, *e)), "no corner at {e}: {got:?}");
        }
        for g in &got {
            assert!(expected.iter().any(|e| points_eq(*g, *e)), "a corner at {g} that shouldn't be there");
        }
    }

    fn role_face(p: &Placed, role: FaceRole) -> usize {
        p.body.faces.iter().position(|f| f.role == Some(role)).unwrap()
    }

    fn world_normal(p: &Placed, f: usize) -> DVec3 {
        p.placement.dir(p.body.face_normal_at(f, DVec3::ZERO))
    }

    #[test]
    fn a_box_on_the_front_plane_by_hand() {
        // A 40 × 30 rectangle with a corner at the sketch's origin, extruded
        // 20 on the front plane: local (u, v, w) → u·X + v·Z + w·(−Y) =
        // (u, −w, v). Its corners are (u, −w, v) for u ∈ {0, 40}, v ∈ {0, 30},
        // w ∈ {0, 20}: x in [0, 40], y in [−20, 0] (towards the viewer, who
        // looks along +Y), z in [0, 30].
        let (p, _) = extrude_in_frame(&rect(40.0, 30.0), 20.0, &FRONT, false).unwrap();
        let mut expected = vec![];
        for u in [0.0, 40.0] {
            for v in [0.0, 30.0] {
                for w in [0.0, 20.0] {
                    expected.push(DVec3::new(u, -w, v));
                }
            }
        }
        corners_are(&p, &expected);
        let (lo, hi) = p.bounds();
        assert!(points_eq(lo, DVec3::new(0.0, -20.0, 0.0)) && points_eq(hi, DVec3::new(40.0, 0.0, 30.0)), "{lo} {hi}");
        // 40·30·20 = 24000 mm³; area 2(40·30 + 40·20 + 30·20) = 5200 mm².
        let m = p.mass_properties();
        assert!(rel_eq(m.volume, 24000.0, FP_REL) && rel_eq(m.area, 5200.0, FP_REL), "{m:?}");
        // The start cap is the sketch plane, y = 0, facing away from the
        // solid (+Y); its centroid is the rectangle's middle (20, 0, 15).
        // The end cap is 20 along the normal: y = −20, facing −Y. The side
        // swept from piece 0, (0, 0) → (40, 0), is the bottom z = 0 facing −Z,
        // centroid (20, −10, 0).
        let faces = p.face_masses();
        let side0 = FaceRole::Side(crate::topology::Piece { boundary: 0, piece: 0 });
        for (role, centroid, normal, area) in [
            (FaceRole::Start, DVec3::new(20.0, 0.0, 15.0), DVec3::Y, 1200.0),
            (FaceRole::End, DVec3::new(20.0, -20.0, 15.0), DVec3::NEG_Y, 1200.0),
            (side0, DVec3::new(20.0, -10.0, 0.0), DVec3::NEG_Z, 800.0),
        ] {
            let f = role_face(&p, role);
            assert!(points_eq(faces[f].centroid, centroid), "{role:?}: {:?}", faces[f]);
            assert!(points_eq(world_normal(&p, f), normal), "{role:?}: {}", world_normal(&p, f));
            assert!(rel_eq(faces[f].area, area, FP_REL), "{role:?}: {:?}", faces[f]);
        }
    }

    #[test]
    fn a_box_on_the_side_plane_by_hand() {
        // The side plane: (u, v, w) → u·Y + v·Z + w·X = (w, u, v). The same
        // rectangle spans x in [0, 20], y in [0, 40], z in [0, 30]; its far
        // corner (40, 30, 20) is at (20, 40, 30).
        let (p, _) = extrude_in_frame(&rect(40.0, 30.0), 20.0, &SIDE, false).unwrap();
        let (lo, hi) = p.bounds();
        assert!(points_eq(lo, DVec3::ZERO) && points_eq(hi, DVec3::new(20.0, 40.0, 30.0)), "{lo} {hi}");
        let f = role_face(&p, FaceRole::End);
        assert!(points_eq(world_normal(&p, f), DVec3::X) && points_eq(p.face_masses()[f].centroid, DVec3::new(20.0, 20.0, 15.0)));
    }

    #[test]
    fn a_slanted_frame_far_from_the_origin_by_hand() {
        // A 3-4-5 slope: normal (0, −0.6, 0.8), x = X, so y = n × x =
        // (−0.6·0 − 0.8·0, 0.8·1 − 0·0, 0·0 − (−0.6)·1) = (0, 0.8, 0.6);
        // y·n = −0.48 + 0.48 = 0. Origin (1, 2, 3). The far corner (40, 30, 20)
        // lands at (1 + 40, 2 + 30·0.8 − 20·0.6, 3 + 30·0.6 + 20·0.8) =
        // (41, 14, 37); the corner (0, 30, 0) at (1, 26, 21).
        let frame = Frame { origin: DVec3::new(1.0, 2.0, 3.0), x: DVec3::X, normal: DVec3::new(0.0, -0.6, 0.8) };
        assert!(points_eq(frame.y(), DVec3::new(0.0, 0.8, 0.6)));
        let (p, _) = extrude_in_frame(&rect(40.0, 30.0), 20.0, &frame, false).unwrap();
        let got: Vec<DVec3> = (0..p.body.vertices.len()).map(|k| p.vertex(k)).collect();
        for e in [DVec3::new(41.0, 14.0, 37.0), DVec3::new(1.0, 26.0, 21.0), DVec3::new(1.0, 2.0, 3.0)] {
            assert!(got.iter().any(|g| points_eq(*g, e)), "no corner at {e}: {got:?}");
        }
        // Rigid: 24000 and 5200 still.
        let m = mass_properties(&p.baked());
        assert!(measure_eq(m.volume, 24000.0, 5200.0 * rounding_slack(60.0)) && measure_eq(m.area, 5200.0, 5200.0 * rounding_slack(60.0)), "{m:?}");
    }

    #[test]
    fn a_flipped_extrude_keeps_its_start_cap_on_the_sketch_plane() {
        // Flipped on XY: the same 40 × 30 rectangle goes down, z in [−20, 0]:
        // the extrude moved back by its distance. The start cap stays on the
        // sketch plane (z = 0) and faces away from the solid, now up (+Z),
        // centroid (20, 15, 0); the end cap is the far one, z = −20, facing
        // −Z. The side swept from piece 0, (0, 0) → (40, 0), still faces −Y,
        // centroid (20, 0, −10).
        let (p, _) = extrude_in_frame(&rect(40.0, 30.0), 20.0, &Frame::XY, true).unwrap();
        let (lo, hi) = p.bounds();
        assert!(points_eq(lo, DVec3::new(0.0, 0.0, -20.0)) && points_eq(hi, DVec3::new(40.0, 30.0, 0.0)), "{lo} {hi}");
        let faces = p.face_masses();
        let side0 = FaceRole::Side(crate::topology::Piece { boundary: 0, piece: 0 });
        for (role, centroid, normal) in [
            (FaceRole::Start, DVec3::new(20.0, 15.0, 0.0), DVec3::Z),
            (FaceRole::End, DVec3::new(20.0, 15.0, -20.0), DVec3::NEG_Z),
            (side0, DVec3::new(20.0, 0.0, -10.0), DVec3::NEG_Y),
        ] {
            let f = role_face(&p, role);
            assert!(points_eq(faces[f].centroid, centroid), "{role:?}: {:?}", faces[f]);
            assert!(points_eq(world_normal(&p, f), normal), "{role:?}: {}", world_normal(&p, f));
        }
        // On the front plane, flipped goes away from the viewer: y in [0, 20].
        let (q, _) = extrude_in_frame(&rect(40.0, 30.0), 20.0, &FRONT, true).unwrap();
        let (lo, hi) = q.bounds();
        assert!(points_eq(lo, DVec3::ZERO) && points_eq(hi, DVec3::new(40.0, 20.0, 30.0)), "{lo} {hi}");
        let m = q.mass_properties();
        assert!(rel_eq(m.volume, 24000.0, FP_REL) && rel_eq(m.area, 5200.0, FP_REL), "{m:?}");
    }

    #[test]
    fn a_flipped_arc_bends_the_way_it_was_drawn() {
        // A half disc: from (0, 0) to (10, 0) with bulge 1, a half turn
        // counter-clockwise round the chord's middle (5, 0), so from angle π
        // on through 3π/2: below the chord, y in [−5, 0]; then straight back.
        // Extruded 4 either way it keeps y in [−5, 0] (z in [0, 4], or
        // [−4, 0] flipped), volume 4 · π·5²/2 = 50π. Mirrored without
        // negating the bulge, the flipped arc would land above the chord.
        let half = Profile { outer: Boundary::Path { corners: vec![DVec2::ZERO, DVec2::new(10.0, 0.0)], bulges: vec![1.0, 0.0] }, holes: vec![] };
        for (flip, z) in [(false, (0.0, 4.0)), (true, (-4.0, 0.0))] {
            let (p, _) = extrude_in_frame(&half, 4.0, &Frame::XY, flip).unwrap();
            let (lo, hi) = p.bounds();
            assert!(points_eq(lo, DVec3::new(0.0, -5.0, z.0)) && points_eq(hi, DVec3::new(10.0, 0.0, z.1)), "flip {flip}: {lo} {hi}");
            let v = p.mass_properties().volume;
            assert!(rel_eq(v, 50.0 * std::f64::consts::PI, FP_REL), "flip {flip}: {v}");
        }
        // A circle hole is mirrored too: centre (3, 2) stays at (3, 2).
        let plate = Profile { outer: rect(10.0, 10.0).outer, holes: vec![Boundary::Circle { center: DVec2::new(3.0, 2.0), radius: 1.0 }] };
        let (p, _) = extrude_in_frame(&plate, 1.0, &Frame::XY, true).unwrap();
        let (_, near) = (0..p.body.faces.len())
            .filter(|&f| matches!(p.body.faces[f].surface, crate::geom::Surface::Cylinder { .. }))
            .map(|f| (f, p.face_masses()[f].centroid))
            .next()
            .unwrap();
        // The hole's wall: centroid on its axis, (3, 2, −0.5).
        assert!(points_eq(near, DVec3::new(3.0, 2.0, -0.5)), "{near}");
    }

    #[test]
    fn a_flipped_refusal_names_the_profile_as_given() {
        // A corner that isn't finite at (3, NaN)... and one beyond model
        // space at (1, 2e8): the message shows (1, 200000000), not the
        // mirrored (1, −200000000).
        let far = Profile::polygon(vec![DVec2::new(0.0, 0.0), DVec2::new(1.0, 0.0), DVec2::new(1.0, 2e8)], vec![]);
        let flipped = extrude_in_frame(&far, 1.0, &Frame::XY, true).unwrap_err().to_string();
        let plain = extrude_in_frame(&far, 1.0, &Frame::XY, false).unwrap_err().to_string();
        assert_eq!(flipped, plain);
        assert!(!flipped.contains("-200000000"), "{flipped}");
        // A bad distance is refused first, as unflipped.
        let e = extrude_in_frame(&far, -1.0, &Frame::XY, true).unwrap_err();
        assert!(matches!(&e, KernelError::InvalidInput { inputs, .. } if inputs == &vec![Input::Param { name: "distance" }]), "{e:?}");
    }

    /// The inputs a refusal names, or a panic.
    fn refused(frame: Frame) -> (Vec<Input>, String) {
        match frame_placement(&frame) {
            Err(KernelError::InvalidInput { inputs, message }) => (inputs, message),
            other => panic!("expected a refusal for {frame:?}, got {other:?}"),
        }
    }

    #[test]
    fn bad_frames_are_refused_naming_the_part_at_fault() {
        let param = |name| Input::Param { name };
        let with = |origin, x, normal| Frame { origin, x, normal };
        let (o, x, n) = (DVec3::ZERO, DVec3::X, DVec3::Z);
        assert_eq!(refused(with(DVec3::new(f64::NAN, 0.0, 0.0), x, n)).0, vec![param("origin")]);
        assert_eq!(refused(with(o, DVec3::new(f64::INFINITY, 0.0, 0.0), DVec3::new(0.0, f64::NAN, 1.0))).0, vec![param("x"), param("normal")]);
        let (inputs, message) = refused(with(DVec3::new(0.0, 0.0, 2e8), x, n));
        assert_eq!(inputs, vec![param("origin")]);
        assert!(message.contains("outside model space"), "{message}");
        // An origin on the edge of model space is fine (what is built there may not be).
        assert!(frame_placement(&with(DVec3::new(0.0, 0.0, MAX_COORD), x, n)).is_ok());
        // Zero, tiny, long and overflowing axes.
        for bad in [DVec3::ZERO, DVec3::new(1e-300, 0.0, 0.0), DVec3::new(2.0, 0.0, 0.0), DVec3::new(1e300, 1e300, 0.0)] {
            assert_eq!(refused(with(o, bad, n)).0, vec![param("x")], "{bad}");
            assert_eq!(refused(with(o, x, DVec3::new(bad.z, bad.x, bad.y))).0, vec![param("normal")], "{bad}");
        }
        // Parallel axes: no plane at all.
        let (inputs, message) = refused(with(o, x, x));
        assert_eq!(inputs, vec![param("x"), param("normal")]);
        assert!(message.contains("not square"), "{message}");
    }

    #[test]
    fn frame_tolerance_boundaries() {
        // FRAME_SQUARE is 64 ulps of 1: 1 ± that is a double, so an axis
        // exactly on the boundary exists and is accepted; 0.9× inside is
        // accepted, 1.1× outside refused. Below 1 the ulp is half as big, so
        // 1 − 0.9·FRAME_SQUARE etc. are doubles too.
        let t = FRAME_SQUARE;
        assert_eq!(t, 64.0 * f64::EPSILON);
        let ok = |f: Frame| frame_placement(&f).is_ok();
        let axis_x = |len: f64| Frame { origin: DVec3::ZERO, x: DVec3::new(len, 0.0, 0.0), normal: DVec3::Z };
        let axis_n = |len: f64| Frame { origin: DVec3::ZERO, x: DVec3::X, normal: DVec3::new(0.0, 0.0, len) };
        for k in [0.9, 1.0] {
            assert!(ok(axis_x(1.0 + k * t)) && ok(axis_x(1.0 - k * t)) && ok(axis_n(1.0 + k * t)) && ok(axis_n(1.0 - k * t)), "{k}×");
        }
        assert!(!ok(axis_x(1.0 + 1.1 * t)) && !ok(axis_x(1.0 - 1.1 * t)) && !ok(axis_n(1.0 + 1.1 * t)) && !ok(axis_n(1.0 - 1.1 * t)));
        // Square: x = X, normal (c, 0, 1), whose length √(1 + c²) is 1 to
        // the last bit for c this small, and whose dot with x is c exactly.
        let tilt = |c: f64| Frame { origin: DVec3::ZERO, x: DVec3::X, normal: DVec3::new(c, 0.0, 1.0) };
        assert_eq!(tilt(t).normal.length(), 1.0);
        assert!(ok(tilt(0.9 * t)) && ok(tilt(t)) && ok(tilt(-t)));
        assert!(!ok(tilt(1.1 * t)) && !ok(tilt(-1.1 * t)));
        assert_eq!(refused(tilt(1.1 * t)).0, vec![Input::Param { name: "x" }, Input::Param { name: "normal" }]);
    }

    #[test]
    fn an_axis_off_square_within_tolerance_is_squared_up_keeping_the_normal() {
        // Normal exactly Z, x tilted up by c = FRAME_SQUARE: the plane is the
        // caller's, so the normal stays Z and x becomes X; a point
        // (1e6, 0, 0) lands at (1e6, 0, 0), not 1e6·c ≈ 1.4e-8 above the plane.
        let c = FRAME_SQUARE;
        let p = frame_placement(&Frame { origin: DVec3::ZERO, x: DVec3::new(1.0, 0.0, c), normal: DVec3::Z }).unwrap();
        assert!(p.dir(DVec3::Z).abs_diff_eq(DVec3::Z, 4.0 * f64::EPSILON), "{}", p.dir(DVec3::Z));
        assert!(p.point(DVec3::new(1e6, 0.0, 0.0)).z.abs() <= rounding_slack(1e6) * 1e-6, "{}", p.point(DVec3::new(1e6, 0.0, 0.0)));
    }

    #[test]
    fn a_far_profile_is_kept_at_home_with_its_mesh() {
        // A 2 × 2 square drawn 50 km out in a slanted frame: re-centred
        // (`Placed::with_mesh`), so the rotation multiplies small numbers;
        // the mesh moves with the geometry, its every point within LINEAR
        // of the local body's box.
        let far = Profile::polygon(vec![DVec2::new(5e7, 5e7), DVec2::new(5e7 + 2.0, 5e7), DVec2::new(5e7 + 2.0, 5e7 + 2.0), DVec2::new(5e7, 5e7 + 2.0)], vec![]);
        let frame = Frame { origin: DVec3::new(0.0, 0.0, -1e7), x: DVec3::X, normal: DVec3::new(0.0, -0.6, 0.8) };
        let (p, mesh) = extrude_in_frame(&far, 3.0, &frame, false).unwrap();
        assert!(!p.placement.rotation.abs_diff_eq(DQuat::IDENTITY, 0.0));
        let (lo, hi) = p.body.bounds();
        assert!((hi - lo).max_element() < 4.0 && lo.abs().max_element() < 4.0, "local {lo} {hi}");
        assert!(mesh.positions.iter().all(|q| (q.cmpge(lo - LINEAR) & q.cmple(hi + LINEAR)).all()), "the mesh was left where the body was built");
        // Corner (5e7, 5e7, 0) → (5e7, 5e7·0.8, −1e7 + 5e7·0.6) = (5e7, 4e7, 2e7).
        let want = DVec3::new(5e7, 4e7, 2e7);
        assert!((0..p.body.vertices.len()).any(|k| p.vertex(k).distance(want) <= rounding_slack(5e7)), "no corner at {want}");
        // Volume 12 exactly as built, and the world mesh's to rounding at the
        // part's own size (it is placed point by point, each to ~1e-8 here,
        // times the 2 × 2 × 3 part's area 32).
        assert!(rel_eq(p.mass_properties().volume, 12.0, FP_REL));
        let world = p.tessellate(&TessOptions::DISPLAY).unwrap();
        assert!(measure_eq(world.signed_volume(), 12.0, 32.0 * rounding_slack(5e7)), "{}", world.signed_volume());
    }

    #[test]
    fn a_body_that_would_leave_model_space_is_refused() {
        let frame = Frame { origin: DVec3::new(MAX_COORD - 10.0, 0.0, 0.0), x: DVec3::Y, normal: DVec3::X };
        assert!(extrude_in_frame(&rect(4.0, 4.0), 10.0, &frame, false).is_ok());
        let e = extrude_in_frame(&rect(4.0, 4.0), 11.0, &frame, false).unwrap_err();
        assert!(matches!(&e, KernelError::InvalidInput { inputs, message } if inputs.is_empty() && message.contains("would reach")), "{e:?}");
        // Flipped, it goes back inside.
        assert!(extrude_in_frame(&rect(4.0, 4.0), 11.0, &frame, true).is_ok());
    }

    use proptest::prelude::*;

    /// A frame from angles: the normal at polar angle `theta`, azimuth
    /// `phi`; x any perpendicular turned by `spin` about it.
    fn frame_of(origin: DVec3, theta: f64, phi: f64, spin: f64) -> Frame {
        let (st, ct) = fmath::sin_cos(theta);
        let (sp, cp) = fmath::sin_cos(phi);
        let n = DVec3::new(st * cp, st * sp, ct).normalize();
        let p = crate::geom::any_perpendicular(n);
        let (ss, cs) = fmath::sin_cos(spin);
        let x = (p * cs + n.cross(p) * ss).normalize();
        Frame { origin, x, normal: n }
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 300, ..ProptestConfig::default() })]

        /// Any frame, any rectangle with a round hole, either way: the body
        /// is the unplaced extrude moved rigidly. Each world corner is where
        /// the frame read literally puts it (origin + u·x + v·y ± w·n);
        /// volume and area, measured again on the baked world geometry and
        /// on the world mesh, are the unplaced body's; flipping gives the
        /// same corners moved back by the distance; the frame is never a
        /// reflection (its rotation's determinant is +1, and y = n × x).
        #[test]
        fn a_placed_extrude_is_the_extrude_moved_rigidly(
            theta in 0.0..std::f64::consts::PI, phi in 0.0..std::f64::consts::TAU, spin in 0.0..std::f64::consts::TAU,
            origin in (-1e4..1e4f64, -1e4..1e4f64, -1e4..1e4f64),
            at in (-1e3..1e3f64, -1e3..1e3f64),
            w in 1.0..500.0f64, h in 1.0..500.0f64, d in 0.01..300.0f64,
            flip in any::<bool>(),
        ) {
            let frame = frame_of(DVec3::new(origin.0, origin.1, origin.2), theta, phi, spin);
            let corners: Vec<DVec2> = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].iter().map(|&(u, v)| DVec2::new(at.0 + u, at.1 + v)).collect();
            let r = 0.25 * w.min(h);
            let profile = Profile { outer: Boundary::polygon(corners.clone()), holes: vec![Boundary::Circle { center: DVec2::new(at.0 + w / 2.0, at.1 + h / 2.0), radius: r }] };
            let (p, _) = extrude_in_frame(&profile, d, &frame, flip).unwrap();
            let unplaced = mass_properties(&extrude(&profile, d).unwrap());
            let reach = frame.origin.abs().max_element() + at.0.abs().max(at.1.abs()) + w + h + d;
            let slack = rounding_slack(reach);
            // Corners, literally.
            let along = if flip { -d } else { d };
            let expected: Vec<DVec3> = corners.iter().flat_map(|c| [0.0, along].map(|t| frame.origin + frame.x * c.x + frame.y() * c.y + frame.normal * t)).collect();
            let got: Vec<DVec3> = (0..p.body.vertices.len()).map(|k| p.vertex(k)).filter(|g| expected.iter().any(|e| e.distance(*g) <= slack)).collect();
            // The 8 corners, plus the hole's two seam vertices (or none).
            prop_assert!(got.len() >= 8, "only {} of the corners where the frame says: {:?}", got.len(), (0..p.body.vertices.len()).map(|k| p.vertex(k)).collect::<Vec<_>>());
            // The hole's axis passes through the frame's point for its centre.
            let centre = frame.origin + frame.x * (at.0 + w / 2.0) + frame.y() * (at.1 + h / 2.0);
            let wall = (0..p.body.faces.len()).find(|&f| matches!(p.body.faces[f].surface, crate::geom::Surface::Cylinder { .. })).unwrap();
            let c = p.face_masses()[wall].centroid;
            prop_assert!(c.distance(centre + frame.normal * (along / 2.0)) <= slack, "hole wall centroid {c}");
            // Rigid: the baked world geometry and the world mesh keep volume and area.
            let baked = mass_properties(&p.baked());
            let allowance = unplaced.area * slack;
            prop_assert!(measure_eq(baked.volume, unplaced.volume, allowance) && measure_eq(baked.area, unplaced.area, allowance), "{baked:?} vs {unplaced:?}");
            // The local geometry is the extrude's, re-centred when far out (or
            // mirrored, flipped), which rounds at the part's own size only.
            let own = p.mass_properties();
            prop_assert!(rel_eq(own.volume, unplaced.volume, FP_REL) && rel_eq(own.area, unplaced.area, FP_REL), "{own:?} vs {unplaced:?}");
            let local = crate::tessellate::tessellate(&p.body, &TessOptions::DISPLAY).unwrap();
            let world = p.tessellate(&TessOptions::DISPLAY).unwrap();
            prop_assert!(measure_eq(world.signed_volume(), local.signed_volume(), allowance) && measure_eq(world.area(), local.area(), allowance));
            // Never a reflection.
            let m = DMat3::from_quat(p.placement.rotation);
            prop_assert!(rel_eq(m.determinant(), 1.0, 1e3 * f64::EPSILON), "det {}", m.determinant());
            prop_assert!(frame.normal.cross(frame.x).distance(frame.y()) == 0.0);
            // Face areas are the unplaced ones, face for face.
            let faces = face_masses(&extrude(&if flip { mirrored(&profile) } else { profile.clone() }, d).unwrap());
            for (a, b) in p.face_masses().iter().zip(&faces) {
                prop_assert!(rel_eq(a.area, b.area, FP_REL), "{} vs {}", a.area, b.area);
            }
        }
    }
}
