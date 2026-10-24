//! Booleans on bodies (steps 31–36; the design is kernel/CLAUDE.md,
//! "Boolean design (B0 decisions)"). Built up a file at a time:
//! - `meet.rs` (31c): where two planes cross, where a line crosses a plane,
//!   and which side of a plane a point is on within a tolerance, each with
//!   the bound on its own rounding.

pub mod meet;
