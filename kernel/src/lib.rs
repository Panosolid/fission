//! Fission geometry kernel.
//!
//! Pure Rust lives in the modules; the `#[wasm_bindgen]` functions below are the
//! thin layer the browser app calls. Vectors cross the boundary as flat
//! `[x, y, z]` arrays (`Float64Array` in JavaScript).

pub mod math;

use math::Vec3;
use wasm_bindgen::prelude::*;

fn vec_from_slice(v: &[f64]) -> Result<Vec3, JsError> {
    match v {
        [x, y, z] => Ok(Vec3::new(*x, *y, *z)),
        _ => Err(JsError::new(&format!(
            "expected a vector of 3 numbers, got {}",
            v.len()
        ))),
    }
}

/// Stage 0 milestone: add two vectors in Rust and hand the result back to JS.
#[wasm_bindgen]
pub fn add_vectors(a: &[f64], b: &[f64]) -> Result<Vec<f64>, JsError> {
    Ok((vec_from_slice(a)? + vec_from_slice(b)?).to_array().to_vec())
}

#[wasm_bindgen]
pub fn dot(a: &[f64], b: &[f64]) -> Result<f64, JsError> {
    Ok(vec_from_slice(a)?.dot(vec_from_slice(b)?))
}

#[wasm_bindgen]
pub fn cross(a: &[f64], b: &[f64]) -> Result<Vec<f64>, JsError> {
    Ok(vec_from_slice(a)?.cross(vec_from_slice(b)?).to_array().to_vec())
}

#[wasm_bindgen]
pub fn kernel_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // JsError can only be built on wasm, so these tests stick to valid input.
    #[test]
    fn add_vectors_adds_componentwise() {
        let r = add_vectors(&[1.0, 2.0, 3.0], &[10.0, 20.0, 30.0]).unwrap();
        assert_eq!(r, vec![11.0, 22.0, 33.0]);
    }

    #[test]
    fn cross_of_x_and_y_is_z() {
        let r = cross(&[1.0, 0.0, 0.0], &[0.0, 1.0, 0.0]).unwrap();
        assert_eq!(r, vec![0.0, 0.0, 1.0]);
    }
}
