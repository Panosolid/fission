//! The exact answer the kernel gives for one saved fuzz input, as one line
//! of text: every number written as its bit pattern (or Rust's shortest
//! round-trip form), meshes and inputs as hashes of their bits, refusals
//! as their messages. `same-answer/` prints these lines from a native
//! build and from the browser's WebAssembly build; any difference between
//! the two lists means a part could come out differently on the website
//! than on a computer.
use super::checks;
use fission_kernel::mesh::Mesh;
use fission_kernel::ops::extrude::{self as extruding, Profile};
use fission_kernel::sketch::{self as sketching, SketchOutline};
use fission_kernel::tessellate::{tessellate, TessOptions};
use fission_kernel::topology::Body;
use fission_kernel::validate::validate;
use fission_kernel::{mass, stl, view_body};
use std::fmt::Write;

/// FNV-1a, 64 bit: any change to any byte changes the hash (in practice).
pub fn hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Debug prints every f64 in its shortest round-trip form, so two values
/// print alike only when their bits are equal (NaN payloads aside).
fn hash_debug(x: &impl std::fmt::Debug) -> u64 {
    hash(format!("{x:?}").as_bytes())
}

fn bits(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

fn one_line(s: impl std::fmt::Display) -> String {
    s.to_string().replace(['\n', '\t'], " ")
}

fn mesh_hash(mesh: &Mesh) -> u64 {
    let mut bytes = Vec::with_capacity(mesh.positions.len() * 24 + mesh.triangles.len() * 16);
    for p in &mesh.positions {
        for c in p.to_array() {
            bytes.extend(c.to_bits().to_le_bytes());
        }
    }
    for (t, f) in mesh.triangles.iter().zip(&mesh.triangle_face) {
        for i in t {
            bytes.extend(i.to_le_bytes());
        }
        bytes.extend((*f as u64).to_le_bytes());
    }
    hash(&bytes)
}

/// Everything the app shows or exports for a body: exact volume and area,
/// counts, validation, the display mesh and the STL file.
fn body(out: &mut String, body: &Body) {
    let Ok(view) = view_body(body) else {
        out.push_str(" view=failed");
        return;
    };
    let d = &view.mesh;
    let floats: Vec<u8> = [&d.positions, &d.normals, &d.edge_lines].iter().flat_map(|v| v.iter().flat_map(|x| x.to_bits().to_le_bytes())).collect();
    let ints: Vec<u8> = [&d.indices, &d.triangle_faces, &d.edge_line_edges].iter().flat_map(|v| v.iter().flat_map(|x| x.to_le_bytes())).collect();
    // The planted break `check.sh` proves the check with: one bit of the
    // volume, in one build only.
    #[cfg(same_answer_break)]
    let view = fission_kernel::BodyView { volume: f64::from_bits(view.volume.to_bits() ^ 1), ..view };
    let _ = write!(
        out,
        " volume={} area={} v/e/f={}/{}/{} errors={:016x} display={:016x}/{:016x}",
        bits(view.volume),
        bits(view.area),
        view.vertices,
        view.edges,
        view.faces,
        hash_debug(&view.errors),
        hash(&floats),
        hash(&ints)
    );
    match tessellate(body, &TessOptions::DISPLAY) {
        Ok(mesh) => {
            let _ = write!(out, " mesh={}:{:016x} stl={:016x}", mesh.triangles.len(), mesh_hash(&mesh), hash(&stl::export(&mesh, "fuzz").bytes));
        }
        Err(e) => {
            let _ = write!(out, " mesh=failed:{}", one_line(e.message));
        }
    }
}

fn extruded(out: &mut String, profile: &Profile, d: f64) {
    match extruding::extrude(profile, d) {
        Ok(b) => body(out, &b),
        Err(e) => {
            let _ = write!(out, " refused: {}", one_line(e));
        }
    }
}

/// The answer line for one input of the extrude, sketch or placed fuzzer.
pub fn answer(target: &str, data: &[u8]) -> String {
    let mut out = String::new();
    match target {
        "extrude" => {
            let (profile, d, _) = checks::extrude_input(data);
            let _ = write!(out, "input={:016x}", hash_debug(&(&profile, d)));
            extruded(&mut out, &profile, d);
        }
        "sketch" => {
            let input = checks::sketch_input(data);
            let _ = write!(out, "input={:016x}", hash_debug(&input));
            match sketching::sketch_outline(&input.0, &input.1, &input.2) {
                Ok(SketchOutline::Closed(profile)) => {
                    let _ = write!(out, " closed={:016x}", hash_debug(&profile));
                    extruded(&mut out, &profile, 1.0);
                }
                Ok(SketchOutline::Open(why)) => {
                    let _ = write!(out, " open: {}", one_line(why));
                }
                Err(e) => {
                    let _ = write!(out, " refused: {}", one_line(e));
                }
            }
        }
        "placed" => {
            let (made, moves) = checks::placed_input(data);
            let _ = write!(out, "input={:016x}", hash_debug(&moves));
            match made {
                Err(e) => {
                    let _ = write!(out, " refused: {}", one_line(e));
                }
                Ok(b) => {
                    let (p, refused) = checks::moved(b, &moves);
                    let (lo, hi) = p.bounds();
                    let _ = write!(out, " refused={:016x} bounds={:016x}", hash_debug(&refused), hash_debug(&(lo, hi)));
                    match p.tessellate(&TessOptions::DISPLAY) {
                        Ok(mesh) => {
                            let _ = write!(out, " mesh={}:{:016x}", mesh.triangles.len(), mesh_hash(&mesh));
                        }
                        Err(e) => {
                            let _ = write!(out, " mesh=failed:{}", one_line(e.message));
                        }
                    }
                    let baked = p.baked();
                    let m = mass::mass_properties(&baked);
                    let _ = write!(out, " baked volume={} area={} valid={}", bits(m.volume), bits(m.area), validate(&baked).is_ok());
                }
            }
        }
        _ => out.push_str("unknown target"),
    }
    out
}
