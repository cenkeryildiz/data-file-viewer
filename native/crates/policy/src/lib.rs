//! D3.4 port of `queryPolicy.ts` and `sqlSafety.ts`. The engine (DuckDB) is reached only through
//! [`QueryEngine`], so every rule here is testable without linking it.
pub mod policy;
pub mod safety;

pub use policy::*;
pub use safety::{destructive_reason, has_multiple_statements};
