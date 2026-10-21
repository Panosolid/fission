//! Modelling operations. Every one returns its body through
//! `validate::checked`, so nothing invalid leaves the kernel.

pub mod extrude;
pub mod place;
pub mod profile;
pub mod primitives;
pub mod transform;

use crate::validate::ValidationError;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum KernelError {
    /// The caller asked for something impossible (e.g. a negative size).
    /// `inputs` says which inputs are at fault, so the app can point at
    /// them without reading `message`; empty when it is the combination
    /// (a body that would reach beyond model space).
    InvalidInput { inputs: Vec<Input>, message: String },
    /// The operation produced a broken body. Only reachable in release
    /// builds; debug and test builds panic instead.
    InvalidResult(Vec<ValidationError>),
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KernelError::InvalidInput { message, .. } => write!(f, "{message}"),
            KernelError::InvalidResult(errs) => {
                write!(f, "internal error, result failed validation: ")?;
                let list: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
                write!(f, "{}", list.join("; "))
            }
        }
    }
}

impl KernelError {
    /// An `InvalidInput` about one input.
    pub fn invalid(input: Input, message: String) -> KernelError {
        KernelError::InvalidInput { inputs: vec![input], message }
    }
}

/// Which input an `InvalidInput` is about, as the app sees it (in
/// JavaScript `{ input: "param", name: "distance" }`, `{ input: "piece",
/// boundary: 0, piece: 3 }`, `{ input: "line", index: 2 }`, …). Indices
/// count from 0, like the app's lists; messages count sketch curves from
/// 1, as a person does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "input", rename_all = "lowercase")]
pub enum Input {
    /// A number argument, by its name in the app's call (width, depth,
    /// height, radius, distance, spacing, pixel, point, offset, pivot,
    /// axis, angle, and a frame's origin, x and normal).
    Param { name: &'static str },
    /// A profile as a whole (too many corners).
    Profile,
    /// One loop of a profile: 0 the outer one, k hole k − 1, numbered as
    /// an extrude's `FaceRole::Side` numbers them.
    Loop { boundary: usize },
    /// Piece `piece` of a profile loop, as given (from corner `piece` to
    /// the next), numbered as `FaceRole::Side` numbers them.
    Piece { boundary: usize, piece: usize },
    /// A sketch as a whole (too many curves).
    Sketch,
    /// A sketch's line, arc or circle, by its place in the list given.
    Line { index: usize },
    Arc { index: usize },
    Circle { index: usize },
}

/// Checks a length parameter: finite, above tolerance, below the model
/// limit. `param` is its name in the app's call, `name` in the message.
pub(crate) fn check_length(param: &'static str, name: &str, value: f64) -> Result<(), KernelError> {
    use crate::tolerance::{MAX_SIZE, MIN_FEATURE};
    if !value.is_finite() || !(MIN_FEATURE..=MAX_SIZE).contains(&value) {
        return Err(KernelError::invalid(
            Input::Param { name: param },
            format!("{name} must be between {MIN_FEATURE} and {MAX_SIZE} mm, got {value}"),
        ));
    }
    Ok(())
}

/// The checked body with the display mesh its validation built (see
/// `validate::checked_meshed`). Each operation also has a `_meshed` form
/// that hands this mesh on, so the app doesn't tessellate the body again.
pub(crate) fn finish(body: crate::topology::Body) -> Result<Meshed, KernelError> {
    crate::validate::checked_meshed(body).map_err(KernelError::InvalidResult)
}

/// A checked body and its display mesh.
pub type Meshed = (crate::topology::Body, crate::mesh::Mesh);
