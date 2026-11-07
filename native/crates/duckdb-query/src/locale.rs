//! Port of `numericLocale.ts`: which decimal convention is a CSV column written in, and when to admit we
//! cannot tell. It only decides; DuckDB does the parsing. Guessing wrong is a silent factor of 1000.
//! Patterns use `[0-9]`, never `\d`: JS `\d` is ASCII-only and the `regex` crate's is Unicode.
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

const EXPONENT: &str = "([eE][+-]?[0-9]+)?";
static VALID_EN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[+-]?([0-9]{{1,3}}(,[0-9]{{3}})+|[0-9]+)(\.[0-9]+)?{EXPONENT}$"
    ))
    .unwrap()
});
static VALID_EU: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[+-]?([0-9]{{1,3}}(\.[0-9]{{3}})+|[0-9]+)(,[0-9]+)?{EXPONENT}$"
    ))
    .unwrap()
});
/// "1.234" / "1,234": one separator, exactly three digits after it. Undecidable in isolation.
static AMBIGUOUS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[+-]?[0-9]{1,3}[,.][0-9]{3}$").unwrap());
static PARENS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^\((.*)\)$").unwrap());
static EN_PATTERNS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        Regex::new(r"^[+-]?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$").unwrap(),
        Regex::new(r"^[+-]?[0-9]+\.[0-9]+$").unwrap(),
        Regex::new(r"^[+-]?[0-9]+(\.[0-9]+)?$").unwrap(),
    ]
});
static EU_PATTERNS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        Regex::new(r"^[+-]?[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?$").unwrap(),
        Regex::new(r"^[+-]?[0-9]+,[0-9]+$").unwrap(),
        Regex::new(r"^[+-]?[0-9]+(,[0-9]+)?$").unwrap(),
    ]
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NumberLocale {
    En,
    Eu,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocaleVerdict {
    /// Decisively one convention. Safe to pass to DuckDB.
    Decided {
        locale: NumberLocale,
        en_score: u32,
        eu_score: u32,
        ambiguous: usize,
    },
    /// No separator anywhere, or nothing numeric: the two readings are identical.
    NoSeparators,
    /// Genuinely undecidable; the caller must leave the column as text and say so.
    Undecidable {
        en_score: u32,
        eu_score: u32,
        ambiguous: usize,
        samples: Vec<String>,
    },
}

/// JS `String.prototype.trim` whitespace: Unicode White_Space plus the BOM.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
fn clean(values: &[Option<&str>]) -> Vec<String> {
    values
        .iter()
        .flatten()
        .map(|v| js_trim(v).to_owned())
        .filter(|v| !v.is_empty())
        .collect()
}
fn unwrap_parens(value: &str) -> (String, bool) {
    match PARENS.captures(value) {
        Some(c) => (c[1].to_owned(), true),
        None => (value.to_owned(), false),
    }
}
fn parse(value: &str, re: &Regex, normalise: fn(&str) -> String) -> Option<f64> {
    let (inner, wrapped) = unwrap_parens(js_trim(value));
    if !re.is_match(&inner) {
        return None;
    }
    let n: f64 = normalise(&inner)
        .parse()
        .ok()
        .filter(|n: &f64| n.is_finite())?;
    Some(if wrapped { -n } else { n })
}
/// `_parse_en`: comma = thousands. `None` when not well-formed.
pub fn parse_en(value: &str) -> Option<f64> {
    parse(value, &VALID_EN, |s| s.replace(',', ""))
}
/// `_parse_eu`: dot = thousands. `None` when not well-formed.
pub fn parse_eu(value: &str) -> Option<f64> {
    parse(value, &VALID_EU, |s| s.replace('.', "").replace(',', "."))
}

/// `_numeric_locale_confidence`. Ambiguous values score nothing for either side.
pub fn score_locale(values: &[Option<&str>], locale: NumberLocale) -> u32 {
    let patterns = if locale == NumberLocale::En {
        &*EN_PATTERNS
    } else {
        &*EU_PATTERNS
    };
    clean(values)
        .iter()
        .filter(|s| !AMBIGUOUS.is_match(s))
        .map(|s| match patterns.iter().position(|p| p.is_match(s)) {
            Some(0) => 3,
            Some(1) => 2,
            Some(_) => 1,
            None => 0,
        })
        .sum()
}
pub fn count_ambiguous(values: &[Option<&str>]) -> usize {
    clean(values)
        .iter()
        .filter(|s| AMBIGUOUS.is_match(s))
        .count()
}
fn ambiguous_samples(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter(|s| AMBIGUOUS.is_match(s))
        .take(3)
        .cloned()
        .collect()
}

pub fn decide_locale(values: &[Option<&str>]) -> LocaleVerdict {
    let v = clean(values);
    if v.is_empty() || !v.iter().any(|s| s.contains(['.', ','])) {
        return LocaleVerdict::NoSeparators;
    }
    // Where both readings produce a value and agree everywhere, the column cannot be misread.
    let (mut comparable, mut agreed) = (0, 0);
    for s in &v {
        if let (Some(en), Some(eu)) = (parse_en(s), parse_eu(s)) {
            comparable += 1;
            agreed += usize::from(en == eu);
        }
    }
    if comparable > 0 && agreed == comparable {
        return LocaleVerdict::Decided {
            locale: NumberLocale::En,
            en_score: 0,
            eu_score: 0,
            ambiguous: 0,
        };
    }
    let opt: Vec<Option<&str>> = v.iter().map(|s| Some(s.as_str())).collect();
    let (en_score, eu_score) = (
        score_locale(&opt, NumberLocale::En),
        score_locale(&opt, NumberLocale::Eu),
    );
    let ambiguous = count_ambiguous(&opt);
    let undecidable = || LocaleVerdict::Undecidable {
        en_score,
        eu_score,
        ambiguous,
        samples: ambiguous_samples(&v),
    };
    if en_score == 0 && eu_score == 0 {
        return if ambiguous > 0 {
            undecidable()
        } else {
            LocaleVerdict::NoSeparators
        };
    }
    if en_score == eu_score && ambiguous > 0 {
        return undecidable();
    }
    let margin = f64::from(en_score.abs_diff(eu_score)) / v.len().max(1) as f64;
    if ambiguous > 0 && margin < 0.2 {
        return undecidable();
    }
    let locale = if en_score > eu_score {
        NumberLocale::En
    } else {
        NumberLocale::Eu
    };
    LocaleVerdict::Decided {
        locale,
        en_score,
        eu_score,
        ambiguous,
    }
}

/// Both readings of one value: the divergence shown to the user (`1.234` is 1.234 or 1234).
pub fn both_readings(value: &str) -> (Option<f64>, Option<f64>) {
    (parse_en(value), parse_eu(value))
}

/// Column verdict; a column converts only if at least `threshold` of its non-empty values parse.
pub fn decide_column(values: &[Option<&str>], threshold: f64) -> LocaleVerdict {
    let verdict = decide_locale(values);
    let LocaleVerdict::Decided { locale, .. } = verdict else {
        return verdict;
    };
    let v = clean(values);
    if v.is_empty() {
        return LocaleVerdict::NoSeparators;
    }
    let parser = if locale == NumberLocale::En {
        parse_en
    } else {
        parse_eu
    };
    let parsed = v.iter().filter(|s| parser(s).is_some()).count();
    if (parsed as f64) / (v.len() as f64) < threshold {
        LocaleVerdict::NoSeparators
    } else {
        verdict
    }
}
pub const DEFAULT_THRESHOLD: f64 = 0.85;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Undecidable {
    pub column: String,
    pub samples: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDecision {
    pub locale: Option<NumberLocale>,
    pub decided: Vec<String>,
    pub undecidable: Vec<Undecidable>,
    pub conflicting: bool,
}
/// File-level decision: a convention is claimed only when one column decided and none decided the other
/// way. `read_csv` options are per file, so one dissenting column blocks the whole file.
pub fn decide_file(columns: &[(String, Vec<Option<String>>)]) -> FileDecision {
    let (mut decided, mut undecidable, mut seen) = (vec![], vec![], HashSet::new());
    for (name, values) in columns {
        let refs: Vec<Option<&str>> = values.iter().map(Option::as_deref).collect();
        match decide_column(&refs, DEFAULT_THRESHOLD) {
            LocaleVerdict::Decided { locale, .. } => {
                seen.insert(locale);
                decided.push(name.clone());
            }
            LocaleVerdict::Undecidable { samples, .. } => undecidable.push(Undecidable {
                column: name.clone(),
                samples,
            }),
            LocaleVerdict::NoSeparators => {}
        }
    }
    let conflicting = seen.len() > 1;
    let locale = if conflicting || seen.is_empty() {
        None
    } else {
        seen.into_iter().next()
    };
    FileDecision {
        locale,
        decided,
        undecidable,
        conflicting,
    }
}

/// `(decimal, thousands)` for a locale name. Unknown names are an error, never a default to English.
pub fn csv_locale_options(locale: &str) -> Result<(char, char), String> {
    match locale {
        "eu" | "tr" => Ok((',', '.')),
        "en" => Ok(('.', ',')),
        other => Err(format!(
            "Invalid number locale \"{other}\": expected \"en\", \"eu\" or \"tr\"."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use NumberLocale::{En, Eu};

    fn some<'a>(v: &[&'a str]) -> Vec<Option<&'a str>> {
        v.iter().map(|s| Some(*s)).collect()
    }
    fn locale_of(v: &LocaleVerdict) -> Option<NumberLocale> {
        if let LocaleVerdict::Decided { locale, .. } = v {
            Some(*locale)
        } else {
            None
        }
    }
    fn kind_undecidable(v: &LocaleVerdict) -> bool {
        matches!(v, LocaleVerdict::Undecidable { .. })
    }

    #[test]
    fn a_turkish_column_is_read_as_european() {
        let v = decide_locale(&some(&["1.794.446,52", "2.145.900,00", "987.654,31"]));
        assert_eq!(locale_of(&v), Some(Eu));
        assert_eq!(parse_eu("1.794.446,52"), Some(1794446.52));
    }
    #[test]
    fn an_english_column_is_read_as_english() {
        let v = decide_locale(&some(&["1,234.56", "9,876.54", "1,000,000.01"]));
        assert_eq!(locale_of(&v), Some(En));
        assert_eq!(parse_en("1,234.56"), Some(1234.56));
    }
    #[test]
    fn a_column_of_only_ambiguous_values_is_refused_not_guessed() {
        let LocaleVerdict::Undecidable {
            ambiguous, samples, ..
        } = decide_locale(&some(&["1.234", "2.345", "3.456"]))
        else {
            panic!("must refuse")
        };
        assert_eq!(ambiguous, 3);
        assert_eq!(samples, ["1.234", "2.345", "3.456"]);
    }
    #[test]
    fn the_same_column_with_commas_is_equally_refused() {
        assert!(kind_undecidable(&decide_locale(&some(&[
            "1,234", "2,345", "3,456"
        ]))));
    }
    #[test]
    fn the_refusal_names_both_readings() {
        assert_eq!(both_readings("1.234"), (Some(1.234), Some(1234.0)));
        assert_eq!(both_readings("1,234"), (Some(1234.0), Some(1.234)));
        let (en, eu) = both_readings("1.234");
        assert_eq!(eu.unwrap() / en.unwrap(), 1000.0);
    }
    #[test]
    fn forcing_a_locale_on_the_refused_column_gives_the_1000x_difference() {
        assert_eq!(["1.234", "2.345"].map(parse_en), [Some(1.234), Some(2.345)]);
        assert_eq!(
            ["1.234", "2.345"].map(parse_eu),
            [Some(1234.0), Some(2345.0)]
        );
    }
    #[test]
    fn plain_english_three_decimal_rates_are_never_read_as_european() {
        let rates = some(&["1.234", "2.345", "0.987", "1.500"]);
        assert_ne!(locale_of(&decide_locale(&rates)), Some(Eu));
        assert_eq!(score_locale(&rates, Eu), 0);
        assert_eq!(score_locale(&rates, En), 0);
    }
    #[test]
    fn one_unambiguous_value_is_enough_to_break_the_tie() {
        assert_eq!(
            locale_of(&decide_locale(&some(&["1.234", "2.345", "1.234,56"]))),
            Some(Eu)
        );
    }
    #[test]
    fn parenthesised_negatives_are_read_as_negative() {
        assert_eq!(parse_eu("(1.234,56)"), Some(-1234.56));
        assert_eq!(parse_en("(1,234.56)"), Some(-1234.56));
    }
    #[test]
    fn a_value_in_the_other_convention_fails_honestly_rather_than_plausibly() {
        assert_eq!(parse_en("1.234,56"), None);
        assert_eq!(parse_eu("1,234.56"), None);
    }
    #[test]
    fn a_column_with_no_separator_at_all_needs_no_decision() {
        assert_eq!(
            decide_locale(&some(&["1", "2", "3", "4000"])),
            LocaleVerdict::NoSeparators
        );
        assert_eq!(decide_locale(&[]), LocaleVerdict::NoSeparators);
        assert_eq!(
            decide_locale(&[None, None, Some("  ")]),
            LocaleVerdict::NoSeparators
        );
    }
    #[test]
    fn a_text_column_is_left_alone_even_when_a_few_values_look_numeric() {
        let col = some(&["Ankara", "İstanbul", "İzmir", "Bursa", "1.234,56"]);
        assert_eq!(
            decide_column(&col, DEFAULT_THRESHOLD),
            LocaleVerdict::NoSeparators
        );
    }
    #[test]
    fn scientific_notation_stays_parseable() {
        assert_eq!(parse_en("1.5e3"), Some(1500.0));
        assert_eq!(parse_eu("1,5e3"), Some(1500.0));
    }
    #[test]
    fn count_ambiguous_counts_only_the_undecidable_shape() {
        assert_eq!(
            count_ambiguous(&some(&["1.234", "1.2345", "12.34", "1.234,56", "1,234"])),
            2
        );
    }
    #[test]
    fn a_file_is_only_claimed_for_a_locale_when_no_column_disagrees() {
        let col = |n: &str, v: &[&str]| {
            (
                n.to_owned(),
                v.iter().map(|s| Some((*s).to_owned())).collect::<Vec<_>>(),
            )
        };
        let eu = decide_file(&[
            col("a", &["1.794.446,52", "2.000,00"]),
            col("b", &["12,5", "13,7"]),
        ]);
        assert_eq!((eu.locale, eu.conflicting), (Some(Eu), false));
        let mixed = decide_file(&[col("a", &["1.794.446,52"]), col("b", &["1,234.56"])]);
        assert_eq!((mixed.locale, mixed.conflicting), (None, true));
    }
    #[test]
    fn an_undecidable_column_is_reported_by_name_with_its_values() {
        let col = |n: &str, v: &[&str]| {
            (
                n.to_owned(),
                v.iter().map(|s| Some((*s).to_owned())).collect::<Vec<_>>(),
            )
        };
        let res = decide_file(&[col("ok", &["1.234,56"]), col("bad", &["1.234", "2.345"])]);
        assert_eq!(res.undecidable.len(), 1);
        assert_eq!(res.undecidable[0].column, "bad");
        assert_eq!(res.undecidable[0].samples, ["1.234", "2.345"]);
    }
    #[test]
    fn locale_options_are_validated_where_set() {
        assert_eq!(csv_locale_options("eu"), Ok((',', '.')));
        assert_eq!(csv_locale_options("en"), Ok(('.', ',')));
        assert_eq!(csv_locale_options("tr"), Ok((',', '.')));
        assert!(
            csv_locale_options("xx")
                .unwrap_err()
                .contains("Invalid number locale")
        );
        assert!(
            csv_locale_options("")
                .unwrap_err()
                .contains("Invalid number locale")
        );
    }
    #[test]
    fn unicode_digits_are_not_numbers() {
        // JS `\d` is ASCII only; Arabic-Indic digits must not parse.
        assert_eq!(parse_en("١٢٣"), None);
    }
}
