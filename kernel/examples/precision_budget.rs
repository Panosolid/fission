//! How many digits do intersections lose, by part size and distance from
//! the origin? Random circles and lines crossing planes, cylinders and
//! spheres (all pieces about `size` across, placed `offset` from the
//! origin, turned at random). For every meeting point the kernel finds we
//! measure how far it is from the surface (it lies on the curve by
//! construction). Candidates more than size × 1e-9 off are near misses the
//! kernel's measuring step throws away, so they are not counted. The worst of these is the rounding an intersection adds
//! before any boolean logic runs; compare it with `tolerance::LINEAR`.
//!
//! cargo run --release --example precision_budget
// Expected values may use the f64 maths methods (clippy.toml, src/fmath.rs).
#![allow(clippy::disallowed_methods)]

use fission_kernel::geom::{Curve, Surface};
use fission_kernel::intersect::curve_surface;
use fission_kernel::tolerance::LINEAR;
use glam::DVec3;

struct Lcg(u64);
impl Lcg {
    fn f(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn unit(&mut self) -> DVec3 {
        loop {
            let v = DVec3::new(self.f() * 2.0 - 1.0, self.f() * 2.0 - 1.0, self.f() * 2.0 - 1.0);
            if v.length() > 0.1 && v.length() < 1.0 {
                return v.normalize();
            }
        }
    }
}

fn perp(a: DVec3, r: &mut Lcg) -> DVec3 {
    a.cross(r.unit()).normalize()
}

fn speed(c: &Curve) -> f64 {
    match c {
        Curve::Line { .. } => 1.0,
        Curve::Circle { radius, .. } => *radius,
    }
}

fn normal(s: &Surface, p: DVec3) -> DVec3 {
    match s {
        Surface::Plane { normal, .. } => *normal,
        Surface::Cylinder { origin, axis, .. } => {
            let q = p - *origin;
            (q - *axis * q.dot(*axis)).normalize()
        }
        Surface::Sphere { center, .. } => (p - *center).normalize(),
    }
}

fn main() {
    let mut r = Lcg(0x5eed);
    println!("LINEAR = {LINEAR:e} mm; worst distance of a found meeting point from the surface:");
    println!("{:>10} {:>10} {:>12} {:>12} {:>10}", "size mm", "offset mm", "worst", "worst/LINEAR", "points");
    println!("{:>60}", "worst slide along the curve, by sin(crossing angle): >0.1  0.01-0.1  1e-3-0.01  1e-4-1e-3  <1e-4");
    for &size in &[1e2, 1e4, 1e6, 1e7] {
        for &offset in &[0.0, 1e6, 1e8] {
            let (mut worst, mut n) = (0.0f64, 0);
            let mut slide = [0.0f64; 5];
            for _ in 0..4000 {
                let at = r.unit() * offset;
                let (a, b) = (r.unit(), r.unit());
                let curve = if r.f() < 0.5 {
                    Curve::Line { origin: at + r.unit() * size * 0.3, dir: a }
                } else {
                    Curve::Circle { center: at + r.unit() * size * 0.3, axis: a, x_dir: perp(a, &mut r), radius: size * (0.2 + r.f()) }
                };
                let c = at + r.unit() * size * 0.3;
                let surface = match (r.f() * 3.0) as u32 {
                    0 => Surface::Plane { origin: c, normal: b, x_dir: perp(b, &mut r) },
                    1 => Surface::Cylinder { origin: c, axis: b, x_dir: perp(b, &mut r), radius: size * (0.2 + r.f()) },
                    _ => Surface::Sphere { center: c, axis: b, x_dir: perp(b, &mut r), radius: size * (0.2 + r.f()) },
                };
                for t in curve_surface(&curve, &surface, &[]) {
                    // Candidates include closest approaches of near misses;
                    // keep only real meetings (a miss is far further off
                    // than any rounding).
                    let d = surface.distance(curve.eval(t));
                    if d < size * 1e-9 {
                        worst = worst.max(d);
                        n += 1;
                        // Along the curve the point is only known to
                        // d / sin(crossing angle): grazing crossings slide.
                        let p = curve.eval(t);
                        let h = 1e-6 * size;
                        let tangent = (curve.eval(t + h / speed(&curve)) - curve.eval(t - h / speed(&curve))).normalize();
                        let s = tangent.dot(normal(&surface, p)).abs().max(1e-300);
                        let k = ((-s.log10()).floor().clamp(0.0, 4.0)) as usize;
                        slide[k] = slide[k].max(d / s);
                    }
                }
            }
            println!("{size:>10.0e} {offset:>10.0e} {worst:>12.2e} {:>12.3} {n:>10}   {}", worst / LINEAR,
                slide.iter().map(|x| format!("{x:>9.1e}")).collect::<Vec<_>>().join(" "));
        }
    }
}
