//! Where flat things meet (step 31c): the line where two planes cross, the
//! point where a line crosses a plane, and which side of a plane a point
//! is on, within a tolerance. Each answer carries a bound on how far its
//! own rounding can have put it off the planes and lines it came from, so
//! the boolean's facts table (32a) can tell a crossing known to within a
//! tolerance from one that isn't, instead of trusting the digits.
//!
//! Like `intersect.rs`, these only compute; whether two things are the same
//! or apart is the facts table's to decide (B0 decision 7, rule 2). The one
//! three-valued answer here, `Plane::side`, takes the tolerance it is given
//! (a vertex against a plane: the vertex's own, B0 decision 5).
//!
//! How the plane–plane line is found. With unit normals n₁, n₂ and the
//! planes n₁·x = n₁·o₁, n₂·x = n₂·o₂, the line runs along c = n₁ × n₂,
//! |c| = sin θ. Its point nearest a work origin w is
//!   p = w + (h₁ (n₂ × c) + h₂ (c × n₁)) / |c|²,   hᵢ = nᵢ·(oᵢ − w),
//! since n₁·(n₂ × c) = c·(n₁ × n₂) = |c|² and n₁·(c × n₁) = 0 (so
//! n₁·(p − w) = h₁, and likewise for plane 2), and both terms are square
//! to c (so p − w has no part along the line, which makes p the nearest).
//!
//! The direction is worked out as n₁ × (n₂ − n₁) (or n₁ × (n₂ + n₁) when
//! the normals face apart), equal to n₁ × n₂ in exact arithmetic since
//! n₁ × n₁ = 0. For nearly parallel planes n₂ − n₁ is small and computed
//! with an error a few ulps of itself, so c comes out with a relative error
//! of a few ulps however small θ is; crossed directly, two nearly equal
//! unit vectors give c with an absolute error of an ulp or so, which is a
//! relative error of ulp ÷ sin θ: at θ = 1e-8 the line would turn 2e-8 rad
//! off both planes, 20 µm at a metre along it. (|n₂ ∓ n₁| = 2 sin(θ/2), or
//! 2 cos(θ/2) facing apart; the smaller is at most √2 sin θ, so the error
//! of c, a few ulps of |n₂ ∓ n₁|, is a few ulps of sin θ.)
//!
//! The bounds (`MeetLine::err`, `drift`; `LineMeet::Point::err`) are
//! ROUNDING_ULPS (64) ulps of the sizes the arithmetic runs through, a
//! generous allowance over the dozen or so roundings each answer goes
//! through (the working is beside each). The point's own bound is about
//! ulp × offset ÷ sin θ: the line of two nearly parallel planes lies far
//! from the work origin unless both planes pass close to it, and a point
//! that far out is only stored to that many digits, whatever the method.
//! So for planes crossing at 1e-6 rad, each 1 mm from the work origin,
//! the bound is ~6e-8 mm; 1 m from it, ~6e-5 mm, more than LINEAR. That
//! bound is the facts table's to weigh (the catalogue's "nearly parallel
//! planes crossing at an angle between ANGULAR and 1e-6 rad"), never this
//! file's to round away. Below ANGULAR planes count as parallel and no
//! line is looked for: whether they are one plane is the side test's.
//!
//! Every function is total: a non-finite input gives None (or, for `side`,
//! ON, the answer that is never forced into IN or OUT).

use crate::geom::{self, Surface};
use crate::tolerance::{rounding_slack, ANGULAR};
use glam::DVec3;

/// A plane through `origin` square to the unit vector `normal`; its
/// positive side is the side `normal` points to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plane {
    origin: DVec3,
    normal: DVec3,
}

/// Which side of a plane a point is on, within a tolerance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Below,
    On,
    Above,
}

impl Plane {
    /// The plane through `origin` square to `normal` (made unit by
    /// `geom::unit`); None if either is not finite or `normal` is zero.
    pub fn through(origin: DVec3, normal: DVec3) -> Option<Plane> {
        if !origin.is_finite() {
            return None;
        }
        Some(Plane { origin, normal: geom::unit(normal)? })
    }

    /// A planar surface's plane, its natural normal kept; None for a
    /// cylinder or sphere (or a plane that isn't finite).
    pub fn of_surface(surface: &Surface) -> Option<Plane> {
        match *surface {
            Surface::Plane { origin, normal, .. } => Plane::through(origin, normal),
            _ => None,
        }
    }

    pub fn origin(&self) -> DVec3 {
        self.origin
    }

    pub fn normal(&self) -> DVec3 {
        self.normal
    }

    /// (p − origin)·normal: how far `p` is above the plane. Off by at most
    /// ~4 ulps of |p − origin| (a subtraction and a three-term dot).
    pub fn signed_distance(&self, p: DVec3) -> f64 {
        (p - self.origin).dot(self.normal)
    }

    /// Above or below when `p` is further than `tol` from the plane, else
    /// ON (a point exactly `tol` away is ON). Anything unmeasurable (a
    /// non-finite point, a NaN tolerance) is ON, the answer the boolean
    /// sends to its coincidence code and never forces into IN or OUT. The
    /// distance's own rounding, ~4 ulps of |p − origin|, is at most ~3e-7
    /// LINEAR for two points of model space (at most 2√3·MAX_COORD apart),
    /// so a point 0.9× or 1.1× of any tolerance from LINEAR up is sided as
    /// in exact arithmetic.
    pub fn side(&self, p: DVec3, tol: f64) -> Side {
        let d = self.signed_distance(p);
        // NaN fails every test, so lands on ON; so does a point exactly on
        // the plane, even against a (meaningless) negative tolerance.
        if d.abs() > tol && d > 0.0 {
            Side::Above
        } else if d.abs() > tol && d < 0.0 {
            Side::Below
        } else {
            Side::On
        }
    }
}

/// The line where two planes cross: `point + t·dir` for real t. In exact
/// arithmetic on the planes as stored, that point lies within `bound_at(t)`
/// of both planes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeetLine {
    /// The line's point nearest the work origin (to within `err`).
    pub point: DVec3,
    /// Unit, along n₁ × n₂.
    pub dir: DVec3,
    /// How far `point` may be from either plane.
    pub err: f64,
    /// How far the line may lean off either plane per unit along it: the
    /// most |nᵢ·dir| can be.
    pub drift: f64,
}

impl MeetLine {
    pub fn at(&self, t: f64) -> DVec3 {
        self.point + self.dir * t
    }

    /// How far `at(t)` may be from either plane: the point's error and the
    /// lean over |t| (plus the rounding of `at` itself, an ulp or two of
    /// |at(t)|, within the 64-ulp allowances).
    pub fn bound_at(&self, t: f64) -> f64 {
        self.err + t.abs() * self.drift
    }
}

/// What two planes make.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlanesMeet {
    /// The normals are within ANGULAR of parallel (|n₁ × n₂| ≤ ANGULAR);
    /// `same_sense` when they point the same way (n₁·n₂ ≥ 0). Whether the
    /// planes are one plane is the side test's to say, at the tolerance of
    /// whatever lies on them.
    Parallel { same_sense: bool },
    Line(MeetLine),
}

/// Where planes `a` and `b` cross, as the line's point nearest `near`
/// (the boolean's work origin, so offsets and rounding stay small). None
/// if `near` isn't finite or the answer or its bound overflows (past
/// ~1e154 from the work origin, far outside model space).
pub fn planes(a: &Plane, b: &Plane, near: DVec3) -> Option<PlanesMeet> {
    if !near.is_finite() {
        return None;
    }
    let (n1, n2) = (a.normal, b.normal);
    let same_sense = n1.dot(n2) >= 0.0;
    let gap = if same_sense { n2 - n1 } else { n2 + n1 };
    let c = n1.cross(gap);
    let sin = c.length();
    // Finite unit normals give a finite sin.
    if sin <= ANGULAR {
        return Some(PlanesMeet::Parallel { same_sense });
    }
    // c is n₁ × n₂ to a few ulps (module comment), and sin ≥ ANGULAR, so
    // sin² ≥ 1e-18 can't underflow.
    let dir = geom::unit(c)?;
    let h1 = n1.dot(a.origin - near);
    let h2 = n2.dot(b.origin - near);
    let offset = (n2.cross(c) * h1 + c.cross(n1) * h2) / (sin * sin);
    let point = near + offset;
    // The point's rounding: oᵢ − w, its dot with nᵢ, the products with
    // n₂ × c and c × n₁ (each of size sin, to a few ulps of it), the sum,
    // the division by sin² and the move from w each add a few ulps of the
    // size they work at: |oᵢ − w|, |h₁|/sin + |h₂|/sin (each term's size,
    // which also bounds |p − w|) and |w| + |p − w| (the size of p). Each
    // shifts p by that much at most, so in any direction, and the distance
    // to a plane by no more. 64 ulps of their sum covers them with room.
    let scale = near.length()
        + (a.origin - near).length()
        + (b.origin - near).length()
        + (h1.abs() + h2.abs()) / sin
        + offset.length();
    // The lean: nᵢ·c is 0 in exact arithmetic, and the roundings of
    // n₂ ∓ n₁ and of the cross product leave a few ulps of |n₂ ∓ n₁| ≤ √2
    // sin, so a few ulps of |c|; making c unit adds an ulp or two.
    let err = rounding_slack(scale);
    let drift = rounding_slack(1.0);
    if !point.is_finite() || !err.is_finite() {
        return None;
    }
    Some(PlanesMeet::Line(MeetLine { point, dir, err, drift }))
}

/// What a line makes with a plane.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineMeet {
    /// The line is within ANGULAR of parallel to the plane (|n·dir| ≤
    /// ANGULAR, dir made unit). Whether it lies in it is the side test's.
    Parallel,
    /// It crosses at `point`, `t` along the unit direction from `origin`;
    /// `point` is within `err` of both the plane and the line. For a
    /// shallow crossing `t` itself may slide by err ÷ sin(angle) along the
    /// line: every point of that stretch is on both to within the bound.
    Point { t: f64, point: DVec3, err: f64 },
}

/// Where the line through `origin` along `dir` crosses `plane`. None if
/// `origin` isn't finite, `dir` is zero or not finite, or the answer or
/// its bound overflows (past ~1e154, far outside model space).
pub fn line_plane(origin: DVec3, dir: DVec3, plane: &Plane) -> Option<LineMeet> {
    if !origin.is_finite() {
        return None;
    }
    let dir = geom::unit(dir)?;
    let along = plane.normal.dot(dir);
    if along.abs() <= ANGULAR {
        return Some(LineMeet::Parallel);
    }
    let h = plane.normal.dot(plane.origin - origin);
    let t = h / along;
    let point = origin + dir * t;
    // In exact arithmetic n·(point − o) = along·t − h + n·(rounding of
    // point). With h and along each a few ulps off (of |o − origin| and of
    // 1) and the division one more, along·t − h comes to a few ulps of
    // |o − origin| + |t|: the slip in `along` (≤ 3 ulps of 1, against an
    // `along` as small as ANGULAR) moves t a long way for a shallow
    // crossing, but along the line, where it costs only along·Δt ≈
    // 3 ulps·|t| off the plane. Forming dir·t and adding it to origin
    // round by an ulp of |t| and of |point|, off the plane and the line
    // alike; `dir` turned an ulp or so from the caller's direction adds an
    // ulp of |t| more off the line. 64 ulps of the sum covers both.
    let err = rounding_slack((plane.origin - origin).length() + t.abs() + point.length());
    if !point.is_finite() || !err.is_finite() {
        return None;
    }
    Some(LineMeet::Point { t, point, err })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accurate::{diff3, Dd};
    use crate::fmath;
    use crate::tolerance::{LINEAR, MAX_COORD};
    use std::f64::consts::{FRAC_1_SQRT_2, FRAC_PI_2};

    fn plane(origin: [f64; 3], normal: [f64; 3]) -> Plane {
        Plane::through(DVec3::from(origin), DVec3::from(normal)).unwrap()
    }

    fn line_of(a: &Plane, b: &Plane, near: DVec3) -> MeetLine {
        match planes(a, b, near) {
            Some(PlanesMeet::Line(l)) => l,
            other => panic!("expected a line, got {other:?}"),
        }
    }

    fn crossing(origin: DVec3, dir: DVec3, p: &Plane) -> (f64, DVec3, f64) {
        match line_plane(origin, dir, p) {
            Some(LineMeet::Point { t, point, err }) => (t, point, err),
            other => panic!("expected a point, got {other:?}"),
        }
    }

    /// n·(x − o) in double-double: x − o exact, each product and the sum
    /// to ~1e-32 of the largest term, so the plane's own distance as
    /// stored, the referee for every bound here.
    fn dd_dot(n: DVec3, w: [Dd; 3]) -> Dd {
        Dd::new(n.x) * w[0] + Dd::new(n.y) * w[1] + Dd::new(n.z) * w[2]
    }

    fn dd_distance(p: &Plane, x: DVec3) -> f64 {
        dd_dot(p.normal(), diff3(x, p.origin())).to_f64().abs()
    }

    #[test]
    fn two_upright_planes_cross_along_an_upright_line() {
        // x = 1 and y = 2 cross along the vertical line through (1, 2, 0).
        // With n₁ = X, n₂ = Y: c = X × (Y − X) = X × Y = Z, sin = 1;
        // from w = 0, h₁ = X·(1, 0, 0) = 1, h₂ = Y·(0, 2, 0) = 2, and
        // p = h₁ (Y × Z) + h₂ (Z × X) = 1·X + 2·Y = (1, 2, 0), all exact.
        let a = plane([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
        let b = plane([0.0, 2.0, 0.0], [0.0, 1.0, 0.0]);
        let l = line_of(&a, &b, DVec3::ZERO);
        assert_eq!((l.point, l.dir), (DVec3::new(1.0, 2.0, 0.0), DVec3::Z));
        // From w = (5, −3, 7) the nearest point is (1, 2, 7): h₁ = X·((1,
        // 0, 0) − w) = −4, h₂ = Y·((0, 2, 0) − w) = 5, p = w − 4X + 5Y.
        let l = line_of(&a, &b, DVec3::new(5.0, -3.0, 7.0));
        assert_eq!(l.point, DVec3::new(1.0, 2.0, 7.0));
        // Swapped, the line runs the other way: Y × X = −Z.
        assert_eq!(line_of(&b, &a, DVec3::ZERO).dir, DVec3::NEG_Z);
        // The bound: 64 ulps of |w| + |o₁ − w| + |o₂ − w| + (|h₁| + |h₂|)
        // ÷ sin + |p − w| = 0 + 1 + 2 + 3 + √5 (from w = 0).
        let l = line_of(&a, &b, DVec3::ZERO);
        assert_eq!(l.err, 64.0 * f64::EPSILON * (6.0 + 5f64.sqrt()));
        assert_eq!(l.drift, 64.0 * f64::EPSILON);
        assert_eq!(l.bound_at(-3.0), l.err + 3.0 * l.drift);
        assert_eq!(l.at(2.5), DVec3::new(1.0, 2.0, 2.5));
    }

    #[test]
    fn a_floor_and_a_slope_cross_along_its_foot() {
        // z = 0 and x + z = 2 (normal (1, 0, 1)/√2 through (2, 0, 0))
        // share the points with z = 0 and x = 2: the line along
        // Z × (1, 0, 1)/√2 = (0, 1/√2, 0), so along Y, sin 45° = 1/√2. Its
        // point nearest (5, 7, 9) is (2, 7, 0).
        let a = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let b = plane([2.0, 0.0, 0.0], [1.0, 0.0, 1.0]);
        let l = line_of(&a, &b, DVec3::new(5.0, 7.0, 9.0));
        assert!((l.point - DVec3::new(2.0, 7.0, 0.0)).length() <= l.err, "{l:?}");
        assert!((l.dir - DVec3::Y).length() <= 4.0 * f64::EPSILON, "{l:?}");
        // The bound, 64 ulps of |w| + |o₁ − w| + |o₂ − w| + (|h₁| + |h₂|)
        // ÷ sin + |p − w|: |w| = √155, o₁ − w = −w, o₂ − w = (−3, −7, −9)
        // so √139, h₁ = −9, h₂ = (−3 − 9)/√2, so (9 + 12/√2)·√2 = 9√2 +
        // 12, and p − w = (−3, 0, −9), √90: about 70.9 in all, ~1e-12 mm.
        let sum = 2.0 * 155f64.sqrt() + 139f64.sqrt() + 9.0 * 2f64.sqrt() + 12.0 + 90f64.sqrt();
        assert!((l.err / (64.0 * f64::EPSILON * sum) - 1.0).abs() < 1e-12, "{l:?} vs {sum}");
    }

    #[test]
    fn parallel_planes_say_which_way_they_face() {
        // Any two planes with the same or opposite normal, whatever their
        // spacing: no line.
        let floor = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        for (b, same_sense) in [
            (plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]), true),
            (plane([3.0, 1.0, 5.0], [0.0, 0.0, 2.0]), true),
            (plane([0.0, 0.0, 0.0], [0.0, 0.0, -1.0]), false),
            (plane([0.0, 0.0, -4.0], [0.0, 0.0, -1.0]), false),
        ] {
            assert_eq!(planes(&floor, &b, DVec3::ZERO), Some(PlanesMeet::Parallel { same_sense }), "{b:?}");
        }
        // Square planes face neither way; n₁·n₂ = 0 counts as the same
        // sense, so c = n₁ × (n₂ − n₁).
        let wall = plane([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
        assert_eq!(line_of(&floor, &wall, DVec3::ZERO).dir, DVec3::Y);
    }

    #[test]
    fn planes_are_parallel_at_0_9_angular_and_cross_at_1_1() {
        // n₂ = (sin a, 0, ±cos a) leans a off ±Z: |Z × n₂| = sin a, which
        // is a to ~a³/6 ≈ 2e-28 here.
        let floor = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        for sign in [1.0, -1.0] {
            let leaning = |a: f64, d: f64| {
                let (s, c) = fmath::sin_cos(a);
                plane([0.0, 0.0, d], [s, 0.0, sign * c])
            };
            let same_sense = sign > 0.0;
            assert_eq!(planes(&floor, &leaning(0.9 * ANGULAR, 0.0), DVec3::ZERO), Some(PlanesMeet::Parallel { same_sense }));
            assert_eq!(planes(&floor, &leaning(ANGULAR, 0.0), DVec3::ZERO), Some(PlanesMeet::Parallel { same_sense }));
            // At 1.1× they cross. Both through the origin: along Z × n₂ =
            // (0, sin a, 0) (either sign of cos a), so Y, through the origin.
            let l = line_of(&floor, &leaning(1.1 * ANGULAR, 0.0), DVec3::ZERO);
            assert_eq!((l.point, l.dir), (DVec3::ZERO, DVec3::Y), "sign {sign}");
            // The second plane 1 nm up instead crosses z = 0 where x sin a
            // = ±d cos a, x = ±d cot a = ±1e-6 / 1.1e-9 ≈ ±909.09 mm: two
            // planes a nanometre apart at the origin meet nearly a metre out.
            let (a, d) = (1.1 * ANGULAR, 1e-6);
            let l = line_of(&floor, &leaning(a, d), DVec3::ZERO);
            let (s, c) = fmath::sin_cos(a);
            let x = sign * d * c / s;
            assert!((l.point - DVec3::new(x, 0.0, 0.0)).length() <= l.err, "sign {sign}: {l:?} vs x {x}");
            assert!(l.err < 1e-10, "{l:?}");
        }
    }

    #[test]
    fn the_bound_is_small_where_it_should_be() {
        // Planes square to each other and to the floor, each 1 km from the
        // work origin: the bound is 64 ulps of 0 + 1e6 + 1e6 + 2e6 + √2·1e6
        // ≈ 5.4e6, so ~7.7e-8 mm, under LINEAR/100.
        let a = plane([1e6, 0.0, 0.0], [1.0, 0.0, 0.0]);
        let b = plane([0.0, 1e6, 0.0], [0.0, 1.0, 0.0]);
        let l = line_of(&a, &b, DVec3::ZERO);
        assert_eq!(l.point, DVec3::new(1e6, 1e6, 0.0));
        assert!(l.err < LINEAR / 100.0, "{}", l.err);
        // And it grows as the planes close: at 1e-6 rad, each 1 m from the
        // work origin, it passes LINEAR (module comment, ~6e-5 mm).
        let (s, c) = fmath::sin_cos(1e-6);
        let a = plane([0.0, 0.0, 1e3], [0.0, 0.0, 1.0]);
        let b = plane([0.0, 0.0, -1e3], [s, 0.0, c]);
        let l = line_of(&a, &b, DVec3::ZERO);
        assert!(l.err > LINEAR && l.err < 1e-4, "{}", l.err);
    }

    #[test]
    fn a_line_crosses_a_plane_by_hand() {
        // Straight down from (0, 0, 5) onto z = 0: 5 along, at the origin.
        let floor = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let (t, p, err) = crossing(DVec3::new(0.0, 0.0, 5.0), DVec3::NEG_Z, &floor);
        assert_eq!((t, p), (5.0, DVec3::ZERO));
        // The bound: 64 ulps of |o − origin| + |t| + |point| = 5 + 5 + 0.
        assert_eq!(err, 64.0 * f64::EPSILON * 10.0);
        // From (0, 0, 1) along (1, 0, −1), not unit: down 1 while across
        // 1, so it lands at (1, 0, 0), √2 along the unit direction.
        let (t, p, err) = crossing(DVec3::new(0.0, 0.0, 1.0), DVec3::new(1.0, 0.0, -1.0), &floor);
        assert!((t - 2f64.sqrt()).abs() <= 4.0 * f64::EPSILON, "{t}");
        assert!((p - DVec3::X).length() <= err, "{p}");
        // Upwards the same line meets it behind the start: t = −√2.
        let (t, _, _) = crossing(DVec3::new(0.0, 0.0, 1.0), DVec3::new(-1.0, 0.0, 1.0), &floor);
        assert!((t + 2f64.sqrt()).abs() <= 4.0 * f64::EPSILON, "{t}");
    }

    #[test]
    fn a_line_is_parallel_at_0_9_angular_and_crosses_at_1_1() {
        // dir = (cos a, 0, −sin a) dips a below z = 0's level: n·dir =
        // −sin a. From (0, 0, d) it lands where t sin a = d, t = d / sin a.
        let floor = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let dip = |a: f64| {
            let (s, c) = fmath::sin_cos(a);
            DVec3::new(c, 0.0, -s)
        };
        let start = DVec3::new(0.0, 0.0, 1e-6);
        assert_eq!(line_plane(start, dip(0.9 * ANGULAR), &floor), Some(LineMeet::Parallel));
        assert_eq!(line_plane(start, dip(ANGULAR), &floor), Some(LineMeet::Parallel));
        assert_eq!(line_plane(start, -dip(0.9 * ANGULAR), &floor), Some(LineMeet::Parallel));
        // At 1.1×: t = 1e-6 / 1.1e-9 ≈ 909.09 mm, at (t cos a, 0, 0).
        let a = 1.1 * ANGULAR;
        let (t, p, err) = crossing(start, dip(a), &floor);
        let (s, c) = fmath::sin_cos(a);
        let expect = 1e-6 / s;
        assert!((t - expect).abs() <= 4.0 * f64::EPSILON * expect, "{t} vs {expect}");
        assert!((p - DVec3::new(expect * c, 0.0, 0.0)).length() <= err, "{p}");
        // Backwards along the same line it lands behind the start.
        let (t, _, _) = crossing(start, -dip(a), &floor);
        assert!((t + expect).abs() <= 4.0 * f64::EPSILON * expect, "{t}");
    }

    #[test]
    fn side_at_0_9_and_1_1_of_the_tolerance() {
        let floor = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let at = |z: f64| DVec3::new(3.0, -4.0, z);
        for tol in [LINEAR, 5.0 * LINEAR, crate::tolerance::TOL_INPUT_MAX] {
            assert_eq!(floor.side(at(0.9 * tol), tol), Side::On, "{tol}");
            assert_eq!(floor.side(at(-0.9 * tol), tol), Side::On, "{tol}");
            assert_eq!(floor.side(at(tol), tol), Side::On, "exactly at {tol} is ON");
            assert_eq!(floor.side(at(1.1 * tol), tol), Side::Above, "{tol}");
            assert_eq!(floor.side(at(-1.1 * tol), tol), Side::Below, "{tol}");
        }
        // A grown tolerance decides: 3e-5 above is ON at 5e-5, above at LINEAR.
        assert_eq!(floor.side(at(3e-5), 5e-5), Side::On);
        assert_eq!(floor.side(at(3e-5), LINEAR), Side::Above);
        // Turned: normal (3, 4, 0)/5 through (1, 1, 1); a point 1.1×LINEAR
        // along it is above, 0.9× is ON, whatever its offset along the plane.
        let slope = plane([1.0, 1.0, 1.0], [3.0, 4.0, 0.0]);
        let n = DVec3::new(0.6, 0.8, 0.0);
        let along = DVec3::new(-4.0, 3.0, 7.0) * 1e3;
        for (k, side) in [(1.1, Side::Above), (0.9, Side::On), (-0.9, Side::On), (-1.1, Side::Below)] {
            assert_eq!(slope.side(DVec3::ONE + along + n * (k * LINEAR), LINEAR), side, "{k}");
        }
        // Unmeasurable is ON, never forced to a side.
        assert_eq!(floor.side(at(1.0), f64::NAN), Side::On);
        assert_eq!(floor.side(DVec3::new(f64::NAN, 0.0, 1.0), LINEAR), Side::On);
        assert_eq!(floor.side(DVec3::new(f64::INFINITY, 0.0, 1.0), LINEAR), Side::On);
        // An infinite tolerance is plainly ON; a negative one sides points
        // off the plane however close, but a point exactly on it stays ON.
        assert_eq!(floor.side(at(1e9), f64::INFINITY), Side::On);
        assert_eq!(floor.side(at(1e-300), -1.0), Side::Above);
        assert_eq!(floor.side(at(-1e-300), -1.0), Side::Below);
        assert_eq!(floor.side(at(0.0), -1.0), Side::On);
        assert_eq!(floor.side(at(-0.0), -1.0), Side::On);
        assert_eq!(floor.signed_distance(at(-2.5)), -2.5);
    }

    #[test]
    fn bad_inputs_give_none() {
        let nan = DVec3::new(f64::NAN, 0.0, 0.0);
        let inf = DVec3::new(0.0, f64::INFINITY, 0.0);
        for (o, n) in [(DVec3::ZERO, DVec3::ZERO), (nan, DVec3::Z), (inf, DVec3::Z), (DVec3::ZERO, nan), (DVec3::ZERO, inf)] {
            assert_eq!(Plane::through(o, n), None, "{o} {n}");
        }
        // A normal of any finite length is made unit: (3, 4, 0) → (0.6, 0.8, 0).
        // (To an ulp: 3/5 rounds to 0.6000000000000001 on the way.)
        for scale in [1e-200, 1.0, 1e200] {
            let p = plane([1.0, 2.0, 3.0], [3.0 * scale, 4.0 * scale, 0.0]);
            assert_eq!(p.origin(), DVec3::new(1.0, 2.0, 3.0));
            assert!((p.normal() - DVec3::new(0.6, 0.8, 0.0)).length() <= 2.0 * f64::EPSILON, "{p:?}");
        }
        let floor = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let wall = plane([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
        assert_eq!(planes(&floor, &wall, nan), None);
        assert_eq!(planes(&floor, &wall, inf), None);
        // Finite but so far out that the answer overflows.
        assert_eq!(planes(&floor, &wall, DVec3::new(f64::MAX, f64::MAX, 0.0)), None);
        // At 1e300 the point is finite but its bound (built from lengths,
        // whose squares overflow) is not; at 1e150 both are.
        assert_eq!(planes(&floor, &wall, DVec3::new(1e300, 0.0, 0.0)), None);
        assert!(planes(&floor, &wall, DVec3::new(1e150, 0.0, 0.0)).is_some());
        for (o, d) in [(nan, DVec3::Z), (inf, DVec3::Z), (DVec3::ZERO, DVec3::ZERO), (DVec3::ZERO, nan), (DVec3::ZERO, inf)] {
            assert_eq!(line_plane(o, d, &floor), None, "{o} {d}");
        }
        assert_eq!(line_plane(DVec3::new(0.0, 0.0, f64::MAX), DVec3::new(1.0, 0.0, -1e-8), &floor), None);
        assert_eq!(line_plane(DVec3::new(0.0, 0.0, 1e300), DVec3::NEG_Z, &floor), None);
        assert!(line_plane(DVec3::new(0.0, 0.0, 1e150), DVec3::NEG_Z, &floor).is_some());
    }

    #[test]
    fn surfaces_give_their_planes() {
        let s = Surface::Plane { origin: DVec3::new(1.0, 2.0, 3.0), normal: DVec3::Y, x_dir: DVec3::Z };
        assert_eq!(Plane::of_surface(&s), Some(plane([1.0, 2.0, 3.0], [0.0, 1.0, 0.0])));
        let s = Surface::Plane { origin: DVec3::new(f64::NAN, 2.0, 3.0), normal: DVec3::Y, x_dir: DVec3::Z };
        assert_eq!(Plane::of_surface(&s), None);
        let s = Surface::Cylinder { origin: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        assert_eq!(Plane::of_surface(&s), None);
        let s = Surface::Sphere { center: DVec3::ZERO, axis: DVec3::Z, x_dir: DVec3::X, radius: 1.0 };
        assert_eq!(Plane::of_surface(&s), None);
    }

    /// splitmix64, so a failing case replays from its number.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        /// Uniform in [0, 1).
        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
        fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
            xs[(self.next() % xs.len() as u64) as usize]
        }
        fn direction(&mut self) -> DVec3 {
            loop {
                let v = DVec3::new(self.unit(), self.unit(), self.unit()) * 2.0 - DVec3::ONE;
                if (0.1..=1.0).contains(&v.length()) {
                    return v.normalize();
                }
            }
        }
        /// Log-uniform from just over ANGULAR to π/2, so every decade of
        /// angle gets its share, the nearly parallel ones above all.
        fn angle(&mut self) -> f64 {
            let lo = 1.01 * ANGULAR;
            lo * fmath::powf(FRAC_PI_2 / lo, self.unit())
        }
        /// A unit vector at `angle` from `n`, turned a random way round it.
        fn leaning(&mut self, n: DVec3, angle: f64) -> DVec3 {
            let a = geom::any_perpendicular(n);
            let (s, c) = fmath::sin_cos(self.unit() * std::f64::consts::TAU);
            let across = a * c + n.cross(a) * s;
            let (s, c) = fmath::sin_cos(angle);
            n * c + across * s
        }
    }

    /// Sizes from a micrometre to a kilometre, and work origins at the
    /// origin, near it, and out to 100 km.
    const SCALES: [f64; 4] = [1e-3, 1.0, 1e3, 1e6];

    fn work_origin(rng: &mut Rng, scale: f64) -> DVec3 {
        match rng.next() % 4 {
            0 => DVec3::ZERO,
            1 => rng.direction() * scale,
            2 => rng.direction() * MAX_COORD * rng.unit(),
            _ => rng.direction() * 1e6 * rng.unit(),
        }
    }

    #[test]
    fn seeded_plane_pairs_cross_within_their_bound() {
        // 20,000 pairs, seed 31003: normals at every angle from 1.01×
        // ANGULAR to 90°, a quarter of them facing apart; planes through
        // random points up to `scale` from the work origin, or (a quarter)
        // both through one point, so h₁ ≈ h₂ and the two terms of p nearly
        // cancel. The referee is the planes themselves, in double-double:
        // the line's points along it must be within bound_at(t) of both,
        // its direction within drift of square to both normals, and its
        // point the nearest to the work origin, to within err.
        let mut rng = Rng(31003);
        let mut worst = 0.0f64;
        for case in 0..20_000 {
            let scale = rng.pick(&SCALES);
            let near = work_origin(&mut rng, scale);
            let n1 = rng.direction();
            let theta = rng.angle();
            let flip = if rng.next().is_multiple_of(4) { -1.0 } else { 1.0 };
            let n2 = rng.leaning(n1, theta) * flip;
            let (o1, o2) = if rng.next().is_multiple_of(4) {
                let p = near + rng.direction() * scale * rng.unit();
                (p, p)
            } else {
                (near + rng.direction() * scale * rng.unit(), near + rng.direction() * scale * rng.unit())
            };
            let (a, b) = (Plane::through(o1, n1).unwrap(), Plane::through(o2, n2).unwrap());
            let l = line_of(&a, &b, near);
            let why = || format!("case {case}: θ {theta:e}, scale {scale:e}, {a:?} {b:?} near {near} → {l:?}");
            for n in [a.normal(), b.normal()] {
                let lean = dd_dot(n, [Dd::new(l.dir.x), Dd::new(l.dir.y), Dd::new(l.dir.z)]).to_f64().abs();
                assert!(lean <= l.drift, "lean {lean:e}: {}", why());
                worst = worst.max(lean / l.drift);
            }
            assert!((l.dir.length() - 1.0).abs() <= 4.0 * f64::EPSILON, "{}", why());
            let along = dd_dot(l.dir, diff3(l.point, near)).to_f64().abs();
            assert!(along <= l.err, "not the nearest point, {along:e} along: {}", why());
            for t in [0.0, scale, -scale, 1e3 * scale, -1e3 * scale] {
                let x = l.at(t);
                for p in [&a, &b] {
                    let d = dd_distance(p, x);
                    assert!(d <= l.bound_at(t), "t {t:e}: {d:e} off: {}", why());
                    worst = worst.max(d / l.bound_at(t));
                }
            }
        }
        println!("worst error / bound over 20,000 plane pairs: {worst:.3e}");
    }

    #[test]
    fn seeded_lines_cross_planes_within_their_bound() {
        // 20,000 lines and planes, seed 31004: the line at every angle to
        // the plane from 1.01× ANGULAR to 90°, from either side, its
        // direction given at a length from 1e-3 to 1e3; the plane through a
        // point up to `scale` from the line's start. The crossing must be
        // within err of the plane and of the line (double-double), and t
        // along it from the start to within err.
        let mut rng = Rng(31004);
        let mut worst = 0.0f64;
        for case in 0..20_000 {
            let scale = rng.pick(&SCALES);
            let start = work_origin(&mut rng, scale);
            let u = rng.direction();
            let alpha = rng.angle();
            // n at 90° − α from u, so the line meets the plane at α.
            let n = rng.leaning(u, FRAC_PI_2 - alpha) * rng.pick(&[1.0, -1.0]);
            let p = Plane::through(start + rng.direction() * scale * rng.unit(), n).unwrap();
            let dir = u * rng.pick(&[1e-3, 1.0, 7.5, 1e3]);
            let (t, x, err) = crossing(start, dir, &p);
            let why = || format!("case {case}: α {alpha:e}, scale {scale:e}, {p:?}, {start} along {dir} → t {t:e}, {x}, {err:e}");
            let d = dd_distance(&p, x);
            assert!(d <= err, "{d:e} off the plane: {}", why());
            // Off the line: |(x − start) × dir| / |dir|, and along it.
            let w = diff3(x, start);
            let dd = [Dd::new(dir.x), Dd::new(dir.y), Dd::new(dir.z)];
            let cross = DVec3::new(
                (w[1] * dd[2] - w[2] * dd[1]).to_f64(),
                (w[2] * dd[0] - w[0] * dd[2]).to_f64(),
                (w[0] * dd[1] - w[1] * dd[0]).to_f64(),
            );
            let off = cross.length() / dir.length();
            assert!(off <= err, "{off:e} off the line: {}", why());
            let along = dd_dot(dir, w).to_f64() / dir.length();
            assert!((along - t).abs() <= err, "t {t:e} but {along:e} along: {}", why());
            worst = worst.max(d / err).max(off / err);
        }
        println!("worst error / bound over 20,000 line crossings: {worst:.3e}");
    }

    #[test]
    fn the_long_way_round_keeps_nearly_parallel_lines_on_their_planes() {
        // Why the direction is n₁ × (n₂ − n₁): crossed directly, two unit
        // normals 1e-8 rad apart give a direction off by about an ulp ÷
        // 1e-8 ≈ 2e-8 rad. Worked here both ways for 200 seeded pairs:
        // the long way stays within its 64-ulp drift every time; the
        // direct cross product leans past it on most (a planted break of
        // the method, kept as a test that the method matters).
        let mut rng = Rng(31005);
        let mut direct_over = 0;
        for _ in 0..200 {
            let n1 = rng.direction();
            let n2 = Plane::through(DVec3::ZERO, rng.leaning(n1, 1e-8)).unwrap().normal();
            let a = Plane::through(DVec3::ZERO, n1).unwrap();
            let n1 = a.normal();
            let b = Plane::through(DVec3::ZERO, n2).unwrap();
            let l = line_of(&a, &b, DVec3::ZERO);
            let direct = n1.cross(n2).normalize();
            let lean = |d: DVec3, n: DVec3| dd_dot(n, [Dd::new(d.x), Dd::new(d.y), Dd::new(d.z)]).to_f64().abs();
            assert!(lean(l.dir, n1) <= l.drift && lean(l.dir, n2) <= l.drift);
            if lean(direct, n1).max(lean(direct, n2)) > l.drift {
                direct_over += 1;
            }
        }
        assert!(direct_over > 100, "the direct cross product leaned past the drift on only {direct_over} of 200");
        // And the angle works out right: at 45°, sin = 1/√2 either way.
        let a = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let b = plane([0.0, 0.0, 0.0], [0.0, 1.0, 1.0]);
        // Z × (0, 1, 1)/√2 = (−1/√2, 0, 0), so −X, sin 45° = 1/√2.
        let l = line_of(&a, &b, DVec3::ZERO);
        assert!((l.dir - DVec3::NEG_X).length() <= 4.0 * f64::EPSILON, "{l:?}");
        let n2 = b.normal();
        assert!((n2.y - FRAC_1_SQRT_2).abs() <= f64::EPSILON && (n2.z - FRAC_1_SQRT_2).abs() <= f64::EPSILON);
    }
}
