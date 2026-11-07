//! D3.17 routes that depend only on the open session's catalog: table lists, the hot/cold sibling,
//! the combined query, and the optional cadence/frequency hints. One entry point, [`read`], serves all
//! seven; the dispatch in `lib.rs` names each method.
use crate::{Tables, controlled, counter, text};
use dfv_table_duckdb::{Engine, Error};
use dfv_table_protocol::errors::MALFORMED_VALUE;
use dfv_table_protocol::{Control, ErrorBody};
use serde_json::{Map, Value, json};

enum Request {
    Names(fn(&Engine) -> Result<Vec<String>, Error>),
    Combined(String, Option<u64>),
    Cadence(String),
    Frequency(String),
}

fn request(method: &str, args: &Map<String, Value>) -> Result<Request, ErrorBody> {
    Ok(match method {
        "listTables" => Request::Names(Engine::list_tables),
        "listSidebarTables" => Request::Names(Engine::list_sidebar_tables),
        "listSiblingTables" => Request::Names(Engine::list_sibling_tables),
        "getCombinableTableNames" => Request::Names(Engine::combinable_table_names),
        "buildCombinedQuery" => {
            Request::Combined(text(args, "table")?.to_owned(), counter(args, "limit_n")?)
        }
        "getPollCadenceSeconds" => Request::Cadence(text(args, "table")?.to_owned()),
        "getSeriesFrequency" => Request::Frequency(text(args, "table")?.to_owned()),
        _ => {
            return Err(ErrorBody::new(
                MALFORMED_VALUE,
                "This is not a catalog read.",
            ));
        }
    })
}

fn answer(engine: &Engine, request: &Request) -> Result<Value, Error> {
    Ok(match request {
        Request::Names(list) => json!({"names": list(engine)?}),
        Request::Combined(table, limit) => {
            if engine.sibling.is_none() {
                return Err(Error::Unsupported(
                    "No sibling attached — buildCombinedQuery requires one.".into(),
                ));
            }
            // A combined query over a name only one side (or neither) holds could never run.
            if !engine.combinable_table_names()?.contains(table) {
                return Err(Error::Invalid(
                    "That table is not present on both sides of the pair.".into(),
                ));
            }
            let (sql, time_column) = engine.combined_query(table, *limit)?;
            json!({"sql": sql, "time_column": time_column})
        }
        Request::Cadence(table) => json!({"seconds": engine.poll_cadence_seconds(table)?}),
        Request::Frequency(table) => json!({"frequency": engine.series_frequency(table)?}),
    })
}

pub(crate) fn read(
    tables: &mut Tables,
    method: &str,
    args: &Map<String, Value>,
    control: &Control,
) -> Result<Value, ErrorBody> {
    let (id, revision) = tables.read_session(args)?;
    let request = request(method, args)?;
    if matches!(method, "listTables" | "listSidebarTables")
        && let Some(names) = crate::xlsx::names(
            &**tables.sources.get(&id).expect("open source checked"),
            method == "listTables",
        )?
    {
        tables.revision(&id, Some(revision))?;
        return Ok(json!({"names":names}));
    }
    let engine = tables.engine(&id)?;
    let value = controlled(engine, control, || answer(engine, &request))?;
    tables.revision(&id, Some(revision))?;
    Ok(value)
}
