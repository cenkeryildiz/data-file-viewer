//! Diff of a live query result against the same query run on the backup, and the table-level "changed since backup" summary.
//! Operates on the rows the readers return, never on SQL text. Values keep their type: `1`, `1.0`, `"1"`, NULL and `""`
//! are all different, and integers are exact.
use std::collections::{BTreeMap, HashMap, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i128),
    /// IEEE-754 bits; use [`Cell::float`] so every NaN compares equal. `-0.0` and `0.0` stay different.
    Float(u64),
    Text(String),
    Bytes(Vec<u8>),
    /// A value the reader could only give as text (decimal, temporal, nested): its SQL type name and exact text.
    Typed(String, String),
}
impl Cell {
    pub fn float(v: f64) -> Self {
        Self::Float(if v.is_nan() {
            f64::NAN.to_bits()
        } else {
            v.to_bits()
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QueryDiff {
    pub cell_changed: Vec<Vec<bool>>,
    pub row_is_new: Vec<bool>,
    /// live column name -> backup column name, for columns found by identical content instead of by name.
    pub renamed_columns: BTreeMap<String, String>,
}

fn column_key(rows: &[Vec<Cell>], col: usize, len: usize) -> Vec<Option<&Cell>> {
    rows[..len].iter().map(|r| r.get(col)).collect()
}

/// Columns are matched by name first, then unmatched live columns by identical content over the shared row range; rows
/// are compared positionally, top to bottom. Rows past the backup's length are new.
///
/// Differs from the TS where the TS is wrong: with no shared rows nothing is renamed (the TS pairs any unmatched columns,
/// because empty columns are all "identical"); values compare by exact type and value (the TS compared their JSON text,
/// so `NaN` equalled NULL).
pub fn diff_query(live: &Table, backup: &Table) -> QueryDiff {
    let mut live_to_backup: HashMap<usize, usize> = HashMap::new();
    let mut used = vec![false; backup.columns.len()];
    for (i, name) in live.columns.iter().enumerate() {
        if let Some(b) = backup.columns.iter().position(|c| c == name)
            && !used[b]
        {
            live_to_backup.insert(i, b);
            used[b] = true;
        }
    }
    let overlap = live.rows.len().min(backup.rows.len());
    let mut renamed = BTreeMap::new();
    if overlap > 0 && live_to_backup.len() < live.columns.len() {
        let mut by_content: HashMap<_, VecDeque<usize>> = HashMap::new();
        for (b, used) in used.iter().enumerate() {
            if !used {
                by_content
                    .entry(column_key(&backup.rows, b, overlap))
                    .or_default()
                    .push_back(b);
            }
        }
        for (i, name) in live.columns.iter().enumerate() {
            if live_to_backup.contains_key(&i) {
                continue;
            }
            let want = column_key(&live.rows, i, overlap);
            if let Some(b) = by_content.get_mut(&want).and_then(VecDeque::pop_front) {
                live_to_backup.insert(i, b);
                used[b] = true;
                renamed.insert(name.clone(), backup.columns[b].clone());
            }
        }
    }
    let row_is_new: Vec<bool> = (0..live.rows.len())
        .map(|r| r >= backup.rows.len())
        .collect();
    let cell_changed = live
        .rows
        .iter()
        .enumerate()
        .map(|(r, row)| {
            (0..row.len())
                .map(|c| {
                    if row_is_new[r] {
                        return false;
                    }
                    let Some(&b) = live_to_backup.get(&c) else {
                        return false;
                    };
                    backup.rows[r].get(b) != Some(&row[c])
                })
                .collect()
        })
        .collect();
    QueryDiff {
        cell_changed,
        row_is_new,
        renamed_columns: renamed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Unchanged,
    Changed,
    New,
}

#[derive(Debug, Clone, Default)]
pub struct TableSnapshot {
    /// (column name, SQL type) in order; a different list is a changed table.
    pub columns: Vec<(String, String)>,
    pub rows: Vec<Vec<Cell>>,
}

fn counts(rows: &[Vec<Cell>]) -> HashMap<&Vec<Cell>, i64> {
    let mut m = HashMap::new();
    for r in rows {
        *m.entry(r).or_insert(0) += 1;
    }
    m
}

/// Per live table: `New` if the backup has no such table, `Changed` if its columns or its rows differ (row order is ignored),
/// else `Unchanged`. Tables only in the backup are not reported, as in the TS.
///
/// Rows compare as a multiset; the TS used `EXCEPT`, which ignores duplicates, so adding a copy of an existing row went
/// unnoticed.
pub fn compare_to_backup(
    live: &BTreeMap<String, TableSnapshot>,
    backup: &BTreeMap<String, TableSnapshot>,
) -> BTreeMap<String, Change> {
    live.iter()
        .map(|(name, l)| {
            let change = match backup.get(name) {
                None => Change::New,
                Some(b) if b.columns != l.columns => Change::Changed,
                Some(b) if counts(&l.rows) == counts(&b.rows) => Change::Unchanged,
                Some(_) => Change::Changed,
            };
            (name.clone(), change)
        })
        .collect()
}
