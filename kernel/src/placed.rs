//! A body as it sits in the world: its geometry in its own local
//! coordinates, plus a placement (see `geom::placement`).
//!
//! Moving and rotating change only the placement. Everything measured from
//! the geometry (validity, volume, area, the mesh's shape) is therefore
//! exactly what it was, and rounding from far-away trips or many turns
//! lands only on where the body is, never on its shape. The world
//! geometry is made on demand (`baked`), e.g. for the model-space check,
//! and once for good where two bodies meet (booleans, step 44). Face areas
//! and centroids (`face_masses`) are measured on the local geometry too,
//! with only each centroid carried into the world.

use crate::face_mass::{face_masses, FaceMass};
use crate::geom::{Placement, Transform};
use crate::mass::{mass_properties, MassProps};
use crate::mesh::Mesh;
use crate::tessellate::{tessellate, TessError, TessOptions};
use crate::topology::{Body, VertexId};
use glam::DVec3;

#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    /// The geometry, in local coordinates. Never changed by moves or turns.
    pub body: Body,
    pub placement: Placement,
}

impl Placed {
    /// A body where it was built. A body built far from the origin (its
    /// centre farther out than its own size) keeps its geometry around its
    /// own centre instead, with the centre as the placement's shift: every
    /// later turn then multiplies small local coordinates, so its rounding
    /// scales with the part, not with where it was drawn. Kept far out, a
    /// profile drawn 100 km away and moved home turned every corner by a
    /// 1e8-sized rotation (rounding ~1e-8) and changed the mesh's volume
    /// by area × that (stateful seed2057fadf92b1).
    pub fn new(body: Body) -> Placed {
        Placed::recentred(body)
    }

    /// `new`'s work, under a name `cargo mutants` mutates (it skips every
    /// function named `new`).
    fn recentred(body: Body) -> Placed {
        let (lo, hi) = body.bounds();
        let centre = (lo + hi) * 0.5;
        if centre.is_finite() && centre.abs().max_element() > (hi - lo).max_element() {
            // Each local coordinate p − c is exact when p and c are within a
            // factor of two of each other (Sterbenz), which holds on every
            // axis where the body is far out; elsewhere it rounds at the
            // part's own scale.
            let body = body.transformed(&Transform::translation(-centre));
            return Placed { body, placement: Placement::IDENTITY.moved(centre) };
        }
        Placed { body, placement: Placement::IDENTITY }
    }

    /// The geometry in world coordinates.
    pub fn baked(&self) -> Body {
        if self.placement.is_identity() {
            self.body.clone()
        } else {
            self.body.transformed(&self.placement.transform())
        }
    }

    /// Where vertex `v` is in the world.
    pub fn vertex(&self, v: VertexId) -> DVec3 {
        self.placement.point(self.body.vertices[v].point)
    }

    /// Axis-aligned world box around the body (as `Body::bounds` of the
    /// baked geometry).
    pub fn bounds(&self) -> (DVec3, DVec3) {
        if self.placement.is_identity() {
            self.body.bounds()
        } else {
            self.baked().bounds()
        }
    }

    /// Volume and area: a rigid motion changes neither, so they come from
    /// the local geometry, untouched by any rounding of the placement.
    pub fn mass_properties(&self) -> MassProps {
        mass_properties(&self.body)
    }

    /// Each face's area and centroid, by face index: measured on the local
    /// geometry, then only the centroid is carried into the world. Measured
    /// on the baked body instead, a long thin face far out takes its
    /// corners' rounding there (~1e-8 mm at 100 km) times its length over
    /// its width: about 1 mm on a 1 km strip 1.1 µm wide (seed8043b8edca9);
    /// this way the only rounding the placement adds is its own, once.
    pub fn face_masses(&self) -> Vec<FaceMass> {
        let mut faces = face_masses(&self.body);
        if !self.placement.is_identity() {
            faces.iter_mut().for_each(|f| f.centroid = self.placement.point(f.centroid));
        }
        faces
    }

    /// The local geometry's mesh, carried into the world. The same body
    /// always gets the same triangles, wherever it is.
    pub fn tessellate(&self, opts: &TessOptions) -> Result<Mesh, TessError> {
        let mut mesh = tessellate(&self.body, opts)?;
        if !self.placement.is_identity() {
            let r = glam::DMat3::from_quat(self.placement.rotation);
            mesh.positions.iter_mut().for_each(|p| *p = r * *p + self.placement.shift);
        }
        Ok(mesh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::primitives::make_box;
    use crate::tolerance::points_eq;
    use std::f64::consts::FRAC_PI_2;

    #[test]
    fn the_mesh_and_bounds_are_where_the_placement_puts_them() {
        // A 1×2×3 box turned a quarter turn about +Z ((x, y) → (−y, x)),
        // then moved by (10, 20, 30): it spans x in [−2, 0], y in [0, 1],
        // z in [0, 3] before the move, so [8, 10] × [20, 21] × [30, 33].
        let p = Placed {
            body: make_box(1.0, 2.0, 3.0).unwrap(),
            placement: Placement::IDENTITY.turned(DVec3::ZERO, DVec3::Z, FRAC_PI_2).moved(DVec3::new(10.0, 20.0, 30.0)),
        };
        let (lo, hi) = p.bounds();
        assert!(points_eq(lo, DVec3::new(8.0, 20.0, 30.0)) && points_eq(hi, DVec3::new(10.0, 21.0, 33.0)), "{lo} {hi}");
        let m = p.tessellate(&TessOptions::DISPLAY).unwrap();
        let (mlo, mhi) = m.positions.iter().fold((DVec3::INFINITY, DVec3::NEG_INFINITY), |(l, h), &q| (l.min(q), h.max(q)));
        assert!(points_eq(mlo, lo) && points_eq(mhi, hi), "{mlo} {mhi}");
        // Its corner (1, 2, 3) → (−2, 1, 3) → (8, 21, 33), in the baked body too.
        let far = p.body.vertices.iter().position(|v| points_eq(v.point, DVec3::new(1.0, 2.0, 3.0))).unwrap();
        assert!(points_eq(p.vertex(far), DVec3::new(8.0, 21.0, 33.0)));
        assert!(points_eq(p.baked().vertices[far].point, DVec3::new(8.0, 21.0, 33.0)));
        // Volume and area as built: 6 and 2(2 + 6 + 3) = 22.
        assert!(crate::tolerance::eq(p.mass_properties().volume, 6.0) && crate::tolerance::eq(p.mass_properties().area, 22.0));
    }

    #[test]
    fn face_centroids_are_measured_at_home_and_carried_out() {
        use crate::topology::FaceRole::*;
        // A 2 × 4 × 6 box spans [0, 2] × [0, 4] × [0, 6]; its Top (z = 6) is
        // 2 × 4 = 8 with centroid (1, 2, 6), its Right (x = 2) 4 × 6 = 24 at
        // (2, 2, 3), its Front (y = 0) 2 × 6 = 12 at (1, 0, 3). Turned a
        // quarter turn about +Z ((x, y, z) → (−y, x, z)) and moved by
        // (100, 0, −50): (1, 2, 6) → (−2, 1, 6) → (98, 1, −44);
        // (2, 2, 3) → (−2, 2, 3) → (98, 2, −47); (1, 0, 3) → (0, 1, 3) →
        // (100, 1, −47). Areas are unchanged.
        let b = make_box(2.0, 4.0, 6.0).unwrap();
        let p = Placed {
            body: b.clone(),
            placement: Placement::IDENTITY.turned(DVec3::ZERO, DVec3::Z, FRAC_PI_2).moved(DVec3::new(100.0, 0.0, -50.0)),
        };
        let faces = p.face_masses();
        let at = |role| faces[b.faces.iter().position(|f| f.role == Some(role)).unwrap()];
        for (role, area, centroid) in [(Top, 8.0, (98.0, 1.0, -44.0)), (Right, 24.0, (98.0, 2.0, -47.0)), (Front, 12.0, (100.0, 1.0, -47.0))] {
            let m = at(role);
            assert!(crate::tolerance::eq(m.area, area) && points_eq(m.centroid, DVec3::from(centroid)), "{role:?}: {m:?}");
        }
        // Unplaced, the same as the body's own.
        assert_eq!(Placed { body: b.clone(), placement: Placement::IDENTITY }.face_masses(), face_masses(&b));
    }

    #[test]
    fn a_long_thin_face_far_out_keeps_its_centroid() {
        // Regression (stateful seed8043b8edca9): a box 1 km × 36 mm × 1.1 µm,
        // turned π about (1, 1, 0), then about a slanted axis through
        // (0, −7, 0), then moved 100 km out. Its Front, 1 km long and 1.1 µm
        // wide, has centroid (L/2, 0, h/2) at home (L = 999 999.999 999,
        // h = 0.0011). The placement maps that one point, rounding a few
        // ulps at 1e8 (ulp 1.5e-8), as does the expected image through the
        // three steps' own matrix, so the two agree to well within 1e-6 mm.
        // Measured on the baked body, whose corners are each rounded to
        // ~1e-8 there, the centroid tips about 1 mm along the strip.
        use crate::topology::FaceRole::Front;
        let (l, h) = (999_999.999_999, 0.0011);
        let base = make_box(l, 36.0, h).unwrap();
        let (flip, pivot) = (DVec3::new(1.0, 1.0, 0.0), DVec3::new(0.0, -7.0, 0.0));
        let axis = DVec3::new(0.0, 0.7231947291110354, -0.9344924436458961);
        let (angle, by) = (9.590236344901994, DVec3::new(0.0, 99_999_999.0, 0.0));
        let p = crate::ops::transform::rotate(&Placed::new(base.clone()), DVec3::ZERO, flip, std::f64::consts::PI).unwrap();
        let p = crate::ops::transform::rotate(&p, pivot, axis, angle).unwrap();
        let p = crate::ops::transform::translate(&p, by).unwrap();
        let turn = |u: DVec3, a: f64| glam::DAffine3::from_axis_angle(u.normalize(), a);
        let matrix = glam::DAffine3::from_translation(by)
            * glam::DAffine3::from_translation(pivot)
            * turn(axis, angle)
            * glam::DAffine3::from_translation(-pivot)
            * turn(flip, std::f64::consts::PI);
        let expected = matrix.transform_point3(DVec3::new(l / 2.0, 0.0, h / 2.0));
        let f = base.faces.iter().position(|f| f.role == Some(Front)).unwrap();
        let off = p.face_masses()[f].centroid.distance(expected);
        assert!(off < 1e-6, "{off:e}");
        let baked = face_masses(&p.baked())[f].centroid.distance(expected);
        assert!(baked > 0.1, "the baked body's centroid is {baked:e} off, this one {off:e}");
    }

    #[test]
    fn a_part_drawn_far_away_keeps_its_shape_when_turned_at_home() {
        // Regression (stateful seeds 2057fadf92b1, 12849982fbf1,
        // 7cf983577b10, f5514195a283): a profile drawn ~100 km out and
        // placed back at the origin. A 0.5 mm cube built with its corner at
        // x = −99 999 999 (every coordinate exact: ulp there is 1.5e-8 and
        // 0.5 is a multiple of it) is centred at (−99 999 998.75, 0.25, 0.25),
        // farther out than its size, so its geometry is kept around that
        // centre: local corners ±0.25 on every axis, shift = the centre.
        let far = make_box(0.5, 0.5, 0.5).unwrap().transformed(&Transform::translation(DVec3::new(-99_999_999.0, 0.0, 0.0)));
        let p = Placed::new(far.clone());
        assert_eq!(p.placement.shift, DVec3::new(-99_999_998.75, 0.25, 0.25));
        assert!(p.body.vertices.iter().all(|v| v.point.abs() == DVec3::splat(0.25)));
        // The world corners are exactly the built ones (c + (p − c) = p here).
        for (k, v) in far.vertices.iter().enumerate() {
            assert_eq!(p.vertex(k), v.point);
        }
        // Moved home by +99 999 999 it spans [0, 0.5]³, and a quarter turn
        // about the line through the origin along (1, 1, 0) keeps every
        // corner's distance from the origin (a rigid motion): 0, √0.25,
        // √0.5 or √0.75, so it must hold to rounding at the part's own size
        // (1 mm), not at where it was drawn. Kept at 1e8, the turn
        // multiplied 1e8-sized coordinates and corners moved by ~1e-8,
        // ~6e5 times this slack.
        let home = crate::ops::transform::translate(&p, DVec3::new(99_999_999.0, 0.0, 0.0)).unwrap();
        let turned = crate::ops::transform::rotate(&home, DVec3::ZERO, DVec3::new(1.0, 1.0, 0.0), FRAC_PI_2).unwrap();
        let slack = crate::tolerance::rounding_slack(1.0);
        for k in 0..far.vertices.len() {
            let (d0, d1) = (home.vertex(k).length(), turned.vertex(k).length());
            assert!((d0 - d1).abs() <= slack, "corner {k}: {d0} → {d1}");
        }
        // Volume 0.125 and area 1.5, as built.
        let m = p.mass_properties();
        assert!(crate::tolerance::eq(m.volume, 0.125) && crate::tolerance::eq(m.area, 1.5), "{m:?}");
    }

    #[test]
    fn a_part_near_the_origin_is_kept_as_built() {
        // Centre (0.5, 1, 1.5) is not farther out than the part's size (3),
        // so nothing moves: the geometry is the built body, bit for bit.
        let b = make_box(1.0, 2.0, 3.0).unwrap();
        let p = Placed::new(b.clone());
        assert!(p.placement.is_identity());
        assert_eq!(p.body, b);
        // At the boundary: a 1 mm cube with its centre exactly 1 mm out (x
        // from 0.5 to 1.5) stays; centred 1.1 mm out it is re-centred.
        let cube = make_box(1.0, 1.0, 1.0).unwrap();
        let shifted = |x: f64| Placed::new(cube.transformed(&Transform::translation(DVec3::new(x, -0.5, -0.5))));
        assert!(shifted(0.5).placement.is_identity());
        assert!(!shifted(0.6).placement.is_identity());
    }
}
