//! Sums, products and 3×3 determinants in double-double arithmetic: each
//! value is an unevaluated sum hi + lo of two doubles, ~32 significant
//! digits instead of ~16.
//!
//! Used where large terms cancel to a small answer, such as the volume of
//! a thin body far across: a wall strip 1e7 long and 1e-3 high, 5e6 from
//! the middle, gives triple products ~1e13 that must cancel to ~1e4, and
//! plain doubles keep only ~1e-3 of each.
//!
//! The building blocks are exact (Knuth's two-sum, and two-product via a
//! fused multiply-add): a + b and a·b are each returned as the rounded
//! result plus its exact rounding error.
//!
//! `Exact` goes further for sums whose sign must be right however much
//! cancels (the area predicates in `tolerance.rs`): it keeps every digit,
//! as a list of doubles that add up to the exact value (Shewchuk 1997).

use glam::DVec3;

/// hi + lo with |lo| ≤ ulp(hi)/2.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dd {
    pub hi: f64,
    pub lo: f64,
}

/// s + e = a + b exactly, with s = fl(a + b) (Knuth; any magnitudes).
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    let e = (a - (s - bb)) + (b - bb);
    (s, e)
}

/// p + e = a·b exactly, with p = fl(a·b) (unless it underflows).
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    (p, a.mul_add(b, -p))
}

impl Dd {
    pub const ZERO: Dd = Dd { hi: 0.0, lo: 0.0 };

    pub fn new(x: f64) -> Dd {
        Dd { hi: x, lo: 0.0 }
    }

    /// a − b exactly.
    pub fn diff(a: f64, b: f64) -> Dd {
        let (hi, lo) = two_sum(a, -b);
        Dd { hi, lo }
    }

    fn renormalise(hi: f64, lo: f64) -> Dd {
        let (hi, lo) = two_sum(hi, lo);
        Dd { hi, lo }
    }

    /// The nearest double. Every Dd here is renormalised (hi = fl(hi + lo)),
    /// so that is hi itself.
    pub fn to_f64(self) -> f64 {
        self.hi
    }
}

impl std::ops::Add for Dd {
    type Output = Dd;
    fn add(self, o: Dd) -> Dd {
        let (s, e) = two_sum(self.hi, o.hi);
        let (t, f) = two_sum(self.lo, o.lo);
        let (s, e) = two_sum(s, e + t);
        Dd::renormalise(s, e + f)
    }
}

impl std::ops::Neg for Dd {
    type Output = Dd;
    fn neg(self) -> Dd {
        Dd { hi: -self.hi, lo: -self.lo }
    }
}

impl std::ops::Sub for Dd {
    type Output = Dd;
    fn sub(self, o: Dd) -> Dd {
        self + -o
    }
}

impl std::ops::Mul for Dd {
    type Output = Dd;
    fn mul(self, o: Dd) -> Dd {
        let (p, e) = two_prod(self.hi, o.hi);
        Dd::renormalise(p, e + (self.hi * o.lo + self.lo * o.hi))
    }
}

/// a − o, componentwise and exactly.
pub fn diff3(a: DVec3, o: DVec3) -> [Dd; 3] {
    [Dd::diff(a.x, o.x), Dd::diff(a.y, o.y), Dd::diff(a.z, o.z)]
}

/// The triple product u·(v × w), the determinant with rows u, v, w.
pub fn triple(u: [Dd; 3], v: [Dd; 3], w: [Dd; 3]) -> Dd {
    let minor = |i: usize, j: usize| v[i] * w[j] - v[j] * w[i];
    u[0] * minor(1, 2) + u[1] * minor(2, 0) + u[2] * minor(0, 1)
}

/// (a − o)·((b − o) × (c − o)): six times the signed volume of the
/// tetrahedron o, a, b, c. The differences are exact, so the only error is
/// double-double rounding, ~1e-32 of the largest product.
pub fn det3(o: DVec3, a: DVec3, b: DVec3, c: DVec3) -> Dd {
    triple(diff3(a, o), diff3(b, o), diff3(c, o))
}

/// An exact sum of doubles and products of doubles, held as an expansion
/// (Shewchuk, "Adaptive precision floating-point arithmetic", 1997):
/// nonzero doubles in increasing magnitude, none overlapping the next (each
/// smaller than the next one's lowest bit), whose exact sum is the value.
/// Without overlap a double can't be split across more than ~40 of them
/// (2,098 bits of exponent range / 53), so the list stays short however
/// many terms go in. Exact unless a product underflows (factors below
/// ~1e-146, far under any length the kernel accepts), when up to ~1e-292
/// of it is lost.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Exact(Vec<f64>);

impl Exact {
    /// Adds x exactly (Grow-Expansion with zero elimination): x passes up
    /// the list from the smallest part, each two-sum keeping the rounded
    /// sum moving up and leaving the exact rounding error behind.
    pub fn add(&mut self, x: f64) {
        let mut q = x;
        let mut k = 0;
        for i in 0..self.0.len() {
            let (s, e) = two_sum(q, self.0[i]);
            if e != 0.0 {
                self.0[k] = e;
                k += 1;
            }
            q = s;
        }
        self.0.truncate(k);
        if q != 0.0 {
            self.0.push(q);
        }
    }

    /// Adds a·b exactly.
    pub fn add_product(&mut self, a: f64, b: f64) {
        let (p, e) = two_prod(a, b);
        self.add(e);
        self.add(p);
    }

    /// The exact sign: 1, −1, or 0 only when the value is exactly 0. The
    /// largest part decides it, being bigger than all the others together.
    pub fn sign(&self) -> i8 {
        self.0.last().map_or(0, |&x| if x > 0.0 { 1 } else { -1 })
    }

    /// The value as one double, within a few ulps, with the exact sign.
    /// (Adding up from the smallest part: everything below the largest
    /// sums to less than it, so the sign can't change on the way.)
    pub fn value(&self) -> f64 {
        self.0.iter().sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_sum_and_two_prod_are_exact() {
        // 1e16 + 1: the double nearest is 1e16 (ulp there is 2), so the
        // error term must hold the lost 1.
        assert_eq!(two_sum(1e16, 1.0), (1e16, 1.0));
        // (2^27 + 1)² = 2^54 + 2^28 + 1. 2^54 + 2^28 is a double (2^28 is
        // a multiple of ulp(2^54) = 4), the final 1 is not: it is the error.
        let a = 134217729.0; // 2^27 + 1
        assert_eq!(two_prod(a, a), (18014398777917440.0, 1.0));
    }

    #[test]
    fn a_determinant_plain_doubles_get_wrong_by_hand() {
        // Rows u = (0, 0, 1), v = (p, q, 0), w = (r, s, 0): det = p·s − q·r.
        // With p = 1e8 + 1, s = 1e8 − 1, q = r = 1e8: (1e16 − 1) − 1e16 = −1.
        // In doubles 1e16 − 1 rounds to 1e16, giving 0.
        let (p, q, r, s) = (1e8 + 1.0, 1e8, 1e8, 1e8 - 1.0);
        assert_eq!(p * s - q * r, 0.0); // the failure this module exists for
        let u = [Dd::ZERO, Dd::ZERO, Dd::new(1.0)];
        let v = [Dd::new(p), Dd::new(q), Dd::ZERO];
        let w = [Dd::new(r), Dd::new(s), Dd::ZERO];
        assert_eq!(triple(u, v, w).to_f64(), -1.0);
        // The same through det3 with every point shifted by o = (0.5, 0.25, 3):
        // every coordinate stays a double (ulp at 1e8 is 1.5e-8), and the
        // differences back to o are exact, so the answer is still −1.
        let o = DVec3::new(0.5, 0.25, 3.0);
        let d = det3(o, o + DVec3::Z, o + DVec3::new(p, q, 0.0), o + DVec3::new(r, s, 0.0));
        assert_eq!(d.to_f64(), -1.0);
    }

    #[test]
    fn a_unit_tetrahedron_by_hand() {
        // o = 0, a = x, b = y, c = z: det of the identity is 1 (six times
        // the tetrahedron's 1/6). Swapping two rows flips the sign.
        let (x, y, z) = (DVec3::X, DVec3::Y, DVec3::Z);
        assert_eq!(det3(DVec3::ZERO, x, y, z).to_f64(), 1.0);
        assert_eq!(det3(DVec3::ZERO, y, x, z).to_f64(), -1.0);
        // Scaling a row by 3 and adding a multiple of another to a third
        // (a shear) gives 3: det(3x, y, z + 5x) = 3.
        assert_eq!(det3(DVec3::ZERO, 3.0 * x, y, z + 5.0 * x).to_f64(), 3.0);
    }

    #[test]
    fn sums_keep_what_doubles_drop() {
        // 1e16 + 1 − 1e16 = 1; doubles give 0.
        assert_eq!((1e16 + 1.0) - 1e16, 0.0);
        assert_eq!((Dd::new(1e16) + Dd::new(1.0) - Dd::new(1e16)).to_f64(), 1.0);
        // 0.1 × 3 in double-double is the exact product of the double 0.1
        // with 3; minus 3 × 0.1 rounded leaves that rounding: 0.1 =
        // 0x3FB999999999999A, so 3 × 0.1 = 0.30000000000000001665 exactly
        // and fl = 0.30000000000000004441; the difference is −2^-55.
        let d = Dd::new(0.1) * Dd::new(3.0) - Dd::new(0.1 * 3.0);
        assert_eq!(d.to_f64(), -(2f64).powi(-55));
        // Both parts carry a remainder: (1e16 + 1) + (1e16 + 1) = 2e16 + 2,
        // each held as hi = 1e16, lo = 1. Minus 2e16 leaves 2 (doubles: 0).
        let a = Dd::new(1e16) + Dd::new(1.0);
        assert_eq!((a.hi, a.lo), (1e16, 1.0));
        assert_eq!((a + a - Dd::new(2e16)).to_f64(), 2.0);
        // Remainders of very different sizes: (1e16 + 1) + (1 + 2^-53) −
        // (1e16 + 2) = 2^-53. Adding the two remainders 1 + 2^-53 rounds to 1
        // (a tie, to even), and that rounding error, 2^-53, must be kept.
        let tiny = (2f64).powi(-53);
        let c = Dd { hi: 1.0, lo: tiny };
        assert_eq!((a + c - Dd::new(1e16 + 2.0)).to_f64(), tiny);
        // And the difference of two such: (1e16 + 1) − (1e16 − 1) = 2.
        let b = Dd::new(1e16) - Dd::new(1.0);
        assert_eq!((a - b).to_f64(), 2.0);
    }

    #[test]
    fn exact_sums_by_hand() {
        // Empty: exactly 0.
        let mut e = Exact::default();
        assert_eq!((e.sign(), e.value()), (0, 0.0));
        // 1e16 + 1 − 1e16 = 1 (doubles give 0); the parts are kept apart
        // while both are there: [1, 1e16].
        e.add(1e16);
        e.add(1.0);
        assert_eq!(e, Exact(vec![1.0, 1e16]));
        e.add(-1e16);
        assert_eq!((e.sign(), e.value()), (1, 1.0));
        assert_eq!(e, Exact(vec![1.0]), "a part that cancels to 0 is dropped");
        // − 1 leaves exactly 0, with no parts.
        e.add(-1.0);
        assert_eq!((e.sign(), e.value(), e.0.len()), (0, 0.0, 0));
        // Three scales at once: 2¹⁰⁰ + 1 + 2⁻¹⁰⁰ − 2¹⁰⁰ = 1 + 2⁻¹⁰⁰, whose
        // nearest double is 1 but whose parts are both still there.
        let (big, small) = ((2f64).powi(100), (2f64).powi(-100));
        let mut e = Exact::default();
        for x in [big, 1.0, small, -big] {
            e.add(x);
        }
        assert_eq!(e, Exact(vec![small, 1.0]));
        assert_eq!(e.value(), 1.0);
        // Then − 1: what's left, 2⁻¹⁰⁰, is positive, and the sign says so.
        e.add(-1.0);
        assert_eq!((e.sign(), e.value()), (1, small));
        e.add(-2.0 * small);
        assert_eq!((e.sign(), e.value()), (-1, -small));
    }

    #[test]
    fn exact_products_by_hand() {
        // (2²⁷ + 1)² − 2⁵⁴ − 2²⁸ = 1: the product's last bit lives only in
        // its rounding error, which add_product must keep.
        let a = 134217729.0; // 2^27 + 1
        let mut e = Exact::default();
        e.add_product(a, a);
        e.add(-(2f64).powi(54));
        e.add(-(2f64).powi(28));
        assert_eq!((e.sign(), e.value()), (1, 1.0));
        // p·s − q·r with p = 1e8 + 1, s = 1e8 − 1, q = r = 1e8:
        // (1e16 − 1) − 1e16 = −1 (doubles give 0, see above).
        let mut e = Exact::default();
        e.add_product(1e8 + 1.0, 1e8 - 1.0);
        e.add_product(-1e8, 1e8);
        assert_eq!((e.sign(), e.value()), (-1, -1.0));
    }
}
