use dfv_table_csv_write::{Dialect, NewValue, Target, WriteError, plan_cell};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Peak;
static BIGGEST: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        BIGGEST.fetch_max(l.size(), Ordering::Relaxed);
        unsafe { System.alloc(l) }
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
static A: Peak = Peak;

#[test]
fn duplicate_rows_do_not_accumulate_record_metadata() {
    let src = format!("a,b\n{}", "x,y\n".repeat(1_000_000));
    BIGGEST.store(0, Ordering::Relaxed);
    let result = plan_cell(
        src.as_bytes(),
        Dialect::default(),
        "b",
        Target::Match(&[("a", Some("x"))]),
        NewValue::Null,
    );
    let largest = BIGGEST.load(Ordering::Relaxed);
    assert!(matches!(
        result,
        Err(WriteError::Ambiguous { rows: 1_000_000 })
    ));
    assert!(largest < 64 * 1024, "largest allocation: {largest}");
}
