//! Port of `textColumns.ts` and `interpretTextColumns` (`duckdbConnection.ts`): a text column that
//! demonstrably holds numbers with Excel error markers (`#N/A`, `NA`, ...) in it is read as numbers with
//! the markers shown as empty. A sample picks the convention; a scan of the WHOLE column proves nothing
//! is lost. The file on disk is never touched and the decision is reported, never silent.
//! shortcut: the reference splits the probes into column groups run on side connections; this runs them in
//! one query. Same counts, same decisions; upgrade only if a measured open of a very wide CSV needs it.
use crate::csv::normalised;
use crate::duckdb::{Engine, quote_ident, quote_literal};
use crate::locale::{LocaleVerdict, NumberLocale, decide_locale, js_trim, parse_en, parse_eu};

/// How many rows to sample when deciding what a text column holds.
const TEXT_COLUMN_SAMPLE_ROWS: usize = 2000;

/// `_EXCEL_ERRORS` (etl_values.py), verbatim. The default of `dataFileViewer.nullText`.
pub const EXCEL_ERROR_TOKENS: [&str; 9] = [
    "#VALUE!", "#REF!", "#DIV/0!", "#NAME?", "#NUM!", "#NULL!", "#N/A", "N/A", "NA",
];

pub fn default_null_text() -> Vec<String> {
    EXCEL_ERROR_TOKENS.iter().map(|t| (*t).to_owned()).collect()
}

/// `_is_excel_error_string`: trimmed, upper-cased, matched.
pub fn is_excel_error(value: &str, tokens: &[String]) -> bool {
    let s = js_trim(value).to_uppercase();
    !s.is_empty() && tokens.iter().any(|t| js_trim(t).to_uppercase() == s)
}

/// What a promoted column is read as: the narrowest type that keeps every value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionTarget {
    Bigint,
    Hugeint,
    Double,
}
impl PromotionTarget {
    fn sql(self) -> &'static str {
        match self {
            Self::Bigint => "bigint",
            Self::Hugeint => "hugeint",
            Self::Double => "double",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextReason {
    Residue,
    Undecidable,
    Empty,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextColumnVerdict {
    /// Every non-marker value is a number; `integral` picks which target is tried first.
    Numeric {
        locale: NumberLocale,
        markers: usize,
        values: usize,
        integral: bool,
    },
    /// Nothing but markers: they become NULL, but no type is invented.
    MarkersOnly { markers: usize },
    /// Left alone; `residue` carries up to three of the values that decided it.
    Text {
        reason: TextReason,
        residue: Vec<String>,
    },
}

/// Is this text column a numeric column with markers in it? Runs on a sample: it picks the locale and
/// discards the plainly textual columns; the whole-column probes are the safety check.
pub fn classify_text_column(values: &[Option<String>], tokens: &[String]) -> TextColumnVerdict {
    let clean: Vec<&str> = values
        .iter()
        .flatten()
        .map(|v| js_trim(v))
        .filter(|v| !v.is_empty())
        .collect();
    let text = |reason, residue| TextColumnVerdict::Text { reason, residue };
    if clean.is_empty() {
        return text(TextReason::Empty, vec![]);
    }
    let (mut markers, mut rest) = (0, vec![]);
    for s in clean {
        if is_excel_error(s, tokens) {
            markers += 1;
        } else {
            rest.push(s);
        }
    }
    if rest.is_empty() {
        return if markers > 0 {
            TextColumnVerdict::MarkersOnly { markers }
        } else {
            text(TextReason::Empty, vec![])
        };
    }
    let first3 = |v: Vec<&&str>| v.into_iter().take(3).map(|s| (*s).to_owned()).collect();
    let unparseable: Vec<&&str> = rest
        .iter()
        .filter(|s| parse_en(s).is_none() && parse_eu(s).is_none())
        .collect();
    if !unparseable.is_empty() {
        return text(TextReason::Residue, first3(unparseable));
    }
    let opt: Vec<Option<&str>> = rest.iter().map(|s| Some(*s)).collect();
    let locale = match decide_locale(&opt) {
        LocaleVerdict::Undecidable { samples, .. } => {
            return text(TextReason::Undecidable, samples);
        }
        LocaleVerdict::Decided { locale, .. } => locale,
        // The two readings are identical; "en" is the one whose SQL is a plain cast.
        LocaleVerdict::NoSeparators => NumberLocale::En,
    };
    let parse = if locale == NumberLocale::En {
        parse_en
    } else {
        parse_eu
    };
    let failed: Vec<&&str> = rest.iter().filter(|s| parse(s).is_none()).collect();
    if !failed.is_empty() {
        return text(TextReason::Residue, first3(failed));
    }
    let integral = rest.iter().all(|s| is_integral(s, locale));
    TextColumnVerdict::Numeric {
        locale,
        markers,
        values: rest.len(),
        integral,
    }
}

/// Written as a whole number: a test on the TEXT (`1e3` and `1.0` are measurements, not identifiers).
fn is_integral(value: &str, locale: NumberLocale) -> bool {
    let bare = if locale == NumberLocale::Eu {
        value.replace('.', "")
    } else {
        value.replace(',', "")
    };
    let bare = js_trim(&bare);
    let digits = bare.strip_prefix(['+', '-']).unwrap_or(bare);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// The `upper(trim(col)) in (...)` test, shared by the projection and the checks.
pub fn marker_test(column: &str, tokens: &[String]) -> String {
    let list: Vec<String> = tokens
        .iter()
        .map(|t| quote_literal(&js_trim(t).to_uppercase()))
        .collect();
    // `list_contains`, not `in (...)`: DuckDB rewrites a constant IN list into a join, and a few hundred of
    // those in one projection exhaust the 512 MB reader budget (a 300-column CSV could not be queried).
    format!(
        "list_contains([{}], upper(trim({})))",
        list.join(", "),
        quote_ident(column)
    )
}

/// One text column read as numbers with its markers nulled.
pub fn marker_null_expr(
    column: &str,
    locale: NumberLocale,
    target: PromotionTarget,
    tokens: &[String],
) -> String {
    format!(
        "case when {} then null else try_cast({} as {}) end",
        marker_test(column, tokens),
        normalised(column, locale),
        target.sql()
    )
}

/// `markerFidelityExpr`'s `double` test for one value: loss of magnitude, not of digits past a double.
fn double_changed_expr(column: &str, locale: NumberLocale) -> String {
    let n = normalised(column, locale);
    let exact = format!("try_cast({n} as decimal(38,15))");
    format!(
        "(try_cast({n} as double) = 0 and regexp_matches(split_part(lower({n}), 'e', 1), '[1-9]') or {exact} is null or {exact} is distinct from try_cast(try_cast(try_cast({n} as double) as varchar) as decimal(38,15)))"
    )
}

/// Values this column would CHANGE (not merely cannot read) when read as `target`.
pub fn marker_fidelity_expr(
    column: &str,
    locale: NumberLocale,
    target: PromotionTarget,
    tokens: &[String],
) -> String {
    let (col, n) = (quote_ident(column), normalised(column, locale));
    let changed = if target == PromotionTarget::Double {
        let identifier_changed = format!(
            "regexp_full_match({n}, '[+-]?[0-9]+') and try_cast({n} as hugeint)::varchar is distinct from {n}"
        );
        format!(
            "({identifier_changed} or {})",
            double_changed_expr(column, locale)
        )
    } else {
        format!(
            "try_cast({n} as {})::varchar is distinct from {n}",
            target.sql()
        )
    };
    format!(
        "count(*) filter (where {col} is not null and trim({col}) <> '' and not {} and {changed})",
        marker_test(column, tokens)
    )
}

/// Markers become NULL, the column stays exactly as typed. For a markers-only column.
pub fn marker_blank_expr(column: &str, tokens: &[String]) -> String {
    format!(
        "case when {} then null else {} end",
        marker_test(column, tokens),
        quote_ident(column)
    )
}

/// Values this column would lose: not null, not blank, not a marker, and unreadable by the conversion.
pub fn marker_residue_expr(column: &str, locale: NumberLocale, tokens: &[String]) -> String {
    let col = quote_ident(column);
    format!(
        "count(*) filter (where {col} is not null and trim({col}) <> '' and not {} and {} is null)",
        marker_test(column, tokens),
        marker_null_expr(column, locale, PromotionTarget::Double, tokens)
    )
}

pub fn marker_count_expr(column: &str, tokens: &[String]) -> String {
    format!("count(*) filter (where {})", marker_test(column, tokens))
}

/// Cells that are neither blank nor a marker: proves a "nothing but markers" column over the whole column.
pub fn non_marker_count_expr(column: &str, tokens: &[String]) -> String {
    let col = quote_ident(column);
    format!(
        "count(*) filter (where {col} is not null and trim({col}) <> '' and not {})",
        marker_test(column, tokens)
    )
}

/// "1,234": thousands grouping, as `toLocaleString('en-US')` prints an integer.
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}
fn shown(columns: &[String], quoted: bool) -> String {
    let list: Vec<String> = columns
        .iter()
        .take(3)
        .map(|c| {
            if quoted {
                format!("\"{c}\"")
            } else {
                c.clone()
            }
        })
        .collect();
    format!(
        "{}{}",
        list.join(", "),
        if columns.len() > 3 { ", …" } else { "" }
    )
}

fn refusal_notice(column: &str, residue: &[String]) -> String {
    let what = if residue.is_empty() {
        "values that are neither markers nor numbers".to_owned()
    } else {
        format!(
            "values such as {}",
            residue
                .iter()
                .map(|s| format!("\"{s}\""))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "Column \"{column}\" was left as text: it holds error markers, but also {what}, so reading it as numbers would lose them."
    )
}

fn unpreserved_notice(columns: &[String]) -> Vec<String> {
    if columns.is_empty() {
        return vec![];
    }
    vec![format!(
        "{n} column{s} ({list}) hold only numbers but are shown as text: reading them as numbers would change a value — a leading zero is part of an identifier, and an integer too wide for an exact type can only be stored approximately. They will sort and filter as text.",
        n = columns.len(),
        s = plural(columns.len()),
        list = shown(columns, true),
    )]
}

struct Converted {
    column: String,
    locale: NumberLocale,
    target: PromotionTarget,
    markers: usize,
}

impl Engine {
    /// Read `view`'s text columns as numbers where they demonstrably are numbers with markers in them.
    /// `read_expr` is how the view reads its source. Returns the notices; on any failure the view is left
    /// exactly as it was (the reference does the same: a view it cannot describe is not touched).
    pub(crate) fn interpret_text_columns(
        &mut self,
        view: &str,
        read_expr: &str,
        tokens: &[String],
    ) -> Vec<String> {
        if tokens.is_empty() {
            return vec![];
        }
        self.try_interpret_text_columns(view, read_expr, tokens)
            .unwrap_or_default()
    }

    fn try_interpret_text_columns(
        &mut self,
        view: &str,
        read_expr: &str,
        tokens: &[String],
    ) -> Result<Vec<String>, duckdb::Error> {
        let ident = quote_ident(view);
        let mut stmt = self.conn.prepare(&format!(
            "select column_name, column_type from (describe {ident})"
        ))?;
        let described: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        let names: Vec<String> = described.iter().map(|(n, _)| n.clone()).collect();
        let text_columns: Vec<String> = described
            .into_iter()
            .filter(|(_, t)| t == "VARCHAR")
            .map(|(n, _)| n)
            .collect();
        if text_columns.is_empty() {
            return Ok(vec![]);
        }

        // A reservoir sample, NOT `limit N`: the head of a time series is the least representative part.
        let select_list: Vec<String> = text_columns.iter().map(|c| quote_ident(c)).collect();
        let mut stmt = self.conn.prepare(&format!(
            "select {} from {ident} using sample reservoir({TEXT_COLUMN_SAMPLE_ROWS} rows) repeatable(1)",
            select_list.join(", ")
        ))?;
        let mut sampled: Vec<Vec<Option<String>>> = vec![vec![]; text_columns.len()];
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            for (i, values) in sampled.iter_mut().enumerate() {
                values.push(row.get::<_, Option<String>>(i)?);
            }
        }
        drop(rows);
        drop(stmt);

        let mut candidates: Vec<(String, NumberLocale, bool)> = vec![];
        let mut blanked: Vec<String> = vec![];
        let mut refused: Vec<(String, Vec<String>)> = vec![];
        let mut unpreserved: Vec<String> = vec![];
        for (column, values) in text_columns.iter().zip(&sampled) {
            match classify_text_column(values, tokens) {
                TextColumnVerdict::Numeric {
                    locale, integral, ..
                } => candidates.push((column.clone(), locale, integral)),
                TextColumnVerdict::MarkersOnly { .. } => blanked.push(column.clone()),
                TextColumnVerdict::Text { reason, residue } => {
                    // Only worth a notice when the column actually holds markers.
                    if reason != TextReason::Empty
                        && values.iter().flatten().any(|v| is_excel_error(v, tokens))
                    {
                        refused.push((column.clone(), residue));
                    }
                }
            }
        }
        let refusals = |refused: &[(String, Vec<String>)]| -> Vec<String> {
            refused.iter().map(|(c, r)| refusal_notice(c, r)).collect()
        };
        if candidates.is_empty() && blanked.is_empty() {
            return Ok(refusals(&refused));
        }

        // The check that makes this safe rather than merely likely: the WHOLE column, not the sample.
        // Four probes per candidate: markers, residue, bigint fidelity, hugeint fidelity (both `double`
        // for a non-integral column, so the result stays rectangular).
        const PROBES_PER_CANDIDATE: usize = 4;
        let mut probes: Vec<String> = vec![];
        for (column, locale, integral) in &candidates {
            let (narrow, wide) = if *integral {
                (PromotionTarget::Bigint, PromotionTarget::Hugeint)
            } else {
                (PromotionTarget::Double, PromotionTarget::Double)
            };
            probes.push(marker_count_expr(column, tokens));
            probes.push(marker_residue_expr(column, *locale, tokens));
            probes.push(marker_fidelity_expr(column, *locale, narrow, tokens));
            probes.push(marker_fidelity_expr(column, *locale, wide, tokens));
        }
        probes.extend(blanked.iter().map(|c| non_marker_count_expr(c, tokens)));
        let mut stmt = self
            .conn
            .prepare(&format!("select {} from {ident}", probes.join(", ")))?;
        let counts: Vec<i64> = stmt.query_row([], |r| {
            (0..probes.len())
                .map(|i| r.get::<_, i64>(i))
                .collect::<Result<_, _>>()
        })?;
        drop(stmt);

        let mut converted: Vec<Converted> = vec![];
        for (i, (column, locale, integral)) in candidates.iter().enumerate() {
            let base = PROBES_PER_CANDIDATE * i;
            if counts[base + 1] > 0 {
                refused.push((column.clone(), vec![]));
                continue;
            }
            let target = if *integral {
                if counts[base + 2] == 0 {
                    Some(PromotionTarget::Bigint)
                } else if counts[base + 3] == 0 {
                    Some(PromotionTarget::Hugeint)
                } else {
                    None
                }
            } else if counts[base + 2] == 0 {
                Some(PromotionTarget::Double)
            } else {
                None
            };
            match target {
                None => unpreserved.push(column.clone()),
                Some(target) => converted.push(Converted {
                    column: column.clone(),
                    locale: *locale,
                    target,
                    markers: usize::try_from(counts[base]).unwrap_or(0),
                }),
            }
        }
        let mut blanked_confirmed: Vec<String> = vec![];
        for (i, column) in blanked.iter().enumerate() {
            if counts[PROBES_PER_CANDIDATE * candidates.len() + i] == 0 {
                blanked_confirmed.push(column.clone());
            } else {
                // The sample saw only markers and the whole column disagrees: keep the text.
                refused.push((column.clone(), vec![]));
            }
        }
        if converted.is_empty() && blanked_confirmed.is_empty() {
            let mut notices = refusals(&refused);
            notices.extend(unpreserved_notice(&unpreserved));
            return Ok(notices);
        }

        // Never half-applied: one statement replaces the view or nothing changes.
        let projection: Vec<String> = names
            .iter()
            .map(|name| {
                if let Some(c) = converted.iter().find(|c| &c.column == name) {
                    format!(
                        "{} as {}",
                        marker_null_expr(name, c.locale, c.target, tokens),
                        quote_ident(name)
                    )
                } else if blanked_confirmed.contains(name) {
                    format!(
                        "{} as {}",
                        marker_blank_expr(name, tokens),
                        quote_ident(name)
                    )
                } else {
                    quote_ident(name)
                }
            })
            .collect();
        self.conn.execute_batch(&format!(
            "create or replace view {ident} as select {} from {read_expr}",
            projection.join(", ")
        ))?;

        let mut notices = vec![];
        let total_markers: usize = converted.iter().map(|c| c.markers).sum();
        if !converted.is_empty() {
            let marker_part = if total_markers > 0 {
                format!(
                    ", with {} Excel error marker{} shown as empty",
                    grouped(total_markers),
                    plural(total_markers)
                )
            } else {
                String::new()
            };
            notices.push(format!(
                "{view}: {} text column{} read as numbers{marker_part}. The file itself is unchanged — set dataFileViewer.nullText to [] to read it literally.",
                converted.len(),
                plural(converted.len()),
            ));
        }
        if !blanked_confirmed.is_empty() {
            let n = blanked_confirmed.len();
            notices.push(format!(
                "{view}: {n} column{} hold nothing but error markers ({}) and are shown as empty. They keep their original type — a column that never held a value cannot say what type it is.",
                plural(n),
                shown(&blanked_confirmed, false),
            ));
        }
        notices.extend(refusals(&refused));
        notices.extend(unpreserved_notice(&unpreserved));
        Ok(notices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> Vec<String> {
        default_null_text()
    }
    fn col(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| Some((*s).to_owned())).collect()
    }

    #[test]
    fn markers_match_trimmed_and_case_insensitively() {
        let t = tokens();
        assert!(
            is_excel_error(" #n/a ", &t) && is_excel_error("na", &t) && is_excel_error("N/A", &t)
        );
        assert!(
            !is_excel_error("", &t) && !is_excel_error("12", &t) && !is_excel_error("name", &t)
        );
        assert!(
            !is_excel_error("NA", &[]),
            "no tokens: a marker is just a word"
        );
    }

    #[test]
    fn a_numeric_column_with_markers_is_numeric_and_counted() {
        let v = classify_text_column(&col(&["1.5", "#N/A", "2.25", "NA"]), &tokens());
        assert_eq!(
            v,
            TextColumnVerdict::Numeric {
                locale: NumberLocale::En,
                markers: 2,
                values: 2,
                integral: false
            }
        );
    }

    #[test]
    fn one_foreign_value_refuses_the_whole_column() {
        let v = classify_text_column(&col(&["1", "2", "note", "#N/A"]), &tokens());
        assert_eq!(
            v,
            TextColumnVerdict::Text {
                reason: TextReason::Residue,
                residue: vec!["note".into()]
            }
        );
    }

    #[test]
    fn markers_only_and_empty_columns_say_so() {
        assert_eq!(
            classify_text_column(&col(&["#N/A", "NA"]), &tokens()),
            TextColumnVerdict::MarkersOnly { markers: 2 }
        );
        assert!(matches!(
            classify_text_column(&[None, Some("  ".into())], &tokens()),
            TextColumnVerdict::Text {
                reason: TextReason::Empty,
                ..
            }
        ));
        // with no tokens a marker is a word, and refuses the column
        assert!(matches!(
            classify_text_column(&col(&["1", "NA"]), &[]),
            TextColumnVerdict::Text {
                reason: TextReason::Residue,
                ..
            }
        ));
    }

    #[test]
    fn locale_follows_the_evidence_and_ambiguity_keeps_the_text() {
        let eu = classify_text_column(&col(&["1.234,56", "12,5", "NA"]), &tokens());
        assert!(matches!(
            eu,
            TextColumnVerdict::Numeric {
                locale: NumberLocale::Eu,
                markers: 1,
                ..
            }
        ));
        let en = classify_text_column(&col(&["1,234.56", "12.5", "NA"]), &tokens());
        assert!(matches!(
            en,
            TextColumnVerdict::Numeric {
                locale: NumberLocale::En,
                ..
            }
        ));
        let amb = classify_text_column(&col(&["1.234", "2.345", "NA"]), &tokens());
        assert!(matches!(
            amb,
            TextColumnVerdict::Text {
                reason: TextReason::Undecidable,
                ..
            }
        ));
    }

    #[test]
    fn integral_is_a_test_on_the_text_in_the_locales_own_convention() {
        let v = |s: &[&str]| classify_text_column(&col(s), &tokens());
        assert!(matches!(
            v(&["007", "42"]),
            TextColumnVerdict::Numeric { integral: true, .. }
        ));
        assert!(matches!(
            v(&["1.0", "42"]),
            TextColumnVerdict::Numeric {
                integral: false,
                ..
            }
        ));
        assert!(matches!(
            v(&["1e3", "42"]),
            TextColumnVerdict::Numeric {
                integral: false,
                ..
            }
        ));
        assert!(matches!(
            v(&["1.234.567", "2.345.678"]),
            TextColumnVerdict::Numeric {
                locale: NumberLocale::Eu,
                integral: true,
                ..
            }
        ));
    }

    #[test]
    fn identifiers_in_sql_cannot_break_out() {
        let t = vec!["it's".to_owned()];
        let sql = marker_test("a\"b", &t);
        assert_eq!(sql, "list_contains(['IT''S'], upper(trim(\"a\"\"b\")))");
    }

    #[test]
    fn counts_are_grouped_like_en_us() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1234), "1,234");
        assert_eq!(grouped(1234567), "1,234,567");
    }
}
