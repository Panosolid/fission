#![allow(dead_code)]
//! The kernel's coverage-guided fuzz checks, one function per target:
//! each turns fuzzer bytes into hostile input for one entry point and
//! panics on anything wrong. `fuzz_targets/*.rs` hand them to libFuzzer
//! (`cargo +nightly fuzz run -a <target>`); `kernel/tests/fuzz_corpus.rs`
//! replays the saved corpus and every saved crash through the same
//! functions in every `cargo test`, on stable Rust.
use fission_kernel::ops::extrude::{self as extruding, Boundary, Profile};
use fission_kernel::ops::{primitives, transform};
use fission_kernel::placed::Placed;
use fission_kernel::sketch::{self as sketching, Arc, Circle, Line, SketchCurve, SketchOutline, Source};
use fission_kernel::tolerance::LINEAR;
use fission_kernel::topology::{Body, FaceRole, Piece};
use fission_kernel::tessellate::{tessellate, TessOptions};
use fission_kernel::validate::validate;
use fission_kernel::{stl, view_body};
use glam::{DVec2, DVec3};

// Turns fuzzer bytes into hostile numbers. Most values are near the
// kernel's thresholds or repeat earlier values (so corners coincide,
// pieces touch and arcs are tangent), so coverage guidance can steer onto
// the boundaries instead of spending its time on random doubles.
pub struct Bytes<'a> {
    data: &'a [u8],
    pub seen: Vec<f64>,
}

const SPECIAL: [f64; 24] = [
    0.0, -0.0, 1.0, -1.0, 0.5, 2.0, 10.0, 1e-3, 1e-5, 1e6, 1e8, -1e8, 5e-324, 1e-300, 1e300,
    f64::MAX, f64::MIN, f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 0.9e-3, 1.1e-3, 0.9e-5, 1.1e-5,
];

impl<'a> Bytes<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Bytes { data, seen: Vec::new() }
    }

    pub fn byte(&mut self) -> u8 {
        match self.data.split_first() {
            Some((&b, rest)) => {
                self.data = rest;
                b
            }
            None => 0,
        }
    }

    pub fn empty(&self) -> bool {
        self.data.is_empty()
    }

    fn raw(&mut self) -> f64 {
        let mut b = [0u8; 8];
        for x in &mut b {
            *x = self.byte();
        }
        f64::from_le_bytes(b)
    }

    /// A number in roughly [-1, 1] times a scale: whole multiples of
    /// 1/16, fractions, and nudges of 0.9× and 1.1× the tolerances.
    pub fn num(&mut self) -> f64 {
        let v = match self.byte() % 8 {
            0 => SPECIAL[self.byte() as usize % SPECIAL.len()],
            1 => self.raw(),
            2 | 3 if !self.seen.is_empty() => {
                // An earlier value, maybe nudged by a tolerance-sized step.
                let k = self.byte() as usize % self.seen.len();
                let base = self.seen[k];
                let nudge = [0.0, 1e-5, -1e-5, 0.9e-5, 1.1e-5, 1e-3, -1e-3, 0.9e-3, 1.1e-3, 1e-12][self.byte() as usize % 10];
                base + nudge
            }
            4 => (self.byte() as i8) as f64 * 10f64.powi((self.byte() % 13) as i32 - 6),
            _ => (self.byte() as i8) as f64 / 16.0 * 10f64.powi((self.byte() % 5) as i32),
        };
        self.seen.push(v);
        v
    }
}

fn boundary(b: &mut Bytes, scale: f64, shift: DVec2) -> Boundary {
    if b.byte().is_multiple_of(4) {
        return Boundary::Circle { center: shift + DVec2::new(b.num(), b.num()) * scale, radius: b.num() * scale };
    }
    let n = 2 + (b.byte() % 10) as usize;
    let corners = (0..n).map(|_| shift + DVec2::new(b.num(), b.num()) * scale).collect();
    let bulges = if b.byte().is_multiple_of(2) { vec![] } else { (0..n).map(|_| if b.byte().is_multiple_of(3) { 0.0 } else { b.num() }).collect() };
    Boundary::Path { corners, bulges }
}

/// Area, a bound on its rounding, and perimeter of one loop, worked out
/// apart from the kernel: shoelace about the first corner plus each arc's
/// circular segment r²/2 (θ − sin θ).
pub fn measure(b: &Boundary) -> (f64, f64, f64) {
    match b {
        Boundary::Circle { radius, .. } => {
            let area = std::f64::consts::PI * radius * radius;
            (area, area, std::f64::consts::TAU * radius)
        }
        Boundary::Path { corners, bulges } => {
            let n = corners.len();
            let (mut area, mut size, mut perimeter) = (0.0, 0.0, 0.0);
            for i in 0..n {
                let (p, q) = (corners[i] - corners[0], corners[(i + 1) % n] - corners[0]);
                let tri = p.perp_dot(q) / 2.0;
                area += tri;
                size += tri.abs();
                let c = p.distance(q);
                let bulge = bulges.get(i).copied().unwrap_or(0.0);
                if bulge == 0.0 {
                    perimeter += c;
                } else {
                    let sweep = 4.0 * bulge.atan();
                    let r = c * (1.0 + bulge * bulge) / (4.0 * bulge.abs());
                    let seg = r * r / 2.0 * (sweep - sweep.sin());
                    area += seg;
                    size += seg.abs();
                    perimeter += r * sweep.abs();
                }
            }
            (area.abs(), size, perimeter)
        }
    }
}

/// Extrude any profile the bytes describe, then show and export it as the
/// app does. Fails on a panic (including an invalid result, which panics in
/// these debug-assertion builds), a body the view reports invalid, or
/// volume or area off from the profile's own area and perimeter.
pub fn extrude(data: &[u8]) {
    let mut b = Bytes::new(data);
    let scale = [1.0, 1e-3, 1e3, 1e6, 0.1, 7.0][b.byte() as usize % 6];
    let shift = if b.byte().is_multiple_of(4) { DVec2::new(b.num(), b.num()) * 1e7 } else { DVec2::ZERO };
    let outer = boundary(&mut b, scale, shift);
    let holes = (0..b.byte() % 4).map(|_| boundary(&mut b, scale, shift)).collect();
    let profile = Profile { outer, holes };
    let d = b.num() * [1.0, 1e3, 1e-3][b.byte() as usize % 3];
    let Ok(body) = extruding::extrude(&profile, d) else { return };
    let view = view_body(&body).expect("an extruded body always meshes");
    assert!(view.errors.is_empty(), "invalid body: {:?}\n{profile:?} d={d}", view.errors);

    let (outer_area, mut size, mut perimeter) = measure(&profile.outer);
    let mut area = outer_area;
    for h in &profile.holes {
        let (a, s, p) = measure(h);
        area -= a;
        size += s;
        perimeter += p;
    }
    let slack = 1e-9 * (size * d + perimeter * d * shift.abs().max_element().max(1.0));
    assert!((view.volume - area * d).abs() <= slack, "volume {} want {} (slack {slack:e})\n{profile:?} d={d}", view.volume, area * d);
    let surface = 2.0 * area + perimeter * d;
    let slack = 1e-9 * (2.0 * size + perimeter * d) * shift.abs().max_element().max(1.0);
    assert!((view.area - surface).abs() <= slack, "area {} want {surface} (slack {slack:e})\n{profile:?} d={d}", view.area);

    check_roles(&body, &profile, d, &view);

    let mesh = tessellate(&body, &TessOptions::DISPLAY).unwrap();
    assert!(mesh.check_closed().is_ok(), "display mesh not closed\n{profile:?} d={d}");
    let file = stl::export(&mesh, "fuzz");
    assert_eq!(stl::read(&file.bytes).unwrap().triangles.len(), mesh.triangles.len());
}

/// Sketch lines, arcs and circles in any arrangement, snapped or not: the
/// outline they make must extrude whenever it is closed (the sketch module's
/// promise), and nothing may panic.
pub fn sketch(data: &[u8]) {
    let mut b = Bytes::new(data);
    let scale = [1.0, 1e-3, 1e3, 1e6][b.byte() as usize % 4];
    let grid = if b.byte().is_multiple_of(2) { Some(b.num()) } else { None };
    let point = |b: &mut Bytes| {
        let p = DVec2::new(b.num(), b.num()) * scale;
        match grid {
            Some(s) => sketching::snap_to_grid(p, s).unwrap_or(p),
            None => p,
        }
    };
    // A chain of lines and arcs, each often starting where the last ended
    // (as the tools draw), maybe closed back to the start.
    let (mut lines, mut arcs): (Vec<Line>, Vec<Arc>) = (vec![], vec![]);
    let (mut first, mut last): (Option<DVec2>, Option<DVec2>) = (None, None);
    let add = |b: &mut Bytes, start: DVec2, end: DVec2, lines: &mut Vec<Line>, arcs: &mut Vec<Arc>| {
        if b.byte().is_multiple_of(3) {
            // Centre on the perpendicular bisector, h along it, maybe nudged.
            let h = b.num() * scale;
            let mid = (start + end) * 0.5;
            let centre = mid + (end - start).perp().normalize_or_zero() * h + if b.byte().is_multiple_of(4) { DVec2::new(b.num(), b.num()) * 1e-5 } else { DVec2::ZERO };
            arcs.push(Arc { start, end, centre });
        } else {
            lines.push(Line { a: start, b: end });
        }
    };
    for _ in 0..b.byte() % 16 {
        let start = match last {
            Some(end) if !b.byte().is_multiple_of(4) => end,
            _ => point(&mut b),
        };
        let end = point(&mut b);
        add(&mut b, start, end, &mut lines, &mut arcs);
        first.get_or_insert(start);
        last = Some(end);
    }
    if let (Some(f), Some(l)) = (first, last) {
        if b.byte().is_multiple_of(2) {
            add(&mut b, l, f, &mut lines, &mut arcs);
        }
    }
    let circles: Vec<Circle> = (0..b.byte() % 3).map(|_| Circle { centre: point(&mut b), radius: b.num() * scale }).collect();
    if let Ok(SketchOutline::Closed(profile, sources)) = sketching::sketch_outline(&lines, &circles, &arcs) {
        check_sources(&profile, &sources, &lines, &circles, &arcs);
        match extruding::extrude(&profile, 1.0) {
            Ok(body) => check_roles(&body, &profile, 1.0, &view_body(&body).expect("an extruded body always meshes")),
            Err(e) => panic!("a closed sketch outline did not extrude: {e}\n{lines:?}\n{circles:?}\n{arcs:?}"),
        }
    }
}

/// Each piece of a closed outline names the sketch curve it came from
/// (step 24b): every curve drawn is named exactly once, and piece i runs
/// between the outline's corners i and i + 1 the way `reversed` says
/// (within LINEAR, as ends are joined), shaped as that curve (a line's
/// bulge 0; an arc's its own bulge, negated when run backwards).
fn check_sources(profile: &Profile, sources: &[Source], lines: &[Line], circles: &[Circle], arcs: &[Arc]) {
    let near = |p: DVec2, q: DVec2| p.distance(q) <= LINEAR;
    match &profile.outer {
        Boundary::Circle { .. } => {
            assert_eq!(sources, [Source { curve: SketchCurve::Circle(0), reversed: false }]);
            assert!(lines.is_empty() && arcs.is_empty() && circles.len() == 1);
        }
        Boundary::Path { corners, bulges } => {
            let n = corners.len();
            assert_eq!(sources.len(), n, "{sources:?}");
            assert_eq!(n, lines.len() + arcs.len(), "every curve is a piece once");
            assert!(circles.is_empty());
            let mut used = std::collections::HashSet::new();
            for (i, s) in sources.iter().enumerate() {
                assert!(used.insert(s.curve), "{:?} named twice", s.curve);
                let (a, b, bulge) = match s.curve {
                    SketchCurve::Line(j) => (lines[j].a, lines[j].b, 0.0),
                    SketchCurve::Arc(j) => (arcs[j].start, arcs[j].end, arcs[j].bulge()),
                    SketchCurve::Circle(_) => panic!("a circle in a path: {sources:?}"),
                };
                let (from, to, bulge) = if s.reversed { (b, a, -bulge) } else { (a, b, bulge) };
                assert!(near(from, corners[i]) && near(to, corners[(i + 1) % n]), "piece {i} {s:?} runs {from} → {to}, corners {corners:?}");
                let got = bulges.get(i).copied().unwrap_or(0.0);
                assert!(got == bulge + 0.0, "piece {i} {s:?}: bulge {got} vs {bulge}");
            }
        }
    }
}

/// Every face of an extrude has a role and no two the same: the start and
/// end caps and one side per piece of each loop, numbered as given (step
/// 24b). Both caps have the profile's area, the end cap's centroid is the
/// start's moved up by d, and the faces' areas add up to the body's.
fn check_roles(body: &Body, profile: &Profile, d: f64, view: &fission_kernel::BodyView) {
    let mut want = vec![FaceRole::Start, FaceRole::End];
    for (k, l) in std::iter::once(&profile.outer).chain(&profile.holes).enumerate() {
        let n = match l {
            Boundary::Path { corners, .. } => corners.len(),
            Boundary::Circle { .. } => 1,
        };
        want.extend((0..n).map(|piece| FaceRole::Side(Some(Piece { boundary: k, piece }))));
    }
    let mut got: Vec<FaceRole> = body.faces.iter().map(|f| f.role.expect("every face has a role")).collect();
    let key = |r: &FaceRole| format!("{r:?}");
    got.sort_by_key(key);
    want.sort_by_key(key);
    assert_eq!(got, want, "{profile:?} d={d}");
    let face = |r: FaceRole| body.faces.iter().position(|f| f.role == Some(r)).unwrap();
    let (s, e) = (face(FaceRole::Start), face(FaceRole::End));
    let (lo, hi) = body.bounds();
    let reach = lo.abs().max(hi.abs()).max_element().max(1.0);
    let size = (hi - lo).length().max(1.0);
    let total: f64 = view.face_areas.iter().sum();
    assert!((total - view.area).abs() <= 1e-9 * view.area, "faces {total} vs body {}\n{profile:?} d={d}", view.area);
    let (a0, a1) = (view.face_areas[s], view.face_areas[e]);
    assert!((a0 - a1).abs() <= 1e-9 * a0.max(1e-300) + 1e-12 * size * size, "caps {a0} vs {a1}\n{profile:?} d={d}");
    let rise = DVec3::from(view.face_centroids[e]) - DVec3::from(view.face_centroids[s]);
    let off = (rise - DVec3::new(0.0, 0.0, d)).length();
    assert!(off <= 1e-9 * reach + 1e-6 * size, "end cap is {rise} from the start cap, not d = {d}\n{profile:?}");
}

/// Moves and turns any number of times, then mesh and bake: the body must
/// stay valid, in model space, and keep its volume within rounding.
pub fn placed(data: &[u8]) {
    let mut b = Bytes::new(data);
    let made = match b.byte() % 3 {
        0 => primitives::make_box(b.num(), b.num(), b.num()),
        1 => primitives::make_cylinder(b.num(), b.num()),
        _ => primitives::make_sphere(b.num()),
    };
    let Ok(body) = made else { return };
    let before = fission_kernel::mass::mass_properties(&body);
    let mut p = Placed::new(body);
    while !b.empty() {
        let v = |b: &mut Bytes| DVec3::new(b.num(), b.num(), b.num());
        let next = if b.byte().is_multiple_of(2) {
            let by = v(&mut b) * 10f64.powi((b.byte() % 9) as i32);
            transform::translate(&p, by)
        } else {
            let (pivot, axis, angle) = (v(&mut b) * 1e4, v(&mut b), b.num());
            transform::rotate(&p, pivot, axis, angle)
        };
        if let Ok(q) = next {
            p = q;
        }
    }
    let (lo, hi) = p.bounds();
    let reach = lo.abs().max(hi.abs()).max_element();
    assert!(reach <= fission_kernel::tolerance::MAX_COORD, "outside model space: {lo} {hi}");
    let mesh = p.tessellate(&TessOptions::DISPLAY).expect("a placed body always meshes");
    assert!(mesh.check_closed().is_ok());
    let baked = p.baked();
    if let Err(e) = validate(&baked) {
        panic!("baked body invalid: {}", e[0]);
    }
    let after = fission_kernel::mass::mass_properties(&baked);
    let slack = 1e-9 * before.volume + before.area * 64.0 * f64::EPSILON * reach.max(1.0);
    assert!((after.volume - before.volume).abs() <= slack, "volume {} became {}", before.volume, after.volume);
}
