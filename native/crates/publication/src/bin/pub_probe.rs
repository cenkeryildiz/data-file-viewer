//! Test-only process: `pub_probe <receipts> <target> <bytes-file> [expected-original-file]`. Exit 0 = published.
use dfv_table_publication::{Protection, Publisher, SourceState};
use std::path::Path;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[3]).expect("bytes");
    let publisher = Publisher::new(Path::new(&a[1]), Protection::default()).expect("publisher");
    let lock = match publisher.lock(Path::new(&a[2])) {
        Ok(l) => l,
        Err(e) => {
            println!("ERR {e}");
            std::process::exit(2);
        }
    };
    let expected = a
        .get(4)
        .map(|p| SourceState::capture(Path::new(p)).expect("state"));
    match publisher.publish(&lock, &bytes, expected.as_ref()) {
        Ok(r) => println!("OK {} {}", r.id, r.durable),
        Err(e) => {
            println!("ERR {e}");
            if let Some(id) = &e.receipt_id {
                println!("RECEIPT {id}");
            }
            std::process::exit(3);
        }
    }
}
