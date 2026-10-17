//! Time budget for the costliest legal extrusion: a 100 m square plate with
//! 1,996 round holes, the most corners a profile may have (MAX_PROFILE_CORNERS:
//! 4 + 1,996, a circle counting as one), each hole big enough that its
//! circles get the most chords allowed (MAX_SEGMENTS_PER_TURN). This is what
//! make_extrude does for the app, end to end: check the profile, build,
//! validate, tessellate, and shape the mesh for the viewer.
//!
//! Before this test (crash-testing found it) one such extrude took 45 s
//! natively: the body was validated twice and tessellated four times, and
//! two steps scanned every triangle once per face (2,000 faces × 2,000,000
//! triangles). It now takes ~8 s in this debug build. The budget leaves room
//! for a slower CI machine while failing if any of that work comes back.
//! Its own test binary, so it runs alone rather than beside other tests.
use fission_kernel::tolerance::{rel_eq, FP_REL, MAX_PROFILE_CORNERS, MAX_SEGMENTS_PER_TURN};
use fission_kernel::{view_of, BodySpec, BoundaryIn, ProfileIn};
use std::time::{Duration, Instant};

/// Wall-clock budget for the whole make_extrude path.
const BUDGET: Duration = Duration::from_secs(25);

#[test]
fn the_largest_legal_hole_pattern_extrudes_within_budget() {
    let (side, grid, holes, height) = (1e5, 45, MAX_PROFILE_CORNERS - 4, 10.0);
    let cell = side / grid as f64;
    let r = 0.3 * cell;
    let circles: Vec<BoundaryIn> = (0..grid * grid)
        .take(holes)
        .map(|k| BoundaryIn::Circle { center: [((k / grid) as f64 + 0.5) * cell, ((k % grid) as f64 + 0.5) * cell], radius: r })
        .collect();
    let spec = BodySpec::Extrude {
        profile: ProfileIn {
            outer: BoundaryIn::Path { corners: vec![0.0, 0.0, side, 0.0, side, side, 0.0, side], bulges: vec![] },
            holes: circles,
        },
        distance: height,
    };
    let start = Instant::now();
    let view = view_of(spec).expect("a valid plate");
    let took = start.elapsed();
    // The result is still right. Volume by hand: the square less 1,996
    // circles of radius r, times the height.
    let expected = (side * side - holes as f64 * std::f64::consts::PI * r * r) * height;
    assert!(rel_eq(view.volume, expected, FP_REL), "{} vs {expected}", view.volume);
    assert!(view.errors.is_empty(), "{:?}", view.errors);
    // Faces: two caps, 4 walls, a wall per hole. Triangles: each hole's
    // circles get s = MAX_SEGMENTS_PER_TURN chords (r ≈ 667 mm would need
    // ~574 for the 0.01 mm chord limit); a cap with n = 4 + 1,996·s boundary
    // points and h = 1,996 holes has n + 2h − 2 triangles (the angle count
    // in tessellate's a_region_with_holes_triangulates_by_hand), each hole
    // wall 2s, each straight wall 2.
    let s = MAX_SEGMENTS_PER_TURN as usize;
    let cap = 4 + holes * s + 2 * holes - 2;
    assert_eq!(view.faces, 2 + 4 + holes);
    assert_eq!(view.mesh.indices.len() / 3, 2 * cap + holes * 2 * s + 4 * 2);
    assert!(took < BUDGET, "make_extrude took {took:?}, budget {BUDGET:?}");
    println!("worst legal extrude: {took:?} (budget {BUDGET:?})");
}
