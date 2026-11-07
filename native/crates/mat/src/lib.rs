//! Bounded, read-only MATLAB Level-5 (v5/v6/v7) MAT-file reader for the viewer's MAT feature.
//!
//! The API is stdio-agnostic: open a file, list its catalog, then read bounded slices or pages
//! of cells and structs through handles bound to one source generation. The file is opened
//! read-only and never written. Level-5 v7.3 (HDF5) is a typed refusal until a pinned HDF5
//! reader is approved (V-MAT2).
mod body;
mod file;
mod parse;
mod read;
mod types;
pub use file::{Entry, FileHeader, MatFile};
pub use types::*;
