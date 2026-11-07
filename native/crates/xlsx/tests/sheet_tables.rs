//! Port of test/sheetTables.test.ts (+ sheetHighlight.test.ts): every case, same fixtures.
use dfv_table_xlsx::sheet_tables::*;

use Cell::{Null, Num};
fn s(v: &str) -> Cell {
    Cell::Str(v.into())
}
fn names(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}
fn wide(n: usize, prefix: &str) -> Vec<Cell> {
    (0..n).map(|i| s(&format!("{prefix}{i}"))).collect()
}
fn row(head: &[Cell], tail: Vec<Cell>) -> Vec<Cell> {
    head.iter().cloned().chain(tail).collect()
}
fn detect(g: &[Vec<Cell>]) -> Vec<SheetTable> {
    detect_tables(g, &DetectOptions::default())
}

fn used_yield_curve() -> Vec<Vec<Cell>> {
    vec![
        vec![],
        vec![s("Series"), s("Compounding Convention"), s("Mnemonic(s)")],
        vec![
            s("Zero-coupon yield"),
            s("Continuously Compounded"),
            s("SVENYXX"),
        ],
        vec![],
        vec![
            s("#of Years to Maturity"),
            s("1-Period HPY's"),
            s("Excess Returns"),
        ],
        row(&[s("Date")], wide(32, "c")),
        row(&[s("22446")], wide(32, "v")),
        row(&[s("22447")], wide(32, "v")),
        row(&[s("22448")], wide(32, "v")),
    ]
}

fn raw_data() -> Vec<Vec<Cell>> {
    vec![
        vec![],
        vec![s(
            "Note: This is not an official Federal Reserve statistical release.",
        )],
        vec![],
        vec![s("Series"), s("Compounding Convention"), s("Mnemonic(s)")],
        vec![
            s("Zero-coupon yield"),
            s("Continuously Compounded"),
            s("SVENYXX"),
        ],
        vec![s("Par yield"), s("Coupon-Equivalent"), s("SVENPYXX")],
        vec![s("Parameters"), s("N/A"), s("BETA0 to TAU2")],
        vec![],
        row(&[s("Date"), s("BETA0"), s("BETA1")], wide(97, "c")),
        row(&[s("22446"), s("3.9176"), s("-1.2779")], wide(97, "v")),
        row(&[s("22447"), s("3.9784"), s("-1.2574")], wide(97, "v")),
    ]
}

#[test]
fn used_yield_curve_33_wide_row_is_the_header_not_the_3_wide_label() {
    let tables = detect(&used_yield_curve());
    let main = tables
        .iter()
        .find(|t| t.columns.len() == 33)
        .expect("33-column table");
    assert_eq!(main.header_row, Some(5));
    assert_eq!(main.columns[0], "Date");
    assert_eq!(main.row_count, 3);
    assert_eq!(main.region.top, 5);
    assert!(
        !tables.iter().any(|t| t.region.top == 4),
        "spanning label offered as a table"
    );
}

#[test]
fn naive_all_strings_rule_would_have_taken_the_label() {
    let g = used_yield_curve();
    assert!(g[4].iter().all(|v| matches!(v, Cell::Str(_))));
    let tables = detect(&g);
    assert!(
        !tables
            .iter()
            .any(|t| t.columns.len() == 3 && t.columns[0] == "#of Years to Maturity")
    );
}

#[test]
fn raw_data_100_wide_table_found_note_is_not_a_table() {
    let tables = detect(&raw_data());
    let main = tables
        .iter()
        .find(|t| t.columns.len() == 100)
        .expect("100-column table");
    assert_eq!(main.header_row, Some(8));
    assert_eq!(main.columns[..3].join("|"), "Date|BETA0|BETA1");
    assert!(!tables.iter().any(|t| t.region.top == 1));
}

#[test]
fn a_3x4_series_legend_is_a_table_in_its_own_right() {
    let tables = detect(&raw_data());
    let legend = tables.iter().find(|t| t.region.top == 3).expect("legend");
    assert_eq!(
        legend.columns,
        names(&["Series", "Compounding Convention", "Mnemonic(s)"])
    );
    assert_eq!(legend.row_count, 3);
}

fn side_by_side() -> Vec<Vec<Cell>> {
    vec![
        vec![s("Date"), s("cpi"), Null, s("Date"), s("gdp")],
        vec![s("2020"), Num(1.0), Null, s("2020"), Num(5.0)],
        vec![s("2021"), Num(1.1), Null, s("2021"), Num(5.2)],
    ]
}

#[test]
fn two_tables_separated_by_a_blank_column_are_two_tables() {
    let t = detect(&side_by_side());
    assert_eq!(t.len(), 2);
    assert_eq!(t[0].columns, names(&["Date", "cpi"]));
    assert_eq!(t[1].columns, names(&["Date", "gdp"]));
    assert_eq!((t[0].region.left, t[0].region.right), (0, 2));
    assert_eq!((t[1].region.left, t[1].region.right), (3, 5));
}

#[test]
fn without_the_column_split_they_fuse_as_the_etl_does() {
    let t = detect_tables(
        &side_by_side(),
        &DetectOptions {
            split_columns: false,
            ..Default::default()
        },
    );
    assert_eq!(t.len(), 1);
    assert_eq!(
        t[0].columns,
        names(&["Date", "cpi", "_col2", "Date_1", "gdp"])
    );
}

#[test]
fn a_2x2_grid_of_tables_needs_both_splits_repeatedly() {
    let g = vec![
        vec![s("Date"), s("a"), Null, s("Date"), s("b")],
        vec![s("2020"), Num(1.0), Null, s("2020"), Num(2.0)],
        vec![],
        vec![s("Date"), s("c"), Null, s("Date"), s("d")],
        vec![s("2021"), Num(3.0), Null, s("2021"), Num(4.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 4);
    assert_eq!(
        t.iter().map(|t| t.columns[1].as_str()).collect::<Vec<_>>(),
        ["a", "b", "c", "d"]
    );
}

#[test]
fn a_shorter_table_beside_a_taller_one_still_separates() {
    let g = vec![
        vec![s("Date"), s("a"), Null, s("Date"), s("b")],
        vec![s("2020"), Num(1.0), Null, s("2020"), Num(2.0)],
        vec![Null, Null, Null, s("2021"), Num(3.0)],
        vec![Null, Null, Null, s("2022"), Num(4.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 2);
    assert_eq!(t[0].row_count, 1);
    assert_eq!(t[1].row_count, 3);
}

#[test]
fn a_row_whose_only_populated_cells_say_null_is_data_not_a_separator() {
    let g = vec![
        vec![s("Date"), s("v")],
        vec![s("2020"), Num(1.0)],
        vec![s("NULL"), s("NULL")],
        vec![s("2021"), Num(2.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].row_count, 3);
}

#[test]
fn an_excel_error_marker_occupies_its_cell() {
    let g = vec![
        vec![s("Date"), s("v")],
        vec![s("2020"), s("#N/A")],
        vec![s("2021"), Num(2.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].row_count, 2);
}

#[test]
fn a_lone_kaynak_promotes_no_header_and_is_no_table() {
    let g = vec![
        vec![s("Date"), s("v")],
        vec![s("2020"), Num(1.0)],
        vec![s("2021"), Num(2.0)],
        vec![],
        vec![s("Kaynak: TCMB")],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(
        t[0].region.bottom, 3,
        "the footnote was swept into the table"
    );
}

#[test]
fn a_footnote_wider_than_the_table_above_it_is_still_a_footnote() {
    let g = vec![
        vec![s("Tarih"), s("kur")],
        vec![s("2020"), Num(1.0)],
        vec![s("2021"), Num(1.1)],
        vec![],
        vec![s("Veri Kaynağı"), s("TCMB"), s("EVDS")],
        vec![s("Etiketler"), s("Kurlar"), s("Döviz")],
    ];
    let t = detect(&g);
    assert_eq!(
        t.len(),
        1,
        "the wider note block was offered as a second table"
    );
    assert_eq!(t[0].columns, names(&["Tarih", "kur"]));
}

#[test]
fn a_section_heading_alone_on_its_row_marks_the_block_a_footer() {
    let g = vec![
        vec![s("Date"), s("v")],
        vec![s("2020"), Num(1.0)],
        vec![s("2021"), Num(2.0)],
        vec![],
        vec![s("Notlar")],
        vec![s("TP.DK.USD"), s("Veri Kaynağı"), s("TCMB")],
    ];
    assert_eq!(detect(&g).len(), 1);
}

#[test]
fn a_block_that_describes_the_table_above_it_is_a_footer_however_big() {
    let g = vec![
        vec![s("Date"), s("cpi"), s("gdp")],
        vec![s("2020"), Num(1.0), Num(5.0)],
        vec![s("2021"), Num(2.0), Num(6.0)],
        vec![],
        vec![s("Definition"), s("Meaning"), s("Unit")],
        vec![s("cpi"), s("consumer prices"), s("index")],
        vec![s("gdp"), s("output"), s("TRY")],
    ];
    assert_eq!(detect(&g).len(), 1);
}

#[test]
fn label_folding_is_accent_case_and_trailing_colon_insensitive() {
    assert_eq!(fold_label("Açıklama:"), "aciklama");
    assert_eq!(fold_label("SIKLIK"), "siklik");
    assert_eq!(fold_label(" Kaynak "), "kaynak");
}

#[test]
fn the_bis_sdmx_code_form_is_matched_only_in_upper_case() {
    let upper = vec![vec![s("FREQ: M")], vec![s("UNIT: index")]];
    assert!(looks_like_footer(
        &upper,
        whole_grid(&upper),
        false,
        &FooterOptions::default()
    ));
    let lower = vec![vec![s("freq: m")], vec![s("unit: index")]];
    assert!(!looks_like_footer(
        &lower,
        whole_grid(&lower),
        false,
        &FooterOptions::default()
    ));
}

#[test]
fn a_stray_blank_row_through_one_table_does_not_make_two() {
    let g = vec![
        vec![s("Date"), s("v")],
        vec![s("2020"), Num(1.0)],
        vec![],
        vec![s("2021"), Num(2.0)],
        vec![s("2022"), Num(3.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].row_count, 3);
    assert_eq!(t[0].region.bottom, 5);
}

#[test]
fn a_repeated_header_continues_the_table_rather_than_starting_one() {
    let g = vec![
        vec![s("Date"), s("v")],
        vec![s("2020"), Num(1.0)],
        vec![],
        vec![s("Date"), s("v")],
        vec![s("2021"), Num(2.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(
        t[0].row_count, 2,
        "the repeated header row was counted as data"
    );
}

#[test]
fn a_different_header_below_a_blank_row_is_a_second_table() {
    let g = vec![
        vec![s("Date"), s("cpi")],
        vec![s("2020"), Num(1.0)],
        vec![],
        vec![s("Date"), s("gdp")],
        vec![s("2020"), Num(5.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 2);
    assert_eq!(t[1].columns, names(&["Date", "gdp"]));
}

#[test]
fn a_header_plus_one_observation_is_a_table() {
    assert_eq!(
        detect(&[vec![s("Date"), s("v")], vec![s("2020"), Num(1.0)]]).len(),
        1
    );
}

#[test]
fn a_one_column_block_is_not_a_table() {
    assert_eq!(
        detect(&[vec![s("Date")], vec![s("2020")], vec![s("2021")]]).len(),
        0
    );
}

#[test]
fn an_empty_sheet_yields_nothing() {
    assert!(detect(&[]).is_empty());
    assert!(detect(&[vec![], vec![Null, Null]]).is_empty());
}

#[test]
fn regions_are_trimmed_to_the_cells_they_hold() {
    let g = vec![
        vec![Null, Null, Null],
        vec![Null, s("Date"), s("v")],
        vec![Null, s("2020"), Num(1.0)],
    ];
    let r = split_regions(&g, whole_grid(&g));
    assert_eq!(
        r,
        vec![Region {
            top: 1,
            bottom: 3,
            left: 1,
            right: 3
        }]
    );
}

#[test]
fn a_header_with_a_blank_cell_keeps_a_placeholder() {
    let g = vec![
        vec![s("Date"), Null, s("v")],
        vec![s("2020"), Num(1.0), Num(2.0)],
        vec![s("2021"), Num(3.0), Num(4.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].columns, names(&["Date", "_col1", "v"]));
}

#[test]
fn repeated_captions_are_suffixed_rather_than_dropped() {
    assert_eq!(
        dedupe(&names(&["a", "a", "b", "a"])),
        names(&["a", "a_1", "b", "a_2"])
    );
}

#[test]
fn column_letters_are_bijective_base_26() {
    assert_eq!(column_letters(0), "A");
    assert_eq!(column_letters(25), "Z");
    assert_eq!(column_letters(26), "AA");
    assert_eq!(column_letters(701), "ZZ");
}

#[test]
fn a_table_with_no_header_is_named_by_its_excel_letters() {
    let g = vec![
        vec![Null, Num(1.0), Num(2.0)],
        vec![Null, Num(3.0), Num(4.0)],
        vec![Null, Num(5.0), Num(6.0)],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].columns, names(&["B", "C"]));
    assert_eq!(t[0].header_row, None);
}

fn repeated() -> Vec<Vec<Cell>> {
    vec![
        vec![s("Name"), s("Value")],
        vec![s("Alice"), s("1")],
        vec![Null, Null],
        vec![s("Name"), s("Value")],
        vec![s("Bob"), s("2")],
    ]
}

#[test]
fn repeated_header_one_table_two_data_rows() {
    let t = detect(&repeated());
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].header_row, Some(0));
    assert_eq!(t[0].columns, names(&["Name", "Value"]));
    assert_eq!(t[0].row_count, 2);
}

#[test]
fn repeated_header_describes_exactly_which_source_rows_are_data() {
    let g = repeated();
    let t = &detect(&g)[0];
    assert_eq!(
        t.data_rows,
        vec![RowSpan { start: 1, end: 2 }, RowSpan { start: 4, end: 5 }]
    );
    assert_eq!(
        t.excluded_rows,
        vec![
            ExcludedRow {
                row: 2,
                reason: ExcludedRowReason::Blank
            },
            ExcludedRow {
                row: 3,
                reason: ExcludedRowReason::Header
            }
        ]
    );
    assert_eq!(span_row_count(&t.data_rows), t.row_count);
    let described: Vec<Vec<Cell>> = t
        .data_rows
        .iter()
        .flat_map(|sp| (sp.start..sp.end).map(|r| g[r][t.region.left..t.region.right].to_vec()))
        .collect();
    assert_eq!(
        described,
        vec![vec![s("Alice"), s("1")], vec![s("Bob"), s("2")]]
    );
    assert_eq!(
        described.len() + t.excluded_rows.len(),
        t.region.bottom - t.region.top - 1
    );
}

#[test]
fn mixed_numeric_text_column_keeps_its_text_and_detection_does_not_mutate() {
    let g = vec![
        vec![s("Name"), s("Value")],
        vec![s("Alice"), s("1")],
        vec![s("Bob"), s("not numeric")],
        vec![s("Clara"), s("3")],
    ];
    let before = g.clone();
    assert_eq!(detect(&g)[0].row_count, 3);
    assert_eq!(g, before);
}

#[test]
fn adjacent_tables_without_a_blank_column_are_one_heuristic_region() {
    let g = vec![
        vec![s("Name"), s("Value"), s("Code"), s("Amount")],
        vec![s("Alice"), s("1"), s("X"), s("2")],
        vec![s("Bob"), s("3"), s("Y"), s("4")],
    ];
    let t = detect(&g);
    assert_eq!(t.len(), 1);
    assert_eq!(
        t[0].region,
        Region {
            top: 0,
            bottom: 3,
            left: 0,
            right: 4
        }
    );
}

/* sheetRowMap.ts: slot arithmetic */

#[test]
fn row_map_slots_round_trip_over_a_gapped_table() {
    let spans = [RowSpan { start: 1, end: 2 }, RowSpan { start: 4, end: 7 }];
    assert!(valid_spans(&spans));
    assert_eq!(span_row_count(&spans), 4);
    assert_eq!(
        (0..5)
            .map(|k| grid_row_of_slot(&spans, k))
            .collect::<Vec<_>>(),
        [Some(1), Some(4), Some(5), Some(6), None]
    );
    for k in 0..4 {
        assert_eq!(
            slot_of_grid_row(&spans, grid_row_of_slot(&spans, k).unwrap()),
            Some(k)
        );
    }
    assert_eq!(slot_of_grid_row(&spans, 2), None);
    assert_eq!(slots_before(&spans, 5), 2);
    assert!(!valid_spans(&[
        RowSpan { start: 4, end: 7 },
        RowSpan { start: 1, end: 2 }
    ]));
    assert_eq!(
        table_data_rows(0, 3, Some(0)),
        vec![RowSpan { start: 1, end: 3 }]
    );
    assert_eq!(table_data_rows(0, 1, Some(0)), vec![]);
}

#[test]
fn locate_edit_cell_uses_the_source_row_map_not_rows_below_the_header() {
    let g = repeated();
    let t = &detect(&g)[0];
    assert_eq!(locate_edit_cell(t, 0, "Value"), Some((1, 1)));
    assert_eq!(
        locate_edit_cell(t, 1, "Name"),
        Some((4, 0)),
        "second data row is grid row 4, not 2"
    );
    assert_eq!(locate_edit_cell(t, 2, "Name"), None);
    assert_eq!(locate_edit_cell(t, 0, "Nope"), None);
}

/* sheetHighlight.test.ts */

#[test]
fn table_edges_mark_only_the_outline() {
    let t = Region {
        top: 3,
        bottom: 9,
        left: 1,
        right: 4,
    };
    assert_eq!(table_edges(&t, 2, 1), None);
    assert_eq!(
        table_edges(&t, 3, 1),
        Some(CellEdges {
            top: true,
            right: false,
            bottom: false,
            left: true
        })
    );
    assert_eq!(
        table_edges(&t, 8, 3),
        Some(CellEdges {
            top: false,
            right: true,
            bottom: true,
            left: false
        })
    );
    assert_eq!(table_edges(&t, 9, 2), None);
    assert_eq!(table_edges(&t, 5, 4), None);
}

/* Header-promotion edge cases the TypeScript documents */

#[test]
fn a_bare_year_header_needs_contrast_with_the_row_below() {
    // "2019 | ppi | wage" over numbers is a header; a row of yearly DATA is not.
    let head = vec![
        vec![Num(2019.0), s("ppi"), s("wage")],
        vec![Num(2020.0), Num(1.0), Num(2.0)],
        vec![Num(2021.0), Num(3.0), Num(4.0)],
    ];
    assert_eq!(detect(&head)[0].header_row, Some(0));
    let data = vec![
        vec![Num(2019.0), Num(1.0), Num(2.0)],
        vec![Num(2020.0), Num(3.0), Num(4.0)],
        vec![Num(2021.0), Num(5.0), Num(6.0)],
    ];
    assert_eq!(detect(&data)[0].header_row, None);
}

#[test]
fn date_column_names_follow_the_etl_pattern() {
    for yes in [
        "Date", "TARIH", "Yıl", "dönem", "Çeyrek", "obs_date", "date_utc", "q3date", "dt", "TS",
    ] {
        assert!(is_date_column_name(yes), "{yes}");
    }
    // Dotless i does not fold to i under JS /i; a bare year, a lone "_date" and plain words are not names.
    for no in ["YIL ", "Yİl", "2019", "_date", "price", "update", "dates"] {
        assert_eq!(is_date_column_name(no), no == "YIL ", "{no}");
    }
}
