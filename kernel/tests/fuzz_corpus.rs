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

/// Every saved input for `target`: the packed seeds, then each saved crash.
fn saved_inputs(target: &str) -> Vec<(String, Vec<u8>)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut inputs: Vec<(String, Vec<u8>)> = vec![];
    let packed = std::fs::read(root.join("fuzz/seeds").join(format!("{target}.seeds"))).unwrap_or_default();
    let mut at = 0;
    while at < packed.len() {
        let size = u32::from_le_bytes(packed[at..at + 4].try_into().unwrap()) as usize;
        inputs.push((format!("seed {} of {target}.seeds", inputs.len()), packed[at + 4..at + 4 + size].to_vec()));
        at += 4 + size;
    }
    inputs.extend(files_in(&root.join("tests/regressions/libfuzzer").join(target)));
    inputs
}

/// Each file in `dir`, sorted by name, or none when there is no `dir`.
fn files_in(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut files: Vec<_> = entries.map(|e| e.unwrap().path()).filter(|p| p.is_file()).collect();
    files.sort();
    files.iter().map(|f| (f.display().to_string(), std::fs::read(f).unwrap())).collect()
}

/// Every saved input for `target`, through `check`; returns how many ran.
fn replay(target: &str, check: fn(&[u8])) -> usize {
    let inputs = saved_inputs(target);
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

// The OpenCascade oracle for the fuzzers' bodies (nasty inputs 2b): every
// body a saved input builds, written as one JSON line for
// prototypes/oracle/fuzz_shapes.py, which rebuilds it in OpenCascade and
// works out its exact volume and area (exact.py, 50 digits) to compare.
//
//   FISSION_ORACLE_OUT=cases.jsonl cargo test --test fuzz_corpus oracle
//
// FISSION_ORACLE_CORPUS=<dir> adds every file in <dir>/<target>/ (a
// fuzzing run's corpus, fuzz/corpus/ after `fuzz/run.sh`),
// FISSION_ORACLE_TARGET=<target> keeps to that one fuzzer,
// FISSION_ORACLE_RANDOM=<n> adds n random inputs per fuzzer from
// FISSION_SEED (decimal; the same seed gives the same inputs), and
// FISSION_ORACLE_BREAK=1 plants a bug: every volume written is 1e-6 too big,
// which the comparison must report for every body (its self-test).

use fission_kernel::ops::extrude::{self as extruding, Boundary, Profile};
use serde_json::{json, Value};

/// A number as compare.py's shapes write it: Rust's shortest round-trip
/// form, so Python reads back the very double the kernel was given.
fn num(x: f64) -> Value {
    Value::String(format!("{x:?}"))
}

fn ring(b: &Boundary) -> Value {
    match b {
        Boundary::Circle { center, radius } => json!({ "Circle": { "c": [num(center.x), num(center.y)], "r": num(*radius) } }),
        Boundary::Path { corners, bulges } => json!({ "Path": {
            "pts": corners.iter().map(|p| json!([num(p.x), num(p.y)])).collect::<Vec<_>>(),
            "bulges": bulges.iter().map(|&b| num(b)).collect::<Vec<_>>(),
        } }),
    }
}

/// An extrude in compare.py's shape format.
fn extrude_shape(profile: &Profile, d: f64) -> Value {
    json!({ "Extrude": { "outer": ring(&profile.outer), "holes": profile.holes.iter().map(ring).collect::<Vec<_>>(), "dist": num(d) } })
}

fn primitive_shape(p: checks::Primitive) -> Value {
    match p {
        checks::Primitive::Box(w, d, h) => json!({ "Box": { "w": num(w), "d": num(d), "h": num(h) } }),
        checks::Primitive::Cylinder(r, h) => json!({ "Cylinder": { "r": num(r), "h": num(h) } }),
        checks::Primitive::Sphere(r) => json!({ "Sphere": { "r": num(r) } }),
    }
}

/// One oracle line: the shape as given, and the kernel's exact volume and
/// area, face count and bounds for the body it built.
fn case(target: &str, input: &str, shape: Value, body: &fission_kernel::topology::Body) -> Value {
    let m = fission_kernel::mass::mass_properties(body);
    let (lo, hi) = body.bounds();
    let volume = if std::env::var_os("FISSION_ORACLE_BREAK").is_some() { m.volume * (1.0 + 1e-6) } else { m.volume };
    json!({
        "target": target, "input": input, "shape": shape,
        "fission_volume": volume, "fission_area": m.area, "fission_faces": body.faces.len(),
        "lo": lo.to_array(), "hi": hi.to_array(),
    })
}

/// The bodies one input builds (none when the kernel refuses it).
fn oracle_case(target: &str, name: &str, data: &[u8]) -> Option<Value> {
    match target {
        "extrude" => {
            let (profile, d, _) = checks::extrude_input(data);
            let body = extruding::extrude(&profile, d).ok()?;
            Some(case(target, name, extrude_shape(&profile, d), &body))
        }
        "sketch" => {
            let (lines, circles, arcs) = checks::sketch_input(data);
            let fission_kernel::sketch::SketchOutline::Closed(profile, _) = fission_kernel::sketch::sketch_outline(&lines, &circles, &arcs).ok()? else { return None };
            let body = extruding::extrude(&profile, 1.0).ok()?;
            Some(case(target, name, extrude_shape(&profile, 1.0), &body))
        }
        _ => {
            // Moved and turned: the baked body is where placement rounding
            // shows; volume and area must not change, bounds are not compared.
            let (shape, moves) = checks::placed_shape(data);
            let body = shape.make().ok()?;
            let baked = checks::moved(body, &moves).0.baked();
            Some(case(target, name, primitive_shape(shape), &baked))
        }
    }
}

/// FISSION_ORACLE_RANDOM inputs for `target`, each 8 to 300 bytes from a
/// splitmix64 stream seeded by FISSION_SEED and the target's name, named
/// by seed and number so a disagreement replays.
fn random_inputs(target: &str) -> Vec<(String, Vec<u8>)> {
    let n: usize = std::env::var("FISSION_ORACLE_RANDOM").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let seed: u64 = std::env::var("FISSION_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x5EED);
    let mut state = seed ^ checks_hash(target.as_bytes());
    let mut next = move || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    (0..n).map(|i| {
        let len = 8 + (next() % 293) as usize;
        (format!("random {i} of seed {seed}"), (0..len).map(|_| next() as u8).collect())
    }).collect()
}

/// FNV-1a, as `fuzz/answers.rs` hashes.
fn checks_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

#[test]
fn oracle_shapes_by_hand() {
    use glam::DVec2;
    // A 2 × 3 rectangle with a half-circle bulge (bulge 1) on its top,
    // 0.1 written as Rust and Python both print it.
    let profile = Profile {
        outer: Boundary::Path { corners: vec![DVec2::new(0.0, 0.0), DVec2::new(2.0, 0.0), DVec2::new(2.0, 3.0), DVec2::new(0.0, 3.0)], bulges: vec![0.0, 0.0, 1.0, 0.0] },
        holes: vec![Boundary::Circle { center: DVec2::new(1.0, 1.0), radius: 0.1 }],
    };
    let got = extrude_shape(&profile, 1e-3).to_string();
    let want = r#"{"Extrude":{"dist":"0.001","holes":[{"Circle":{"c":["1.0","1.0"],"r":"0.1"}}],"outer":{"Path":{"bulges":["0.0","0.0","1.0","0.0"],"pts":[["0.0","0.0"],["2.0","0.0"],["2.0","3.0"],["0.0","3.0"]]}}}}"#;
    assert_eq!(got, want);
    // Shortest round trip, never rounded: 0.1 + 0.2 keeps its last digit.
    assert_eq!(num(0.1 + 0.2), json!("0.30000000000000004"));
    assert_eq!(primitive_shape(checks::Primitive::Cylinder(2.5, 1e-5)).to_string(), r#"{"Cylinder":{"h":"1e-5","r":"2.5"}}"#);
}

#[test]
fn oracle_cases() {
    let extra = std::env::var_os("FISSION_ORACLE_CORPUS").map(std::path::PathBuf::from);
    let only = std::env::var("FISSION_ORACLE_TARGET").ok();
    let mut lines = String::new();
    for target in ["extrude", "sketch", "placed"].into_iter().filter(|t| only.as_deref().is_none_or(|o| o == *t)) {
        let mut inputs = saved_inputs(target);
        if let Some(dir) = &extra {
            inputs.extend(files_in(&dir.join(target)));
        }
        inputs.extend(random_inputs(target));
        let mut built = 0;
        for (name, data) in &inputs {
            // A panic is the replay tests' to report; here it just has no body.
            if let Ok(Some(c)) = catch_unwind(AssertUnwindSafe(|| oracle_case(target, name, data))) {
                lines += &format!("{c}\n");
                built += 1;
            }
        }
        // Without bodies to compare the nightly comparison would pass by
        // checking nothing: the seeds must build plenty of each kind.
        assert!(built > 50, "{target}: only {built} of {} saved inputs built a body", inputs.len());
    }
    if let Some(out) = std::env::var_os("FISSION_ORACLE_OUT") {
        std::fs::write(out, lines).unwrap();
    }
}
