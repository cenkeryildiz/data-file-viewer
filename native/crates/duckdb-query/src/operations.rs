//! Optional writer metadata and synthesized hot/cold SQL. Host format/session routing lives separately.
use crate::duckdb::{Engine, Error, quote_ident};
use dfv_table_policy::{QUERY_LIMITS, validate_sql_size};
use serde_json::Value;

pub const KNOWN_FREQUENCIES: [&str; 6] = [
    "annual",
    "semiannual",
    "quarterly",
    "monthly",
    "weekly",
    "daily",
];

/// File-supplied hints are a fixed vocabulary, never HTML or an arbitrary chart formatter.
pub fn series_frequency(raw: &str) -> Option<&'static str> {
    if raw.len() > QUERY_LIMITS.catalog_bytes {
        return None;
    }
    let word = crate::edit::js_trim(raw).to_ascii_lowercase();
    KNOWN_FREQUENCIES.into_iter().find(|f| *f == word)
}

pub fn poll_cadence(extra_json: &str) -> Option<f64> {
    if extra_json.len() > QUERY_LIMITS.catalog_bytes {
        return None;
    }
    let parsed: Value = serde_json::from_str(extra_json).ok()?;
    parsed
        .get("live_poll_seconds")?
        .as_f64()
        .filter(|s| s.is_finite() && *s > 0.0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CombinedQuery {
    pub sql: String,
    pub time_column: Option<&'static str>,
}

/// Catalogs/column lists must come from the two approved source generations, never a webview claim.
/// Attachment and source identity checks belong to the host's owning session.
pub fn build_combined_query(
    table: &str,
    main_catalog: &str,
    sibling_catalog: &str,
    main_columns: &[&str],
    sibling_columns: &[&str],
    limit: Option<u64>,
) -> Result<CombinedQuery, Error> {
    if [table, main_catalog, sibling_catalog]
        .iter()
        .any(|s| s.is_empty() || s.contains('\0'))
    {
        return Err(Error::Invalid(
            "Combined tables require valid catalog and table names.".into(),
        ));
    }
    if main_catalog == sibling_catalog {
        return Err(Error::Invalid(
            "A combined query requires two distinct source catalogs.".into(),
        ));
    }
    if limit.is_some_and(|n| n > 9_007_199_254_740_991) {
        return Err(Error::Invalid(
            "The combined row limit exceeds the exact protocol range.".into(),
        ));
    }
    let time_column = ["Datetime", "Date", "scraped_at"]
        .into_iter()
        .find(|name| main_columns.contains(name) && sibling_columns.contains(name));
    let reference = |catalog: &str| format!("{}.main.{}", quote_ident(catalog), quote_ident(table));
    let union = format!(
        "select *, false as is_hot from {}\n  union all by name\n  select *, true as is_hot from {}",
        reference(main_catalog),
        reference(sibling_catalog)
    );
    let sql = match time_column {
        None => format!("select *\nfrom (\n  {union}\n) as _combined"),
        Some(column) => {
            let column = quote_ident(column);
            let limit = limit.filter(|n| *n > 0).unwrap_or(500);
            format!(
                "select * from (\n  select *\n  from (\n    {union}\n  ) as _union\n  order by {column} desc\n  limit {limit}\n) as _combined\norder by {column} asc"
            )
        }
    };
    validate_sql_size(&sql)?;
    Ok(CombinedQuery { sql, time_column })
}

impl Engine {
    pub(crate) fn metadata_text(
        &self,
        catalog: &str,
        table: &str,
        column: &str,
    ) -> Result<Option<String>, Error> {
        self.guarded(|| {
            // The optional hint must be text and <=1 MiB before it crosses into Rust.
            let column = quote_ident(column);
            let sql = format!("select case when system.main.bit_length({column}) <= {} then {column} else null end from {}.main.sheet_metadata where table_name = ? limit 1", QUERY_LIMITS.catalog_bytes * 8, quote_ident(catalog));
            match self.conn.query_row(&sql, [table], |r| r.get::<_, Option<String>>(0)) {
                Ok(value) => Ok(value),
                Err(error) => match Error::from(error) {
                    e @ Error::Interrupted => Err(e),
                    // Missing table/column/row or malformed type is simply no optional hint.
                    _ => Ok(None),
                },
            }
        })
    }
}
