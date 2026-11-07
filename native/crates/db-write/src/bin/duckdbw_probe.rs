//! Test-only subprocess for native locks, abrupt termination, and publication races.
use dfv_table_db_write::duckdb_write::{self, CellEdit};
use dfv_table_publication::{Protection, Publisher};
use duckdb::{Connection, types::Value};
use std::{io::Write, path::Path};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let path = Path::new(&a[2]);
    if a[1] == "hold" {
        let _connection = Connection::open(path).expect("native writer lock");
        println!("locked");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    if a[1] == "try-lock" {
        if let Err(e) = Connection::open(path) {
            eprintln!("{e}");
            std::process::exit(2);
        }
        return;
    }
    let root = path.parent().unwrap();
    let publisher = Publisher::new(&root.join("receipts"), Protection::default()).unwrap();
    let lock = publisher.lock(path).unwrap();
    let plan = duckdb_write::plan(lock.target()).unwrap();
    let edit = CellEdit {
        schema: "main".into(),
        table: "t".into(),
        column: "v".into(),
        value: Value::Text("new".into()),
        row: vec![
            ("id".into(), Value::Int(1)),
            ("v".into(), Value::Text("old".into())),
        ],
    };
    match duckdb_write::update_cell(&publisher, &lock, &plan, &edit, root) {
        Ok(o) => println!("OK {o:?}"),
        Err(e) => {
            eprintln!("ERR {e}");
            std::process::exit(2);
        }
    }
}
