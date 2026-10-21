//! Moving and rotating bodies. Both change only the body's placement, never
//! its geometry (see `placed`).

use super::{Input, KernelError};
use crate::placed::Placed;
use crate::tolerance::{ANGULAR, MAX_COORD};
use crate::topology::Body;
use glam::DVec3;
use std::f64::consts::TAU;

/// Moves a body by `offset`.
pub fn translate(placed: &Placed, offset: DVec3) -> Result<Placed, KernelError> {
    if !offset.is_finite() {
        return Err(KernelError::invalid(Input::Param { name: "offset" }, format!("move distance must be finite, got {offset}")));
    }
    checked_place(Placed { body: placed.body.clone(), placement: placed.placement.moved(offset) })
}

/// Rotates a body by `angle` radians about the line through `pivot` along `axis`
/// (counter-clockwise looking down the axis). The pivot must lie in model
/// space (within ±MAX_COORD), like every point of every body.
pub fn rotate(placed: &Placed, pivot: DVec3, axis: DVec3, angle: f64) -> Result<Placed, KernelError> {
    if !pivot.is_finite() || !axis.is_finite() || !angle.is_finite() {
        let params = ["pivot", "axis", "angle"].map(|name| Input::Param { name });
        let finite = [pivot.is_finite(), axis.is_finite(), angle.is_finite()];
        let inputs = params.into_iter().zip(finite).filter(|(_, ok)| !ok).map(|(p, _)| p).collect();
        return Err(KernelError::InvalidInput { inputs, message: "rotation pivot, axis and angle must be finite".into() });
    }
    if pivot.abs().max_element() > MAX_COORD {
        return Err(KernelError::invalid(Input::Param { name: "pivot" }, format!(
            "rotation pivot {pivot} is outside model space (±{MAX_COORD:e} mm)"
        )));
    }
    // Lengths can overflow (1e300, 1e300, 0) or underflow, so judge the
    // axis by its largest component.
    let unit = crate::geom::unit(axis).filter(|_| axis.abs().max_element() > ANGULAR);
    let Some(unit) = unit else {
        return Err(KernelError::invalid(Input::Param { name: "axis" }, "rotation axis must not be zero".into()));
    };
    // Reduce huge angles first so sin/cos stay accurate.
    checked_place(Placed { body: placed.body.clone(), placement: placed.placement.turned(pivot, unit, angle.rem_euclid(TAU)) })
}

/// The geometry is unchanged (and was valid), so only where it now is needs
/// checking.
pub(crate) fn checked_place(placed: Placed) -> Result<Placed, KernelError> {
    let (lo, hi) = placed.bounds();
    check_reach(lo, hi)?;
    Ok(placed)
}

/// Every part of the body must lie within ±MAX_COORD. In `extrude` the
/// profile check already bounds every piece of the outline, and the height
/// is at most MAX_SIZE < MAX_COORD, but an arc's extreme there can round
/// down onto MAX_COORD while the body's own bound for it rounds up past it,
/// and this check refuses those (extrude's test
/// `an_arc_too_close_to_the_edge_of_model_space_is_refused`).
pub(crate) fn check_in_model_space(body: &Body) -> Result<(), KernelError> {
    let (lo, hi) = body.bounds();
    check_reach(lo, hi)
}

fn check_reach(lo: DVec3, hi: DVec3) -> Result<(), KernelError> {
    let reach = lo.abs().max(hi.abs()).max_element();
    if !reach.is_finite() || reach > MAX_COORD {
        return Err(KernelError::InvalidInput { inputs: vec![], message: format!(
            "result would reach {reach:e} mm from the origin; the limit is {MAX_COORD:e} mm"
        ) });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::primitives::make_box;
    use crate::placed::Placed;
    use crate::tolerance::{points_eq, MAX_COORD};
    use std::f64::consts::FRAC_PI_2;

    #[test]
    fn each_refusal_names_the_inputs_at_fault() {
        let placed = Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        let inputs = |r: Result<Placed, KernelError>| match r {
            Err(KernelError::InvalidInput { inputs, .. }) => inputs,
            other => panic!("expected InvalidInput, got {other:?}"),
        };
        let param = |name| Input::Param { name };
        assert_eq!(inputs(translate(&placed, DVec3::new(f64::INFINITY, 0.0, 0.0))), vec![param("offset")]);
        // Only the arguments that aren't finite.
        assert_eq!(inputs(rotate(&placed, DVec3::ZERO, DVec3::Z, f64::NAN)), vec![param("angle")]);
        assert_eq!(inputs(rotate(&placed, DVec3::NAN, DVec3::NAN, 1.0)), vec![param("pivot"), param("axis")]);
        assert_eq!(inputs(rotate(&placed, DVec3::splat(2.0 * MAX_COORD), DVec3::Z, 1.0)), vec![param("pivot")]);
        assert_eq!(inputs(rotate(&placed, DVec3::ZERO, DVec3::ZERO, 1.0)), vec![param("axis")]);
        // Reaching beyond model space is the move as a whole: no one input.
        assert_eq!(inputs(translate(&placed, DVec3::new(2.0 * MAX_COORD, 0.0, 0.0))), vec![]);
    }

    #[test]
    fn move_by_hand() {
        // A 1×2×3 box moved by (10, 20, 30) spans (10,20,30)..(11,22,33).
        let b = translate(&Placed::new(make_box(1.0, 2.0, 3.0).unwrap()), DVec3::new(10.0, 20.0, 30.0)).unwrap();
        let (lo, hi) = b.bounds();
        assert!(points_eq(lo, DVec3::new(10.0, 20.0, 30.0)));
        assert!(points_eq(hi, DVec3::new(11.0, 22.0, 33.0)));
    }

    #[test]
    fn rotate_about_a_pivot_by_hand() {
        // 2×1×1 box turned 90° about the vertical line through (1, 0, 0):
        // corner (0,0,0) is 1 to the -X of the pivot and swings to 1 to the
        // -Y: (1, -1, 0). Far corner (2,1,1) → (1-1, 0+1, 1) = (0, 1, 1).
        let b = rotate(&Placed::new(make_box(2.0, 1.0, 1.0).unwrap()), DVec3::X, DVec3::Z, FRAC_PI_2).unwrap();
        assert!(points_eq(b.vertex(0), DVec3::new(1.0, -1.0, 0.0)));
        assert!(points_eq(b.vertex(7), DVec3::new(0.0, 1.0, 1.0)));
    }

    #[test]
    fn long_thin_box_keeps_its_volume_when_rotated() {
        // Regression (stateful harness, seed5eed-ff933607647b9f14.json, a
        // 0.044 × 2228 mm cylinder): 0.01 × 0.01 × 2000 has volume exactly
        // 0.2 and area 2(0.0001 + 20 + 20) = 80.0002 however it is turned.
        // The old volume sum multiplied three ~2000 mm vectors per triangle
        // and lost ~1e-6 to rounding.
        // Second cause, found when the sum moved to the bounding-box centre:
        // the cross product was taken at the first corner even when both its
        // edges were the 2000 mm ones (products ~1e6 cancelling to ~20), and
        // gave 0.20000002445. Now it is taken opposite the longest edge.
        use crate::tessellate::TessOptions;
        let b = Placed::new(make_box(0.01, 0.01, 2000.0).unwrap());
        for (axis, angle) in [(DVec3::new(1.0, -2.0, 3.0), 1.0), (DVec3::new(0.63, -0.37, 0.41), -FRAC_PI_2), (DVec3::X, 0.3)] {
            let r = rotate(&b, DVec3::ZERO, axis, angle).unwrap();
            let m = r.tessellate(&TessOptions::DISPLAY).unwrap();
            // The bound this test has always had in effect: rel_eq used to
            // fall back to an absolute LINEAR² = 1e-12 near zero, and
            // FP_REL·0.2 is smaller. Measured: 4e-13. (Rounding theory
            // allows up to area × rounding_slack(2000) ≈ 2.3e-9; widening to
            // that would loosen the test, so it stays.)
            let v = m.signed_volume();
            assert!((v - 0.2).abs() <= crate::tolerance::AREA, "{axis} {angle}: {v}");
            // Area can't be better than the rotated coordinates allow: each
            // is rounded by up to δ = rounding_slack(2000), and moving a
            // vertex by δ changes a triangle's area by at most its
            // perimeter × δ. Sum of perimeters: 8 long triangles of about
            // 4000 mm each (plus tiny caps) ≈ 32000 mm.
            let slack = 32_001.0 * crate::tolerance::rounding_slack(2000.0);
            assert!(crate::tolerance::measure_eq(m.area(), 80.0002, slack), "{axis} {angle}: {}", m.area());
        }
    }

    #[test]
    fn huge_axis_vectors_still_rotate() {
        // Regression (found by the OpenCascade oracle): (1e300, 1e300, 0)
        // is the direction (1,1,0)/√2, but its length overflows, so the old
        // code normalised it to (0,0,0) and the "rotation" did nothing.
        // A quarter turn about (1,1,0) through the origin takes (1,0,0) to
        // (1/2, 1/2, -1/√2) (Rodrigues: v cosθ + (k×v) sinθ + k(k·v)(1−cosθ)
        // with k = (1,1,0)/√2: k×v = (0,0,-1/√2), k(k·v) = (1/2,1/2,0)).
        let b = Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        let expected = DVec3::new(0.5, 0.5, -(0.5f64.sqrt()));
        for axis in [DVec3::new(1.0, 1.0, 0.0), DVec3::new(1e300, 1e300, 0.0), DVec3::new(f64::MAX, f64::MAX, 0.0)] {
            let r = rotate(&b, DVec3::ZERO, axis, FRAC_PI_2).unwrap();
            assert!(points_eq(r.vertex(1), expected), "axis {axis}: {}", r.vertex(1));
        }
    }

    #[test]
    fn huge_angles_are_reduced_first() {
        // 1000 full turns plus a quarter is a quarter turn.
        let b = Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        let q = rotate(&b, DVec3::ZERO, DVec3::Z, FRAC_PI_2).unwrap();
        let big = rotate(&b, DVec3::ZERO, DVec3::Z, 1000.0 * TAU + FRAC_PI_2).unwrap();
        for v in 0..q.body.vertices.len() {
            assert!(points_eq(q.vertex(v), big.vertex(v)));
        }
    }

    #[test]
    fn bad_inputs_are_clean_errors() {
        let b = Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        assert!(translate(&b, DVec3::new(f64::NAN, 0.0, 0.0)).is_err());
        assert!(translate(&b, DVec3::new(f64::INFINITY, 0.0, 0.0)).is_err());
        assert!(rotate(&b, DVec3::ZERO, DVec3::ZERO, 1.0).is_err());
        assert!(rotate(&b, DVec3::ZERO, DVec3::Z * ANGULAR * 0.9, 1.0).is_err());
        assert!(rotate(&b, DVec3::ZERO, DVec3::Z * ANGULAR * 1.1, 1.0).is_ok());
        assert!(rotate(&b, DVec3::ZERO, DVec3::Z, f64::NAN).is_err());
        assert!(rotate(&b, DVec3::splat(f64::NAN), DVec3::Z, 1.0).is_err());
        // Each bad input is refused for its own reason (not by a later check
        // that happens to trip on the NaNs it produced).
        let reason = |r: Result<Placed, KernelError>| match r {
            Err(KernelError::InvalidInput { message: m, .. }) => m,
            other => panic!("expected InvalidInput, got {other:?}"),
        };
        for r in [
            rotate(&b, DVec3::new(f64::NAN, 0.0, 0.0), DVec3::Z, 1.0),
            rotate(&b, DVec3::ZERO, DVec3::new(0.0, f64::INFINITY, 1.0), 1.0),
            rotate(&b, DVec3::ZERO, DVec3::Z, f64::NAN),
            rotate(&b, DVec3::ZERO, DVec3::Z, f64::INFINITY),
        ] {
            assert!(reason(r).contains("must be finite"));
        }
        // The axis counts as zero up to and including ANGULAR.
        assert!(reason(rotate(&b, DVec3::ZERO, DVec3::Z * ANGULAR, 1.0)).contains("must not be zero"));
    }

    #[test]
    fn model_space_boundary() {
        // The unit box's far corner is at offset + 1, so moving by
        // MAX_COORD - 1 lands exactly on the limit (allowed); 0.9×/1.1× of
        // the tolerance either side of it decide in/out.
        let b = Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        let edge = MAX_COORD - 1.0;
        assert!(translate(&b, DVec3::X * edge).is_ok());
        assert!(translate(&b, DVec3::X * (edge - 0.9 * crate::tolerance::LINEAR)).is_ok());
        assert!(translate(&b, DVec3::X * (edge + 1.1 * MAX_COORD * 1e-9)).is_err());
        assert!(translate(&b, DVec3::X * -(MAX_COORD + 1.0)).is_err());
    }

    #[test]
    fn moving_and_turning_never_touch_the_geometry() {
        // Step 12: geometry stays in local coordinates; only the placement
        // changes. After any chain of moves and turns the body is bit for
        // bit the one that was built, so its volume and area are too.
        let built = make_box(26.5, 0.0124, 27.0).unwrap();
        let mut p = Placed::new(built.clone());
        p = rotate(&p, DVec3::new(3.0, -7.0, 1.0), DVec3::new(0.3, -0.9, 0.2), 2.1).unwrap();
        p = translate(&p, DVec3::new(3.78e7, -2.5e7, 1e6)).unwrap();
        p = rotate(&p, DVec3::new(3.78e7, -2.5e7, 0.0), DVec3::Z, -1.0).unwrap();
        p = translate(&p, DVec3::new(-1e3, 4e4, -9e5)).unwrap();
        assert_eq!(p.body, built);
        assert_eq!(p.mass_properties(), crate::mass::mass_properties(&built));
    }

    #[test]
    fn far_out_and_back_loses_no_volume() {
        // Step 12 acceptance (OpenCascade oracle, seed 0x5eed, 3000 cases):
        // a 26.5 × 0.0124 × 27 box placed 37.8 km out and moved back used to
        // lose 8.7e-8 of its volume. V = 26.5 × 0.0124 × 27 = 8.8722 and
        // A = 2(26.5·0.0124 + 0.0124·27 + 26.5·27) = 2(0.3286 + 0.3348 +
        // 715.5) = 1432.3268, exactly as built, to rounding of the product.
        let b = Placed::new(make_box(26.5, 0.0124, 27.0).unwrap());
        let out = DVec3::new(3.78e7, 0.0, 0.0);
        let back = translate(&translate(&b, out).unwrap(), -out).unwrap();
        let m = back.mass_properties();
        assert!(crate::tolerance::rel_eq(m.volume, 8.8722, crate::tolerance::FP_REL), "{}", m.volume);
        assert!(crate::tolerance::rel_eq(m.area, 1432.3268, crate::tolerance::FP_REL), "{}", m.area);
        assert_eq!(m, b.mass_properties()); // not "close": the same bits
        // Where it ended up carries one rounding at 3.78e7 (ulp 7.5e-9).
        assert!(points_eq(back.vertex(7), b.vertex(7)));
    }

    #[test]
    fn a_huge_thin_frame_turned_keeps_its_volume() {
        // Regression (random tester, seed 0x389ee678a942 and 23 others):
        // the square frame with 1 µm walls (`mass` tests; 10 km then, 1 km
        // now), turned a quarter turn about (0, 0.366, −0.644). V = (L² −
        // (L − 2w)²)·h = 4Lw − 4w² with L = 999999.99999, w = 0.001, h = 1:
        // 3999.99999596. At 10 km, baking the turn into the corners rounded
        // each by ~1e-9, and the exact volume came out 37231 instead of
        // 39999.99 (each 1e7 mm² side face's area moved ~0.01, times its
        // 5e6 mm lever). Now the turn is a placement and the geometry is
        // untouched.
        let frame = Placed::new(crate::mass::tests::huge_thin_frame());
        let turned = rotate(&frame, DVec3::ZERO, DVec3::new(0.0, 0.36568663456908856, -0.6439675223061451), FRAC_PI_2).unwrap();
        for p in [&frame, &turned] {
            let m = p.mass_properties();
            let (lo, hi) = frame.bounds();
            let slack = m.area * crate::tolerance::rounding_slack(lo.abs().max(hi.abs()).max_element());
            assert!(crate::tolerance::measure_eq(m.volume, crate::mass::tests::HUGE_THIN_FRAME_VOLUME, slack), "volume {} ± {slack}", m.volume);
            // The mesh, carried into the world, keeps it too (double-double
            // volume; see mesh tests).
            let v = p.tessellate(&crate::tessellate::TessOptions::DISPLAY).unwrap().signed_volume();
            assert!(crate::tolerance::measure_eq(v, crate::mass::tests::HUGE_THIN_FRAME_VOLUME, slack), "mesh volume {v} ± {slack}");
        }
    }

    #[test]
    fn the_pivot_must_be_in_model_space() {
        // Regression (random tester, seeds 0x96a125919bb2, 0xab7657e86756):
        // a turn about a pivot at 1e300 was accepted; the result can only be
        // computed to ~1e284 there. Like every point, a pivot must lie within
        // ±MAX_COORD. A zero turn leaves the box where it is, so only the
        // pivot decides: on the limit is fine, past it (by 1.1 × LINEAR, or
        // anywhere further) is refused; 0.9 × LINEAR inside is fine.
        let b = Placed::new(make_box(1.0, 1.0, 1.0).unwrap());
        for (pivot, ok) in [
            (DVec3::X * MAX_COORD, true),
            (DVec3::Y * -(MAX_COORD - 0.9 * crate::tolerance::LINEAR), true),
            (DVec3::Z * (MAX_COORD + 1.1 * crate::tolerance::LINEAR), false),
            (DVec3::new(0.0, 1e300, 0.0), false),
            (DVec3::new(1e300, 0.0, 0.0), false),
        ] {
            assert_eq!(rotate(&b, pivot, DVec3::Y, 0.0).is_ok(), ok, "pivot {pivot}");
        }
    }
}
