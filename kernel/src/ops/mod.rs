//! Modelling operations. Every one returns its body through
//! `validate::checked`, so nothing invalid leaves the kernel.

pub mod extrude;
pub mod primitives;
pub mod transform;

use crate::validate::ValidationError;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum KernelError {
    /// The caller asked for something impossible (e.g. a negative size).
    InvalidInput(String),
    /// The operation produced a broken body. Only reachable in release
    /// builds; debug and test builds panic instead.
    InvalidResult(Vec<ValidationError>),
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KernelError::InvalidInput(m) => write!(f, "{m}"),
            KernelError::InvalidResult(errs) => {
                write!(f, "internal error, result failed validation: ")?;
                let list: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
                write!(f, "{}", list.join("; "))
            }
        }
    }
}

/// Checks a length parameter: finite, above tolerance, below the model limit.
pub(crate) fn check_length(name: &str, value: f64) -> Result<(), KernelError> {
    use crate::tolerance::{MAX_SIZE, MIN_FEATURE};
    if !value.is_finite() || !(MIN_FEATURE..=MAX_SIZE).contains(&value) {
        return Err(KernelError::InvalidInput(format!(
            "{name} must be between {MIN_FEATURE} and {MAX_SIZE} mm, got {value}"
        )));
    }
    Ok(())
}

pub(crate) fn finish(body: crate::topology::Body) -> Result<crate::topology::Body, KernelError> {
    crate::validate::checked(body).map_err(KernelError::InvalidResult)
}
