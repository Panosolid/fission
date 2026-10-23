//! The nasty-case generator for booleans (step 30c, tests/support/boolean_cases.rs):
//! checks of the cases themselves, and the lines for the judge
//! (prototypes/boolean/judge.py). Environment:
//! - FISSION_BOOLEAN_CASES_OUT  write the lines here (CI's kernel job judges them)
//! - FISSION_SEED               base seed (default boolean_cases::SEED, decimal)
//! - FISSION_BOOLEAN_SEEDS      how many seeds from it (default 1)
#[path = "support/boolean_cases.rs"]
mod boolean_cases;

use boolean_cases::{lines, matrix, offsets, pairs, Pair, Solid, FAMILIES, KINDS, OPS, PLACES, SAME, SEED};
use fission_kernel::tolerance::{LINEAR, MAX_COORD, MIN_FEATURE};
use std::collections::BTreeSet;

fn env_num(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[test]
fn lines_for_the_judge() {
    let base = env_num("FISSION_SEED", SEED);
    let mut out = String::new();
    for seed in base..base + env_num("FISSION_BOOLEAN_SEEDS", 1) {
        let text = lines(seed);
        assert_eq!(text.lines().count(), 3 * pairs(seed).len());
        out += &text;
    }
    if let Some(path) = std::env::var_os("FISSION_BOOLEAN_CASES_OUT") {
        std::fs::write(path, out).unwrap();
    }
}

#[test]
fn every_family_at_every_place_with_every_op() {
    let ps = pairs(SEED);
    let have: BTreeSet<(&str, &str, &str)> = ps.iter().map(|p| (p.kind, p.family, p.place)).collect();
    for place in PLACES {
        for kind in KINDS {
            for family in FAMILIES {
                assert!(have.contains(&(kind, family, place)), "{kind} {family} at {place}");
            }
        }
        assert!(have.contains(&("prisms", "corner on corner", place)), "corner on corner at {place}");
    }
    // Each offset in both arrangements, for both kinds.
    let offs: BTreeSet<(&str, &str, &str)> = ps.iter().filter_map(|p| p.offset.map(|o| (p.kind, p.family, o.0))).collect();
    for kind in KINDS {
        for (name, _) in offsets() {
            for arrangement in ["stacked offset", "coplanar offset"] {
                assert!(offs.contains(&(kind, arrangement, name)), "{kind} {arrangement} {name}");
            }
        }
    }
    // One line per op, with the op named.
    let text = lines(SEED);
    for op in OPS {
        assert_eq!(text.matches(&format!("\"op\":\"{op}\"")).count(), ps.len(), "{op}");
    }
}

#[test]
fn the_same_seed_gives_the_same_lines_and_another_does_not() {
    assert_eq!(lines(SEED), lines(SEED));
    assert_ne!(lines(SEED), lines(SEED + 1));
}

/// Every number in a line (a string) reads back as the double it came
/// from, so the judge sees exactly what the kernel is given.
#[test]
fn every_number_reads_back_to_the_same_bits() {
    fn walk(v: &serde_json::Value, seen: &mut usize) {
        match v {
            serde_json::Value::String(s) => {
                if let Ok(x) = s.parse::<f64>() {
                    assert_eq!(format!("{x:?}"), *s, "{s} doesn't read back");
                    *seen += 1;
                }
            }
            serde_json::Value::Array(xs) => xs.iter().for_each(|x| walk(x, seen)),
            serde_json::Value::Object(m) => m.values().for_each(|x| walk(x, seen)),
            _ => {}
        }
    }
    let mut seen = 0;
    for line in lines(SEED).lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        walk(&v["a"], &mut seen);
        walk(&v["b"], &mut seen);
    }
    assert!(seen > 10_000, "{seen}");
    // Hand-worked: 0.9 × 2·LINEAR = 1.8e-5 is no double; the line carries
    // the nearest, which Rust prints as 1.8e-5 and Python's float() reads
    // back to the same bits.
    assert_eq!(boolean_cases::num(0.9 * SAME), "1.8e-5");
    assert_eq!(boolean_cases::num(1e8 - 100.0), "99999900.0");
}

/// The gap an offset pair puts between A and B, worked out in its own frame:
/// B's bottom less A's top (stacked) or B's top less A's (coplanar). Both
/// near the same z, so the subtraction is exact (Sterbenz).
fn gap(p: &Pair) -> f64 {
    let (az, bz) = match (&p.a, &p.b) {
        (Solid::Boxes { boxes: a, .. }, Solid::Boxes { boxes: b, .. }) => (a[0][5], [b[0][2], b[0][5]]),
        (Solid::Prism { z: a, .. }, Solid::Prism { z: b, .. }) => (a[1], *b),
        _ => unreachable!(),
    };
    if p.family == "stacked offset" { bz[0] - az } else { bz[1] - az }
}

#[test]
fn offsets_land_in_their_bands() {
    // Hand-worked first: A's top at 10 mm, 0.9 × 2·LINEAR = 18 nm above it.
    // Doubles near 10 are 2^-49 ≈ 1.8e-15 mm apart, so the gap the kernel
    // sees is 18 nm to within 1.8e-15 mm: under the 20 nm within which two
    // places are one (rule 1), by 2 nm, a million times that rounding.
    let z = 10.0 + 0.9 * SAME;
    assert!(((z - 10.0) - 1.8e-5).abs() <= 2f64.powi(-49));
    assert!(z - 10.0 < SAME);
    let mut seen = 0;
    for p in pairs(SEED) {
        let Some((name, delta)) = p.offset else { continue };
        let g = gap(&p);
        // Every unit is a power of two and every coordinate a whole number of
        // them, so A's top is exact and only delta's own rounding remains.
        assert!((g - delta).abs() <= 32.0 * f64::EPSILON, "{name} at {}: {g:e}", p.place);
        let threshold = if name.ends_with("MIN_FEATURE") { MIN_FEATURE } else if name.ends_with("SAME") { SAME } else { LINEAR };
        let ratio = g.abs() / threshold;
        let want: f64 = name[1..4].parse().unwrap();
        assert!((ratio - want).abs() < 1e-6, "{name}: {ratio}");
        assert_eq!(g > 0.0, name.starts_with('+'), "{name}");
        // The bands: every LINEAR offset and 0.9× of 2·LINEAR are one place;
        // 1.1× of it is not.
        assert_eq!(g.abs() <= SAME, name.ends_with("LINEAR") || name.starts_with("+0.9 SAME") || name.starts_with("-0.9 SAME"), "{name}");
        seen += 1;
    }
    assert_eq!(seen, 2 * PLACES.len() * offsets().len());
}

/// Prism outlines are what the models can take exactly: strictly convex,
/// anticlockwise, every corner dyadic, every side a rational length.
#[test]
fn outlines_are_convex_with_rational_sides() {
    let mut seen = 0;
    for p in pairs(SEED) {
        for s in [&p.a, &p.b] {
            let Solid::Prism { outline, .. } = s else { continue };
            let n = outline.len();
            for i in 0..n {
                let (o, q, r) = (outline[i], outline[(i + 1) % n], outline[(i + 2) % n]);
                // Turning left at every corner (exact: dyadic, small).
                assert!((q[0] - o[0]) * (r[1] - q[1]) - (q[1] - o[1]) * (r[0] - q[0]) > 0.0, "{outline:?}");
                // The side, in whole 2^-15 units, has a whole length: a² + b² = c².
                let (a, b) = ((q[0] - o[0]) * 32768.0, (q[1] - o[1]) * 32768.0);
                assert!(a.fract() == 0.0 && b.fract() == 0.0, "{o:?} to {q:?} is not dyadic");
                let (a, b) = (a as i128, b as i128);
                let c = ((a * a + b * b) as f64).sqrt().round() as i128;
                assert_eq!(c * c, a * a + b * b, "side {o:?} to {q:?} has no rational length");
            }
            seen += 1;
        }
    }
    assert!(seen > 150, "{seen}");
}

#[test]
fn matrices_are_their_turns() {
    use boolean_cases::Turn;
    // Hand-worked: a turn about z with cos 3/5, sin 4/5 takes x to
    // (0.6, 0.8, 0) and y to (-0.8, 0.6, 0) (x to y about z, as
    // convex_model.turn); then about x by cos 5/13, sin 12/13 takes that
    // (0.6, 0.8, 0) to (0.6, 0.8·5/13, 0.8·12/13) = (0.6, 4/13, 48/65).
    let m = matrix(&[Turn { axis: 2, a: 3, b: 4, c: 5 }]);
    assert_eq!(m, [[0.6, -0.8, 0.0], [0.8, 0.6, 0.0], [0.0, 0.0, 1.0]]);
    let m = matrix(&[Turn { axis: 2, a: 3, b: 4, c: 5 }, Turn { axis: 0, a: 5, b: 12, c: 13 }]);
    let x = [m[0][0], m[1][0], m[2][0]];
    for (got, want) in x.iter().zip([0.6, 4.0 / 13.0, 48.0 / 65.0]) {
        assert!((got - want).abs() <= 4.0 * f64::EPSILON, "{x:?}");
    }
    // Every matrix in the lines is a rotation to rounding.
    for p in pairs(SEED) {
        for s in [&p.a, &p.b] {
            let Solid::Prism { turns, .. } = s else { continue };
            let m = matrix(turns);
            for i in 0..3 {
                for j in 0..3 {
                    let dot: f64 = (0..3).map(|k| m[i][k] * m[j][k]).sum();
                    assert!((dot - if i == j { 1.0 } else { 0.0 }).abs() < 1e-15, "{turns:?}");
                }
            }
            for t in turns {
                assert_eq!(t.a * t.a + t.b * t.b, t.c * t.c, "{t:?}");
            }
        }
    }
}

/// Inside the kernel's range: every corner within MAX_COORD; bodies a few
/// millimetres (micrometres at "1 um"); and every pair's corners at the
/// distance its place says.
#[test]
fn every_body_is_where_its_place_says() {
    for p in pairs(SEED) {
        let corners: Vec<[f64; 3]> = p.a.corners().into_iter().chain(p.b.corners()).collect();
        let reach = corners.iter().flat_map(|c| c.iter()).fold(0f64, |m, x| m.max(x.abs()));
        let size = (0..3)
            .map(|k| corners.iter().map(|c| c[k]).fold(f64::MIN, f64::max) - corners.iter().map(|c| c[k]).fold(f64::MAX, f64::min))
            .fold(0f64, f64::max);
        assert!(reach <= MAX_COORD, "{} {} at {}: {reach}", p.kind, p.family, p.place);
        let (lo, hi) = match p.place {
            "origin" => (0.0, 100.0),
            "1 km" => (0.99e6, 1e6),
            "100 km" => (0.99e8, 1e8),
            _ => (0.0, 0.1),
        };
        assert!(reach > lo && reach <= hi, "{} {} at {}: reach {reach}", p.kind, p.family, p.place);
        let (lo, hi) = if p.place == "1 um" { (4e-3, 0.1) } else { (4.0, 100.0) };
        assert!(size > lo && size < hi, "{} {} at {}: size {size}", p.kind, p.family, p.place);
    }
}

/// Touching families touch exactly: B's contact coordinate is A's, bit for
/// bit, in every box pair (a planted gap in the generator fails here and in
/// the judge's intent check).
#[test]
fn touching_boxes_touch_exactly() {
    for p in pairs(SEED) {
        let (Solid::Boxes { boxes: a, .. }, Solid::Boxes { boxes: b, .. }) = (&p.a, &p.b) else { continue };
        let (a, b) = (a[0], b[0]);
        let pairs: &[(usize, usize)] = match p.family {
            "edge touch" => &[(0, 3), (2, 5)],
            "vertex touch" => &[(0, 3), (1, 4), (2, 5)],
            "side touch" => &[(0, 3)],
            "sitting on" | "coplanar opposite" => &[(2, 5)],
            "coplanar same" => &[(5, 5)],
            "shared vertex" => &[(0, 0), (1, 1), (2, 2)],
            _ => &[],
        };
        for &(i, j) in pairs {
            assert_eq!(b[i].to_bits(), a[j].to_bits(), "{} at {}: {b:?} against {a:?}", p.family, p.place);
        }
    }
}
