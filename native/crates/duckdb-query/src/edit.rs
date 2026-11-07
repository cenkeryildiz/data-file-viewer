//! Edit eligibility of a read (`checkEditableSelect` with `describeOnly`, as the read worker asks it, and
//! `baseTableOfSelect`): only a plain `select * from "<one table>" [where] [order by] [limit n [offset m]]`
//! may be edited, and the answer is always re-derived here, never taken from the webview. The gate is
//! deliberately conservative: a false negative only hides the edit affordance. The real boundary is the
//! parser-backed read policy this runs first. No write path lives here.
//! shortcut: the reference's two regular expressions are hand-parsed (the `regex` dependency has no
//! Unicode classes); whitespace and `\b` follow JavaScript's, and `tests/engine.rs` checks both against it.
use crate::duckdb::{Engine, Error, quote_literal};

/// What the host may do with a result. `table`/`columns` are set only when editable.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Editability {
    pub editable: bool,
    pub table: Option<String>,
    pub columns: Vec<String>,
    /// Set when the shape qualifies but the file's values are not shown exactly (`Engine::edit_blockers`).
    pub reason: Option<String>,
}

/// JavaScript `\s`: Unicode White_Space and line terminators, plus the BOM (not U+0085).
fn ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
/// JavaScript `String.prototype.trim`.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(ws)
}
/// One or more whitespace characters: what follows them and how many there were.
fn skip_ws_n(s: &str) -> Option<(&str, usize)> {
    let rest = s.trim_start_matches(ws);
    let n = s[..s.len() - rest.len()].chars().count();
    (n > 0).then_some((rest, n))
}
fn skip_ws(s: &str) -> Option<&str> {
    skip_ws_n(s).map(|(rest, _)| rest)
}
/// `word` (ASCII, case-insensitive) at the start; the caller checks what follows.
fn word<'a>(s: &'a str, w: &str) -> Option<&'a str> {
    s.get(..w.len())
        .filter(|head| head.eq_ignore_ascii_case(w))
        .map(|_| &s[w.len()..])
}

/// `\s+where\s+[\s\S]+?` (or `order\s+by`): the lazy body takes anything, so the clause matches when at
/// least one character follows the last `\s+` (which may give one whitespace back to the body).
fn clause_with_body(rest: &str, words: &[&str]) -> bool {
    let Some(mut s) = skip_ws(rest) else {
        return false;
    };
    for (i, w) in words.iter().enumerate() {
        let Some((after, run)) = word(s, w).and_then(skip_ws_n) else {
            return false;
        };
        s = after;
        if i + 1 == words.len() {
            return !s.is_empty() || run >= 2;
        }
    }
    false
}

/// `\s+limit\s+\d+(\s+offset\s+\d+)?` followed by `\s*;?\s*$`.
fn limit_then_end(rest: &str) -> bool {
    let digits = |s: &str| -> Option<usize> {
        let n = s.bytes().take_while(u8::is_ascii_digit).count();
        (n > 0).then_some(n)
    };
    let Some(s) = skip_ws(rest)
        .and_then(|s| word(s, "limit"))
        .and_then(skip_ws)
    else {
        return false;
    };
    let Some(n) = digits(s) else {
        return false;
    };
    let s = &s[n..];
    if let Some(after) = skip_ws(s)
        .and_then(|s| word(s, "offset"))
        .and_then(skip_ws)
        .and_then(|s| digits(s).map(|n| &s[n..]))
        && end_only(after)
    {
        return true;
    }
    end_only(s)
}
/// `\s*;?\s*$`
fn end_only(s: &str) -> bool {
    let s = s.trim_start_matches(ws);
    let s = s.strip_prefix(';').unwrap_or(s);
    s.trim_start_matches(ws).is_empty()
}

/// The identifier after `from`, and what follows it: `"(?:[^"]|"")+"` or `[a-zA-Z_][a-zA-Z0-9_]*`.
fn identifier(s: &str) -> Option<(&str, &str, bool)> {
    if let Some(body) = s.strip_prefix('"') {
        let mut chars = body.char_indices().peekable();
        let mut inner = 0;
        while let Some((i, c)) = chars.next() {
            if c == '"' {
                if chars.peek().is_some_and(|(_, n)| *n == '"') {
                    chars.next();
                    inner += 1;
                } else if inner > 0 {
                    return Some((&body[..i], &body[i + 1..], true));
                } else {
                    return None;
                }
            } else {
                inner += 1;
            }
        }
        return None;
    }
    let first = s.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let n = s
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    Some((&s[..n], &s[n..], false))
}

/// `FORBIDDEN_KEYWORDS_RE`: `\b(join|group\s+by|distinct|union|intersect|except|using|window)\b`, where
/// `\b` is JavaScript's (ASCII word characters).
fn has_forbidden_keyword(sql: &str) -> bool {
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let bytes = sql.as_bytes();
    let (mut i, mut words) = (0, vec![]);
    while i < bytes.len() {
        if is_word(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_word(bytes[i]) {
                i += 1;
            }
            words.push((start, i));
        } else {
            i += 1;
        }
    }
    words.iter().enumerate().any(|(k, &(a, b))| {
        let w = sql[a..b].to_ascii_lowercase();
        match w.as_str() {
            "join" | "distinct" | "union" | "intersect" | "except" | "using" | "window" => true,
            "group" => words.get(k + 1).is_some_and(|&(na, nb)| {
                sql[na..nb].eq_ignore_ascii_case("by") && na > b && sql[b..na].chars().all(ws)
            }),
            _ => false,
        }
    })
}

/// The one table a plain `select * from X ...` reads, or `None` for anything else (`baseTableOfSelect`).
pub fn base_table_of_select(sql: &str) -> Option<String> {
    let t = js_trim(sql);
    let rest = word(t, "select")
        .and_then(skip_ws)
        .and_then(|s| s.strip_prefix('*'))
        .and_then(skip_ws)
        .and_then(|s| word(s, "from"))
        .and_then(skip_ws)?;
    let (name, rest, quoted) = identifier(rest)?;
    let tail_ok = end_only(rest)
        || clause_with_body(rest, &["where"])
        || clause_with_body(rest, &["order", "by"])
        || limit_then_end(rest);
    if !tail_ok || has_forbidden_keyword(sql) {
        return None;
    }
    Some(if quoted {
        name.replace("\"\"", "\"")
    } else {
        name.to_owned()
    })
}

impl Engine {
    /// May `sql`'s result be edited, and through which table? A refused query is an error (the read policy
    /// runs first); a query that is merely not a plain single-table select is `editable: false`.
    pub fn check_editable_select(&self, sql: &str) -> Result<Editability, Error> {
        self.assert_read_sql(sql)?;
        let not = Ok(Editability::default());
        let Some(wanted) = base_table_of_select(sql) else {
            return not;
        };
        let tables = self.list_tables()?;
        let lower = wanted.to_lowercase();
        let mut matches = tables.iter().filter(|table| table.to_lowercase() == lower);
        let Some(found) = matches.next() else {
            return not;
        };
        // An unqualified edit must never combine identities or columns from different schemas.
        if matches.next().is_some() {
            return not;
        }
        if let Some(reason) = self.edit_blockers.first() {
            return Ok(Editability {
                reason: Some(reason.clone()),
                ..Editability::default()
            });
        }
        let mut stmt = self.conn.prepare(&format!(
            "select column_name from information_schema.columns where table_catalog = system.main.current_database() and table_name = {} order by ordinal_position",
            quote_literal(found)
        ))?;
        let columns = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(Editability {
            editable: true,
            table: Some(found.clone()),
            columns,
            reason: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(sql: &str) -> Option<String> {
        base_table_of_select(sql)
    }

    #[test]
    fn a_plain_select_names_its_table() {
        for (sql, table) in [
            ("select * from t", "t"),
            ("  SELECT  *  FROM  \"My \"\"T\"\"\"  ;  ", "My \"T\""),
            (
                "select * from t where a = 1 order by a limit 5 offset 2",
                "t",
            ),
            ("select * from t order by a", "t"),
            ("select * from t limit 10", "t"),
            ("select * from t limit 10 offset 5;", "t"),
            ("select\u{a0}*\u{a0}from\u{a0}t", "t"),
        ] {
            assert_eq!(t(sql).as_deref(), Some(table), "{sql}");
        }
    }

    #[test]
    fn everything_else_is_not_editable() {
        for sql in [
            "select a from t",
            "select * from t, u",
            "select * from t join u on 1=1",
            "select * from t group by a",
            "select distinct * from t",
            "select * from t where a in (select 1 union select 2)",
            "select * from t limit x",
            "select * from t offset 3",
            "select * from t where",
            "select * from t where ",
            "select * from \"\"",
            "select * from \"abc",
            "select * from 1t",
            "select * from t; select 1",
            "select * from t window w as ()",
            "select*from t",
        ] {
            assert_eq!(t(sql), None, "{sql}");
        }
        // a keyword inside a longer word is not the keyword
        assert_eq!(
            t("select * from t where x = 'rejoin' or my_union = 1").as_deref(),
            Some("t")
        );
        // ... but a quoted use of one is refused, as the reference does
        assert_eq!(t("select * from t where x = 'a union b'"), None);
        assert_eq!(t("select * from t where a group\u{a0}by"), None);
    }
}
