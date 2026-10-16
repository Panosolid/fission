//! Speed and memory of the kernel's key operations, for `tests/baseline.json`
//! (checked in CI by `.github/scripts/baseline.py`, test audit item 3).
//!
//! `cargo run --release --example baseline` prints one JSON object: for each
//! operation its peak extra heap (`peak_bytes`) and number of allocations
//! (`allocations`), counted by a wrapping allocator, so the same code gives
//! the same numbers on any machine; and its wall time (`nanos`, the median
//! of 9 runs, which varies by machine and load, so it is only reported).
//! `-- --one <op>` runs one operation once inside `measured`, for callgrind:
//! `valgrind --tool=callgrind --toggle-collect='*measured*'` then counts the
//! instructions it executes, the speed metric CI holds to the baseline.
//!
//! Every operation runs once first, unmeasured, so one-time set-up (lazy
//! tables, the first page of a pool) is not counted against it.
use fission_kernel::mass::mass_properties;
use fission_kernel::ops::extrude::extrude;
use fission_kernel::ops::primitives::{make_box, make_cylinder, make_sphere};
use fission_kernel::ops::profile::{Boundary, Profile};
use fission_kernel::ops::transform::rotate;
use fission_kernel::placed::Placed;
use fission_kernel::stl;
use fission_kernel::tessellate::{tessellate, TessOptions};
use fission_kernel::validate::validate;
use glam::{DVec2, DVec3};
use std::alloc::{GlobalAlloc, Layout, System};
use std::any::Any;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

/// The system allocator, counting live bytes, their peak and allocations.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static COUNT: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let live = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(live, Relaxed);
            COUNT.fetch_add(1, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, layout, new_size) };
        if !q.is_null() {
            if new_size >= layout.size() {
                let live = LIVE.fetch_add(new_size - layout.size(), Relaxed) + new_size - layout.size();
                PEAK.fetch_max(live, Relaxed);
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Relaxed);
            }
            COUNT.fetch_add(1, Relaxed);
        }
        q
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

type Run = Box<dyn FnMut() -> Box<dyn Any>>;

/// A star of `n` corners whose sides bulge outwards a little: arcs and
/// lines, like a real sketch.
fn star(n: usize, r: f64) -> Profile {
    let corners = (0..n).map(|i| DVec2::from_angle(std::f64::consts::TAU * i as f64 / n as f64) * if i % 2 == 0 { r } else { r * 0.6 }).collect();
    let bulges = (0..n).map(|i| if i % 3 == 0 { 0.1 } else { 0.0 }).collect();
    Profile { outer: Boundary::Path { corners, bulges }, holes: vec![] }
}

/// A regular polygon of `n` corners, every side a shallow arc bulging
/// outwards (as examples/validate_timing.rs, smaller).
fn arcs(n: usize, r: f64) -> Profile {
    let corners = (0..n).map(|i| DVec2::from_angle(std::f64::consts::TAU * i as f64 / n as f64) * r).collect();
    Profile { outer: Boundary::Path { corners, bulges: vec![0.05; n] }, holes: vec![] }
}

/// The operations, each with its input made outside the measured part.
fn operations() -> Vec<(&'static str, Run)> {
    let boxed = |x: Box<dyn Any>| x;
    let sphere = make_sphere(25.0).unwrap();
    let sphere_mesh = tessellate(&sphere, &TessOptions::DISPLAY).unwrap();
    let sphere_stl = stl::export(&sphere_mesh, "ball").bytes;
    let star_body = extrude(&star(24, 30.0), 10.0).unwrap();
    let cylinder = Placed::new(make_cylinder(10.0, 30.0).unwrap());
    vec![
        ("make_box", Box::new(move || boxed(Box::new(make_box(40.0, 30.0, 20.0).unwrap())))),
        ("make_cylinder", Box::new(move || boxed(Box::new(make_cylinder(10.0, 30.0).unwrap())))),
        ("make_sphere", Box::new(move || boxed(Box::new(make_sphere(25.0).unwrap())))),
        ("extrude_star_24", Box::new(move || boxed(Box::new(extrude(&star(24, 30.0), 10.0).unwrap())))),
        ("extrude_arcs_200", Box::new(move || boxed(Box::new(extrude(&arcs(200, 100.0), 10.0).unwrap())))),
        ("validate_star_24", {
            let b = star_body.clone();
            Box::new(move || boxed(Box::new(validate(&b).is_ok())))
        }),
        ("mass_star_24", {
            let b = star_body.clone();
            Box::new(move || boxed(Box::new(mass_properties(&b))))
        }),
        ("tessellate_sphere", Box::new(move || boxed(Box::new(tessellate(&sphere, &TessOptions::DISPLAY).unwrap())))),
        ("tessellate_star_24", Box::new(move || boxed(Box::new(tessellate(&star_body, &TessOptions::DISPLAY).unwrap())))),
        ("rotate_cylinder", Box::new(move || boxed(Box::new(rotate(&cylinder, DVec3::ZERO, DVec3::X, 0.7).unwrap())))),
        ("stl_export_sphere", Box::new(move || boxed(Box::new(stl::export(&sphere_mesh, "ball"))))),
        ("stl_read_sphere", Box::new(move || {
            let read = stl::read(&sphere_stl).unwrap();
            let welded = read.welded();
            boxed(Box::new((welded.check_closed().is_ok(), read)))
        })),
        ("stl_of_box", Box::new(move || {
            let spec = serde_json::from_str(r#"{"box": {"width": 40, "depth": 30, "height": 20}}"#).unwrap();
            boxed(Box::new(fission_kernel::stl_of(spec, "part").unwrap().bytes))
        })),
    ]
}

/// The one function callgrind counts (its name is what `--toggle-collect` matches).
#[inline(never)]
fn measured(run: &mut Run) -> Box<dyn Any> {
    std::hint::black_box(run())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut ops = operations();
    if let Some(i) = args.iter().position(|a| a == "--one") {
        let name = args.get(i + 1).expect("--one <operation>");
        let (_, run) = ops.iter_mut().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no operation {name}"));
        drop(run()); // warm-up, not counted
        drop(measured(run));
        return;
    }
    if args.iter().any(|a| a == "--list") {
        for (name, _) in &ops {
            println!("{name}");
        }
        return;
    }
    let mut out = Vec::new();
    for (name, run) in ops.iter_mut() {
        drop(run());
        let start = LIVE.load(Relaxed);
        PEAK.store(start, Relaxed);
        let count = COUNT.load(Relaxed);
        let result = measured(run);
        let peak = PEAK.load(Relaxed) - start;
        let allocations = COUNT.load(Relaxed) - count;
        drop(result);
        let mut times: Vec<u128> = (0..9)
            .map(|_| {
                let t = std::time::Instant::now();
                drop(measured(run));
                t.elapsed().as_nanos()
            })
            .collect();
        times.sort();
        out.push(format!(r#"  "{name}": {{"peak_bytes": {peak}, "allocations": {allocations}, "nanos": {}}}"#, times[4]));
    }
    println!("{{\n{}\n}}", out.join(",\n"));
}
