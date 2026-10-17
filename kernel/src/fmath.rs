//! Sine, cosine and the other maths functions beyond + − × ÷ and √, the same
//! to the last bit in every build.
//!
//! IEEE 754 fixes the result of + − × ÷ and √ exactly, but not of sin, cos,
//! atan and the rest: Rust's `f64::sin` calls the platform's maths library,
//! which on a computer is the C library's and in the browser is a different
//! one compiled into the WebAssembly. The two are both accurate, yet differ
//! in the last bit for some inputs, so before this module a part could come
//! out a hair different on the website from the one the tests checked (the
//! cross-build check `fuzz/same-answer/` found 1,740 of 2,559 saved fuzz
//! inputs differing). These call the pure-Rust `libm` instead (glam does too,
//! through its `libm` feature): the same code, so the same bits, everywhere.
//! Kernel code calls these, never the `f64` methods (`clippy.toml` refuses
//! them).

pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

/// (sin x, cos x).
pub fn sin_cos(x: f64) -> (f64, f64) {
    libm::sincos(x)
}

pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}

pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}

pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}

pub fn atan(x: f64) -> f64 {
    libm::atan(x)
}

/// The angle of the point (x, y), in (−π, π].
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

/// √(x² + y²) without overflow or underflow on the way.
pub fn hypot(x: f64, y: f64) -> f64 {
    libm::hypot(x, y)
}

/// x to the power y.
pub fn powf(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_3, FRAC_PI_4, FRAC_PI_6, PI};

    /// Within `ulps` steps between doubles of `want`.
    fn near(got: f64, want: f64, ulps: u64) -> bool {
        got.to_bits().abs_diff(want.to_bits()) <= ulps
    }

    #[test]
    fn hand_worked_values() {
        // From the unit circle: the point at angle π/6 is (√3/2, 1/2), at
        // π/3 it is (1/2, √3/2), at π/4 it is (√2/2, √2/2). π/6 etc. are
        // rounded, so allow a step either way, except where the working
        // pins the answer: FRAC_PI_3 is π/3 rounded up by 1.07e-16, so
        // (cos′ = −sin = −√3/2 there) cos(FRAC_PI_3) = 1/2 − 9.3e-17
        // = 1/2 − 1.67·2⁻⁵⁴ (its series in fractions, 60 digits of π, agrees).
        // Below 1/2 the doubles are 2⁻⁵⁴ apart and 1.67 is nearer 2 than 1:
        // the correctly rounded answer is 1/2 − 2⁻⁵³, two steps below.
        assert!(near(sin(FRAC_PI_6), 0.5, 1), "{}", sin(FRAC_PI_6));
        assert_eq!(cos(FRAC_PI_3), 0.5 - 2f64.powi(-53));
        assert!(near(tan(FRAC_PI_4), 1.0, 1), "{}", tan(FRAC_PI_4));
        assert!(near(sin_cos(FRAC_PI_4).0, 2f64.sqrt() / 2.0, 1) && near(sin_cos(FRAC_PI_4).1, 2f64.sqrt() / 2.0, 1));
        // Exact inputs: sin 0 = 0, cos 0 = 1, atan 1 = π/4, asin 1 = π/2,
        // acos(−1) = π, acos(1/2) = π/3; atan2 of (1, 1) is π/4, of (1, −1)
        // the second quadrant's 3π/4, of (−1, −1) the third's −3π/4.
        assert_eq!((sin(0.0), cos(0.0)), (0.0, 1.0));
        assert!(near(atan(1.0), FRAC_PI_4, 1) && near(asin(1.0), FRAC_PI_2, 1) && near(acos(-1.0), PI, 1));
        assert!(near(acos(0.5), FRAC_PI_3, 1));
        assert!(near(atan2(1.0, 1.0), FRAC_PI_4, 1) && near(atan2(1.0, -1.0), 3.0 * FRAC_PI_4, 1) && near(atan2(-1.0, -1.0), -3.0 * FRAC_PI_4, 1));
        // 3-4-5 and 5-12-13 triangles, exact; 2 to the 10th and √2 as 2^½.
        assert_eq!((hypot(3.0, 4.0), hypot(-5.0, 12.0)), (5.0, 13.0));
        assert_eq!(powf(2.0, 10.0), 1024.0);
        assert!(near(powf(2.0, 0.5), 2f64.sqrt(), 1));
        // hypot keeps its digits where squaring would overflow: 3e300, 4e300.
        assert!(near(hypot(3e300, 4e300), 5e300, 1));
    }

    #[test]
    fn same_bits_as_the_pure_rust_library() {
        // The point of the module: each function is libm's, so the bits
        // equal what the browser build computes (fuzz/same-answer checks
        // that end to end). Off-grid angles where the C library and libm
        // can disagree in the last bit.
        for i in 0..1000 {
            let x = i as f64 * 0.0137 - 6.85;
            assert_eq!(sin(x).to_bits(), libm::sin(x).to_bits());
            assert_eq!(cos(x).to_bits(), libm::cos(x).to_bits());
            assert_eq!(tan(x).to_bits(), libm::tan(x).to_bits());
            assert_eq!(atan(x).to_bits(), libm::atan(x).to_bits());
            assert_eq!(atan2(x, 1.5).to_bits(), libm::atan2(x, 1.5).to_bits());
            assert_eq!(hypot(x, 1.5).to_bits(), libm::hypot(x, 1.5).to_bits());
            assert_eq!(powf(1.5, x).to_bits(), libm::pow(1.5, x).to_bits());
            let s = x / 7.0;
            assert_eq!(asin(s).to_bits(), libm::asin(s).to_bits());
            assert_eq!(acos(s).to_bits(), libm::acos(s).to_bits());
        }
    }
}
