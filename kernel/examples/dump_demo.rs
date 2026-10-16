//! Writes two failure dumps for the browser check of the dump viewer
//! (`apps/fission/e2e/dump-viewer.mjs`): `<dir>/broken/`, a 20 × 30 × 40 box
//! with one corner lifted off its edges, and `<dir>/valid/`, the same box
//! untouched.
//!
//! Run: `cargo run --example dump_demo -- <dir>`

use fission_kernel::debug_dump::dump;
use fission_kernel::ops::primitives::make_box;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: dump_demo <dir>");
    let dir = std::path::Path::new(&dir);
    let good = make_box(20.0, 30.0, 40.0).expect("a 20 × 30 × 40 box");
    let mut broken = good.clone();
    // The corner furthest from the origin, lifted 10 mm.
    let far = (0..broken.vertices.len())
        .max_by(|&a, &b| {
            broken.vertices[a]
                .point
                .length()
                .total_cmp(&broken.vertices[b].point.length())
        })
        .expect("a box has vertices");
    broken.vertices[far].point.z += 10.0;
    dump(dir, "broken", &[("box", &broken)], "corner lifted 10 mm").expect("write broken dump");
    dump(dir, "valid", &[("box", &good)], "nothing wrong").expect("write valid dump");
}
