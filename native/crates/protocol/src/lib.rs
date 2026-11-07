//! Table worker protocol v1 (draft D1.9 schemas under `test/migration/schema/`): NDJSON frames,
//! typed envelopes, one capabilities frame after start, typed errors. Framing is the PDF worker's
//! byte-for-byte; engine state lives in the engine crate. Draft until D1.7/D1.9 are accepted.
#![forbid(unsafe_code)]

pub mod envelope;
pub mod errors;
pub mod framing;
pub mod sched;
pub mod serve;

pub use errors::ErrorBody;
pub use sched::{Control, Lane, Limits, Route, serve_scheduled};
pub use serve::{Capabilities, Engine, serve, serve_with};

pub const PROTOCOL: &str = "dfv-table";
pub const VERSION: u64 = 1;
/// Largest frame in either direction (the draft `limits.max_frame_bytes` fixture value).
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
/// Id of a reply to a frame whose own id was unusable; hosts allocate ids from 1.
pub const UNADDRESSED_ID: &str = "0";
