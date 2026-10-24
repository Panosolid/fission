// Step 30c: the nasty-case generator for booleans (docs/progress/booleans.md).
//
// Seeded pairs of solids in each family of kernel/CLAUDE.md's nasty-case
// catalogue that flat booleans meet (coplanar faces of the same and the
// opposite sense, touching along an edge, at a corner and face to face,
// shared corners, one sitting on the other, one wholly inside, two apart,
// crossing in general position, and offsets at 0.9x and 1.1x of LINEAR,
// 2·LINEAR and MIN_FEATURE either way), as boxes and as turned prisms, at
// the origin, 1 km and 100 km out and at micrometre size, written as JSON
// lines for prototypes/boolean/judge.py. The judge takes a line carrying
// the kernel's answer and judges it against the exact models (box_model.py,
// convex_model.py). The kernel's own answers start at 34 (`Op::Boolean` in
// the stateful harness, the cargo-fuzz `boolean` target); until then
// tests/boolean_cases.rs checks the cases themselves, and CI's kernel job
// has the judge answer them from the models, check each family's intent
// below against the model, and catch planted wrong answers.
//
// A solid is boxes (axis-aligned; the body is their union) or a prism (a
// convex outline in x, y run along z from z[0] to z[1], turned about the
// origin by Pythagorean turns), then moved by `place`: the shape in its own
// frame and its placement, as the kernel holds a body. Every number is
// written as the shortest decimal that reads back as the same double, so the
// judge works with exactly the values the kernel is given. Two things make
// those values exact inputs for the models:
// - outline corners are dyadic (multiples of 2^-6 units, a unit being 1 mm,
//   or 2^-9 mm at micrometre size), and every side is a whole multiple of a
//   Pythagorean direction (3-4-5, 5-12-13, ...), so its length is rational;
// - a turn is written as its triple (cos a/c, sin b/c), which the double
//   matrix beside it only approximates (to an ulp; the judge checks).
// The offsets the bands care about are made in the solids' own frame,
// between two solids with the same turns and placement, so they reach the
// kernel unchanged far from the origin (it intersects B in A's frame,
// booleans.md B0r).

use fission_kernel::tolerance::{LINEAR, MIN_FEATURE};
use serde_json::{json, Value};

/// The base seed (FISSION_SEED style: decimal, recorded so a run replays).
pub const SEED: u64 = 30003;
pub const OPS: [&str; 3] = ["union", "subtract", "intersect"];
pub const PLACES: [&str; 4] = ["origin", "1 km", "100 km", "1 um"];
pub const KINDS: [&str; 2] = ["boxes", "prisms"];
/// Two places within the sum of two default tolerances are one (rule 1).
pub const SAME: f64 = 2.0 * LINEAR;
/// The families every kind gets once per place; "stacked offset" and
/// "coplanar offset" come once per offset in `offsets`, and prisms also get
/// "corner on corner" (two differently turned prisms sharing a corner).
pub const FAMILIES: [&str; 10] = [
    "coplanar same", "coplanar opposite", "sitting on", "edge touch", "vertex touch",
    "side touch", "shared vertex", "inside", "apart", "crossing",
];

/// The offsets of the bands, by name, either way (+ apart, - overlapping):
/// 0.9x LINEAR apart and 1.1x LINEAR overlapping, both within 2·LINEAR, so
/// one place (rule 1); 0.9x and 1.1x of 2·LINEAR either side of that;
/// MIN_FEATURE overlapping, and 0.9x and 1.1x of it either way.
pub fn offsets() -> Vec<(&'static str, f64)> {
    vec![
        ("+0.9 LINEAR", 0.9 * LINEAR),
        ("-1.1 LINEAR", -1.1 * LINEAR),
        ("+0.9 SAME", 0.9 * SAME),
        ("-0.9 SAME", -0.9 * SAME),
        ("+1.1 SAME", 1.1 * SAME),
        ("-1.1 SAME", -1.1 * SAME),
        ("-1.0 MIN_FEATURE", -MIN_FEATURE),
        ("+0.9 MIN_FEATURE", 0.9 * MIN_FEATURE),
        ("-0.9 MIN_FEATURE", -0.9 * MIN_FEATURE),
        ("+1.1 MIN_FEATURE", 1.1 * MIN_FEATURE),
        ("-1.1 MIN_FEATURE", -1.1 * MIN_FEATURE),
    ]
}

/// SplitMix64: small, and the same numbers on every platform and version.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A whole number from lo to hi, both included.
    fn int(&mut self, lo: i64, hi: i64) -> i64 {
        assert!(lo <= hi, "empty range {lo}..={hi}");
        lo + (self.next() % (hi - lo + 1) as u64) as i64
    }

    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[(self.next() % xs.len() as u64) as usize]
    }

    fn sign(&mut self) -> f64 {
        if self.next() & 1 == 0 { 1.0 } else { -1.0 }
    }
}

/// A turn about `axis` (0, 1, 2 for x, y, z) with cos a/c and sin b/c,
/// a² + b² = c²: positive turns x to y about z, y to z about x, z to x
/// about y (convex_model.turn).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Turn {
    pub axis: usize,
    pub a: i64,
    pub b: i64,
    pub c: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Solid {
    Boxes { boxes: Vec<[f64; 6]>, place: [f64; 3] },
    Prism { outline: Vec<[f64; 2]>, z: [f64; 2], turns: Vec<Turn>, place: [f64; 3] },
}

/// The turns applied in order, as the double matrix the kernel is given.
pub fn matrix(turns: &[Turn]) -> [[f64; 3]; 3] {
    let mut out = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for t in turns {
        let (k, c) = (t.axis, t.c as f64);
        let (i, j) = ((k + 1) % 3, (k + 2) % 3);
        let mut m = [[0.0; 3]; 3];
        m[k][k] = 1.0;
        m[i][i] = t.a as f64 / c;
        m[i][j] = -(t.b as f64) / c;
        m[j][i] = t.b as f64 / c;
        m[j][j] = t.a as f64 / c;
        let mut next = [[0.0; 3]; 3];
        for (r, row) in next.iter_mut().enumerate() {
            for (col, x) in row.iter_mut().enumerate() {
                *x = (0..3).map(|n| m[r][n] * out[n][col]).sum();
            }
        }
        out = next;
    }
    out
}

impl Solid {
    /// Every corner where the kernel puts it (in doubles).
    pub fn corners(&self) -> Vec<[f64; 3]> {
        match self {
            Solid::Boxes { boxes, place } => boxes
                .iter()
                .flat_map(|b| {
                    (0..8).map(move |i| {
                        [0, 1, 2].map(|a| b[a + 3 * ((i >> a) & 1)] + place[a])
                    })
                })
                .collect(),
            Solid::Prism { outline, z, turns, place } => {
                let m = matrix(turns);
                z.iter()
                    .flat_map(|&h| {
                        outline.iter().map(move |p| {
                            let local = [p[0], p[1], h];
                            [0, 1, 2].map(|r| (0..3).map(|n| m[r][n] * local[n]).sum::<f64>() + place[r])
                        })
                    })
                    .collect()
            }
        }
    }

    fn json(&self) -> Value {
        let v3 = |p: &[f64; 3]| json!([num(p[0]), num(p[1]), num(p[2])]);
        match self {
            Solid::Boxes { boxes, place } => json!({
                "boxes": boxes.iter().map(|b| b.iter().map(|&x| num(x)).collect::<Vec<_>>()).collect::<Vec<_>>(),
                "place": v3(place),
            }),
            Solid::Prism { outline, z, turns, place } => json!({
                "outline": outline.iter().map(|p| json!([num(p[0]), num(p[1])])).collect::<Vec<_>>(),
                "z": [num(z[0]), num(z[1])],
                "turns": turns.iter().map(|t| { let axis = ["x", "y", "z"][t.axis]; json!([axis, t.a, t.b, t.c]) }).collect::<Vec<_>>(),
                "matrix": matrix(turns).iter().map(v3).collect::<Vec<_>>(),
                "place": v3(place),
            }),
        }
    }
}

/// Closer than this, two places are the same place on purpose (a contact
/// the generator made, a hair apart from rounding); the judge snaps them.
pub const TOUCH: f64 = 1e-6;

/// Every near-place gap judge.py's snap looks at, between prisms a and b
/// as the kernel is given them: each corner's distance (signed) from each
/// face plane of the other, and the distance between two edges whose
/// closest points lie inside both. Worked about A's place, so far out the
/// rounding is that of the shapes, not of their placement.
pub fn near_gaps(a: &Solid, b: &Solid) -> Vec<f64> {
    let origin = match a {
        Solid::Prism { place, .. } | Solid::Boxes { place, .. } => *place,
    };
    let corners = |s: &Solid| -> Vec<[f64; 3]> {
        let Solid::Prism { outline, z, turns, place } = s else { panic!("near_gaps takes prisms") };
        let m = matrix(turns);
        let off = [0, 1, 2].map(|r| place[r] - origin[r]);
        z.iter()
            .flat_map(|&h| outline.iter().map(move |p| [0, 1, 2].map(|r| m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * h + off[r])))
            .collect()
    };
    let sub = |p: [f64; 3], q: [f64; 3]| [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    let dot = |p: [f64; 3], q: [f64; 3]| p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    let cross = |p: [f64; 3], q: [f64; 3]| [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    // Bottom ring 0..n, top ring n..2n: each side's plane, the top's, the bottom's.
    let planes = |c: &[[f64; 3]]| -> Vec<([f64; 3], [f64; 3])> {
        let n = c.len() / 2;
        let mut out: Vec<_> = (0..n).map(|i| (c[i], cross(sub(c[(i + 1) % n], c[i]), sub(c[n + i], c[i])))).collect();
        out.push((c[n], cross(sub(c[n + 1], c[n]), sub(c[n + 2], c[n]))));
        out.push((c[0], cross(sub(c[1], c[0]), sub(c[2], c[0]))));
        out.into_iter().map(|(p, v)| (p, v.map(|x| x / dot(v, v).sqrt()))).collect()
    };
    let edges = |c: &[[f64; 3]]| -> Vec<([f64; 3], [f64; 3])> {
        let n = c.len() / 2;
        (0..n).flat_map(|i| [(c[i], c[(i + 1) % n]), (c[n + i], c[n + (i + 1) % n]), (c[i], c[n + i])]).collect()
    };
    let (ca, cb) = (corners(a), corners(b));
    let mut out = vec![];
    for (s, o) in [(&cb, &ca), (&ca, &cb)] {
        for (p, n) in planes(o) {
            out.extend(s.iter().map(|&v| dot(n, sub(v, p))));
        }
    }
    for (p0, p1) in edges(&cb) {
        for (q0, q1) in edges(&ca) {
            let (u, v, w) = (sub(p1, p0), sub(q1, q0), sub(p0, q0));
            let m = cross(u, v);
            let den = dot(u, u) * dot(v, v) - dot(u, v) * dot(u, v);
            if dot(m, m) == 0.0 || den == 0.0 {
                continue; // parallel: near only where a corner is, counted above
            }
            let s_ = (dot(u, v) * dot(v, w) - dot(v, v) * dot(u, w)) / den;
            let t_ = (dot(u, u) * dot(v, w) - dot(u, v) * dot(u, w)) / den;
            if 0.0 < s_ && s_ < 1.0 && 0.0 < t_ && t_ < 1.0 {
                out.push(dot(m, w) / dot(m, m).sqrt());
            }
        }
    }
    out
}

/// Whether prisms a and b have a near place nobody asked for: a gap above
/// TOUCH and within 2·LINEAR, or a little past it (twice that), so none
/// sits on the band's edge either.
pub fn accidental(a: &Solid, b: &Solid) -> bool {
    near_gaps(a, b).iter().any(|g| g.abs() > TOUCH && g.abs() <= 2.0 * SAME)
}

/// The shortest decimal that reads back as `x` exactly.
pub fn num(x: f64) -> String {
    format!("{x:?}")
}

/// The answer each family must give, per op (union, subtract, intersect),
/// as judge.py's summary of a model's answer: "bodies:N" (and ":shells:S"
/// when a body has voids), "empty", "nonmanifold" or "thin"; "a|b" when
/// either is right (a length of exactly MIN_FEATURE, where the double
/// nearest decides); None for crossings, which the models alone decide.
pub type Intent = [Option<&'static str>; 3];

pub struct Pair {
    pub kind: &'static str,
    pub family: &'static str,
    pub place: &'static str,
    pub offset: Option<(&'static str, f64)>,
    pub a: Solid,
    pub b: Solid,
    pub intent: Intent,
}

impl Pair {
    /// One JSON line per op, for the judge.
    pub fn lines(&self, seed: u64, case: usize) -> Vec<String> {
        OPS.iter()
            .zip(self.intent)
            .map(|(op, intent)| {
                json!({
                    "seed": seed, "case": case, "kind": self.kind, "family": self.family, "place": self.place,
                    "offset": self.offset.map(|o| o.0), "op": op, "intent": intent,
                    "a": self.a.json(), "b": self.b.json(),
                })
                .to_string()
            })
            .collect()
    }
}

/// Every pair for `seed`: each kind, each family, each place (and each
/// offset in its two arrangements, alternating over the places).
pub fn pairs(seed: u64) -> Vec<Pair> {
    let mut rng = Rng::new(seed);
    let mut out = vec![];
    for (pi, place) in PLACES.into_iter().enumerate() {
        for kind in KINDS {
            let mut families: Vec<(&'static str, Option<(&'static str, f64)>)> = FAMILIES.iter().map(|&f| (f, None)).collect();
            if kind == "prisms" {
                families.push(("corner on corner", None));
            }
            for (oi, o) in offsets().into_iter().enumerate() {
                families.push((if (pi + oi) % 2 == 0 { "stacked offset" } else { "coplanar offset" }, Some(o)));
            }
            for (family, offset) in families {
                let unit = if place == "1 um" { 2f64.powi(-9) } else { 1.0 };
                let at = place_vector(&mut rng, place);
                let (a, b, intent) = if kind == "boxes" {
                    boxes(&mut rng, family, offset.map(|o| o.1), unit, at)
                } else {
                    prisms(&mut rng, family, offset.map(|o| o.1), unit, at)
                };
                out.push(Pair { kind, family, place, offset, a, b, intent });
            }
        }
    }
    out
}

/// Every line for `seed`, one per pair and op.
pub fn lines(seed: u64) -> String {
    let mut out = String::new();
    for (case, pair) in pairs(seed).iter().enumerate() {
        for line in pair.lines(seed, case) {
            out += &line;
            out.push('\n');
        }
    }
    out
}

fn place_vector(rng: &mut Rng, place: &str) -> [f64; 3] {
    // Whole millimetres just inside the distance, so a body stays within
    // MAX_COORD (100 km) and its corners are exact there.
    let far = |rng: &mut Rng, d: f64| [0, 1, 2].map(|_| rng.sign() * (d - rng.int(100, 999) as f64));
    match place {
        "1 km" => far(rng, 1e6),
        "100 km" => far(rng, 1e8),
        _ => [0.0; 3],
    }
}

const B1: Option<&str> = Some("bodies:1");
const B2: Option<&str> = Some("bodies:2");
const EMPTY: Option<&str> = Some("empty");
const NM: Option<&str> = Some("nonmanifold");
const THIN: Option<&str> = Some("thin");
const B1_OR_THIN: Option<&str> = Some("bodies:1|thin");

fn intent(family: &str) -> Intent {
    match family {
        "coplanar same" | "shared vertex" => [B1, B1, B1],
        "coplanar opposite" | "sitting on" | "side touch" => [B1, B1, EMPTY],
        "edge touch" | "vertex touch" => [NM, B1, EMPTY],
        "inside" => [B1, Some("bodies:1:shells:2"), B1],
        "apart" => [B2, B1, EMPTY],
        _ => [None; 3],
    }
}

/// The intent of an offset `delta` (+ apart, - overlapping). Stacked: B
/// sits on A's top, its footprint inside it, `delta` above it. Coplanar: B
/// straddles one of A's sides, its top `delta` above A's.
fn offset_intent(stacked: bool, delta: f64) -> Intent {
    let d = delta.abs();
    if d <= SAME {
        // One place to the kernel: the touching (or coplanar) family.
        return intent(if stacked { "sitting on" } else { "coplanar same" });
    }
    let exact = d == MIN_FEATURE;
    let thin = if exact { B1_OR_THIN } else if d < MIN_FEATURE { THIN } else { B1 };
    if stacked {
        if delta > 0.0 {
            // A gap: two bodies apart (the thin rule is per face; there is
            // no face across a gap).
            [B2, B1, EMPTY]
        } else {
            // Overlapping by d: the pocket A − B and the slab A ∩ B are d deep.
            [B1, thin, thin]
        }
    } else {
        // The union has a step of d in its top; A − B leaves a skin of d
        // over the notch when B's top is below A's.
        [thin, if delta < 0.0 { thin } else { B1 }, B1]
    }
}

/// A sub-range of lo..hi at least 1 unit inside each end and 2 long.
fn inner(rng: &mut Rng, lo: i64, hi: i64) -> (i64, i64) {
    let x0 = rng.int(lo + 1, hi - 3);
    (x0, rng.int(x0 + 2, hi - 1))
}

/// Two boxes in whole units (every coordinate distinct from the others by
/// a unit or more, unless equal), scaled, then `delta` added where the
/// offset families put it.
fn boxes(rng: &mut Rng, family: &'static str, delta: Option<f64>, unit: f64, at: [f64; 3]) -> (Solid, Solid, Intent) {
    let mut a = [0i64; 6];
    for k in 0..3 {
        a[k] = rng.int(-12, -4);
        a[k + 3] = a[k] + rng.int(8, 20);
    }
    let (w, h) = (a[3] - a[0], a[5] - a[2]);
    // B straddling A's +x side, its y inside A's.
    let straddle = |rng: &mut Rng| (a[3] - rng.int(2, w - 2), a[3] + rng.int(2, 8));
    let mut b = [0i64; 6];
    let set = |b: &mut [i64; 6], k: usize, r: (i64, i64)| {
        b[k] = r.0;
        b[k + 3] = r.1;
    };
    let mut intent = intent(family);
    let (mut z0_delta, mut z1_delta) = (0.0, 0.0);
    match family {
        "coplanar same" | "coplanar offset" => {
            let x = straddle(rng);
            set(&mut b, 0, x);
            let y = inner(rng, a[1], a[4]);
            set(&mut b, 1, y);
            set(&mut b, 2, (a[5] - rng.int(2, h - 2), a[5]));
            if let Some(d) = delta {
                z1_delta = d;
                intent = offset_intent(false, d);
            }
        }
        "coplanar opposite" => {
            let x = straddle(rng);
            set(&mut b, 0, x);
            let y = inner(rng, a[1], a[4]);
            set(&mut b, 1, y);
            set(&mut b, 2, (a[5], a[5] + rng.int(2, 8)));
        }
        "sitting on" | "stacked offset" => {
            for k in 0..2 {
                let r = inner(rng, a[k], a[k + 3]);
                set(&mut b, k, r);
            }
            set(&mut b, 2, (a[5], a[5] + rng.int(2, 8)));
            if let Some(d) = delta {
                z0_delta = d;
                intent = offset_intent(true, d);
            }
        }
        "edge touch" | "vertex touch" | "side touch" => {
            set(&mut b, 0, (a[3], a[3] + rng.int(2, 8)));
            let y = if family == "vertex touch" { (a[4], a[4] + rng.int(2, 8)) } else { inner(rng, a[1], a[4]) };
            set(&mut b, 1, y);
            let z = if family == "side touch" { (a[2] + rng.int(2, h - 2), a[5] + rng.int(2, 8)) } else { (a[5], a[5] + rng.int(2, 8)) };
            set(&mut b, 2, z);
        }
        "shared vertex" => {
            for k in 0..2 {
                b[k] = a[k];
                b[k + 3] = a[k] + rng.int(2, a[k + 3] - a[k] - 2);
            }
            set(&mut b, 2, (a[2], a[5] + rng.int(2, 8)));
        }
        "inside" => {
            for k in 0..3 {
                let r = inner(rng, a[k], a[k + 3]);
                set(&mut b, k, r);
            }
        }
        "apart" => {
            set(&mut b, 0, {
                let x0 = a[3] + rng.int(2, 8);
                (x0, x0 + rng.int(4, 12))
            });
            for k in 1..3 {
                let r = inner(rng, a[k], a[k + 3]);
                set(&mut b, k, r);
            }
        }
        "crossing" => {
            for k in 0..3 {
                let x0 = rng.int(a[k] - 6, a[k + 3] - 2);
                set(&mut b, k, (x0, x0 + rng.int(4, 16)));
            }
        }
        _ => unreachable!("no box family {family}"),
    }
    let scale = |v: [i64; 6]| v.map(|x| x as f64 * unit);
    let mut bf = scale(b);
    bf[2] += z0_delta;
    bf[5] += z1_delta;
    (Solid::Boxes { boxes: vec![scale(a)], place: at }, Solid::Boxes { boxes: vec![bf], place: at }, intent)
}

/// Pythagorean triples: every side and turn is built from these.
const TRIPLES: [(i64, i64, i64); 5] = [(3, 4, 5), (5, 12, 13), (8, 15, 17), (7, 24, 25), (20, 21, 29)];

/// Every direction (a, b) with a whole length c: the axes and the triples,
/// either way round, with either sign.
fn directions() -> Vec<(i64, i64, i64)> {
    let mut out = vec![(1, 0, 1), (0, 1, 1), (-1, 0, 1), (0, -1, 1)];
    for (a, b, c) in TRIPLES {
        for (x, y) in [(a, b), (b, a)] {
            for (sx, sy) in [(1, 1), (1, -1), (-1, 1), (-1, -1)] {
                out.push((sx * x, sy * y, c));
            }
        }
    }
    out
}

/// Whether e is anticlockwise of d by an angle whose sine is at least
/// `sin` (so between asin(sin) and π − asin(sin)), worked in integers.
fn turned_by(d: (i64, i64, i64), e: (i64, i64, i64), sin: f64) -> bool {
    let cross = d.0 * e.1 - d.1 * e.0;
    cross > 0 && cross as f64 >= sin * (d.2 * e.2) as f64
}

/// A side along d, a whole number of 1/16 units of (a, b), so between lo
/// and hi units long.
fn side(rng: &mut Rng, d: (i64, i64, i64), lo: i64, hi: i64) -> [f64; 2] {
    let k = rng.int((16 * lo + d.2 - 1) / d.2, 16 * hi / d.2);
    [(k * d.0) as f64 / 16.0, (k * d.1) as f64 / 16.0]
}

fn add(p: [f64; 2], q: [f64; 2]) -> [f64; 2] {
    [p[0] + q[0], p[1] + q[1]]
}

fn scale2(p: [f64; 2], k: f64) -> [f64; 2] {
    [p[0] * k, p[1] * k]
}

/// The corners of the sides `vs` in order, from `start`.
fn walk(start: [f64; 2], vs: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out = vec![start];
    for v in &vs[..vs.len() - 1] {
        out.push(add(*out.last().unwrap(), *v));
    }
    out
}

/// Whether every side of an outline centred on the origin is at least 2.5
/// units from the centre, so the half-size copies the families put inside
/// it or across its sides leave walls of 1.25 units (2.4 µm at micrometre
/// size) at least: nothing thin unless a family means it.
fn roomy(corners: &[[f64; 2]]) -> bool {
    let n = corners.len();
    (0..n).all(|i| {
        let (p, q) = (corners[i], corners[(i + 1) % n]);
        let v = [q[0] - p[0], q[1] - p[1]];
        (p[0] * v[1] - p[1] * v[0]).abs() >= 2.5 * (v[0] * v[0] + v[1] * v[1]).sqrt()
    })
}

/// A parallelogram centred on the origin, sides v1 then v2 (anticlockwise,
/// the sine of the turn at least 0.35, 4 to 12 units long): its corners and v1, v2.
fn parallelogram(rng: &mut Rng) -> (Vec<[f64; 2]>, [f64; 2], [f64; 2]) {
    let dirs = directions();
    loop {
        let (d1, d2) = (rng.pick(&dirs), rng.pick(&dirs));
        if !turned_by(d1, d2, 0.35) {
            continue;
        }
        let (v1, v2) = (side(rng, d1, 4, 12), side(rng, d2, 4, 12));
        let start = scale2(add(v1, v2), -0.5);
        let corners = walk(start, &[v1, v2, scale2(v1, -1.0), scale2(v2, -1.0)]);
        if roomy(&corners) {
            return (corners, v1, v2);
        }
    }
}

/// A centrally symmetric hexagon centred on the origin (sides v1, v2, v3,
/// then the same reversed; the sine of each turn at least 0.3, and v3 still
/// less than a half-turn from v1; 3 to 8 units).
fn hexagon(rng: &mut Rng) -> Vec<[f64; 2]> {
    let dirs = directions();
    loop {
        let (d1, d2, d3) = (rng.pick(&dirs), rng.pick(&dirs), rng.pick(&dirs));
        if !(turned_by(d1, d2, 0.3) && turned_by(d2, d3, 0.3) && turned_by(d1, d3, 0.3)) {
            continue;
        }
        let vs = [side(rng, d1, 3, 8), side(rng, d2, 3, 8), side(rng, d3, 3, 8)];
        let start = scale2(add(add(vs[0], vs[1]), vs[2]), -0.5);
        let back = vs.map(|v| scale2(v, -1.0));
        let corners = walk(start, &[vs[0], vs[1], vs[2], back[0], back[1], back[2]]);
        if roomy(&corners) {
            return corners;
        }
    }
}

/// A right triangle: legs along a direction (a, b) and its left turn
/// (-b, a), their lengths in the ratio of another triple, so the long side
/// is rational too; legs 4 to 12 units.
fn triangle(rng: &mut Rng) -> Vec<[f64; 2]> {
    let dirs = directions();
    loop {
        let d = rng.pick(&dirs);
        let (p, q, _) = rng.pick(&TRIPLES);
        let (p, q) = if rng.next() & 1 == 0 { (p, q) } else { (q, p) };
        // Legs s·p/16 · (a, b) and s·q/16 · (-b, a): s·p·c/16 and s·q·c/16 long.
        let lo = (64 + d.2 * p.min(q) - 1) / (d.2 * p.min(q));
        let hi = 192 / (d.2 * p.max(q));
        if lo > hi {
            continue;
        }
        let s = rng.int(lo, hi);
        let v1 = [(s * p * d.0) as f64 / 16.0, (s * p * d.1) as f64 / 16.0];
        let v2 = [(-s * q * d.1) as f64 / 16.0, (s * q * d.0) as f64 / 16.0];
        let start = scale2(add(v1, v2), -0.5);
        return walk(start, &[v1, v2, scale2(add(v1, v2), -1.0)]);
    }
}

fn any_outline(rng: &mut Rng) -> Vec<[f64; 2]> {
    match rng.int(0, 2) {
        0 => parallelogram(rng).0,
        1 => hexagon(rng),
        _ => triangle(rng),
    }
}

/// One to three Pythagorean turns about random axes, with random signs.
fn turns(rng: &mut Rng) -> Vec<Turn> {
    (0..rng.int(1, 3))
        .map(|_| {
            let (a, b, c) = rng.pick(&TRIPLES);
            Turn { axis: rng.int(0, 2) as usize, a: a * rng.sign() as i64, b: b * rng.sign() as i64, c }
        })
        .collect()
}

fn shift(outline: &[[f64; 2]], by: [f64; 2]) -> Vec<[f64; 2]> {
    outline.iter().map(|&p| add(p, by)).collect()
}

fn half(outline: &[[f64; 2]], about: [f64; 2]) -> Vec<[f64; 2]> {
    outline.iter().map(|&p| scale2(add(p, about), 0.5)).collect()
}

/// Two prisms in units: A a parallelogram (or, where only the centre
/// matters, a hexagon) with its turns, B made from A's outline in A's frame
/// with the same turns and place, so contacts are exact; crossings and
/// corner on corner turn B its own way.
fn prisms(rng: &mut Rng, family: &'static str, delta: Option<f64>, unit: f64, at: [f64; 3]) -> (Solid, Solid, Intent) {
    let (para, v1, v2) = parallelogram(rng);
    let tu = turns(rng);
    let z0 = rng.int(-10, -4);
    let z1 = z0 + 4 * rng.int(2, 4);
    let h = z1 - z0;
    let hb = rng.int(2, 8);
    let centred = if rng.next() & 1 == 0 { para.clone() } else { hexagon(rng) };
    let mut intent = intent(family);
    let a_outline;
    let (b_outline, bz, b_turns, b_place): (Vec<[f64; 2]>, [f64; 2], Vec<Turn>, [f64; 3]);
    let (z0f, z1f) = (z0 as f64, z1 as f64);
    let straddle = || shift(&half(&para, [0.0, 0.0]), scale2(v1, 0.5));
    match family {
        "coplanar same" | "coplanar offset" => {
            a_outline = para.clone();
            b_outline = straddle();
            bz = [(z1 - rng.int(2, h - 2)) as f64, z1f];
            if let Some(d) = delta {
                intent = offset_intent(false, d);
            }
        }
        "coplanar opposite" => {
            a_outline = para.clone();
            b_outline = straddle();
            bz = [z1f, (z1 + hb) as f64];
        }
        "sitting on" | "stacked offset" => {
            a_outline = centred.clone();
            b_outline = half(&centred, [0.0, 0.0]);
            bz = [z1f, (z1 + hb) as f64];
            if let Some(d) = delta {
                intent = offset_intent(true, d);
            }
        }
        "edge touch" => {
            a_outline = para.clone();
            b_outline = shift(&para, v2);
            bz = [z1f, (z1 + hb) as f64];
        }
        "vertex touch" => {
            a_outline = para.clone();
            b_outline = shift(&para, add(v1, v2));
            bz = [z1f, (z1 + hb) as f64];
        }
        "side touch" => {
            a_outline = para.clone();
            b_outline = shift(&para, v2);
            bz = [(z0f + z1f) / 2.0, (z1 + hb) as f64];
        }
        "shared vertex" => {
            a_outline = para.clone();
            b_outline = half(&para, para[0]);
            bz = [z0f, (z1 + hb) as f64];
        }
        "inside" => {
            a_outline = centred.clone();
            b_outline = half(&centred, [0.0, 0.0]);
            bz = [z0f + h as f64 / 4.0, z1f - h as f64 / 4.0];
        }
        "apart" => {
            a_outline = para.clone();
            b_outline = shift(&para, scale2(v2, 2.0));
            bz = [z0f, z1f];
        }
        "crossing" | "corner on corner" => loop {
            let a_drawn = any_outline(rng);
            let b_outline = any_outline(rng);
            let lo = rng.int(-8, 0);
            let bz = [lo as f64, (lo + rng.int(6, 14)) as f64];
            let b_turns = turns(rng);
            // A third of crossings are an axis-aligned box against a turned prism.
            let a_turns = if family == "crossing" && rng.int(0, 2) == 0 { vec![] } else { tu.clone() };
            let a_outline = if a_turns.is_empty() {
                let (x, y) = (rng.int(4, 12) as f64, rng.int(4, 12) as f64);
                vec![[-x, -y], [x, -y], [x, y], [-x, y]]
            } else {
                a_drawn
            };
            let a = Solid::Prism { outline: scale_outline(&a_outline, unit), z: [z0f * unit, z1f * unit], turns: a_turns, place: at };
            let b_place = if family == "crossing" {
                // A whole number of eighths of a unit off: exact far out too.
                [0, 1, 2].map(|r| at[r] + rng.int(-24, 24) as f64 / 8.0 * unit)
            } else {
                // B's corner on A's: A's top corner i, where the kernel puts
                // it, less B's bottom corner j turned. Rounded, so a hair
                // apart: the judge (and the kernel) take them as one.
                let ca = a.corners();
                let i = a_outline.len() + rng.int(0, a_outline.len() as i64 - 1) as usize;
                let j = rng.int(0, b_outline.len() as i64 - 1) as usize;
                let m = matrix(&b_turns);
                let q = [b_outline[j][0] * unit, b_outline[j][1] * unit, bz[0] * unit];
                [0, 1, 2].map(|r| ca[i][r] - (0..3).map(|n| m[r][n] * q[n]).sum::<f64>())
            };
            let b = Solid::Prism { outline: scale_outline(&b_outline, unit), z: [bz[0] * unit, bz[1] * unit], turns: b_turns, place: b_place };
            // Turned freely, a corner can land by chance within 2·LINEAR of
            // a plane of the other solid without touching it (seed 31009
            // case 160, at micrometre size: an edge of A leaving the shared
            // corner and ending 15.6 nm off B's face). That near place and
            // the one asked for are two that no single move of B brings
            // together, beyond the judge; such a near miss is a family of
            // its own (near-tangent, 37a). Draw again.
            if !accidental(&a, &b) {
                return (a, b, intent);
            }
        },
        _ => unreachable!("no prism family {family}"),
    }
    b_turns = tu.clone();
    b_place = at;
    let mut bz = [bz[0] * unit, bz[1] * unit];
    match (family, delta) {
        ("stacked offset", Some(d)) => bz[0] += d,
        ("coplanar offset", Some(d)) => bz[1] += d,
        _ => {}
    }
    (
        Solid::Prism { outline: scale_outline(&a_outline, unit), z: [z0f * unit, z1f * unit], turns: tu, place: at },
        Solid::Prism { outline: scale_outline(&b_outline, unit), z: bz, turns: b_turns, place: b_place },
        intent,
    )
}

fn scale_outline(outline: &[[f64; 2]], unit: f64) -> Vec<[f64; 2]> {
    outline.iter().map(|&p| scale2(p, unit)).collect()
}
