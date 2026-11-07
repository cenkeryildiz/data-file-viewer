use dfv_table_csv_write::*;

const D: Dialect = Dialect {
    delimiter: b',',
    quote: b'"',
};
const SEMI: Dialect = Dialect {
    delimiter: b';',
    quote: b'"',
};
const TAB: Dialect = Dialect {
    delimiter: b'\t',
    quote: b'"',
};

/// Independent decode: the `csv` crate, flexible, no header handling.
fn table(bytes: &[u8], d: Dialect) -> Vec<Vec<String>> {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(d.delimiter)
        .quote(d.quote)
        .terminator(csv::Terminator::CRLF)
        .from_reader(body);
    // csv's CRLF terminator also accepts a lone LF or CR; mixed endings are exactly what the fixtures need.
    rdr.records()
        .map(|r| r.unwrap().iter().map(str::to_owned).collect())
        .collect()
}

/// The edited region is the only difference: common prefix + suffix cover everything else.
fn assert_single_splice(a: &[u8], b: &[u8]) -> (usize, usize) {
    let p = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let s = a[p..]
        .iter()
        .rev()
        .zip(b[p..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    (p, a.len() - s)
}

fn edit(src: &str, d: Dialect, col: &str, row: usize, new: NewValue) -> Vec<u8> {
    update_cell(
        src.as_bytes(),
        d,
        col,
        Target::Row {
            index: row,
            expect: None,
        },
        new,
    )
    .unwrap()
}

#[test]
fn only_the_edited_field_changes_across_line_endings_and_bom() {
    for src in [
        "id,v\n1,a\n2,b\n",
        "id,v\r\n1,a\r\n2,b\r\n",
        "id,v\n1,a\r\n2,b\r3,c", // mixed endings, no trailing newline
        "id,v\n1,a\n2,b",
        "\u{feff}id,v\n1,a\n2,b\n",
    ] {
        let out = update_cell(
            src.as_bytes(),
            D,
            "v",
            Target::Row {
                index: 1,
                expect: None,
            },
            NewValue::Text("ZZ"),
        )
        .unwrap();
        let (p, _) = assert_single_splice(src.as_bytes(), &out);
        assert!(p >= src.find("2,").unwrap(), "{src:?}");
        let mut want = table(src.as_bytes(), D);
        want[2][1] = "ZZ".into();
        assert_eq!(table(&out, D), want, "{src:?}");
        assert_eq!(out.len(), src.len() - 1 + 2);
        assert_eq!(
            out.starts_with(&[0xEF, 0xBB, 0xBF]),
            src.starts_with('\u{feff}')
        );
    }
}

#[test]
fn quoted_fields_with_newlines_quotes_and_delimiters_survive() {
    let src = "name,note,qty\n\"Smith, J\",\"line1\nline2 \"\"q\"\"\",7\nbolt,\"x\",8\n";
    let out = edit(
        src,
        D,
        "qty",
        0,
        NewValue::Number {
            text: "70",
            decimal_comma: false,
        },
    );
    let cut = src
        .find(
            "7
",
        )
        .unwrap();
    assert_eq!(&out[..cut], &src.as_bytes()[..cut]);
    let mut want = table(src.as_bytes(), D);
    want[1][2] = "70".into();
    assert_eq!(table(&out, D), want);
    // The embedded-newline note is untouched even when it is the edited cell's neighbour; editing it keeps quotes.
    let out = edit(src, D, "note", 0, NewValue::Text("a,b \"c\"\nd"));
    let mut want = table(src.as_bytes(), D);
    want[1][1] = "a,b \"c\"\nd".into();
    assert_eq!(table(&out, D), want);
    assert!(
        String::from_utf8(out)
            .unwrap()
            .contains("\"a,b \"\"c\"\"\nd\"")
    );
}

#[test]
fn quote_style_is_kept_or_added_only_when_needed() {
    let src = "code,n\n\"007\",1\n010,2\n";
    // Old field was quoted: stays quoted even though plain text would do.
    assert_eq!(
        edit(src, D, "code", 0, NewValue::Text("008")),
        b"code,n\n\"008\",1\n010,2\n".to_vec()
    );
    // Old field was plain: stays plain.
    assert_eq!(
        edit(src, D, "code", 1, NewValue::Text("011")),
        b"code,n\n\"007\",1\n011,2\n".to_vec()
    );
    // Plain field needing quotes gets them.
    assert_eq!(
        edit(src, D, "code", 1, NewValue::Text("a,b")),
        b"code,n\n\"007\",1\n\"a,b\",2\n".to_vec()
    );
}

#[test]
fn null_and_empty_string_are_written_distinctly() {
    let src = "a,b\n1,x\n2,y\n";
    assert_eq!(
        edit(src, D, "b", 0, NewValue::Null),
        b"a,b\n1,\n2,y\n".to_vec()
    );
    assert_eq!(
        edit(src, D, "b", 0, NewValue::Text("")),
        b"a,b\n1,\"\"\n2,y\n".to_vec()
    );
}

#[test]
fn numbers_follow_the_files_decimal_convention_and_bad_numbers_are_refused() {
    let semi = "id;price\n1;1,50\n2;2,25\n";
    assert_eq!(
        edit(
            semi,
            SEMI,
            "price",
            0,
            NewValue::Number {
                text: "3.75",
                decimal_comma: true
            }
        ),
        b"id;price\n1;3,75\n2;2,25\n".to_vec()
    );
    // Decimal comma in a comma-delimited file needs quotes or the record would gain a field.
    let c = "id,price\n1,\"1,50\"\n";
    let out = edit(
        c,
        D,
        "price",
        0,
        NewValue::Number {
            text: "3.75",
            decimal_comma: true,
        },
    );
    assert_eq!(out, b"id,price\n1,\"3,75\"\n".to_vec());
    let c2 = "id,price\n1,1.5\n";
    let out = edit(
        c2,
        D,
        "price",
        0,
        NewValue::Number {
            text: "9.75",
            decimal_comma: true,
        },
    );
    assert_eq!(table(&out, D)[1], vec!["1", "9,75"]);
    for bad in [
        "not a number",
        "1,234.5",
        "",
        "1e",
        ".",
        "--1",
        "1 2",
        "0x10",
        "NaN",
        "٣",
    ] {
        assert_eq!(
            update_cell(
                c2.as_bytes(),
                D,
                "price",
                Target::Row {
                    index: 0,
                    expect: None
                },
                NewValue::Number {
                    text: bad,
                    decimal_comma: false
                }
            ),
            Err(WriteError::BadNumber(bad.into())),
            "{bad:?}"
        );
    }
    for ok in ["0", "-12", "+3.5", ".5", "5.", "1e-9", "1.5E+10"] {
        assert!(
            update_cell(
                c2.as_bytes(),
                D,
                "price",
                Target::Row {
                    index: 0,
                    expect: None
                },
                NewValue::Number {
                    text: ok,
                    decimal_comma: false
                }
            )
            .is_ok(),
            "{ok}"
        );
    }
    // Wide integers are text-exact: nothing round-trips through a float.
    let out = edit(
        c2,
        D,
        "price",
        0,
        NewValue::Number {
            text: "12345678901234567890123",
            decimal_comma: false,
        },
    );
    assert_eq!(table(&out, D)[1][1], "12345678901234567890123");
}

#[test]
fn other_dialects_and_unicode() {
    let tsv = "k\tv\nİstanbul\t😀\nb\tc\n";
    let out = edit(tsv, TAB, "v", 1, NewValue::Text("tab\there"));
    assert_eq!(table(&out, TAB)[2], vec!["b", "tab\there"]);
    assert_eq!(table(&out, TAB)[1], vec!["İstanbul", "😀"]);
    let out = edit(tsv, TAB, "k", 0, NewValue::Text("σ→ş"));
    assert_eq!(table(&out, TAB)[1], vec!["σ→ş", "😀"]);
}

#[test]
fn matches_by_values_like_the_ts_row_identity_and_refuses_ambiguity() {
    let src = "name,qty\nwidget,2\nwidget,2\nbolt,7\n";
    // TS E14: two identical rows -> refused, file untouched (no bytes returned).
    assert_eq!(
        update_cell(
            src.as_bytes(),
            D,
            "qty",
            Target::Match(&[("name", Some("widget")), ("qty", Some("2"))]),
            NewValue::Text("99")
        ),
        Err(WriteError::Ambiguous { rows: 2 })
    );
    // TS E14 control: unambiguous edit changes exactly one row.
    let out = update_cell(
        src.as_bytes(),
        D,
        "qty",
        Target::Match(&[("name", Some("bolt")), ("qty", Some("7"))]),
        NewValue::Text("8"),
    )
    .unwrap();
    assert_eq!(out, b"name,qty\nwidget,2\nwidget,2\nbolt,8\n");
    // TS EXT-02: no row values -> refused.
    assert_eq!(
        update_cell(
            src.as_bytes(),
            D,
            "qty",
            Target::Match(&[]),
            NewValue::Text("0")
        ),
        Err(WriteError::NoRowSelector)
    );
    assert_eq!(
        update_cell(
            src.as_bytes(),
            D,
            "qty",
            Target::Match(&[("name", Some("nut"))]),
            NewValue::Text("0")
        ),
        Err(WriteError::RowNotFound)
    );
    assert_eq!(
        update_cell(
            src.as_bytes(),
            D,
            "qty",
            Target::Match(&[("nope", Some("x"))]),
            NewValue::Text("0")
        ),
        Err(WriteError::UnknownColumn("nope".into()))
    );
    // Empty cell matches None.
    let e = "a,b\n1,\n2,x\n";
    assert_eq!(
        update_cell(
            e.as_bytes(),
            D,
            "a",
            Target::Match(&[("b", None)]),
            NewValue::Text("9")
        )
        .unwrap(),
        b"a,b\n9,\n2,x\n"
    );
}

#[test]
fn stale_view_header_problems_and_ragged_rows_are_refused() {
    let src = "a,b\n1,x\n2\n3,y,extra\n";
    let stale = |cur| {
        update_cell(
            src.as_bytes(),
            D,
            "b",
            Target::Row {
                index: 0,
                expect: Some(cur),
            },
            NewValue::Text("z"),
        )
    };
    assert_eq!(stale(Some("not x")), Err(WriteError::StaleCell));
    assert!(stale(Some("x")).is_ok());
    // Short row: no field to patch -> refused rather than padded.
    assert_eq!(
        update_cell(
            src.as_bytes(),
            D,
            "b",
            Target::Row {
                index: 1,
                expect: None
            },
            NewValue::Text("z")
        ),
        Err(WriteError::RaggedRow {
            row: 1,
            fields: 1,
            column: 1
        })
    );
    // Long row: the cell exists; the extra field is carried through untouched.
    let out = edit(src, D, "b", 2, NewValue::Text("Y"));
    assert_eq!(out, b"a,b\n1,x\n2\n3,Y,extra\n");
    assert_eq!(
        update_cell(
            b"a,a\n1,2\n",
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None
            },
            NewValue::Null
        ),
        Err(WriteError::DuplicateColumn("a".into()))
    );
    assert_eq!(
        update_cell(
            b"",
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None
            },
            NewValue::Null
        ),
        Err(WriteError::Empty)
    );
    assert_eq!(
        update_cell(
            b"a,b\n",
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None
            },
            NewValue::Null
        ),
        Err(WriteError::RowNotFound)
    );
}

#[test]
fn undecidable_encodings_and_broken_quoting_are_refused() {
    let t = |b: &[u8]| {
        update_cell(
            b,
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None,
            },
            NewValue::Text("z"),
        )
    };
    assert_eq!(t(&[0xFF, 0xFE, b'a', 0]), Err(WriteError::Utf16));
    assert_eq!(t(&[0xFE, 0xFF, 0, b'a']), Err(WriteError::Utf16));
    assert_eq!(t(b"a\ncaf\xe9\n"), Err(WriteError::NotUtf8)); // Latin-1
    assert_eq!(t(b"a\nx\0y\n"), Err(WriteError::ContainsNul));
    assert_eq!(
        t(b"a\n\"open\n"),
        Err(WriteError::MalformedQuote { record: 1 })
    );
    assert_eq!(
        t(b"a,b\n\"x\"y,1\n"),
        Err(WriteError::MalformedQuote { record: 1 })
    );
    assert_eq!(
        update_cell(
            b"a\n1\n",
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None
            },
            NewValue::Text("n\0ul")
        ),
        Err(WriteError::Unrepresentable("NUL in value"))
    );
}

#[test]
fn blank_lines_are_not_rows_with_several_columns_but_are_with_one() {
    let two = "a,b\n1,x\n\n2,y\n";
    assert_eq!(
        edit(two, D, "b", 1, NewValue::Text("Q")),
        b"a,b\n1,x\n\n2,Q\n".to_vec()
    );
    let one = "a\n1\n\n2\n";
    assert_eq!(
        edit(one, D, "a", 1, NewValue::Text("B")),
        b"a
1
B
2
"
    );
}

#[test]
fn editing_to_the_current_value_is_a_byte_identical_noop() {
    let src = "id,v\r\n1,\"a b\"\r\n2,plain\r\n";
    assert_eq!(edit(src, D, "v", 0, NewValue::Text("a b")), src.as_bytes());
    assert_eq!(
        edit(src, D, "v", 1, NewValue::Text("plain")),
        src.as_bytes()
    );
}

#[test]
fn a_large_file_edits_one_row_and_nothing_else() {
    let mut src = String::from("id,region,amount\n");
    for i in 0..40_000 {
        src += &format!(
            "{i},{},{}\n",
            if i % 4 == 0 { "north" } else { "south" },
            i * 10
        );
    }
    let out = update_cell(
        src.as_bytes(),
        D,
        "amount",
        Target::Match(&[("id", Some("30000")), ("amount", Some("300000"))]),
        NewValue::Number {
            text: "12345",
            decimal_comma: false,
        },
    )
    .unwrap();
    let (a, b) = assert_single_splice(src.as_bytes(), &out);
    assert!(b - a <= 6 && a > 500_000, "{a}..{b}");
    let (t_src, t_out) = (table(src.as_bytes(), D), table(&out, D));
    assert_eq!(t_out.len(), t_src.len());
    for (i, (r1, r2)) in t_src.iter().zip(&t_out).enumerate() {
        if i == 30_001 {
            assert_eq!(r2[2], "12345")
        } else {
            assert_eq!(r1, r2)
        }
    }
}

/// Deterministic fuzz against the independent decoder: random dialect, endings, quoting and content.
#[test]
fn random_files_edit_exactly_one_cell() {
    let mut s = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move |n: usize| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % n as u64) as usize
    };
    let alphabet = [
        "a", "b", " ", ",", ";", "\t", "\"", "\n", "\r\n", "é", "😀", "0", "9", ".", "-",
    ];
    for case in 0..3000 {
        let d = [D, SEMI, TAB][next(3)];
        let (cols, rows) = (1 + next(4), 1 + next(6));
        let eol = ["\n", "\r\n", "\r"][next(3)];
        let mut text = String::new();
        let put = |text: &mut String, v: &str, last: bool, next: &mut dyn FnMut(usize) -> usize| {
            let need = v.contains(d.delimiter as char)
                || v.contains('"')
                || v.contains('\n')
                || v.contains('\r');
            if need || next(3) == 0 {
                text.push('"');
                text.push_str(&v.replace('"', "\"\""));
                text.push('"')
            } else {
                text.push_str(v)
            }
            if !last {
                text.push(d.delimiter as char)
            }
        };
        for c in 0..cols {
            put(&mut text, &format!("h{c}"), c + 1 == cols, &mut next)
        }
        text.push_str(eol);
        for r in 0..rows {
            for c in 0..cols {
                let mut v: String = (0..next(5))
                    .map(|_| alphabet[next(alphabet.len())])
                    .collect();
                if cols == 1 && v.is_empty() {
                    v.push('a')
                } // the independent decoder drops blank lines, which a one-column file counts as rows
                put(&mut text, &v, c + 1 == cols, &mut next);
            }
            if r + 1 < rows || next(2) == 0 {
                text.push_str(eol)
            } // only the last row may lack a terminator
        }
        let before = table(text.as_bytes(), d);
        let nonblank: Vec<usize> = (1..before.len())
            .filter(|&i| !(before[i].len() == 1 && before[i][0].is_empty() && cols > 1))
            .collect();
        if nonblank.is_empty() {
            continue;
        }
        let row = next(nonblank.len());
        let col = next(cols);
        let v: String = (0..next(6))
            .map(|_| alphabet[next(alphabet.len())])
            .collect();
        let r = update_cell(
            text.as_bytes(),
            d,
            &format!("h{col}"),
            Target::Row {
                index: row,
                expect: None,
            },
            NewValue::Text(&v),
        );
        let Ok(out) = r else {
            panic!("case {case}: {r:?} for {text:?}")
        };
        let mut want = before.clone();
        if want[nonblank[row]].len() <= col {
            panic!("case {case}: ragged slipped through")
        }
        want[nonblank[row]][col] = v.clone();
        assert_eq!(
            table(&out, d),
            want,
            "case {case}: {text:?} -> {:?}",
            String::from_utf8_lossy(&out)
        );
        // Everything outside the edited field is byte-identical.
        let (p, e) = assert_single_splice(text.as_bytes(), &out);
        assert!(p <= e, "case {case}");
    }
}

#[test]
fn streaming_splice_preserves_surrounding_bytes_and_tiny_reads() {
    use std::io::Read;
    let src = "\u{feff}id;v\r\n007;old\n010;1,500\r\n".as_bytes();
    let patch = plan_cell(
        src,
        SEMI,
        "v",
        Target::Row {
            index: 0,
            expect: Some(Some("old")),
        },
        NewValue::Text("a;\"\n😀"),
    )
    .unwrap();
    let mut reader = patch.reader();
    let mut out = Vec::new();
    let mut byte = [0];
    while reader.read(&mut byte).unwrap() != 0 {
        out.push(byte[0]);
    }
    assert_eq!(out.len(), patch.len());
    assert!(!patch.is_empty());
    assert_eq!(
        out,
        "\u{feff}id;v\r\n007;\"a;\"\"\n😀\"\n010;1,500\r\n".as_bytes()
    );
}

#[test]
fn dialect_bytes_cannot_split_utf8_or_create_nul() {
    for (delimiter, quote) in [
        (0, b'"'),
        (b',', 0),
        (b',', b','),
        (b'\n', b'"'),
        (b',', b'\r'),
        (0xc3, b'"'),
        (b',', 0xa9),
    ] {
        assert!(matches!(
            update_cell(
                b"a,b\nx,y\n",
                Dialect { delimiter, quote },
                "b",
                Target::Row {
                    index: 0,
                    expect: None
                },
                NewValue::Text("z")
            ),
            Err(WriteError::Unrepresentable(_))
        ));
    }
}

#[test]
fn final_single_column_null_refuses_but_terminated_null_retains_row() {
    assert!(matches!(
        plan_cell(
            b"a\nx",
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None
            },
            NewValue::Null
        ),
        Err(WriteError::Verification(_))
    ));
    assert_eq!(
        update_cell(
            b"a\nx\n",
            D,
            "a",
            Target::Row {
                index: 0,
                expect: None
            },
            NewValue::Null
        )
        .unwrap(),
        b"a\n\n"
    );
}

#[test]
fn counts_all_ambiguous_matches_and_checks_malformed_tail() {
    let src = format!("a,b\n{}", "x,y\n".repeat(100_000));
    assert!(matches!(
        plan_cell(
            src.as_bytes(),
            D,
            "b",
            Target::Match(&[("a", Some("x"))]),
            NewValue::Null
        ),
        Err(WriteError::Ambiguous { rows: 100_000 })
    ));
    assert!(matches!(
        plan_cell(
            b"a,b\nx,y\nx,y\n\"bad",
            D,
            "b",
            Target::Match(&[("a", Some("x"))]),
            NewValue::Null
        ),
        Err(WriteError::MalformedQuote { .. })
    ));
}
