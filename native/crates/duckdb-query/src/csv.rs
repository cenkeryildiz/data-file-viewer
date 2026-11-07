//! CSV reads (`csvReadExpr`, `sniffCsvLocale`, `csvColumnsADoubleWouldChange`): the decimal convention is
//! sniffed from the file's own values and reported, never guessed; columns a double would change are read
//! from the file's own text instead.
use crate::duckdb::{Engine, Error, OpenOptions, quote_ident, quote_literal};
use crate::locale::{NumberLocale, Undecidable, decide_file};
use crate::text::default_null_text;
use std::path::Path;

/// How many rows to sample when sniffing a CSV's decimal convention.
const LOCALE_SAMPLE_ROWS: usize = 2000;
type SampleColumns = Vec<(String, Vec<Option<String>>)>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocaleReport {
    /// Applied convention, or `None` when the file needed no options.
    pub locale: Option<NumberLocale>,
    /// `true` when the user stated it rather than us sniffing it.
    pub forced: bool,
    /// Columns left as text because nothing in them could break the tie.
    pub undecidable: Vec<Undecidable>,
    /// Different columns wanted different conventions.
    pub conflicting: bool,
}

pub fn csv_read_expr(path: &str, locale: Option<NumberLocale>, text_columns: &[String]) -> String {
    let types = if text_columns.is_empty() {
        String::new()
    } else {
        let list: Vec<String> = text_columns
            .iter()
            .map(|c| format!("{}: 'VARCHAR'", quote_literal(c)))
            .collect();
        format!(", types={{{}}}", list.join(", "))
    };
    match locale {
        // "en" is already what read_csv_auto does; adding the options would only disable its sniffing.
        None | Some(NumberLocale::En) => {
            format!("read_csv_auto({}{types})", quote_literal(path))
        }
        Some(NumberLocale::Eu) => format!(
            "read_csv({}, decimal_separator=',', thousands='.'{types})",
            quote_literal(path)
        ),
    }
}

/// The value with its separators removed in SQL, as `parseEn`/`parseEu` do (`normalisedExpr`).
pub(crate) fn normalised(column: &str, locale: NumberLocale) -> String {
    let col = quote_ident(column);
    match locale {
        NumberLocale::Eu => format!("replace(replace(trim({col}), '.', ''), ',', '.')"),
        NumberLocale::En => format!("replace(trim({col}), ',', '')"),
    }
}
/// Rows of `column` whose text a double would change: an integer past 2^53, an overflow, an underflow.
fn double_fidelity(column: &str, locale: NumberLocale) -> String {
    let (col, n) = (quote_ident(column), normalised(column, locale));
    let value = format!("try_cast({n} as double)");
    let nonzero = format!("regexp_matches(split_part(lower({n}), 'e', 1), '[1-9]')");
    format!(
        "count(*) filter (where case when {col} is null then false \
         when regexp_full_match({n}, '[+-]?[0-9]+') \
         then try_cast({value} as hugeint)::varchar is distinct from {n} \
         else coalesce(not isfinite({value}), true) or ({value} = 0 and {nonzero}) end)"
    )
}

impl Engine {
    /// Sample the file as text and decide the convention. A file that cannot be sampled is a file we
    /// cannot make claims about: fall back to DuckDB's defaults rather than to a guess.
    fn sniff_csv_locale(
        &self,
        path: &str,
    ) -> (Option<NumberLocale>, Vec<Undecidable>, bool, Vec<String>) {
        let sample = || -> Result<SampleColumns, duckdb::Error> {
            let sql = format!(
                "select * from read_csv_auto({}, all_varchar=true) limit {LOCALE_SAMPLE_ROWS}",
                quote_literal(path)
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let mut rows = stmt.query([])?;
            let names = rows
                .as_ref()
                .map(duckdb::Statement::column_names)
                .unwrap_or_default();
            let mut columns: SampleColumns = names.into_iter().map(|n| (n, vec![])).collect();
            while let Some(row) = rows.next()? {
                for (i, (_, values)) in columns.iter_mut().enumerate() {
                    values.push(row.get::<_, Option<String>>(i)?);
                }
            }
            Ok(columns)
        };
        match sample() {
            Ok(columns) if !columns.is_empty() && !columns[0].1.is_empty() => {
                let decision = decide_file(&columns);
                let mut text_columns = if decision.conflicting {
                    decision.decided
                } else {
                    vec![]
                };
                if decision.locale.is_none() {
                    text_columns.extend(decision.undecidable.iter().map(|u| u.column.clone()));
                }
                (
                    decision.locale,
                    decision.undecidable,
                    decision.conflicting,
                    text_columns,
                )
            }
            _ => (None, vec![], false, vec![]),
        }
    }

    /// DOUBLE columns of the view whose own text a double would change, found in one scan.
    fn csv_columns_a_double_would_change(
        &self,
        path: &str,
        locale: Option<NumberLocale>,
        view: &str,
    ) -> Result<Vec<String>, Error> {
        let fail = |e: duckdb::Error| {
            Error::Engine(format!(
                "CSV fidelity verification failed; the file was not opened: {e}"
            ))
        };
        let mut stmt = self
            .conn
            .prepare(&format!(
                "select column_name from (describe {}) where column_type = 'DOUBLE'",
                quote_ident(view)
            ))
            .map_err(fail)?;
        let doubles: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(fail)?
            .collect::<Result<_, _>>()
            .map_err(fail)?;
        if doubles.is_empty() {
            return Ok(vec![]);
        }
        let locale = locale.unwrap_or(NumberLocale::En);
        let exprs: Vec<String> = doubles.iter().map(|c| double_fidelity(c, locale)).collect();
        let sql = format!(
            "select {} from {}",
            exprs.join(", "),
            csv_read_expr(
                path,
                Some(locale).filter(|l| *l == NumberLocale::Eu),
                &doubles
            )
        );
        let mut stmt = self.conn.prepare(&sql).map_err(fail)?;
        let counts: Vec<i64> = stmt
            .query_row([], |r| {
                (0..doubles.len())
                    .map(|i| r.get::<_, i64>(i))
                    .collect::<Result<_, _>>()
            })
            .map_err(fail)?;
        Ok(doubles
            .into_iter()
            .zip(counts)
            .filter(|(_, n)| *n > 0)
            .map(|(c, _)| c)
            .collect())
    }

    pub(crate) fn open_csv(
        &mut self,
        path: &Path,
        stem: &str,
        options: &OpenOptions,
    ) -> Result<(), Error> {
        let path = path.to_string_lossy().into_owned();
        let (locale, undecidable, conflicting, locale_text) = match options.number_locale {
            None => self.sniff_csv_locale(&path),
            Some(forced) => (Some(forced), vec![], false, vec![]),
        };
        self.number_locale = Some(LocaleReport {
            locale,
            forced: options.number_locale.is_some(),
            undecidable: undecidable.clone(),
            conflicting,
        });
        // A forced "en" is DuckDB's default; the report keeps it, the read expression drops it.
        let mut read_expr = csv_read_expr(&path, locale, &locale_text);
        self.create_view(stem, &read_expr)?;
        let as_text = self.csv_columns_a_double_would_change(&path, locale, stem)?;
        if !as_text.is_empty() {
            let mut all_text = locale_text;
            all_text.extend(as_text.iter().cloned());
            read_expr = csv_read_expr(&path, locale, &all_text);
            self.create_view(stem, &read_expr)?;
            let n = as_text.len();
            let shown: Vec<String> = as_text.iter().take(3).map(|c| format!("\"{c}\"")).collect();
            self.open_warnings.push(format!(
                "{n} column{} ({}{}) hold numbers a floating-point type would change — an integer past 2^53 or wider than any exact type — so {} read from the file's own text instead.",
                if n == 1 { "" } else { "s" },
                shown.join(", "),
                if n > 3 { ", …" } else { "" },
                if n == 1 { "it is" } else { "they are" },
            ));
        }
        for u in undecidable.iter().filter(|_| locale.is_none()) {
            let sample = u.samples.first().cloned().unwrap_or_default();
            let en = sample.replace(',', "");
            let eu = sample.replace('.', "").replace(',', ".");
            self.open_warnings.push(format!(
                "Column \"{}\" was left as text: {sample} is {eu} read as Turkish and {en} read as English, and nothing else in the column tells them apart. Set dataFileViewer.numberLocale to \"eu\" or \"en\" to convert it.",
                u.column
            ));
        }
        if conflicting {
            self.open_warnings.push(
                "Columns in this file disagree about the decimal convention, so none were converted. Set dataFileViewer.numberLocale to \"eu\" or \"en\" to read the whole file one way.".into(),
            );
        }
        // A CSV declares no types at all, so its text columns are interpreted (a Parquet footer is not).
        let tokens = options.null_text.clone().unwrap_or_else(default_null_text);
        if !conflicting {
            let notices = self.interpret_text_columns(stem, &read_expr, &tokens);
            self.open_warnings.extend(notices);
        }
        Ok(())
    }
}
