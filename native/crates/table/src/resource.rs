//! Owned result handles. A handle belongs to one session and one source revision, is never reused,
//! and dies with an explicit release or its session. Bytes are immutable `Arc`s, so an in-flight
//! read keeps what it is encoding even if the handle is released meanwhile.
use dfv_table_duckdb::WireQueryResult;
use dfv_table_protocol::ErrorBody;
use dfv_table_protocol::errors::{NOT_OPEN, RESOURCE_LIMIT, WORKER_FAILED};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, Write};
use std::ops::Range;
use std::sync::Arc;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_count: usize,
    pub max_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_count: 64,
            max_bytes: 256 << 20,
        }
    }
}

pub struct Entry {
    pub revision: u64,
    pub data: Arc<[u8]>,
    session: String,
    query: Option<QueryIndex>,
}

// Leave room for the page envelope in the 32 MiB protocol frame.
const MAX_QUERY_BYTES: usize = (32 << 20) - 4096;

struct QueryIndex {
    row_starts: Box<[usize]>,
    columns: Range<usize>,
    sql: Range<usize>,
    truncated: bool,
}

pub(crate) struct QueryPage {
    pub columns: Value,
    pub rows: Vec<Value>,
    pub sql: Value,
    pub total_rows: usize,
    pub end: usize,
    pub truncated: bool,
}

fn full() -> ErrorBody {
    ErrorBody::new(
        RESOURCE_LIMIT,
        "The worker cannot hold more results; release some first.",
    )
}
fn encoding_limit() -> ErrorBody {
    ErrorBody::new(
        RESOURCE_LIMIT,
        "The query result exceeds its byte or held-resource budget.",
    )
}

// A failed serialization cannot grow beyond either the result limit or remaining held budget.
struct LimitedBytes {
    data: Vec<u8>,
    limit: usize,
}
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.data.len()) {
            return Err(io::Error::other("result budget"));
        }
        self.data.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl LimitedBytes {
    fn append(&mut self, bytes: &[u8]) -> Result<(), ErrorBody> {
        self.write_all(bytes).map_err(|_| encoding_limit())
    }
}

impl QueryIndex {
    fn bytes_for_rows(rows: usize) -> Option<usize> {
        rows.checked_add(1)?
            .checked_mul(std::mem::size_of::<usize>())?
            .checked_add(std::mem::size_of::<Self>())
    }
    fn held_bytes(&self) -> usize {
        // Boxed offsets have no spare capacity; the fixed ranges/flags are charged too.
        Self::bytes_for_rows(self.row_starts.len() - 1).expect("allocated index size")
    }
    fn encode(
        result: WireQueryResult,
        sql: &str,
        limit: usize,
    ) -> Result<(Arc<[u8]>, Self), ErrorBody> {
        let mut out = LimitedBytes {
            data: Vec::new(),
            limit,
        };
        out.append(b"{\"columns\":")?;
        let columns_start = out.data.len();
        serde_json::to_writer(&mut out, &result.columns).map_err(|_| encoding_limit())?;
        let columns = columns_start..out.data.len();
        drop(result.columns);
        out.append(b",\"rows\":[")?;
        let mut row_starts = Vec::with_capacity(result.rows.len() + 1);
        for (i, row) in result.rows.into_iter().enumerate() {
            if i != 0 {
                out.append(b",")?;
            }
            row_starts.push(out.data.len());
            serde_json::to_writer(&mut out, &row).map_err(|_| encoding_limit())?;
        }
        row_starts.push(out.data.len());
        out.append(b"],\"sql\":")?;
        let sql_start = out.data.len();
        serde_json::to_writer(&mut out, sql).map_err(|_| encoding_limit())?;
        let sql = sql_start..out.data.len();
        out.append(if result.truncated {
            b",\"truncated\":true}"
        } else {
            b",\"truncated\":false}"
        })?;
        Ok((
            out.data.into(),
            Self {
                row_starts: row_starts.into_boxed_slice(),
                columns,
                sql,
                truncated: result.truncated,
            },
        ))
    }
}

impl Entry {
    fn held_bytes(&self) -> usize {
        self.data.len() + self.query.as_ref().map_or(0, QueryIndex::held_bytes)
    }
    pub(crate) fn query_page(&self, offset: usize, length: usize) -> Result<QueryPage, ErrorBody> {
        let invalid = || ErrorBody::new(WORKER_FAILED, "The result resource is invalid.");
        let index = self.query.as_ref().ok_or_else(invalid)?;
        let total_rows = index.row_starts.len() - 1;
        let start = offset.min(total_rows);
        let end = start.saturating_add(length).min(total_rows);
        let rows = if start == end {
            vec![]
        } else {
            let first = index.row_starts[start];
            // Non-final offsets follow the comma preceding the next row.
            let last = index.row_starts[end] - usize::from(end < total_rows);
            let mut bytes = Vec::with_capacity(last - first + 2);
            bytes.push(b'[');
            bytes.extend_from_slice(&self.data[first..last]);
            bytes.push(b']');
            serde_json::from_slice(&bytes).map_err(|_| invalid())?
        };
        Ok(QueryPage {
            columns: serde_json::from_slice(&self.data[index.columns.clone()])
                .map_err(|_| invalid())?,
            sql: serde_json::from_slice(&self.data[index.sql.clone()]).map_err(|_| invalid())?,
            rows,
            total_rows,
            end,
            truncated: index.truncated,
        })
    }
}

#[derive(Default)]
pub struct Resources {
    limits: Limits,
    held: usize,
    next: u64,
    entries: HashMap<String, Entry>,
}

/// `r<session number>_<serial>`, matching the schema's `^[A-Za-z0-9_-]{1,64}$`.
pub fn session_of(handle: &str) -> Option<String> {
    let (n, _) = handle.strip_prefix('r')?.split_once('_')?;
    n.bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| format!("s{n}"))
        .filter(|_| !n.is_empty())
}

impl Resources {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    /// Refuses (never evicts) when full: an owner has to release a handle explicitly.
    pub fn add(
        &mut self,
        session: &str,
        revision: u64,
        data: Arc<[u8]>,
    ) -> Result<String, ErrorBody> {
        self.insert(session, revision, data, None)
    }

    pub(crate) fn add_query(
        &mut self,
        session: &str,
        revision: u64,
        result: WireQueryResult,
        sql: &str,
        check: impl FnOnce() -> Result<(), ErrorBody>,
    ) -> Result<String, ErrorBody> {
        if self.entries.len() >= self.limits.max_count {
            return Err(full());
        }
        let index_bytes = QueryIndex::bytes_for_rows(result.rows.len()).ok_or_else(full)?;
        let remaining = self.limits.max_bytes.saturating_sub(self.held);
        let limit = remaining
            .checked_sub(index_bytes)
            .ok_or_else(full)?
            .min(MAX_QUERY_BYTES);
        let (data, index) = QueryIndex::encode(result, sql, limit)?;
        check()?;
        self.insert(session, revision, data, Some(index))
    }

    fn insert(
        &mut self,
        session: &str,
        revision: u64,
        data: Arc<[u8]>,
        query: Option<QueryIndex>,
    ) -> Result<String, ErrorBody> {
        let bytes = data
            .len()
            .checked_add(query.as_ref().map_or(0, QueryIndex::held_bytes))
            .ok_or_else(full)?;
        if self.entries.len() >= self.limits.max_count
            || bytes > self.limits.max_bytes.saturating_sub(self.held)
        {
            return Err(full());
        }
        self.next += 1;
        let handle = format!("r{}_{}", session.trim_start_matches('s'), self.next);
        self.held += bytes;
        self.entries.insert(
            handle.clone(),
            Entry {
                revision,
                data,
                session: session.to_owned(),
                query,
            },
        );
        Ok(handle)
    }

    pub fn get(&self, handle: &str) -> Result<&Entry, ErrorBody> {
        self.entries.get(handle).ok_or_else(|| {
            ErrorBody::new(
                NOT_OPEN,
                "No such result handle (released, closed or never issued).",
            )
        })
    }

    /// Releasing twice is defined: the second call finds nothing and returns false.
    pub fn release(&mut self, handle: &str) -> bool {
        let Some(e) = self.entries.remove(handle) else {
            return false;
        };
        self.held -= e.held_bytes();
        true
    }

    pub fn release_session(&mut self, session: &str) -> usize {
        let ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.session == session)
            .map(|(h, _)| h.clone())
            .collect();
        ids.iter().filter(|h| self.release(h)).count()
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }
    pub fn held_bytes(&self) -> usize {
        self.held
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bytes(n: usize) -> Arc<[u8]> {
        vec![7; n].into()
    }

    #[test]
    fn handles_are_session_bound_never_reused_and_release_twice_is_defined() {
        let mut r = Resources::new(Limits::default());
        let a = r.add("s1", 1, bytes(10)).unwrap();
        assert_eq!(session_of(&a).as_deref(), Some("s1"));
        assert!(r.release(&a));
        assert!(!r.release(&a), "second release finds nothing");
        assert_eq!(r.get(&a).err().unwrap().code, NOT_OPEN);
        let b = r.add("s1", 1, bytes(10)).unwrap();
        assert_ne!(a, b, "a released handle is never reissued");
        assert_eq!((r.count(), r.held_bytes()), (1, 10));
    }

    #[test]
    fn limits_refuse_instead_of_evicting() {
        let mut r = Resources::new(Limits {
            max_count: 2,
            max_bytes: 100,
        });
        let a = r.add("s1", 1, bytes(60)).unwrap();
        assert_eq!(
            r.add("s1", 1, bytes(41)).err().unwrap().code,
            RESOURCE_LIMIT
        );
        r.add("s2", 1, bytes(40)).unwrap();
        assert_eq!(
            r.add("s2", 1, bytes(0)).err().unwrap().code,
            RESOURCE_LIMIT,
            "count limit"
        );
        assert!(r.get(&a).is_ok(), "nothing was evicted");
    }

    #[test]
    fn closing_a_session_releases_only_its_handles() {
        let mut r = Resources::new(Limits::default());
        let a = r.add("s1", 1, bytes(5)).unwrap();
        r.add("s1", 2, bytes(5)).unwrap();
        let c = r.add("s2", 1, bytes(5)).unwrap();
        assert_eq!(r.release_session("s1"), 2);
        assert!(r.get(&a).is_err() && r.get(&c).is_ok());
        assert_eq!(r.held_bytes(), 5);
    }

    #[test]
    fn handle_text_maps_back_to_its_session_and_rejects_foreign_text() {
        assert_eq!(session_of("r12_5").as_deref(), Some("s12"));
        for bad in ["", "r_5", "rx_5", "r12", "s1_2", "r1-2"] {
            assert_eq!(session_of(bad), None, "{bad}");
        }
    }

    fn result(rows: Vec<Vec<Value>>, truncated: bool) -> WireQueryResult {
        WireQueryResult {
            columns: vec![json!({"name":"value","type":"VARCHAR"})],
            rows,
            truncated,
        }
    }

    #[test]
    fn indexed_pages_preserve_exact_nested_values_and_all_boundaries() {
        let rows = vec![
            vec![json!(null)],
            vec![json!({"integer":"18446744073709551615","nested":["[,]\"\\\n",null]})],
            vec![json!("Unicode: ç 東京\nnext line")],
        ];
        let sql = "SELECT 'escaped \\\"\n'";
        for truncated in [false, true] {
            let mut resources = Resources::default();
            let handle = resources
                .add_query("s1", 7, result(rows.clone(), truncated), sql, || Ok(()))
                .unwrap();
            let entry = resources.get(&handle).unwrap();
            let whole: Value = serde_json::from_slice(&entry.data).unwrap();
            assert_eq!(whole["rows"], json!(rows));
            for offset in 0..=rows.len() + 1 {
                for length in [0, 1, 2, usize::MAX] {
                    let page = entry.query_page(offset, length).unwrap();
                    let start = offset.min(rows.len());
                    let end = start.saturating_add(length).min(rows.len());
                    assert_eq!(json!(page.rows), json!(&rows[start..end]));
                    assert_eq!(page.columns, whole["columns"]);
                    assert_eq!(page.sql, json!(sql));
                    assert_eq!(
                        (page.total_rows, page.end, page.truncated),
                        (3, end, truncated)
                    );
                }
            }
        }
        let mut resources = Resources::default();
        let empty = resources
            .add_query("s1", 7, result(vec![], false), "", || Ok(()))
            .unwrap();
        assert!(
            resources
                .get(&empty)
                .unwrap()
                .query_page(0, 100)
                .unwrap()
                .rows
                .is_empty()
        );
    }

    #[test]
    fn query_index_is_charged_and_released_with_encoded_bytes() {
        let mut resources = Resources::default();
        let handle = resources
            .add_query("s1", 1, result(vec![vec![json!(1)]], false), "sql", || {
                Ok(())
            })
            .unwrap();
        let held = resources.held_bytes();
        assert_eq!(
            held,
            resources.get(&handle).unwrap().data.len() + QueryIndex::bytes_for_rows(1).unwrap()
        );
        assert!(resources.release(&handle));
        assert_eq!(resources.held_bytes(), 0);
        let mut exact = Resources::new(Limits {
            max_count: 2,
            max_bytes: held,
        });
        exact
            .add_query("s1", 1, result(vec![vec![json!(1)]], false), "sql", || {
                Ok(())
            })
            .unwrap();
        assert_eq!(exact.held_bytes(), held);
        assert_eq!(
            exact
                .add_query("s2", 1, result(vec![], false), "", || Ok(()))
                .err()
                .unwrap()
                .code,
            RESOURCE_LIMIT
        );
        assert_eq!(exact.release_session("s1"), 1);
        assert_eq!(exact.held_bytes(), 0);
        let mut short = Resources::new(Limits {
            max_count: 2,
            max_bytes: held - 1,
        });
        assert_eq!(
            short
                .add_query("s1", 1, result(vec![vec![json!(1)]], false), "sql", || Ok(
                    ()
                ))
                .err()
                .unwrap()
                .code,
            RESOURCE_LIMIT
        );
        assert_eq!((short.count(), short.held_bytes()), (0, 0));
    }

    #[test]
    fn cancelled_serialization_and_encoding_refusal_do_not_retain_resources() {
        let mut resources = Resources::default();
        let error = resources
            .add_query("s1", 1, result(vec![vec![json!(1)]], false), "", || {
                Err(ErrorBody::new("cancelled", "cancelled"))
            })
            .err()
            .unwrap();
        assert_eq!(error.code, "cancelled");
        assert_eq!((resources.count(), resources.held_bytes()), (0, 0));
        let huge = result(
            vec![vec![Value::String("x".repeat(MAX_QUERY_BYTES))]],
            false,
        );
        assert_eq!(
            resources
                .add_query("s1", 1, huge, "", || Ok(()))
                .err()
                .unwrap()
                .code,
            RESOURCE_LIMIT
        );
        assert_eq!((resources.count(), resources.held_bytes()), (0, 0));
        let raw = resources.add("s1", 1, bytes(4)).unwrap();
        assert_eq!(
            resources
                .get(&raw)
                .unwrap()
                .query_page(0, 1)
                .err()
                .unwrap()
                .code,
            WORKER_FAILED
        );
    }
}
