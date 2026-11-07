//! What an open document is to the worker: a locked [`Engine`] plus the facts only its format knows.
//! `formats::open` produces one; the dispatch only ever sees `dyn Source`, so a format with extra state
//! (xlsx detected tables) implements this trait and keeps that state behind `as_any`.
use dfv_table_duckdb::Engine;
use serde_json::Value;
use std::any::Any;

/// Open-time facts that feed the read-metadata.v1 object (`formats::read_metadata`).
/// The defaults are the answer for a plain table: no worksheets, no detected tables, nothing pending.
#[derive(Debug, Clone, Default)]
pub struct Info {
    pub worksheets: Vec<String>,
    /// `detected_tables` items, already in their wire shape (snake_case).
    pub detected_tables: Vec<Value>,
    pub has_pending_sheets: bool,
    /// Facts about what is shown that are not errors (reference `warnings`; `open_warnings` live on the engine).
    pub warnings: Vec<String>,
    /// `text_decisions` / `preparation_metrics` / `sheet_preparation`, when the format has them.
    pub text_decisions: Option<Value>,
    pub preparation_metrics: Option<Value>,
    pub sheet_preparation: Option<Value>,
}

pub trait Source: Send {
    fn engine(&self) -> &Engine;
    fn info(&self) -> &Info;
    fn as_any(&self) -> &dyn Any;
}

/// A format that needs nothing beyond its engine (duckdb, parquet, csv, sqlite).
pub struct Plain {
    pub engine: Engine,
    pub info: Info,
}
impl Source for Plain {
    fn engine(&self) -> &Engine {
        &self.engine
    }
    fn info(&self) -> &Info {
        &self.info
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// The product of `formats::open`: the source to hold under the session id.
pub struct Opened {
    pub source: Box<dyn Source>,
}
