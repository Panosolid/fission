//! Fuzzing the binary STL reader (`stl::read` and `StlMesh::welded`, the
//! path a downloaded or dropped .stl file takes), against a simple model.
//!
//! Each case starts from a real file (the kernel's own export of a random
//! box, cylinder, sphere or extrusion, random triangles, or random bytes)
//! and breaks it in one to four ways: flipped bits, a wrong triangle count
//! (0, one off, the most allowed and one more, u32::MAX), cut short,
//! lengthened, bytes inserted or deleted, corners replaced by NaN, ±inf,
//! subnormals, -0 or huge values, triangles duplicated or collapsed to a
//! point. Then it checks:
//! - nothing panics (reading, welding, the closed check, volume, area);
//! - `read` accepts exactly the files the model accepts (at least a header,
//!   a count of at most MAX_READ_TRIANGLES, and exactly 84 + 50 n bytes),
//!   and refuses the others with the model's reason;
//! - an accepted file gives back the header, normals and corners the model
//!   decodes, bit for bit (NaN included), written independently of `read`;
//! - welding keeps every triangle, merges only corners with identical bits
//!   and loses none: each welded corner is the original one, bit for bit;
//! - an unbroken export of a closed kernel body welds into a closed mesh.
//!
//! Seeded and reproducible: quick mode (part of `cargo test`) runs fixed
//! seeds; `FISSION_FUZZ_SECONDS=<s>` runs rounds until the time is up,
//! starting from `FISSION_SEED` (decimal) or a fresh seed, and with
//! `FISSION_FUZZ_OUT=<dir>` writes `seed-<seed>/fuzz-report.txt` and each
//! failing input, shrunk to a minimal one, for the nightly fuzzing
//! workflow (`.github/workflows/fuzz.yml`). A failing input saved in
//! `tests/regressions/fuzz-stl/` is replayed forever by
//! `saved_fuzz_inputs_still_pass`.
use fission_kernel::ops::extrude::extrude;
use fission_kernel::ops::primitives::{make_box, make_cylinder, make_sphere};
use fission_kernel::ops::profile::{Boundary, Profile};
use fission_kernel::stl::{self, HEADER_BYTES, MAX_READ_TRIANGLES, TRIANGLE_BYTES};
use fission_kernel::tessellate::{tessellate, TessOptions};
use glam::DVec2;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};
use std::time::Instant;

/// SplitMix64: tiny, fast and fully determined by its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

// ---- The model: what a binary STL reader must do, written from the format.

#[derive(Debug, PartialEq)]
enum Refusal {
    TooShort,
    TooMany,
    WrongLength,
}

struct Decoded {
    header: Vec<u8>,
    /// Per triangle: normal then three corners, as raw f32 bits.
    triangles: Vec<[u32; 12]>,
}

fn model(bytes: &[u8]) -> Result<Decoded, Refusal> {
    if bytes.len() < 84 {
        return Err(Refusal::TooShort);
    }
    let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as u64;
    if n > 20_000_000 {
        return Err(Refusal::TooMany);
    }
    if bytes.len() as u64 != 84 + 50 * n {
        return Err(Refusal::WrongLength);
    }
    let triangles = bytes[84..]
        .chunks_exact(50)
        .map(|t| std::array::from_fn(|k| u32::from_le_bytes([t[4 * k], t[4 * k + 1], t[4 * k + 2], t[4 * k + 3]])))
        .collect();
    Ok(Decoded { header: bytes[..80].to_vec(), triangles })
}

fn refusal_of(message: &str) -> Option<Refusal> {
    if message.contains("too short") {
        Some(Refusal::TooShort)
    } else if message.contains("at most") {
        Some(Refusal::TooMany)
    } else if message.contains(" need ") {
        Some(Refusal::WrongLength)
    } else {
        None
    }
}

// ---- Inputs.

/// Real files to start from: exports of closed kernel bodies (marked
/// closed) and of random triangle soups.
fn starting_files(rng: &mut Rng) -> Vec<(Vec<u8>, bool)> {
    let size = |rng: &mut Rng| 10f64.powf(rng.unit() * 4.0 - 1.0); // 0.1 … 1000 mm
    let mut files = Vec::new();
    for kind in 0..4 {
        let body = match kind {
            0 => make_box(size(rng), size(rng), size(rng)),
            1 => make_cylinder(size(rng), size(rng)),
            2 => make_sphere(size(rng)),
            _ => {
                let n = 3 + rng.below(6);
                let r = size(rng);
                let corners = (0..n).map(|i| DVec2::from_angle(std::f64::consts::TAU * i as f64 / n as f64) * r).collect();
                let bulges = (0..n).map(|_| if rng.chance(0.5) { 0.0 } else { rng.unit() * 0.5 }).collect();
                extrude(&Profile { outer: Boundary::Path { corners, bulges }, holes: vec![] }, size(rng))
            }
        };
        let body = body.expect("a valid starting body");
        let mesh = tessellate(&body, &TessOptions::DISPLAY).expect("tessellates");
        files.push((stl::export(&mesh, "fuzz").bytes, true));
    }
    for _ in 0..2 {
        let n = rng.below(40);
        let mut bytes = vec![0u8; 80];
        bytes.extend_from_slice(&(n as u32).to_le_bytes());
        for _ in 0..n {
            for _ in 0..12 {
                bytes.extend_from_slice(&((rng.unit() * 200.0 - 100.0) as f32).to_le_bytes());
            }
            bytes.extend_from_slice(&[0, 0]);
        }
        files.push((bytes, false));
    }
    files
}

const NASTY: [f32; 10] = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -0.0, 0.0, f32::MIN_POSITIVE / 2.0, f32::MAX, f32::MIN, 1e-30, 3.4e38];

fn put_u32(bytes: &mut [u8], at: usize, v: u32) {
    if at + 4 <= bytes.len() {
        bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
}

/// One case: a starting file broken in one to four ways (sometimes none,
/// sometimes plain random bytes). Returns the bytes and whether they are an
/// unbroken export of a closed body.
fn make_case(rng: &mut Rng, files: &[(Vec<u8>, bool)]) -> (Vec<u8>, bool) {
    if rng.chance(0.05) {
        let n = rng.below(300);
        return ((0..n).map(|_| rng.next() as u8).collect(), false);
    }
    let (mut bytes, closed) = files[rng.below(files.len())].clone();
    if rng.chance(0.1) {
        return (bytes, closed);
    }
    for _ in 0..1 + rng.below(4) {
        let n = (bytes.len().saturating_sub(84)) / 50;
        let tri = |rng: &mut Rng| 84 + 50 * rng.below(n);
        match rng.below(10) {
            0 => {
                if !bytes.is_empty() {
                    let at = rng.below(bytes.len());
                    bytes[at] ^= 1 << rng.below(8);
                }
            }
            1 => {
                let counts = [0, n as u32 + 1, (n as u32).wrapping_sub(1), MAX_READ_TRIANGLES as u32, MAX_READ_TRIANGLES as u32 + 1, u32::MAX, rng.next() as u32];
                put_u32(&mut bytes, 80, counts[rng.below(counts.len())]);
            }
            2 => bytes.truncate(rng.below(bytes.len() + 1)),
            3 => {
                let extra = [1, 49, 50, 51, 100][rng.below(5)];
                bytes.extend((0..extra).map(|_| rng.next() as u8));
            }
            4 => {
                let at = rng.below(bytes.len() + 1);
                let len = [1, 4, 50][rng.below(3)];
                bytes.splice(at..at, (0..len).map(|_| rng.next() as u8));
            }
            5 => {
                if !bytes.is_empty() {
                    let at = rng.below(bytes.len());
                    let end = (at + 1 + rng.below(60)).min(bytes.len());
                    bytes.drain(at..end);
                }
            }
            6 if n > 0 => {
                // A corner or normal coordinate becomes a nasty value.
                let at = tri(rng) + 4 * rng.below(12);
                put_u32(&mut bytes, at, NASTY[rng.below(NASTY.len())].to_bits());
            }
            7 if n > 0 => {
                // A triangle collapsed to one point.
                let at = tri(rng);
                if at + 50 <= bytes.len() {
                    let p: Vec<u8> = bytes[at + 12..at + 24].to_vec();
                    bytes[at + 24..at + 36].copy_from_slice(&p);
                    bytes[at + 36..at + 48].copy_from_slice(&p);
                }
            }
            8 if n > 0 => {
                // A triangle duplicated, with the count kept right.
                let at = tri(rng);
                if at + 50 <= bytes.len() {
                    let t: Vec<u8> = bytes[at..at + 50].to_vec();
                    bytes.splice(at..at, t);
                    put_u32(&mut bytes, 80, n as u32 + 1);
                }
            }
            _ => {
                // The header's text (which "solid" can make look like ASCII STL).
                if bytes.len() >= 5 {
                    bytes[..5].copy_from_slice(b"solid");
                }
            }
        }
    }
    (bytes, false)
}

// ---- The checks.

static QUIET: Once = Once::new();
static LAST_PANIC: Mutex<String> = Mutex::new(String::new());

thread_local! {
    static GUARDED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Panics inside a guarded stage are caught and become failures, without
/// the default hook printing each one; any other panic (a test's own
/// assertion) still prints as usual.
fn quiet_panics() {
    QUIET.call_once(|| {
        let default = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if !GUARDED.with(|g| g.get()) {
                return default(info);
            }
            let at = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_default();
            *LAST_PANIC.lock().unwrap_or_else(|e| e.into_inner()) = format!("{msg}{at}");
        }))
    });
}

fn guarded<T>(stage: &str, f: impl FnOnce() -> T) -> Result<T, String> {
    GUARDED.with(|g| g.set(true));
    let result = panic::catch_unwind(AssertUnwindSafe(f));
    GUARDED.with(|g| g.set(false));
    result.map_err(|_| format!("panic in {stage}: {}", LAST_PANIC.lock().unwrap_or_else(|e| e.into_inner())))
}

/// None if the reader behaves; otherwise the kind of failure (what went
/// wrong, without the case's own numbers where they vary) and details.
fn check(bytes: &[u8], closed_export: bool) -> Option<(String, String)> {
    let fail = |kind: &str, detail: String| Some((kind.to_string(), detail));
    let got = match guarded("stl::read", || stl::read(bytes)) {
        Ok(r) => r,
        Err(p) => return fail(&p, String::new()),
    };
    let want = model(bytes);
    let read = match (got, want) {
        (Err(message), Err(why)) => {
            return match refusal_of(&message) {
                Some(r) if r == why => None,
                _ => fail("refused for the wrong reason", format!("model: {why:?}; read: {message}")),
            }
        }
        (Err(message), Ok(_)) => return fail("refused a well-formed file", message),
        (Ok(_), Err(why)) => return fail("accepted a malformed file", format!("model refuses it: {why:?}")),
        (Ok(read), Ok(want)) => {
            if read.header[..] != want.header[..] {
                return fail("header differs from the file", String::new());
            }
            if read.triangles.len() != want.triangles.len() || read.normals.len() != want.triangles.len() {
                return fail("triangle count differs from the file", format!("{} read, {} in the file", read.triangles.len(), want.triangles.len()));
            }
            for (t, w) in want.triangles.iter().enumerate() {
                let n = read.normals[t].to_array().map(f32::to_bits);
                let c = read.triangles[t].map(|p| p.to_array().map(f32::to_bits));
                let got: Vec<u32> = n.iter().chain(c.iter().flatten()).copied().collect();
                if got[..] != w[..] {
                    return fail("a triangle differs from the file", format!("triangle {t}"));
                }
            }
            read
        }
    };
    let welded = match guarded("StlMesh::welded", || read.welded()) {
        Ok(w) => w,
        Err(p) => return fail(&p, String::new()),
    };
    if welded.triangles.len() != read.triangles.len() || welded.triangle_face.len() != read.triangles.len() {
        return fail("welding lost or added triangles", String::new());
    }
    if welded.positions.len() > 3 * read.triangles.len() {
        return fail("welding made more corners than the file has", String::new());
    }
    // Corners are kept as f64, exactly the f32 value (a NaN's payload may
    // be quietened on the way, so two NaN corners can look alike).
    let mut seen = std::collections::HashSet::new();
    for p in welded.positions.iter().filter(|p| !p.is_nan()) {
        if !seen.insert(p.to_array().map(f64::to_bits)) {
            return fail("welding kept two corners with identical bits", String::new());
        }
    }
    for (t, ids) in welded.triangles.iter().enumerate() {
        for (k, &i) in ids.iter().enumerate() {
            let Some(p) = welded.positions.get(i as usize) else {
                return fail("a welded triangle points past the corners", format!("triangle {t}"));
            };
            if p.to_array().map(f64::to_bits) != read.triangles[t][k].as_dvec3().to_array().map(f64::to_bits) {
                return fail("welding moved a corner", format!("triangle {t} corner {k}"));
            }
        }
    }
    let closed = match guarded("Mesh::check_closed", || welded.check_closed()) {
        Ok(c) => c,
        Err(p) => return fail(&p, String::new()),
    };
    if let Err(p) = guarded("Mesh::signed_volume and area", || (welded.signed_volume(), welded.area())) {
        return fail(&p, String::new());
    }
    if closed_export && closed.is_err() {
        return fail("an unbroken export of a closed body is not closed after reading", String::new());
    }
    None
}

/// Most re-checks one shrink may spend (a check reads and welds the whole
/// input, so shrinking a 100 kB file byte by byte would take hours).
const SHRINK_TRIES: usize = 3000;

/// A small input (by deleting runs of bytes, then zeroing them) that still
/// fails the same way: the smallest one found within SHRINK_TRIES checks.
fn shrink(mut bytes: Vec<u8>, closed: bool, kind: &str) -> Vec<u8> {
    let tries = std::cell::Cell::new(0);
    let same = |b: &[u8]| {
        tries.set(tries.get() + 1);
        tries.get() <= SHRINK_TRIES && check(b, closed).is_some_and(|(k, _)| k == kind)
    };
    // A well-formed file shrinks by whole triangles, with the count kept
    // right (deleting loose bytes would only make it the wrong length).
    let mut drop = (bytes.len().saturating_sub(84) / 50).next_power_of_two();
    while drop >= 1 && model(&bytes).is_ok() && tries.get() < SHRINK_TRIES {
        let mut t = 0;
        while 84 + 50 * t < bytes.len() && tries.get() < SHRINK_TRIES {
            let n = (bytes.len() - 84) / 50;
            let k = drop.min(n - t);
            let mut fewer = bytes.clone();
            fewer.drain(84 + 50 * t..84 + 50 * (t + k));
            put_u32(&mut fewer, 80, (n - k) as u32);
            if same(&fewer) {
                bytes = fewer;
            } else {
                t += k;
            }
        }
        drop /= 2;
    }
    let mut chunk = bytes.len().next_power_of_two();
    while chunk >= 1 && tries.get() < SHRINK_TRIES {
        let mut at = 0;
        while at < bytes.len() && tries.get() < SHRINK_TRIES {
            let mut fewer = bytes.clone();
            fewer.drain(at..(at + chunk).min(bytes.len()));
            if same(&fewer) {
                bytes = fewer;
            } else {
                at += chunk;
            }
        }
        chunk /= 2;
    }
    for at in 0..bytes.len() {
        if tries.get() >= SHRINK_TRIES {
            break;
        }
        if bytes[at] != 0 {
            let mut zeroed = bytes.clone();
            zeroed[at] = 0;
            if same(&zeroed) {
                bytes = zeroed;
            }
        }
    }
    bytes
}

struct Failure {
    case: usize,
    kind: String,
    detail: String,
    input: Vec<u8>,
}

/// One round: `cases` inputs from `seed`. Returns the failures (shrunk) and
/// how many inputs `read` accepted, refused for each reason, and how many
/// were unbroken closed exports.
fn round(seed: u64, cases: usize) -> (Vec<Failure>, [usize; 5]) {
    quiet_panics();
    let mut rng = Rng(seed);
    let files = starting_files(&mut rng);
    let mut failures: Vec<Failure> = Vec::new();
    let mut counts = [0; 5];
    for case in 0..cases {
        let (bytes, closed) = make_case(&mut rng, &files);
        match model(&bytes) {
            Ok(_) => counts[0] += 1,
            Err(Refusal::TooShort) => counts[1] += 1,
            Err(Refusal::TooMany) => counts[2] += 1,
            Err(Refusal::WrongLength) => counts[3] += 1,
        }
        counts[4] += closed as usize;
        if let Some((kind, detail)) = check(&bytes, closed) {
            // One shrunk example per kind is plenty.
            if !failures.iter().any(|f| f.kind == kind) {
                let input = shrink(bytes, closed, &kind);
                failures.push(Failure { case, kind, detail, input });
            }
        }
    }
    (failures, counts)
}

fn report(seed: u64, cases: usize, failures: &[Failure]) -> String {
    let mut s = format!("STL reader fuzzing, seed {seed}, {cases} inputs: {} kind(s) of failure\n", failures.len());
    for f in failures {
        s += &format!("failure: {} | case {} {}| shrunk input: input-{}.stl ({} bytes)\n", f.kind, f.case, if f.detail.is_empty() { String::new() } else { format!("({}) ", f.detail) }, f.case, f.input.len());
    }
    s
}

fn regressions() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/regressions/fuzz-stl")
}

#[test]
fn fuzz_stl_random() {
    let env_seed = std::env::var("FISSION_SEED").ok().map(|s| s.trim().parse::<u64>().expect("FISSION_SEED is a decimal u64"));
    let seconds: Option<f64> = std::env::var("FISSION_FUZZ_SECONDS").ok().map(|s| s.parse().expect("FISSION_FUZZ_SECONDS is a number"));
    let out = std::env::var("FISSION_FUZZ_OUT").ok().map(PathBuf::from);
    let Some(seconds) = seconds else {
        // Quick mode: fixed seeds, part of every `cargo test`.
        let seeds = env_seed.map(|s| vec![s]).unwrap_or(vec![0x5eed, 1, 2]);
        for seed in seeds {
            let (failures, counts) = round(seed, 1500);
            println!("seed {seed}: accepted {}, too short {}, too many {}, wrong length {}, unbroken closed {}", counts[0], counts[1], counts[2], counts[3], counts[4]);
            // Every branch of the model is reached, or the fuzzer is blind.
            assert!(counts.iter().all(|&c| c > 0), "seed {seed}: some kind of input never came up: {counts:?}");
            assert!(failures.is_empty(), "{}", report(seed, 1500, &failures));
        }
        return;
    };
    // Long mode: rounds of 2,000 inputs until the time is up, a new seed each.
    let start = Instant::now();
    let mut seed = env_seed.unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64);
    let mut found = 0;
    while start.elapsed().as_secs_f64() < seconds {
        let t = Instant::now();
        let (failures, _) = round(seed, 2000);
        let text = report(seed, 2000, &failures);
        println!("{}", text.trim_end());
        if let Some(out) = &out {
            std::fs::create_dir_all(out).unwrap();
            let log = out.join("log.csv");
            if !log.exists() {
                std::fs::write(&log, "target,seed,cases,failures,seconds\n").unwrap();
            }
            let line = format!("stl,{seed},2000,{},{:.1}\n", failures.len(), t.elapsed().as_secs_f64());
            std::fs::OpenOptions::new().append(true).open(&log).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes())).unwrap();
            if !failures.is_empty() {
                let dir = out.join(format!("seed-{seed}"));
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("fuzz-report.txt"), &text).unwrap();
                for f in &failures {
                    std::fs::write(dir.join(format!("input-{}.stl", f.case)), &f.input).unwrap();
                }
            }
        }
        found += failures.len();
        seed = Rng(seed).next();
    }
    assert_eq!(found, 0, "fuzzing found {found} failure(s); see the reports above");
}

#[test]
fn saved_fuzz_inputs_still_pass() {
    quiet_panics();
    let Ok(dir) = std::fs::read_dir(regressions()) else { return };
    for entry in dir {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "stl") {
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(check(&bytes, false), None, "{}", path.display());
        }
    }
}

// ---- The fuzzer's own tests: the model by hand, and that it can fail.

#[test]
fn the_model_by_hand() {
    // 83 bytes: one short of a header → too short. 84 zero bytes: zero
    // triangles, 84 + 50·0 = 84 → accepted, empty. A count of 1 needs
    // 84 + 50 = 134 bytes: 133 and 135 are the wrong length.
    assert_eq!(model(&[0; 83]).err(), Some(Refusal::TooShort));
    assert_eq!(model(&[0; 84]).unwrap().triangles.len(), 0);
    let one = |len: usize| {
        let mut b = vec![0u8; len];
        b[80] = 1;
        b
    };
    assert_eq!(model(&one(133)).err(), Some(Refusal::WrongLength));
    assert_eq!(model(&one(135)).err(), Some(Refusal::WrongLength));
    // 134 bytes with the first corner's x = 1.0f32 (bits 0x3F800000) at
    // byte 84 + 12 (after the normal's three floats).
    let mut b = one(134);
    b[96..100].copy_from_slice(&1.0f32.to_le_bytes());
    let d = model(&b).unwrap();
    assert_eq!(d.triangles[0][3], 0x3F80_0000);
    // 20,000,000 triangles is the most (a 1 GB file); 20,000,001 is refused
    // before the length is looked at.
    let mut big = vec![0u8; 84];
    big[80..84].copy_from_slice(&20_000_000u32.to_le_bytes());
    assert_eq!(model(&big).err(), Some(Refusal::WrongLength));
    big[80..84].copy_from_slice(&20_000_001u32.to_le_bytes());
    assert_eq!(model(&big).err(), Some(Refusal::TooMany));
    // The model's constants are the reader's, written out again by hand.
    assert_eq!((HEADER_BYTES, TRIANGLE_BYTES, MAX_READ_TRIANGLES), (84, 50, 20_000_000));
}

#[test]
fn the_checks_can_fail() {
    quiet_panics();
    // A file `read` accepts, checked as a closed export when it is not one
    // (a lone triangle has three open edges): the closed check must notice.
    let mut b = vec![0u8; 134];
    b[80] = 1;
    for (k, v) in [1.0f32, 0.0, 0.0, 0.0, 1.0, 0.0].iter().enumerate() {
        b[96 + 12 + 4 * k..100 + 12 + 4 * k].copy_from_slice(&v.to_le_bytes());
    }
    assert_eq!(check(&b, false), None);
    assert_eq!(check(&b, true).unwrap().0, "an unbroken export of a closed body is not closed after reading");
    // A panicking stage is caught and named, not fatal.
    let caught = guarded("a stage", || panic!("boom")).unwrap_err();
    assert!(caught.starts_with("panic in a stage: boom at "), "{caught}");
    // Shrinking keeps the failure and gets small: the 134-byte file above
    // still fails as a closed export after shrinking, and is no longer.
    let small = shrink(b.clone(), true, "an unbroken export of a closed body is not closed after reading");
    assert!(small.len() <= 134);
    assert!(check(&small, true).is_some());
}
