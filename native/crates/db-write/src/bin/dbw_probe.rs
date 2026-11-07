//! Test-only process: `dbw_probe <db> <table> <column> <new-text> <row-index>`. Exit 0 = committed, 2 = refused.
use dfv_table_db_write::*;
use dfv_table_sqlite::*;
use std::path::Path;
use std::time::Duration;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let path = Path::new(&a[1]);
    let reader = open_read_only(path, OpenMode::ReadOnly, Duration::ZERO).expect("open");
    let plan = plan_tables(&reader, None).expect("plan");
    let table = &plan[&a[2]];
    let (rows, _) = read_rows(&reader, &a[2], table, 1000).expect("rows");
    let row = &rows[a[5].parse::<usize>().unwrap()];
    let edit = CellEdit {
        table: a[2].clone(),
        column: a[3].clone(),
        new_value: Cell::Text(a[4].clone()),
        row: table
            .columns
            .iter()
            .map(|c| c.name.clone())
            .zip(row.iter().cloned())
            .collect(),
    };
    let stamp = FileStamp::of(path).expect("stamp");
    drop(reader);
    match update_cell(path, &plan, &stamp, &edit, Duration::from_secs(2)) {
        Ok(o) => println!("OK {o:?}"),
        Err(e) => {
            println!("ERR {e}");
            std::process::exit(2);
        }
    }
}
