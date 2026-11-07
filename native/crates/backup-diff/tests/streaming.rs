use dfv_table_backup_diff::{Options, create_backup};
use dfv_table_publication::{Protection, Publisher};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    fs,
    sync::atomic::{AtomicUsize, Ordering},
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

#[test]
fn a_large_backup_streams_and_matches_an_independent_sha256() {
    let dir = std::env::temp_dir().join(format!("dfv-streaming-backup-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let source = dir.join("large.bin");
    fs::File::create(&source)
        .unwrap()
        .set_len(64 << 20)
        .unwrap();
    let publisher = Publisher::new(&dir.join("receipts"), Protection::default()).unwrap();
    let lock = publisher.lock(&source).unwrap();
    let backup = create_backup(&publisher, &lock, || Ok(()), &Options::default()).unwrap();
    assert_eq!(backup.length, 64 << 20);
    // Python hashlib.sha256 over 64 one-MiB zero blocks, independent of the Rust hash implementation.
    assert_eq!(
        backup.sha256,
        "3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351"
    );
    assert!(backup.intact() && backup.receipt.durable);
    assert!(
        BIGGEST.load(Ordering::Relaxed) < 1 << 20,
        "backup buffered a file-sized allocation"
    );
    drop(lock);
    fs::remove_dir_all(dir).unwrap();
}
