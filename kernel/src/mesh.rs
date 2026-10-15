//! Triangle meshes produced by tessellation, with the checks and measures
//! that only make sense on triangles.

use crate::topology::FaceId;
use glam::DVec3;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mesh {
    pub positions: Vec<DVec3>,
    /// Counter-clockwise seen from outside.
    pub triangles: Vec<[u32; 3]>,
    /// The B-rep face each triangle came from.
    pub triangle_face: Vec<FaceId>,
    /// Polyline of mesh vertex indices for each B-rep edge.
    pub edge_polylines: Vec<Vec<u32>>,
    /// The settings the mesh was made with.
    pub options: crate::tessellate::TessOptions,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MeshError {
    /// A mesh edge isn't shared by exactly two triangles.
    OpenEdge { a: u32, b: u32, uses: usize },
    /// Two triangles sharing an edge traverse it the same way.
    FlippedTriangles { a: u32, b: u32 },
}

impl Mesh {
    pub fn triangle(&self, t: usize) -> [DVec3; 3] {
        self.triangles[t].map(|i| self.positions[i as usize])
    }

    /// Volume enclosed, positive when triangles face outward (divergence theorem).
    pub fn signed_volume(&self) -> f64 {
        self.signed_volume_of(|_| true)
    }

    /// Volume enclosed by the triangles `keep` selects (e.g. one shell's).
    ///
    /// Each triangle contributes (a−o)·((b−a)×(c−a))/6, which equals the
    /// tetrahedron volume (a−o)·((b−o)×(c−o))/6 exactly (the extra terms
    /// are triple products with a repeated vector). Two choices keep the
    /// rounding small:
    /// - `o` is the centre of the bounding box of the selected triangles,
    ///   so |a−o| is at most half the selection's own diagonal, however far
    ///   it is from the world origin or from other shells in the mesh;
    /// - the cross product is taken at the corner opposite the longest
    ///   edge, so it multiplies the two shorter edges. On a 2000 × 0.01
    ///   sliver, the two long edges would give products ~10^6 cancelling
    ///   to ~20 (error ~1e-10, times |a−o| in the sum); the short pair
    ///   gives products ~10 with error ~1e-15.
    pub fn signed_volume_of(&self, keep: impl Fn(usize) -> bool) -> f64 {
        let selected: Vec<usize> = (0..self.triangles.len()).filter(|&t| keep(t)).collect();
        let (lo, hi) = selected
            .iter()
            .flat_map(|&t| self.triangle(t))
            .fold((DVec3::INFINITY, DVec3::NEG_INFINITY), |(lo, hi), p| (lo.min(p), hi.max(p)));
        if selected.is_empty() {
            return 0.0;
        }
        // lo/2 + hi/2 can't overflow, unlike (lo + hi)/2.
        let o = lo * 0.5 + hi * 0.5;
        selected
            .into_iter()
            .map(|t| {
                let [a, b, c] = short_edge_corner(self.triangle(t));
                (a - o).dot((b - a).cross(c - a))
            })
            .sum::<f64>()
            / 6.0
    }

    pub fn area(&self) -> f64 {
        (0..self.triangles.len()).map(|t| self.triangle_area(t)).sum()
    }

    pub fn triangle_area(&self, t: usize) -> f64 {
        let [a, b, c] = short_edge_corner(self.triangle(t));
        (b - a).cross(c - a).length() / 2.0
    }

    /// Watertight and consistently oriented: every directed edge appears
    /// exactly once and its reverse exactly once.
    pub fn check_closed(&self) -> Result<(), Vec<MeshError>> {
        // Each directed edge as (low, high, runs low→high). Sorting groups
        // the uses of every undirected edge together; a flat sort is much
        // faster than a hash map on meshes with ~10^5 triangles.
        let mut uses: Vec<(u32, u32, bool)> = Vec::with_capacity(self.triangles.len() * 3);
        for t in &self.triangles {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                uses.push((a.min(b), a.max(b), a < b));
            }
        }
        uses.sort_unstable();
        let mut errs = Vec::new();
        for group in uses.chunk_by(|x, y| (x.0, x.1) == (y.0, y.1)) {
            let (lo, hi) = (group[0].0, group[0].1);
            let up = group.iter().filter(|u| u.2).count();
            let down = group.len() - up;
            if up > 1 || down > 1 {
                errs.push(MeshError::FlippedTriangles { a: lo, b: hi });
            } else if up == 0 || down == 0 {
                let (a, b) = if up == 1 { (lo, hi) } else { (hi, lo) };
                errs.push(MeshError::OpenEdge { a, b, uses: group.len() });
            }
        }
        if errs.is_empty() { Ok(()) } else { Err(errs) }
    }
}

/// The same triangle, rotated so its first corner is opposite the longest
/// edge (cyclic rotation keeps the orientation): then (b−a) and (c−a) are
/// the two shorter edges.
fn short_edge_corner([a, b, c]: [DVec3; 3]) -> [DVec3; 3] {
    let (ab, bc, ca) = ((b - a).length_squared(), (c - b).length_squared(), (a - c).length_squared());
    if ab >= bc && ab >= ca {
        [c, a, b]
    } else if bc >= ca {
        [a, b, c]
    } else {
        [b, c, a]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tolerance::eq;

    /// |a − b| ≤ FP_REL·|b| with no absolute floor: `rel_eq` falls back to
    /// LINEAR² near zero, which would hide the error on volumes ~1e-7.
    fn strictly_rel_eq(a: f64, b: f64) -> bool {
        (a - b).abs() <= crate::tolerance::FP_REL * b.abs()
    }

    fn tetra() -> Mesh {
        Mesh {
            positions: vec![DVec3::ZERO, DVec3::X, DVec3::Y, DVec3::Z],
            triangles: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
            triangle_face: vec![0, 1, 2, 3],
            edge_polylines: vec![],
            options: Default::default(),
        }
    }

    #[test]
    fn tetrahedron_volume_and_area() {
        let m = tetra();
        assert!(eq(m.signed_volume(), 1.0 / 6.0));
        assert!(eq(m.area(), 1.5 + 3f64.sqrt() / 2.0));
        assert_eq!(m.check_closed(), Ok(()));
    }

    #[test]
    fn volume_far_from_the_origin() {
        // A tetrahedron is still 1/6 when moved to (1e5, 1e5, 1e5); area
        // 1.5 + √3/2 too. Summing a·(b×c) about the world origin would
        // cancel terms of size ~1e15 down to ~0.17 and lose the digits.
        let mut m = tetra();
        let far = DVec3::splat(1e5);
        m.positions.iter_mut().for_each(|p| *p += far);
        assert!(crate::tolerance::rel_eq(m.signed_volume(), 1.0 / 6.0, crate::tolerance::FP_REL), "{}", m.signed_volume());
        assert!(crate::tolerance::rel_eq(m.area(), 1.5 + 3f64.sqrt() / 2.0, crate::tolerance::FP_REL));

        // Worst case the kernel allows: a MIN_FEATURE (1 µm) tetrahedron at
        // the edge of model space, MAX_COORD = 1e8 mm out on every axis.
        // The stored corners are rounded doubles (spacing 2^-26 ≈ 1.5e-8
        // at 1e8, against edges of 1e-3), so the reference is the volume
        // of the stored points, shifted by the first one: subtracting
        // nearby doubles is exact (Sterbenz).
        use crate::tolerance::{MAX_COORD, MIN_FEATURE};
        let mut tiny = tetra();
        tiny.positions.iter_mut().for_each(|p| *p = *p * MIN_FEATURE + DVec3::splat(MAX_COORD));
        let [a, b, c, d] = [0, 1, 2, 3].map(|i| tiny.positions[i]);
        let expected = (b - a).dot((c - a).cross(d - a)) / 6.0;
        // Sanity: each edge moved by at most one spacing, ~1.5e-5 of its
        // length, so the volume is within ~1e-4 of the ideal 1e-9/6.
        assert!((expected / (MIN_FEATURE.powi(3) / 6.0) - 1.0).abs() < 1e-4, "{expected:e}");
        assert!(strictly_rel_eq(tiny.signed_volume(), expected), "{:e} vs {expected:e}", tiny.signed_volume());
    }

    #[test]
    fn shell_volume_is_measured_from_its_own_centre() {
        // Two shells in one mesh: the unit tetrahedron at the origin and a
        // ~0.01 mm skewed one ~10 km out. Measuring the far shell from a
        // point of the near one makes each term ~1.7e7 × 1e-4 ≈ 1.7e3, and
        // they cancel down to ~1e-7, losing ~10 digits. From the far shell's
        // own bounding-box centre the terms are ~1e-7 and nothing is lost.
        //
        // The far vertices are rounded doubles, so the reference volume is
        // that of the stored points, not of the ideal shape. It comes from
        // the stored points shifted by the first one: subtracting nearby
        // doubles is exact (Sterbenz), so the reference is exact up to the
        // rounding of a single small triple product, (b−a)·((c−a)×(d−a))/6.
        let mut m = tetra();
        let near_tris = m.triangles.len();
        let far = tetra();
        let base = m.positions.len() as u32;
        let offset = DVec3::new(1e7 + 0.123456789, 9.87654321e6, 1.1e7 / 3.0);
        let skew = |p: DVec3| DVec3::new(p.x + 0.3 * p.y, p.y + 0.2 * p.z, p.z + 0.1 * p.x) * 0.0123;
        m.positions.extend(far.positions.iter().map(|&p| skew(p) + offset));
        m.triangles.extend(far.triangles.iter().map(|t| t.map(|i| i + base)));
        let [a, b, c, d] = [0, 1, 2, 3].map(|i| m.positions[base as usize + i]);
        let reference = (b - a).dot((c - a).cross(d - a)).abs() / 6.0;

        let v_far = m.signed_volume_of(|t| t >= near_tris);
        let v_near = m.signed_volume_of(|t| t < near_tris);
        assert!(strictly_rel_eq(v_far, reference), "{v_far:e} vs {reference:e}");
        assert!(crate::tolerance::rel_eq(v_near, 1.0 / 6.0, crate::tolerance::FP_REL), "{v_near}");
    }

    #[test]
    fn short_edge_corner_picks_the_corner_opposite_the_longest_edge() {
        // Triangle p=(0,0,0), q=(10,0,0), r=(0,1,0): the longest edge is
        // q–r (√101), so the corner opposite is p, whichever order the
        // corners arrive in. Each rotation keeps the cyclic order, so the
        // normal (q−p)×(r−p) = (10,0,0)×(0,1,0) = (0,0,10) is unchanged.
        let (p, q, r) = (DVec3::ZERO, DVec3::new(10.0, 0.0, 0.0), DVec3::new(0.0, 1.0, 0.0));
        assert_eq!(short_edge_corner([p, q, r]), [p, q, r]); // longest is b–c
        assert_eq!(short_edge_corner([q, r, p]), [p, q, r]); // longest is a–b
        assert_eq!(short_edge_corner([r, p, q]), [p, q, r]); // longest is c–a
    }

    #[test]
    fn missing_triangle_is_open() {
        // Removing one face of a tetrahedron leaves its 3 edges each used once.
        let mut m = tetra();
        m.triangles.pop();
        let errs = m.check_closed().unwrap_err();
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(errs.iter().all(|e| matches!(e, MeshError::OpenEdge { uses: 1, .. })), "{errs:?}");
    }

    #[test]
    fn flipped_triangle_is_caught() {
        let mut m = tetra();
        m.triangles[2].swap(1, 2); // the slanted face, which doesn't pass through the origin
        // Each of the flipped triangle's 3 edges now runs the same way as its
        // neighbour's: exactly 3 problems, each reported once.
        let errs = m.check_closed().unwrap_err();
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(errs.iter().all(|e| matches!(e, MeshError::FlippedTriangles { .. })), "{errs:?}");
        // The sum now depends on where it is measured from (the mesh isn't
        // closed). Measured from the box centre o = (½,½,½): the slanted
        // triangle a=(1,0,0), b=(0,1,0), c=(0,0,1) has (b−a)×(c−a) =
        // (−1,1,0)×(−1,0,1) = (1,1,1) and (a−o)·(1,1,1) = ½−½−½ = −½, so it
        // contributed −1/12 and the rest 1/6 + 1/12 = 1/4. Flipped, it
        // contributes +1/12: total 1/4 + 1/12 = 1/3.
        assert!(eq(m.signed_volume(), 1.0 / 3.0), "{}", m.signed_volume());
    }
}
