//! Replays the coverage-guided fuzzers' saved inputs on stable Rust, in
//! every `cargo test`: each input in `fuzz/seeds/<target>.seeds` (the
//! minimised corpus, packed by `fuzz/seeds.py`: inputs that between them
//! reach every piece of kernel code the fuzzer found) and each file in
//! `tests/regressions/libfuzzer/<target>/` (every failing input the fuzzer
//! found, kept forever) goes through the same check `cargo fuzz run` uses
//! (`fuzz/checks.rs`). A failing check panics naming the input.
#[path = "../fuzz/checks.rs"]
mod checks;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

/// Every saved input for `target`, through `check`; returns how many ran.
fn replay(target: &str, check: fn(&[u8])) -> usize {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut inputs: Vec<(String, Vec<u8>)> = vec![];
    let packed = std::fs::read(root.join("fuzz/seeds").join(format!("{target}.seeds"))).unwrap_or_default();
    let mut at = 0;
    while at < packed.len() {
        let size = u32::from_le_bytes(packed[at..at + 4].try_into().unwrap()) as usize;
        inputs.push((format!("seed {} of {target}.seeds", inputs.len()), packed[at + 4..at + 4 + size].to_vec()));
        at += 4 + size;
    }
    if let Ok(entries) = std::fs::read_dir(root.join("tests/regressions/libfuzzer").join(target)) {
        let mut files: Vec<_> = entries.map(|e| e.unwrap().path()).filter(|p| p.is_file()).collect();
        files.sort();
        inputs.extend(files.iter().map(|f| (f.display().to_string(), std::fs::read(f).unwrap())));
    }
    let mut failed = vec![];
    for (name, data) in &inputs {
        if let Err(e) = catch_unwind(AssertUnwindSafe(|| check(data))) {
            let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            failed.push(format!("{name}: {}", msg.lines().take(3).collect::<Vec<_>>().join(" / ")));
        }
    }
    assert!(failed.is_empty(), "{} of {} saved {target} inputs fail:\n{}", failed.len(), inputs.len(), failed.join("\n"));
    inputs.len()
}

#[test]
fn extrude_inputs_still_pass() {
    // The seeds are what makes this test worth having: without them it
    // would pass by checking nothing.
    assert!(replay("extrude", checks::extrude) > 100);
}

#[test]
fn sketch_inputs_still_pass() {
    assert!(replay("sketch", checks::sketch) > 100);
}

#[test]
fn placed_inputs_still_pass() {
    assert!(replay("placed", checks::placed) > 100);
}

/// The checks must be able to fail: a body whose volume is off, or a
/// closed sketch that doesn't extrude, has to be caught. These run the
/// checks' own measuring on hand-made inputs with known answers.
#[test]
fn the_reference_area_is_right_by_hand() {
    use fission_kernel::ops::extrude::Boundary;
    use glam::DVec2;
    // A 2 × 1 rectangle whose top edge bulges into a half circle of
    // radius 1 (bulge 1 on the piece from (2, 1) to (0, 1)): 2 + π/2.
    // Perimeter: 2 + 1 + 1 straight, plus the half circle π.
    let b = Boundary::Path {
        corners: vec![DVec2::new(0.0, 0.0), DVec2::new(2.0, 0.0), DVec2::new(2.0, 1.0), DVec2::new(0.0, 1.0)],
        bulges: vec![0.0, 0.0, 1.0, 0.0],
    };
    let (area, _, perimeter) = checks::measure(&b);
    assert!((area - (2.0 + std::f64::consts::FRAC_PI_2)).abs() < 1e-12, "{area}");
    assert!((perimeter - (4.0 + std::f64::consts::PI)).abs() < 1e-12, "{perimeter}");
    // A circle of radius 3: area 9π, perimeter 6π.
    let (area, _, perimeter) = checks::measure(&Boundary::Circle { center: DVec2::new(5.0, 5.0), radius: 3.0 });
    assert!((area - 9.0 * std::f64::consts::PI).abs() < 1e-12 && (perimeter - 6.0 * std::f64::consts::PI).abs() < 1e-12);
}
