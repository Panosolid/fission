//! A body as it sits in the world: its geometry in its own local
//! coordinates, plus a placement (see `geom::placement`).
//!
//! Moving and rotating change only the placement. Everything measured from
//! the geometry (validity, volume, area, the mesh's shape) is therefore
//! exactly what it was, and rounding from far-away trips or many turns
//! lands only on where the body is, never on its shape. The world
//! geometry is made on demand (`baked`), e.g. for the model-space check,
//! and once for good where two bodies meet (booleans, step 44).

use crate::geom::Placement;
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
    /// A body where it was built.
    pub fn new(body: Body) -> Placed {
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
}
