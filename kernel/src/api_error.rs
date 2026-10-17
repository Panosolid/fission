//! What the app is told when a kernel call fails: what kind of failure,
//! which of its inputs are at fault, and the message to show (in
//! JavaScript a thrown `Error` whose `message` is that message, with
//! `kind` and `inputs` beside it).
//!
//! The app decides from `kind` and `inputs`, never by reading `message`:
//! the timeline (24d) keeps a failed extrude's last shape and marks where
//! its sketch went wrong from these fields (health check 2026-10-17, risk
//! 2). Messages are unchanged from when errors crossed as plain text.

use crate::ops::{Input, KernelError};
use serde::Serialize;
use std::fmt;

/// One failed kernel call.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApiError {
    pub kind: ErrorKind,
    /// The inputs at fault (`ops::Input`); empty when no single input is
    /// (a body that would reach beyond model space, an internal failure).
    pub inputs: Vec<Input>,
    pub message: String,
}

/// In JavaScript `"invalid-input"`, `"invalid-result"`, ….
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    /// The kernel refuses an input (`KernelError::InvalidInput`): the
    /// user's to fix.
    InvalidInput,
    /// A result failed validation (`KernelError::InvalidResult`, release
    /// builds only; debug builds panic): a kernel bug.
    InvalidResult,
    /// The call itself was malformed: an argument of the wrong form, or a
    /// body handle that isn't a whole number from 1. The app's bug.
    BadRequest,
    /// A body handle the store doesn't hold: freed, or never made.
    UnknownBody,
    /// The store already holds `store::MAX_LIVE_BODIES` bodies.
    TooManyBodies,
    /// The kernel failed in a way none of the above covers (a body it
    /// can't mesh, a value it can't hand over). A kernel bug.
    Internal,
}

impl ApiError {
    pub fn new(kind: ErrorKind, inputs: Vec<Input>, message: String) -> ApiError {
        ApiError { kind, inputs, message }
    }

    /// A malformed argument, by its name in the app's call.
    pub fn bad_argument(name: &'static str, message: String) -> ApiError {
        ApiError::new(ErrorKind::BadRequest, vec![Input::Param { name }], message)
    }

    pub fn internal(message: String) -> ApiError {
        ApiError::new(ErrorKind::Internal, vec![], message)
    }
}

impl From<KernelError> for ApiError {
    fn from(e: KernelError) -> ApiError {
        let message = e.to_string();
        match e {
            KernelError::InvalidInput { inputs, .. } => ApiError::new(ErrorKind::InvalidInput, inputs, message),
            KernelError::InvalidResult(_) => ApiError::new(ErrorKind::InvalidResult, vec![], message),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::ValidationError;

    #[test]
    fn kernel_errors_keep_their_message_and_inputs() {
        let e = KernelError::invalid(Input::Param { name: "width" }, "width must be positive".into());
        assert_eq!(ApiError::from(e), ApiError::new(ErrorKind::InvalidInput, vec![Input::Param { name: "width" }], "width must be positive".into()));
        // A broken result is the kernel's bug, about no input; its message
        // is KernelError's own.
        let e = KernelError::InvalidResult(vec![ValidationError::ZeroLengthEdge { edge: 4 }]);
        let want = e.to_string();
        assert_eq!(ApiError::from(e), ApiError::new(ErrorKind::InvalidResult, vec![], want));
    }

    #[test]
    fn in_javascript_kinds_and_inputs_are_plain_words_and_numbers() {
        let e = ApiError::new(
            ErrorKind::InvalidInput,
            vec![Input::Piece { boundary: 0, piece: 3 }, Input::Line { index: 2 }, Input::Param { name: "distance" }, Input::Sketch],
            "m".into(),
        );
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"kind":"invalid-input","inputs":[{"input":"piece","boundary":0,"piece":3},{"input":"line","index":2},{"input":"param","name":"distance"},{"input":"sketch"}],"message":"m"}"#
        );
        let kinds = [
            (ErrorKind::InvalidResult, "invalid-result"),
            (ErrorKind::BadRequest, "bad-request"),
            (ErrorKind::UnknownBody, "unknown-body"),
            (ErrorKind::TooManyBodies, "too-many-bodies"),
            (ErrorKind::Internal, "internal"),
        ];
        for (kind, word) in kinds {
            assert_eq!(serde_json::to_string(&kind).unwrap(), format!("\"{word}\""));
        }
        assert_eq!(ApiError::bad_argument("body", "x".into()).to_string(), "x");
        assert_eq!(ApiError::internal("y".into()), ApiError::new(ErrorKind::Internal, vec![], "y".into()));
    }
}
