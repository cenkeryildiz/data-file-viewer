use dfv_table_dta::{Error, Limits, from_bytes};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
struct Peak;
static BIGGEST: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        BIGGEST.fetch_max(n, Ordering::Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static ALLOC: Peak = Peak;
fn fx(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}
fn tight() -> Limits {
    Limits {
        file_bytes: 4 << 20,
        metadata_bytes: 1 << 20,
        columns: 64,
        row_bytes: 64 << 10,
        cell_bytes: 16 << 10,
        metadata_entries: 1000,
        page_cells: 1000,
        page_bytes: 128 << 10,
    }
}
fn read(bytes: Vec<u8>) -> Result<(), Error> {
    let s = from_bytes(Arc::from(bytes), &tight())?;
    s.read_rows(0, 10)?;
    Ok(())
}
#[test]
fn flipped_bytes_never_panic_or_request_unbounded_allocations() {
    let mut flips = 0;
    for file in ["v117-le.dta", "v119-be.dta", "readstat-15.dta"] {
        let good = fx(file);
        read(good.clone()).unwrap();
        for at in 0..good.len() {
            let mut bad = good.clone();
            bad[at] ^= 0xff;
            let result = std::panic::catch_unwind(|| read(bad));
            assert!(result.is_ok(), "{file} byte {at} panicked");
            flips += 1;
        }
    }
    assert!(flips > 10_000);
    assert!(
        BIGGEST.load(Ordering::Relaxed) <= 4 << 20,
        "input length bypassed allocation guards"
    );
}
#[test]
fn every_strict_prefix_is_refused() {
    for file in ["v117-le.dta", "v118-be.dta", "readstat-15.dta"] {
        let good = fx(file);
        for cut in 0..good.len() {
            assert!(read(good[..cut].to_vec()).is_err(), "{file} prefix {cut}");
        }
    }
}
