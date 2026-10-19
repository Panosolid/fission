//! STL export (binary), and reading it back for round-trip tests and, later,
//! for meshes people bring in.
//!
//! Binary STL: an 80-byte header, a little-endian u32 triangle count, then
//! 50 bytes per triangle: a normal and three corners as little-endian f32
//! (x, y, z each), and a u16 "attribute byte count", 0. Corners run
//! counter-clockwise seen from outside, so the normal is (b − a) × (c − a)
//! normalised (some programs ignore the stored normal and use the order).
//!
//! The format only holds single precision. A coordinate x is rounded to the
//! nearest f32, an error of up to |x|·2⁻²⁴ (6e-8 of it): 2.4 µm for a part
//! 40 m from the origin. `export` reports the largest rounding and a warning
//! when it exceeds MIN_FEATURE, the smallest size the kernel models.

use crate::mesh::Mesh;
use crate::tolerance::MIN_FEATURE;
use glam::{DVec3, Vec3};

/// Bytes before the first triangle.
pub const HEADER_BYTES: usize = 84;
/// Bytes per triangle.
pub const TRIANGLE_BYTES: usize = 50;
/// Most triangles `read` accepts (a 1 GB file), so a bad count can't make it
/// allocate without bound.
pub const MAX_READ_TRIANGLES: usize = 20_000_000;

#[derive(Debug, Clone, PartialEq)]
pub struct StlExport {
    pub bytes: Vec<u8>,
    /// Largest distance any coordinate moved when rounded to f32 (mm).
    pub rounding: f64,
    /// Set when that rounding is larger than MIN_FEATURE.
    pub warning: Option<String>,
}

/// A mesh read from an STL file: three corners per triangle, as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct StlMesh {
    pub header: [u8; 80],
    pub normals: Vec<Vec3>,
    pub triangles: Vec<[Vec3; 3]>,
}

/// Binary STL of a mesh, with `name` at the start of the header.
pub fn export(mesh: &Mesh, name: &str) -> StlExport {
    let n = mesh.triangles.len();
    let mut bytes = Vec::with_capacity(HEADER_BYTES + TRIANGLE_BYTES * n);
    // A header starting with "solid" makes some readers take the file for
    // ASCII STL, so ours always starts with "Panosolid".
    let mut header = [b' '; 80];
    let text = format!("Panosolid STL: {name}");
    let len = text.len().min(80);
    header[..len].copy_from_slice(&text.as_bytes()[..len]);
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&(n as u32).to_le_bytes());
    let mut rounding = 0.0f64;
    let mut push = |bytes: &mut Vec<u8>, v: DVec3| {
        for x in v.to_array() {
            let f = x as f32;
            rounding = rounding.max((f as f64 - x).abs());
            bytes.extend_from_slice(&f.to_le_bytes());
        }
    };
    for t in 0..n {
        let [a, b, c] = mesh.triangle(t);
        let normal = (b - a).cross(c - a).normalize_or_zero();
        for x in normal.to_array() {
            bytes.extend_from_slice(&(x as f32).to_le_bytes());
        }
        for p in [a, b, c] {
            push(&mut bytes, p);
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    StlExport { bytes, rounding, warning: rounding_warning(rounding) }
}

/// The warning for a given largest rounding, if it is worth one.
pub fn rounding_warning(rounding: f64) -> Option<String> {
    (rounding > MIN_FEATURE).then(|| {
        format!(
            "STL stores single-precision numbers: this part's corners move by up to {rounding:.3e} mm, \
             more than the smallest feature ({MIN_FEATURE} mm). Move it closer to the origin before exporting."
        )
    })
}

/// Reads a binary STL. Refuses files whose length doesn't match their
/// triangle count, and counts past MAX_READ_TRIANGLES.
pub fn read(bytes: &[u8]) -> Result<StlMesh, String> {
    if bytes.len() < HEADER_BYTES {
        return Err(format!("STL file too short: {} bytes, a header alone is {HEADER_BYTES}", bytes.len()));
    }
    let n = u32::from_le_bytes(bytes[80..84].try_into().expect("4 bytes")) as usize;
    if n > MAX_READ_TRIANGLES {
        return Err(format!("STL file claims {n} triangles; at most {MAX_READ_TRIANGLES} are read"));
    }
    let expected = HEADER_BYTES + TRIANGLE_BYTES * n;
    if bytes.len() != expected {
        return Err(format!("STL file is {} bytes but {n} triangles need {expected}", bytes.len()));
    }
    let f = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
    let v = |at: usize| Vec3::new(f(at), f(at + 4), f(at + 8));
    let mut normals = Vec::with_capacity(n);
    let mut triangles = Vec::with_capacity(n);
    for t in 0..n {
        let at = HEADER_BYTES + TRIANGLE_BYTES * t;
        normals.push(v(at));
        triangles.push([v(at + 12), v(at + 24), v(at + 36)]);
    }
    let mut header = [0u8; 80];
    header.copy_from_slice(&bytes[..80]);
    Ok(StlMesh { header, normals, triangles })
}

impl StlMesh {
    /// The triangles as a mesh, with corners at identical f32 positions
    /// merged into one vertex (STL stores every corner separately), so it
    /// can be checked for being closed.
    pub fn welded(&self) -> Mesh {
        let mut index = std::collections::HashMap::new();
        let mut mesh = Mesh::default();
        for tri in &self.triangles {
            let ids = tri.map(|p| {
                let key = p.to_array().map(f32::to_bits);
                *index.entry(key).or_insert_with(|| {
                    mesh.positions.push(p.as_dvec3());
                    (mesh.positions.len() - 1) as u32
                })
            });
            mesh.triangles.push(ids);
            mesh.triangle_face.push(0);
        }
        mesh
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::primitives::{make_box, make_sphere};
    use crate::tessellate::{tessellate, TessOptions};

    #[test]
    fn a_box_by_hand() {
        // A 2 × 3 × 4 box: 6 faces × 2 triangles = 12, so 84 + 12 × 50 =
        // 684 bytes. Every corner coordinate is 0, 2, 3 or 4, all exact in
        // f32, so nothing is rounded.
        let b = make_box(2.0, 3.0, 4.0).unwrap();
        let out = export(&tessellate(&b, &TessOptions::DISPLAY).unwrap(), "box");
        assert_eq!(out.bytes.len(), 684);
        assert_eq!(&out.bytes[..19], b"Panosolid STL: box ");
        assert_eq!(&out.bytes[80..84], &[12, 0, 0, 0]); // u32 12, little-endian
        assert_eq!(out.rounding, 0.0);
        assert_eq!(out.warning, None);
        // Every corner coordinate is one of the box's: 0, 2 (x), 3 (y), 4 (z),
        // and each stored normal is an axis direction (a box face).
        let read = read(&out.bytes).unwrap();
        for (tri, n) in read.triangles.iter().zip(&read.normals) {
            for p in tri {
                assert!([0.0, 2.0].contains(&p.x) && [0.0, 3.0].contains(&p.y) && [0.0, 4.0].contains(&p.z), "{p}");
            }
            assert_eq!(n.abs().max_element(), 1.0);
            assert_eq!(n.abs().min_element(), 0.0);
            // Outward: the normal points away from the box's middle (1, 1.5, 2).
            let centre = (tri[0] + tri[1] + tri[2]) / 3.0;
            assert!((centre - Vec3::new(1.0, 1.5, 2.0)).dot(*n) > 0.0);
            // And the corners run counter-clockwise about it: programs that
            // ignore the stored normal take it from the order.
            assert_eq!((tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize(), *n);
        }
        // 1.0f32 is 0x3F800000: the byte pattern 00 00 80 3F appears only
        // where a stored value is 1 (here, the unit normals).
        let one = 1.0f32.to_le_bytes();
        assert_eq!(one, [0x00, 0x00, 0x80, 0x3F]);
    }

    #[test]
    fn the_round_trip_keeps_every_triangle_and_stays_closed() {
        // A sphere of r = 137.52459832834157: every coordinate is rounded to
        // f32 (|x| ≤ 137.5, so by at most 137.5 · 2⁻²⁴ ≈ 8.2e-6). Reading it
        // back gives the same triangles in the same order, each corner the
        // f32 nearest the kernel's; welding identical corners gives a closed
        // mesh again, and its volume is the mesh's to rounding: each corner
        // moved by ≤ 8.2e-6, so |ΔV| ≤ area × 8.2e-6.
        let r = 137.52459832834157;
        let m = tessellate(&make_sphere(r).unwrap(), &TessOptions::DISPLAY).unwrap();
        let out = export(&m, "ball");
        assert!(out.rounding > 0.0 && out.rounding <= r * (2f64).powi(-24), "{}", out.rounding);
        let back = read(&out.bytes).unwrap();
        assert_eq!(back.triangles.len(), m.triangles.len());
        for (t, tri) in back.triangles.iter().enumerate() {
            for (p, q) in tri.iter().zip(m.triangle(t)) {
                assert_eq!(*p, q.as_vec3());
            }
        }
        let welded = back.welded();
        assert_eq!(welded.positions.len(), m.positions.len());
        welded.check_closed().unwrap();
        let slack = m.area() * r * (2f64).powi(-24);
        assert!((welded.signed_volume() - m.signed_volume()).abs() <= slack);
    }

    #[test]
    fn rounding_warning_boundary() {
        // Warned when the rounding exceeds MIN_FEATURE (1 µm): 0.9 × is
        // quiet, 1.1 × warns.
        assert_eq!(rounding_warning(0.9 * MIN_FEATURE), None);
        assert!(rounding_warning(1.1 * MIN_FEATURE).unwrap().contains("single-precision"));
        // Exactly MIN_FEATURE is not "more than" it.
        assert_eq!(rounding_warning(MIN_FEATURE), None);
        // A coordinate rounds by at most |x| · 2⁻²⁴, so a corner past
        // 2²⁴ × 1e-3 ≈ 16.8 km out can be warned about; one 50 km out is.
        let b = crate::placed::Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        let far = crate::ops::transform::translate(&b, DVec3::new(5e7 + 0.3, 0.0, 0.0)).unwrap();
        let out = export(&far.tessellate(&TessOptions::DISPLAY).unwrap(), "far");
        // 5e7 + 0.3 lies between f32 neighbours 4 apart (ulp at 2^25..2^26),
        // 50000000 and 50000004: it rounds to 50000000, 0.3 away; 5e7 + 1.3
        // rounds to 50000000 too, 1.3 away, the largest.
        assert!((out.rounding - 1.3).abs() < 1e-6, "{}", out.rounding);
        assert!(out.warning.is_some());
    }

    #[test]
    fn bad_files_are_clean_errors() {
        assert!(read(&[0u8; 83]).unwrap_err().contains("too short"));
        // A header claiming 2 triangles with only one present.
        let mut one = vec![0u8; 84 + 50];
        one[80] = 2;
        assert!(read(&one).unwrap_err().contains("need 184"));
        // An absurd count is refused before anything is allocated.
        let mut huge = vec![0u8; 84];
        huge[80..84].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read(&huge).unwrap_err().contains("at most"));
        // Exactly the most is allowed past the count rule (then refused
        // here only because the bytes aren't there).
        huge[80..84].copy_from_slice(&(MAX_READ_TRIANGLES as u32).to_le_bytes());
        assert!(read(&huge).unwrap_err().contains("triangles need"));
        // Zero triangles is a valid (empty) file.
        assert_eq!(read(&[0u8; 84]).unwrap().triangles.len(), 0);
    }
}
