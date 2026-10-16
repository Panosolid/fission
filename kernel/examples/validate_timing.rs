//! Times `validate` on the largest profile allowed (MAX_PROFILE_CORNERS
//! corners, every side a shallow arc bulging outwards), extruded.
//! Run: `cargo run --release --example validate_timing`
use fission_kernel::ops::extrude::extrude;
use fission_kernel::ops::profile::{Boundary, Profile};
use fission_kernel::tolerance::MAX_PROFILE_CORNERS;
use fission_kernel::validate::validate;
use glam::DVec2;

fn main() {
    let n = MAX_PROFILE_CORNERS;
    let corners: Vec<DVec2> = (0..n)
        .map(|i| DVec2::from_angle(std::f64::consts::TAU * i as f64 / n as f64) * 100.0)
        .collect();
    let profile = Profile { outer: Boundary::Path { corners, bulges: vec![0.05; n] }, holes: vec![] };
    let t = std::time::Instant::now();
    let body = extrude(&profile, 10.0).expect("a valid star");
    println!("extrude (includes validate): {:?}", t.elapsed());
    let t = std::time::Instant::now();
    validate(&body).expect("valid");
    println!("validate alone: {:?} ({} edges, {} faces)", t.elapsed(), body.edges.len(), body.faces.len());
}
