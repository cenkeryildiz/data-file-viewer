//! Oracle driver: csv_patch <in> <out> <delimiter> <column> <match-json [[col,val|null],...]> <kind text|number|null> <value> [decimal_comma]
use dfv_table_csv_write::*;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let src = std::fs::read(&a[1]).unwrap();
    let d = Dialect {
        delimiter: a[3].as_bytes()[0],
        ..Dialect::default()
    };
    let m: Vec<(String, Option<String>)> = serde_json::from_str(&a[5]).unwrap();
    let m: Vec<(&str, Option<&str>)> = m.iter().map(|(c, v)| (c.as_str(), v.as_deref())).collect();
    let new = match a[6].as_str() {
        "null" => NewValue::Null,
        "number" => NewValue::Number {
            text: &a[7],
            decimal_comma: a.get(8).is_some(),
        },
        _ => NewValue::Text(&a[7]),
    };
    match update_cell(&src, d, &a[4], Target::Match(&m), new) {
        Ok(out) => std::fs::write(&a[2], out).unwrap(),
        Err(e) => {
            println!("REFUSED {e}");
            std::process::exit(3)
        }
    }
}
