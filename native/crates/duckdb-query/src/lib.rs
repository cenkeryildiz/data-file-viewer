//! D3.5/D3.6: the DuckDB-backed read engine (catalog, query paging, sorting, counts, statistics, chart
//! reads) and the CSV / Parquet read adapters, behind the D3.4 query policy.
pub mod csv;
pub mod duckdb;
pub mod edit;
pub mod locale;
pub mod materialized;
pub mod operations;
pub mod parquet;
pub mod query;
pub mod text;
pub mod value;

pub use ::duckdb::Connection;
pub use ::duckdb::types::{TimeUnit, Value};
pub use duckdb::{Engine, Error, Kind, OpenOptions as ReadOptions, Sibling};
pub use materialized::{Loader, TableLoad};
pub use query::{QueryResult, StatsKind, WireQueryResult};
