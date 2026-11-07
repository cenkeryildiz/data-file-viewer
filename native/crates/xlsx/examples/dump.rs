//! Dumps a workbook as JSON lines for independent comparison (openpyxl). One line per sheet:
//! {"sheet":..,"merges":[..],"declared":..,"cells":[[row0,col0,kind,text,is_date,formula|null],..]}
use dfv_table_xlsx::xlsx_read::*;
use serde_json::json;

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let mut p = Package::open(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{e}"));
    let styles = p.styles().unwrap();
    for s in p.list_sheets().unwrap() {
        let sheet = p.read_sheet(&s).unwrap();
        let cells: Vec<_> = sheet
            .cells
            .iter()
            .map(|(&(r, c), x)| {
                let kind = match x.value {
                    Value::Text(_) => "s",
                    Value::Number(_) => "n",
                    Value::Bool(_) => "b",
                    Value::Error(_) => "e",
                };
                let date = styles.get(x.style as usize).is_some_and(|s| s.is_date);
                json!([
                    r,
                    c,
                    kind,
                    x.text(),
                    date,
                    x.formula.as_ref().map(|f| f.text.clone())
                ])
            })
            .collect();
        let merges: Vec<_> = sheet
            .merges
            .iter()
            .map(|m| json!([m.top, m.left, m.bottom, m.right]))
            .collect();
        println!(
            "{}",
            json!({"sheet": s.name, "merges": merges, "declared": sheet.declared.as_ref().map(|d| format!("{}{}:{}{}", d.first_col, d.first_row, d.last_col, d.last_row)), "cells": cells})
        );
    }
}
