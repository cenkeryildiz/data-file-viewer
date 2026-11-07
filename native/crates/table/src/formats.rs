//! Open dispatch by file kind, and the read-metadata.v1 object every open answers with.
//! DuckDB, Parquet and CSV are read by the engine itself; SQLite is decoded by `dfv-table-sqlite` and
//! loaded into the engine's in-memory catalog before the lock-down. XLSX plugs in at [`attach_xlsx`].
//! Native format decoders feed private typed catalogs; unsupported profiles refuse explicitly.
use crate::session::Identity;
use crate::source::{Info, Opened, Plain, Source};
use dfv_table_duckdb::locale::NumberLocale;
use dfv_table_duckdb::{Engine, Error, Kind, Loader, ReadOptions, TableLoad, Value as Dv};
use dfv_table_sqlite as sqlite;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[path = "formats_arrow.rs"]
mod arrow;
#[path = "formats_dta.rs"]
mod dta;
#[path = "formats_kdb.rs"]
mod kdb;

/// An SQLite file is decoded into memory whole; beyond this the open is refused instead of risking the host.
/// shortcut: whole-table row vectors, bounded by this cap; upgrade to a streaming cursor in the sqlite crate.
const SQLITE_MAX_BYTES: u64 = 256 << 20;
/// 2^53: integers beyond it cannot share a lossless DOUBLE.
const SAFE_INTEGER: i64 = 9_007_199_254_740_992;

#[derive(Clone)]
pub struct OpenRequest {
    pub path: PathBuf,
    pub force_read_only: bool,
    /// The host's explicit kind (extensionless kdb); `None` reads it from the extension.
    pub force_kind: Option<Kind>,
    pub options: ReadOptions,
    /// The other half of a hot/cold pair, chosen by the host; an unreadable one is simply no pair.
    pub sibling_path: Option<PathBuf>,
    /// How a workbook's sheets become tables; read by XLSX only.
    pub sheets: crate::xlsx::SheetOpen,
}

/// The protocol's `FileKind` word to a kind; `None` for a word that is not one.
pub fn kind_named(word: &str) -> Option<Kind> {
    [
        Kind::Duckdb,
        Kind::Parquet,
        Kind::Csv,
        Kind::Sqlite,
        Kind::Arrow,
        Kind::Feather,
        Kind::Xlsx,
        Kind::Dta,
        Kind::Kdb,
    ]
    .into_iter()
    .find(|k| k.as_str() == word)
}

fn kind_from_extension(path: &Path) -> Result<Kind, Error> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("duckdb") => Ok(Kind::Duckdb),
        Some("parquet") => Ok(Kind::Parquet),
        Some("csv") => Ok(Kind::Csv),
        Some("db" | "sqlite" | "sqlite3") => Ok(Kind::Sqlite),
        Some("arrow" | "arrows" | "ipc") => Ok(Kind::Arrow),
        Some("feather") => Ok(Kind::Feather),
        Some("xlsx") => Ok(Kind::Xlsx),
        Some("dta") => Ok(Kind::Dta),
        _ if dfv_table_kdb::is_kdb_path(path) => Ok(Kind::Kdb),
        _ => Err(Error::Unsupported(
            "This worker does not recognise this file type.".into(),
        )),
    }
}

fn is_sqlite_name(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("db" | "sqlite" | "sqlite3")
    )
}

/// Open `request.path` as the kind it is. `cancel` is polled between rows of anything decoded here.
pub fn open(
    request: &OpenRequest,
    cancel: &dyn Fn() -> Result<(), Error>,
) -> Result<Opened, Error> {
    let kind = match request.force_kind {
        Some(kind) => kind,
        None => kind_from_extension(&request.path)?,
    };
    let source: Box<dyn Source> = match kind {
        Kind::Duckdb | Kind::Parquet | Kind::Csv => {
            let engine =
                Engine::open_with_pre(&request.path, &request.options, cancel, |loader| {
                    attach_sibling(loader, request.sibling_path.as_deref(), cancel)
                })?;
            Box::new(Plain {
                engine,
                info: Info::default(),
            })
        }
        Kind::Sqlite => {
            let path = std::fs::canonicalize(&request.path).map_err(|e| {
                Error::Invalid(format!(
                    "Could not open \"{}\": {e}",
                    request.path.display()
                ))
            })?;
            let stem = path
                .file_stem()
                .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
            let wal = sidecar(&path, "-wal");
            let engine = Engine::open_loaded(&path, Kind::Sqlite, &[wal], cancel, |loader| {
                loader.use_catalog(&stem)?;
                load_sqlite(loader, &path, false)?;
                attach_sibling(loader, request.sibling_path.as_deref(), cancel)
            })?;
            Box::new(Plain {
                engine,
                info: Info::default(),
            })
        }
        Kind::Xlsx => attach_xlsx(request, cancel)?,
        Kind::Kdb => Box::new(Plain {
            engine: kdb::open(&request.path, cancel)?,
            info: Info::default(),
        }),
        Kind::Arrow | Kind::Feather => Box::new(Plain {
            engine: arrow::open(&request.path, kind, cancel)?,
            info: Info::default(),
        }),
        Kind::Dta => Box::new(Plain {
            engine: dta::open(&request.path, cancel)?,
            info: Info::default(),
        }),
    };
    Ok(Opened { source })
}

/// The xlsx-ops hook. It receives the request and the cancellation poll and answers with its own
/// [`Source`] (an `Engine` from `Engine::open_loaded` whose loader derived the sheet tables, plus the
/// detected-table state behind `as_any`). Until that crate is wired, XLSX is a typed refusal and the
/// worker does not advertise it.
pub use crate::xlsx::attach as attach_xlsx;

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Attach the hot/cold sibling, if the host named one and it is readable. Cancellation and the
/// deadline end the open; anything else about the sibling only means there is no pair.
fn attach_sibling(
    loader: &mut Loader<'_>,
    sibling: Option<&Path>,
    cancel: &dyn Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    let Some(path) = sibling else { return Ok(()) };
    let attached = if is_sqlite_name(path) {
        loader
            .begin_memory_sibling(path)
            .and_then(|()| load_sqlite(loader, path, true))
    } else {
        loader.attach_duckdb_sibling(path)
    };
    match attached {
        Err(e @ (Error::Interrupted | Error::TimedOut)) => Err(e),
        Err(_) => {
            loader.drop_sibling();
            cancel()
        }
        Ok(()) => Ok(()),
    }
}

fn sqlite_error(error: sqlite::SqliteError) -> Error {
    match error {
        sqlite::SqliteError::UnsupportedFormat => Error::Unsupported(error.to_string()),
        sqlite::SqliteError::SchemaChanged => Error::SourceChanged,
        other => Error::Engine(other.to_string()),
    }
}

/// SQLite's affinity rules, read from the declared type.
fn affinity(declared: &str) -> Option<&'static str> {
    let d = declared.to_ascii_uppercase();
    if d.contains("INT") {
        Some("BIGINT")
    } else if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
        Some("VARCHAR")
    } else if d.contains("BLOB") {
        Some("BLOB")
    } else if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") {
        Some("DOUBLE")
    } else {
        None
    }
}

/// The DuckDB type that holds every value of a column exactly: the plan's retype, else the declared
/// affinity if the stored classes fit it, else what the stored classes say.
fn column_type(
    declared: &str,
    retyped: Option<sqlite::Retype>,
    classes: &[String],
) -> Result<&'static str, Error> {
    if let Some(kind) = retyped {
        return Ok(match kind {
            sqlite::Retype::Varchar => "VARCHAR",
            sqlite::Retype::BigInt => "BIGINT",
            sqlite::Retype::Double => "DOUBLE",
        });
    }
    let present: Vec<&str> = classes
        .iter()
        .map(String::as_str)
        .filter(|c| *c != "null")
        .collect();
    let fits = |ty: &str| {
        present.iter().all(|c| match ty {
            "BIGINT" => *c == "integer",
            "DOUBLE" => *c == "integer" || *c == "real",
            "VARCHAR" => *c == "text",
            _ => *c == "blob",
        })
    };
    if let Some(ty) = affinity(declared).filter(|ty| fits(ty)) {
        return Ok(ty);
    }
    match present.as_slice() {
        [] => Ok("VARCHAR"),
        _ if fits("BIGINT") => Ok("BIGINT"),
        _ if fits("DOUBLE") => Ok("DOUBLE"),
        _ if fits("VARCHAR") => Ok("VARCHAR"),
        _ if fits("BLOB") => Ok("BLOB"),
        _ if present.contains(&"blob") => Err(Error::Unsupported(
            "A column mixes binary values with other values.".into(),
        )),
        _ => Ok("VARCHAR"),
    }
}

fn cell_value(cell: sqlite::Cell, ty: &str) -> Result<Dv, Error> {
    use sqlite::Cell as S;
    Ok(match (cell, ty) {
        (S::Null, _) => Dv::Null,
        (S::Integer(i), "BIGINT") => Dv::BigInt(i),
        (S::Integer(i), "DOUBLE") if (-SAFE_INTEGER..=SAFE_INTEGER).contains(&i) => {
            Dv::Double(i as f64)
        }
        (S::Integer(_), "DOUBLE") => {
            return Err(Error::Unsupported(
                "A whole number is too large to show exactly beside decimals.".into(),
            ));
        }
        (S::Real(r), "DOUBLE") => Dv::Double(r),
        (S::Integer(i), "VARCHAR") => Dv::Text(i.to_string()),
        (S::Real(r), "VARCHAR") => Dv::Text(r.to_string()),
        (S::Text(s), "VARCHAR") => Dv::Text(s),
        (S::Blob(b), "BLOB") => Dv::Blob(b),
        _ => {
            return Err(Error::Unsupported(
                "A value does not fit its column (for example, text that is not valid UTF-8)."
                    .into(),
            ));
        }
    })
}

/// Decode every table of the SQLite file at `path` into the loader's main (or sibling) catalog.
fn load_sqlite(loader: &mut Loader<'_>, path: &Path, sibling: bool) -> Result<(), Error> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| Error::Invalid(format!("Could not read \"{}\": {e}", path.display())))?;
    if !metadata.is_file() {
        return Err(Error::Invalid(
            "A SQLite source must be a regular file.".into(),
        ));
    }
    let size = metadata.len();
    if size > SQLITE_MAX_BYTES {
        return Err(Error::TooLarge(
            "This SQLite file is larger than this worker may load.".into(),
        ));
    }
    let connection = sqlite::open_read_only(path, sqlite::OpenMode::ReadOnly, Duration::ZERO)
        .map_err(sqlite_error)?;
    let plan = sqlite::plan_tables(&connection, None).map_err(sqlite_error)?;
    if !sibling {
        loader.warnings.extend(sqlite::retype_notices(&plan));
    }
    for (name, table) in &plan {
        let names: Vec<String> = table.columns.iter().map(|c| c.name.clone()).collect();
        let classes = sqlite::classes_of(&connection, name, &names).map_err(sqlite_error)?;
        let types = table
            .columns
            .iter()
            .zip(&classes)
            .map(|(c, classes)| {
                column_type(&c.declared, table.retyped.get(&c.name).copied(), classes)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (rows, _) =
            sqlite::read_rows(&connection, name, table, usize::MAX).map_err(sqlite_error)?;
        let load_types = types.clone();
        loader.table(
            TableLoad {
                name: name.clone(),
                columns: names
                    .into_iter()
                    .zip(types.iter().map(|t| (*t).to_owned()))
                    .collect(),
                rows: Box::new(rows.into_iter().map(move |row| {
                    row.into_iter()
                        .zip(&load_types)
                        .map(|(cell, ty)| cell_value(cell, ty))
                        .collect()
                })),
            },
            sibling,
        )?;
    }
    Ok(())
}

fn number_locale_json(engine: &Engine) -> Value {
    engine.number_locale.as_ref().map_or(Value::Null, |report| {
        json!({
            "locale": report.locale.map(|l| if l == NumberLocale::En { "en" } else { "eu" }),
            "forced": report.forced, "conflicting": report.conflicting,
            "undecidable": report.undecidable.iter().map(|c| json!({"column":c.column,"samples":c.samples})).collect::<Vec<_>>()
        })
    })
}

/// read-metadata.v1, from the open source and the identity of the generation it was opened against.
pub fn read_metadata(
    source: &dyn Source,
    identity: &Identity,
    revision: u64,
) -> Map<String, Value> {
    let (engine, info) = (source.engine(), source.info());
    let kind = engine.kind.as_str();
    let mut meta = Map::new();
    meta.insert("file_kind".into(), json!(kind));
    meta.insert(
        "read_only".into(),
        json!(!crate::write_dispatch::writable(engine.kind)),
    );
    meta.insert(
        "read_only_by_format".into(),
        json!(matches!(engine.kind, Kind::Dta | Kind::Kdb)),
    );
    meta.insert("has_sibling".into(), json!(engine.sibling.is_some()));
    meta.insert("has_pending_sheets".into(), json!(info.has_pending_sheets));
    meta.insert("worksheets".into(), json!(info.worksheets));
    meta.insert("detected_tables".into(), json!(info.detected_tables));
    meta.insert("open_warnings".into(), json!(engine.open_warnings));
    meta.insert("warnings".into(), json!(info.warnings));
    meta.insert("number_locale".into(), number_locale_json(engine));
    meta.insert(
        "source".into(),
        json!({
            "file_kind": kind,
            "path": identity.path.to_string_lossy(),
            "size": identity.size.to_string(),
            "mtime": {"$t":"timestamp","v":identity.mtime_ns.to_string(),"unit":"ns","tz":null},
            "sha256": identity.fingerprint,
            "revision": revision.to_string(),
        }),
    );
    for (key, value) in [
        ("text_decisions", &info.text_decisions),
        ("preparation_metrics", &info.preparation_metrics),
        ("sheet_preparation", &info.sheet_preparation),
    ] {
        if let Some(value) = value {
            meta.insert(key.into(), value.clone());
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classes(list: &[&str]) -> Vec<String> {
        list.iter().map(|c| (*c).to_owned()).collect()
    }

    #[test]
    fn column_types_follow_declared_affinity_only_while_the_stored_values_fit_it() {
        let t = |declared, retyped, list: &[&str]| column_type(declared, retyped, &classes(list));
        assert_eq!(t("INTEGER", None, &["integer", "null"]).unwrap(), "BIGINT");
        assert_eq!(t("REAL", None, &["real", "integer"]).unwrap(), "DOUBLE");
        assert_eq!(t("VARCHAR(20)", None, &["text"]).unwrap(), "VARCHAR");
        assert_eq!(t("BLOB", None, &["blob"]).unwrap(), "BLOB");
        // dynamic typing: text stored under INTEGER makes the column text, never a lossy number
        assert_eq!(t("INTEGER", None, &["integer", "text"]).unwrap(), "VARCHAR");
        assert_eq!(t("NUMERIC", None, &["integer"]).unwrap(), "BIGINT");
        assert_eq!(t("NUMERIC", None, &["integer", "real"]).unwrap(), "DOUBLE");
        assert_eq!(
            t("", Some(sqlite::Retype::BigInt), &["integer"]).unwrap(),
            "BIGINT"
        );
        assert_eq!(t("TEXT", None, &["null"]).unwrap(), "VARCHAR");
        assert!(matches!(
            t("", None, &["blob", "text"]),
            Err(Error::Unsupported(_))
        ));
    }

    #[test]
    fn cells_are_converted_exactly_or_refused() {
        use sqlite::Cell as S;
        assert_eq!(
            cell_value(S::Integer(i64::MAX), "BIGINT").unwrap(),
            Dv::BigInt(i64::MAX)
        );
        assert_eq!(
            cell_value(S::Integer(3), "VARCHAR").unwrap(),
            Dv::Text("3".into())
        );
        assert_eq!(cell_value(S::Null, "BLOB").unwrap(), Dv::Null);
        assert!(cell_value(S::Integer(SAFE_INTEGER + 1), "DOUBLE").is_err());
        assert!(cell_value(S::Blob(vec![0xff]), "VARCHAR").is_err());
        assert!(cell_value(S::Text("x".into()), "BIGINT").is_err());
    }

    #[test]
    fn kind_words_round_trip() {
        for word in [
            "duckdb", "parquet", "sqlite", "csv", "dta", "arrow", "feather", "xlsx", "kdb",
        ] {
            assert_eq!(kind_named(word).unwrap().as_str(), word);
        }
        assert!(kind_named("pdf").is_none());
    }
}
