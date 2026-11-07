//! Safe Mode statement scanner (`sqlSafety.ts`). Allowlist on the leading keyword plus a scan of the
//! whole input, because a write can hide behind a safe first word (`select 1; drop ...`, `with x as (...) delete ...`).
const SAFE_LEADING_KEYWORDS: [&str; 7] = [
    "select",
    "with",
    "explain",
    "describe",
    "show",
    "summarize",
    "call",
];
const WRITE_KEYWORDS: [&str; 18] = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "truncate",
    "replace",
    "attach",
    "detach",
    "copy",
    "pragma",
    "vacuum",
    "install",
    "load",
    "export",
    "import",
    "checkpoint",
];

/// JavaScript's `\s` set (not Rust's `char::is_whitespace`: U+0085 and U+FEFF differ).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}
pub(crate) fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Length of a dollar-quote opener (`$$` or `$tag$`) at the start of `b`.
fn dollar_tag_len(b: &[u8]) -> Option<usize> {
    if b.first() != Some(&b'$') {
        return None;
    }
    let mut j = 1;
    if b.get(j)
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
    {
        while b.get(j).is_some_and(|c| is_word(*c)) {
            j += 1;
        }
    }
    (b.get(j) == Some(&b'$')).then_some(j + 1)
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Removes comments, string literals and quoted identifiers in one left-to-right pass. A scanner, not
/// regexes: comments and strings nest each other, and a dollar-quoted string containing `'` must not
/// open a phantom literal that swallows a following `;` and DROP.
fn strip_comments_and_literals(sql: &str) -> String {
    let b = sql.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let ch = b[i];
        let next = b.get(i + 1).copied();
        if ch == b'-' && next == Some(b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            out.push(b' ');
            continue;
        }
        if ch == b'/' && next == Some(b'*') {
            i += 2;
            while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            i += 2;
            out.push(b' ');
            continue;
        }
        if let Some(len) = dollar_tag_len(&b[i..]).filter(|_| ch == b'$') {
            i = find(b, &b[i..i + len], i + len).map_or(b.len(), |close| close + len);
            out.push(b' ');
            continue;
        }
        if ch == b'\'' || ch == b'"' {
            i += 1;
            while i < b.len() {
                if b[i] == ch {
                    if b.get(i + 1) == Some(&ch) {
                        i += 2; // doubled quote is an escaped quote
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(b' ');
            continue;
        }
        out.push(ch);
        i += 1;
    }
    // Skipped ranges start and end on ASCII delimiters, so the rest stays valid UTF-8.
    String::from_utf8_lossy(&out).into_owned()
}

/// `/;\s*\S/`: a second statement after a semicolon. One trailing `;` is fine.
fn has_statement_after_semicolon(stripped: &str) -> bool {
    stripped
        .char_indices()
        .any(|(i, c)| c == ';' && stripped[i + 1..].chars().any(|c| !is_js_space(c)))
}

/// A short reason the statement is not safe in Safe Mode, or `None` if it is. Names what actually
/// tripped: for `select 1; drop table x` the first word is the innocent half.
pub fn destructive_reason(sql: &str) -> Option<String> {
    let stripped = strip_comments_and_literals(sql);
    let stripped = js_trim(&stripped);
    if stripped.is_empty() {
        return None;
    }
    if has_statement_after_semicolon(stripped) {
        return Some("it contains more than one statement".into());
    }
    let end = stripped
        .bytes()
        .position(|c| !c.is_ascii_alphabetic())
        .unwrap_or(stripped.len());
    let first = stripped[..end].to_ascii_lowercase();
    if !SAFE_LEADING_KEYWORDS.contains(&first.as_str()) {
        let shown = if first.is_empty() {
            stripped.chars().take(12).collect()
        } else {
            first
        };
        return Some(format!("it starts with \"{shown}\""));
    }
    // \b(kw)\b: a keyword is a whole [A-Za-z0-9_]+ run, so create_date never matches.
    let b = stripped.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !is_word(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && is_word(b[i]) {
            i += 1;
        }
        let word = stripped[start..i].to_ascii_lowercase();
        if WRITE_KEYWORDS.contains(&word.as_str()) {
            return Some(format!("it contains \"{word}\""));
        }
    }
    None
}

/// True if the input runs more than one statement.
pub fn has_multiple_statements(sql: &str) -> bool {
    has_statement_after_semicolon(&strip_comments_and_literals(sql))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reason(sql: &str) -> String {
        destructive_reason(sql).unwrap_or_else(|| panic!("expected a reason for {sql}"))
    }

    #[test]
    fn plain_reads_are_allowed() {
        for sql in [
            "select * from t",
            "SELECT * FROM \"t\" LIMIT 100;",
            "with x as (select 1) select * from x",
            "describe t",
            "summarize t",
        ] {
            assert_eq!(destructive_reason(sql), None, "{sql}");
        }
    }

    #[test]
    fn writes_are_blocked_and_named_by_what_tripped() {
        assert!(reason("drop table t").contains("starts with \"drop\""));
        assert!(reason("update t set a = 1").contains("starts with \"update\""));
        assert!(reason("select 1; drop table t").contains("more than one statement"));
        assert!(reason("with x as (select 1) delete from t").contains("contains \"delete\""));
    }

    #[test]
    fn comments_and_literals_cannot_hide_or_fake_a_write() {
        assert_eq!(
            destructive_reason("select * from t where note = 'a;b'"),
            None
        );
        assert_eq!(
            destructive_reason("select * from t where note = 'drop table x'"),
            None
        );
        assert_eq!(destructive_reason("select * from t -- it's fine\n"), None);
        assert_eq!(destructive_reason("select \"update\" from t"), None);
        assert_eq!(
            destructive_reason("select create_date, update_time from t"),
            None
        );
        assert!(reason("select 1 /* x */ ; drop table t").contains("more than one statement"));
    }

    #[test]
    fn single_trailing_semicolon_is_not_multiple() {
        assert!(!has_multiple_statements("select 1;"));
        assert!(!has_multiple_statements("select 1;   \n"));
        assert!(has_multiple_statements("select 1; select 2"));
        assert!(!has_multiple_statements("select ';'"));
    }

    #[test]
    fn dollar_quoted_string_cannot_smuggle_a_second_statement() {
        let sql = "select $a$'$a$ as c; drop table t; select '1'";
        assert!(destructive_reason(sql).is_some() || has_multiple_statements(sql));
    }

    #[test]
    fn ordinary_dollar_quoted_literal_is_still_allowed() {
        assert_eq!(
            destructive_reason("select $tag$ drop table t $tag$ as note"),
            None
        );
        assert_eq!(
            destructive_reason("select $$ delete everything $$ as note"),
            None
        );
    }

    #[test]
    fn extra_adversarial_inputs_fail_closed_or_stay_valid_utf8() {
        // Unterminated constructs swallow to the end instead of leaking a keyword.
        assert_eq!(destructive_reason("select 'unterminated drop"), None);
        assert_eq!(destructive_reason("select /* unterminated ; drop"), None);
        assert!(reason("select 1;\u{feff}drop table t").contains("more than one statement"));
        assert!(reason("select 1\u{85};drop table t").contains("more than one statement"));
        assert!(reason("select é from t; delete from t").contains("more than one statement"));
        assert!(reason("éé select 1").starts_with("it starts with"));
        assert_eq!(destructive_reason("   -- only a comment"), None);
        assert!(
            reason("select 1 where x = $q$a$q$ and y in (select 1 from drop)")
                .contains("contains \"drop\"")
        );
    }
}
