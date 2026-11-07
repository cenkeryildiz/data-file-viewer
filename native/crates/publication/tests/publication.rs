// Real-process kill/fail tests need the probe binary, so this file builds only with `--features test-mutations`.
use dfv_table_publication::{
    Identity, Kind, Protection, Publisher, SourceState, Status, digest, digest_reader,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

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

const OLD: &[u8] = b"old destination contents";
const NEW: &[u8] = b"new verified contents, a little longer than the old ones";

#[test]
fn a_last_syscall_replacement_is_retained_for_recovery_instead_of_destroyed() {
    let dir = scratch();
    let target = dir.join("out/saved.bin");
    fs::write(&target, OLD).unwrap();
    let mut child = probe(&dir, "pause:before_exchange", 2_000);
    reach(&mut child, "before_exchange");
    let foreign = b"another program committed this file";
    fs::write(dir.join("out/foreign.bin"), foreign).unwrap();
    fs::rename(dir.join("out/foreign.bin"), &target).unwrap();
    let (ok, text) = finish(child);
    assert!(!ok && text.contains("Unconfirmed"), "{text}");
    let id = text
        .lines()
        .find_map(|line| line.strip_prefix("RECEIPT "))
        .unwrap();
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("receipts").join(format!("{id}.json"))).unwrap())
            .unwrap();
    assert_eq!(
        fs::read(record["staging"].as_str().unwrap()).unwrap(),
        foreign
    );
    assert_eq!(publisher(&dir).status(id), Status::Unconfirmed);
    assert_eq!(dest(&dir), NEW);
}

#[test]
fn death_after_the_atomic_swap_retains_a_verifiable_original() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let mut child = probe(&dir, "pause:after_exchange", 15_000);
    reach(&mut child, "after_exchange");
    child.kill().unwrap();
    child.wait().unwrap();
    let ids = receipt_ids(&dir);
    assert_eq!(ids.len(), 1);
    assert_eq!(dest(&dir), NEW);
    assert_eq!(
        publisher(&dir).status(&ids[0]),
        Status::Published {
            finalized: false,
            durable: false
        }
    );
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(dir.join("receipts").join(format!("{}.json", ids[0]))).unwrap(),
    )
    .unwrap();
    assert_eq!(fs::read(record["staging"].as_str().unwrap()).unwrap(), OLD);
}

#[test]
fn a_non_utf8_destination_is_refused_before_creating_an_unusable_receipt() {
    use std::os::unix::ffi::OsStringExt;
    let dir = scratch();
    let p = publisher(&dir);
    let target = dir
        .join("out")
        .join(std::ffi::OsString::from_vec(b"invalid-\xff.bin".to_vec()));
    let lock = p.lock(&target).unwrap();
    assert_eq!(
        p.publish(&lock, NEW, None).err().unwrap().reason,
        "destination_encoding"
    );
    assert!(!target.exists() && receipt_ids(&dir).is_empty());
}

#[test]
fn streaming_input_is_bounded_and_requires_the_exact_length_and_hash() {
    assert_eq!(digest_reader(&b"stable"[..], 6).unwrap(), digest(b"stable"));
    assert!(digest_reader(std::io::repeat(0), 8).is_err());
    assert!(digest_reader(&b"short"[..], 6).is_err());
    let dir = scratch();
    let p = publisher(&dir);
    let target = dir.join("out/saved.bin");
    fs::write(&target, OLD).unwrap();
    let lock = p.lock(&target).unwrap();
    for data in [&b"wrong!"[..], &b"short"[..], &b"too long"[..]] {
        assert!(
            p.publish_reader(&lock, data, 6, &digest(b"stable"), None)
                .is_err()
        );
        assert_eq!(dest(&dir), OLD);
        assert!(receipt_ids(&dir).is_empty());
    }
    assert!(
        p.publish_reader(&lock, &b"stable"[..], 6, &digest(b"stable"), None)
            .is_ok()
    );
    assert_eq!(dest(&dir), b"stable");
}

#[test]
fn a_new_destination_appearing_at_the_publish_syscall_is_never_overwritten() {
    let dir = scratch();
    let mut child = probe(&dir, "pause:before_new_link", 2_000);
    reach(&mut child, "before_new_link");
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let (ok, text) = finish(child);
    assert!(!ok && text.contains("Changed"), "{text}");
    assert_eq!(dest(&dir), OLD);
    assert!(receipt_ids(&dir).is_empty());
    assert_eq!(staging_left(&dir), 0);
}

#[test]
fn an_unconfirmed_error_returns_the_receipt_id_needed_for_reconciliation() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let (ok, text) = finish(probe(&dir, "fail:after_rename", 0));
    assert!(!ok);
    let id = text
        .lines()
        .find_map(|line| line.strip_prefix("RECEIPT "))
        .expect("uncertain error includes its id");
    assert_eq!(
        publisher(&dir).status(id),
        Status::Published {
            finalized: false,
            durable: false
        }
    );
}

#[test]
fn different_receipt_stores_still_exclude_writers_to_the_same_target() {
    let dir = scratch();
    let first = publisher(&dir);
    let second = Publisher::new(&dir.join("other-receipts"), Protection::default()).unwrap();
    let target = dir.join("out/saved.bin");
    let held = first.lock(&target).unwrap();
    assert_eq!(second.lock(&target).err().unwrap().kind, Kind::Locked);
    let independent = second.lock(&dir.join("out/another.bin")).unwrap();
    drop(independent);
    drop(held);
    assert!(second.lock(&target).is_ok());
}

#[test]
fn existing_file_case_aliases_cannot_bypass_the_writer_lock() {
    let dir = scratch();
    let upper = dir.join("out/CaseAlias.CSV");
    let lower = dir.join("out/casealias.csv");
    fs::write(&upper, OLD).unwrap();
    if !lower.exists() {
        return;
    } // The runner's filesystem is case-sensitive.
    let p = publisher(&dir);
    let lock = p.lock(&upper).unwrap();
    assert_eq!(p.lock(&lower).err().unwrap().kind, Kind::Locked);
    drop(lock);
}

#[test]
fn creation_under_another_case_invalidates_an_earlier_alias_lock() {
    let dir = scratch();
    let probe_path = dir.join("out/CaseProbe");
    fs::write(&probe_path, OLD).unwrap();
    if !dir.join("out/caseprobe").exists() {
        return;
    }
    fs::remove_file(probe_path).unwrap();
    let p = publisher(&dir);
    let upper = dir.join("out/CaseRace.csv");
    let lower = dir.join("out/caserace.csv");
    let first = p.lock(&upper).unwrap();
    let stale = p.lock(&lower).unwrap();
    p.publish(&first, NEW, None).unwrap();
    assert_eq!(
        p.publish(&stale, b"must not replace the other host's save", None)
            .err()
            .unwrap()
            .kind,
        Kind::Changed
    );
    assert_eq!(fs::read(upper).unwrap(), NEW);
}

#[test]
fn old_destination_hashing_stays_streaming() {
    let dir = scratch();
    let target = dir.join("out/saved.bin");
    fs::File::create(&target)
        .unwrap()
        .set_len(32 << 20)
        .unwrap();
    let p = publisher(&dir);
    let lock = p.lock(&target).unwrap();
    let r = p.publish(&lock, NEW, None).unwrap();
    assert_eq!(
        p.status(&r.id),
        Status::Published {
            finalized: true,
            durable: true
        }
    );
    assert_eq!(dest(&dir), NEW);
    assert!(
        BIGGEST.load(Ordering::Relaxed) < 1 << 20,
        "old file was buffered wholesale"
    );
}

#[test]
fn oversized_receipts_are_unconfirmed_without_large_allocations() {
    let dir = scratch();
    let p = publisher(&dir);
    let id = "c".repeat(32);
    fs::File::create(dir.join("receipts").join(format!("{id}.json")))
        .unwrap()
        .set_len(8 << 20)
        .unwrap();
    assert_eq!(p.status(&id), Status::Unconfirmed);
    assert!(
        BIGGEST.load(Ordering::Relaxed) < 1 << 20,
        "oversized receipt was buffered wholesale"
    );
}

#[test]
fn foreign_receipts_and_receipt_symlinks_never_confirm_a_save() {
    let dir = scratch();
    let p = publisher(&dir);
    let target = dir.join("out/saved.bin");
    let lock = p.lock(&target).unwrap();
    let r = p.publish(&lock, NEW, None).unwrap();
    let record = dir.join("receipts").join(format!("{}.json", r.id));
    let original: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    for (field, value) in [
        ("format", serde_json::json!("foreign")),
        ("version", serde_json::json!(2)),
        ("id", serde_json::json!("a".repeat(32))),
        ("state", serde_json::json!("unknown")),
    ] {
        let mut bad = original.clone();
        bad[field] = value;
        fs::write(&record, bad.to_string()).unwrap();
        assert_eq!(p.status(&r.id), Status::Unconfirmed);
    }
    fs::write(&record, original.to_string()).unwrap();
    let other = dir.join("original.json");
    fs::rename(&record, &other).unwrap();
    symlink(other, record).unwrap();
    assert_eq!(p.status(&r.id), Status::Unconfirmed);
}

fn scratch() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "dfv-pub-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("out")).unwrap();
    fs::write(dir.join("new.bin"), NEW).unwrap();
    dir
}
fn probe(dir: &Path, fault: &str, pause_ms: u32) -> Child {
    Command::new(env!("CARGO_BIN_EXE_pub_probe"))
        .args([
            dir.join("receipts"),
            dir.join("out/saved.bin"),
            dir.join("new.bin"),
        ])
        .env("DFV_TEST_PUBLICATION_FAULT", fault)
        .env("DFV_TEST_PUBLICATION_PAUSE_MS", pause_ms.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}
fn reach(child: &mut Child, stage: &str) {
    let mut lines = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            lines.read_line(&mut line).unwrap() > 0,
            "probe exited before checkpoint {stage}"
        );
        if line.contains(&format!("checkpoint {stage}")) {
            return;
        }
    }
}
fn finish(child: Child) -> (bool, String) {
    let out = child.wait_with_output().unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}
fn publisher(dir: &Path) -> Publisher {
    Publisher::new(&dir.join("receipts"), Protection::default()).unwrap()
}
fn receipt_ids(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir.join("receipts")) else {
        return vec![];
    };
    rd.filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".json").map(str::to_owned))
        .filter(|n| !n.starts_with('.'))
        .collect()
}
fn staging_left(dir: &Path) -> usize {
    fs::read_dir(dir.join("out"))
        .unwrap()
        .filter(|e| {
            let entry = e.as_ref().unwrap();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(".dfv-table-lock-") {
                assert_eq!(
                    entry.metadata().unwrap().len(),
                    0,
                    "persistent lock is empty"
                );
                return false;
            }
            name.starts_with(".dfv-table-")
        })
        .count()
}
fn dest(dir: &Path) -> Vec<u8> {
    fs::read(dir.join("out/saved.bin")).unwrap()
}

#[test]
fn sigkill_at_every_boundary_leaves_a_truthful_resolvable_state() {
    // (stage, destination already replaced, status after the kill)
    let cases: [(&str, bool, Status); 9] = [
        ("before_write", false, Status::NotPublished),
        ("after_write", false, Status::NotPublished),
        ("after_flush", false, Status::NotPublished),
        ("after_verify", false, Status::NotPublished),
        ("before_rename", false, Status::NotPublished),
        (
            "after_rename",
            true,
            Status::Published {
                finalized: false,
                durable: false,
            },
        ),
        (
            "after_parent_flush",
            true,
            Status::Published {
                finalized: false,
                durable: false,
            },
        ),
        (
            "before_receipt",
            true,
            Status::Published {
                finalized: false,
                durable: false,
            },
        ),
        (
            "after_receipt",
            true,
            Status::Published {
                finalized: true,
                durable: true,
            },
        ),
    ];
    for (stage, replaced, status) in cases {
        let dir = scratch();
        fs::write(dir.join("out/saved.bin"), OLD).unwrap();
        let mut child = probe(&dir, &format!("pause:{stage}"), 15_000);
        reach(&mut child, stage);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(
            dest(&dir),
            if replaced { NEW } else { OLD },
            "{stage}: destination is exactly old or exactly new, never partial"
        );
        let ids = receipt_ids(&dir);
        assert_eq!(ids.len(), 1, "{stage}");
        let p = publisher(&dir);
        assert_eq!(p.status(&ids[0]), status, "{stage}");
        // The dead process's lock is gone: a new writer can take it and publish.
        let lock = p
            .lock(&dir.join("out/saved.bin"))
            .unwrap_or_else(|e| panic!("{stage}: {e}"));
        let again = p.publish(&lock, NEW, None).unwrap();
        assert_eq!(dest(&dir), NEW, "{stage}");
        assert_eq!(
            p.status(&again.id),
            Status::Published {
                finalized: true,
                durable: true
            },
            "{stage}"
        );
        drop(lock);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn kill_before_the_rename_leaves_at_most_one_staging_file_and_after_it_none() {
    for (stage, expect) in [
        ("before_write", 1),
        ("before_rename", 1),
        ("after_rename", 0),
    ] {
        let dir = scratch();
        fs::write(dir.join("out/saved.bin"), OLD).unwrap();
        let mut child = probe(&dir, &format!("pause:{stage}"), 15_000);
        reach(&mut child, stage);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(staging_left(&dir), expect, "{stage}");
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn injected_failures_before_the_rename_change_nothing_and_leave_no_record() {
    for fault in [
        "disk_full:before_write",
        "disk_full:after_write",
        "fail:after_flush",
        "fail:after_verify",
        "fail:before_rename",
    ] {
        let dir = scratch();
        fs::write(dir.join("out/saved.bin"), OLD).unwrap();
        let (ok, out) = finish(probe(&dir, fault, 0));
        assert!(!ok, "{fault}");
        assert!(
            out.contains(if fault.starts_with("disk_full") {
                "DiskFull"
            } else {
                "Io"
            }),
            "{fault}: {out}"
        );
        assert_eq!(dest(&dir), OLD, "{fault}");
        assert_eq!(staging_left(&dir), 0, "{fault}");
        assert!(
            receipt_ids(&dir).is_empty(),
            "{fault}: failed run must not leave a pending record"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn failures_after_the_rename_are_unconfirmed_but_status_reports_the_truth() {
    for fault in [
        "fail:after_rename",
        "fail:after_parent_flush",
        "fail:before_receipt",
    ] {
        let dir = scratch();
        fs::write(dir.join("out/saved.bin"), OLD).unwrap();
        let (ok, out) = finish(probe(&dir, fault, 0));
        assert!(!ok && out.contains("Unconfirmed"), "{fault}: {out}");
        assert_eq!(dest(&dir), NEW, "{fault}");
        let ids = receipt_ids(&dir);
        assert_eq!(
            publisher(&dir).status(&ids[0]),
            Status::Published {
                finalized: false,
                durable: false
            },
            "{fault}"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn failed_directory_flush_publishes_but_reports_not_durable() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let (ok, out) = finish(probe(&dir, "fail:directory_flush", 0));
    assert!(ok && out.trim_end().ends_with("false"), "{out}");
    assert_eq!(dest(&dir), NEW);
    assert_eq!(
        publisher(&dir).status(&receipt_ids(&dir)[0]),
        Status::Published {
            finalized: true,
            durable: false
        }
    );
    let record =
        fs::read_to_string(dir.join(format!("receipts/{}.json", receipt_ids(&dir)[0]))).unwrap();
    assert!(record.contains("\"durable\":false"));
}

#[test]
fn writer_lock_covers_the_run_until_the_receipt_is_written() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let mut child = probe(&dir, "pause:before_receipt", 15_000);
    reach(&mut child, "before_receipt");
    let p = publisher(&dir);
    let target = dir.join("out/saved.bin");
    assert_eq!(
        p.lock(&target).err().unwrap().kind,
        Kind::Locked,
        "destination already replaced but the receipt is pending"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    let first = p.lock(&target).unwrap();
    assert_eq!(
        p.lock(&target).err().unwrap().kind,
        Kind::Locked,
        "second writer refused while the first holds the lock"
    );
    drop(first);
    assert!(p.lock(&target).is_ok());
}

#[test]
fn external_replacement_between_stage_and_rename_is_refused_and_preserved() {
    for stage in ["after_verify", "before_rename"] {
        let dir = scratch();
        let target = dir.join("out/saved.bin");
        fs::write(&target, OLD).unwrap();
        let mut child = probe(&dir, &format!("pause:{stage}"), 2_000);
        reach(&mut child, stage);
        fs::write(dir.join("out/other"), b"someone else wrote this").unwrap();
        fs::rename(dir.join("out/other"), &target).unwrap();
        let (ok, out) = finish(child);
        assert!(!ok && out.contains("Changed"), "{out}");
        assert_eq!(dest(&dir), b"someone else wrote this");
        assert_eq!(staging_left(&dir), 0);
        assert!(receipt_ids(&dir).is_empty());
    }
}

#[test]
fn receipt_temp_symlinks_cannot_truncate_an_unrelated_file() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let victim = dir.join("private.bin");
    fs::write(&victim, b"must survive receipt publication").unwrap();
    let mut child = probe(&dir, "pause:before_receipt", 2_000);
    reach(&mut child, "before_receipt");
    let ids = receipt_ids(&dir);
    assert_eq!(ids.len(), 1);
    symlink(
        &victim,
        dir.join("receipts").join(format!(".{}.json.tmp", ids[0])),
    )
    .unwrap();
    let (ok, text) = finish(child);
    assert!(!ok && text.contains("Unconfirmed"), "{text}");
    assert_eq!(
        fs::read(victim).unwrap(),
        b"must survive receipt publication"
    );
    assert_eq!(dest(&dir), NEW);
    assert_eq!(
        publisher(&dir).status(&ids[0]),
        Status::Published {
            finalized: false,
            durable: false
        }
    );
}

#[test]
fn substituted_staging_bytes_never_replace_the_destination() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let mut child = probe(&dir, "pause:before_rename", 2_000);
    reach(&mut child, "before_rename");
    let stage = fs::read_dir(dir.join("out"))
        .unwrap()
        .map(|p| p.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".dfv-table-")
                && p.extension().is_some_and(|e| e == "tmp")
        })
        .unwrap();
    fs::write(stage, b"unverified external contents").unwrap();
    let (ok, text) = finish(child);
    assert!(!ok, "{text}");
    assert_eq!(dest(&dir), OLD);
    assert!(receipt_ids(&dir).is_empty());
}

#[test]
fn tampering_right_after_the_rename_never_earns_a_receipt() {
    let dir = scratch();
    fs::write(dir.join("out/saved.bin"), OLD).unwrap();
    let mut child = probe(&dir, "pause:after_rename", 2_000);
    reach(&mut child, "after_rename");
    fs::write(dir.join("out/saved.bin"), b"tampered").unwrap();
    let (ok, out) = finish(child);
    assert!(!ok && out.contains("Unconfirmed"), "{out}");
    let ids = receipt_ids(&dir);
    assert_eq!(publisher(&dir).status(&ids[0]), Status::Unconfirmed);
    assert!(
        !fs::read_to_string(dir.join(format!("receipts/{}.json", ids[0])))
            .unwrap()
            .contains("\"published\"")
    );
}

#[test]
fn stale_source_alias_hardlink_symlink_and_fifo_destinations_are_refused() {
    let dir = scratch();
    let out = dir.join("out");
    let p = publisher(&dir);
    let target = out.join("saved.bin");
    fs::write(&target, OLD).unwrap();

    // The caller read the file, then it changed.
    let seen = SourceState::capture(&target).unwrap();
    fs::write(&target, b"changed after read").unwrap();
    let lock = p.lock(&target).unwrap();
    assert_eq!(
        p.publish(&lock, NEW, Some(&seen)).err().unwrap().kind,
        Kind::Changed
    );
    assert_eq!(fs::read(&target).unwrap(), b"changed after read");
    drop(lock);

    // Destination is another name for a protected file (alias by identity), or protected by path.
    let protected = out.join("open-document.bin");
    fs::write(&protected, OLD).unwrap();
    let alias = out.join("alias.bin");
    fs::hard_link(&protected, &alias).unwrap();
    let guarded = Publisher::new(
        &dir.join("receipts"),
        Protection {
            paths: vec![],
            identities: vec![Identity::of(&fs::metadata(&protected).unwrap())],
        },
    )
    .unwrap();
    for t in [&alias, &protected] {
        let l = guarded.lock(t).unwrap();
        assert_eq!(
            guarded.publish(&l, NEW, None).err().unwrap().reason,
            "protected_destination"
        );
    }
    let by_path = Publisher::new(
        &dir.join("receipts"),
        Protection {
            paths: vec![protected.clone()],
            identities: vec![],
        },
    )
    .unwrap();
    let l = by_path.lock(&protected).unwrap();
    assert_eq!(
        by_path.publish(&l, NEW, None).err().unwrap().reason,
        "protected_destination"
    );

    // A hardlinked destination that is not protected is still refused: rename would detach the other name.
    let unprotected = Publisher::new(&dir.join("receipts"), Protection::default()).unwrap();
    let l = unprotected.lock(&alias).unwrap();
    assert_eq!(
        unprotected.publish(&l, NEW, None).err().unwrap().reason,
        "destination_hardlinked"
    );
    assert_eq!(fs::read(&protected).unwrap(), OLD);

    // Symlink destination refused at lock time.
    let link = out.join("link.bin");
    symlink(&target, &link).unwrap();
    assert_eq!(p.lock(&link).err().unwrap().reason, "destination_symlink");
    // FIFO destination refused without blocking.
    let fifo = out.join("pipe");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let l = p.lock(&fifo).unwrap();
    assert_eq!(
        p.publish(&l, NEW, None).err().unwrap().reason,
        "destination_type"
    );
    assert_eq!(staging_left(&dir), 0);
}

#[test]
fn status_is_absent_for_unknown_ids_and_unconfirmed_for_corrupt_records() {
    let dir = scratch();
    let p = publisher(&dir);
    assert_eq!(p.status(&"0".repeat(32)), Status::Absent);
    assert_eq!(p.status("../../etc/passwd"), Status::Absent);
    fs::write(
        dir.join(format!("receipts/{}.json", "a".repeat(32))),
        b"{not json",
    )
    .unwrap();
    assert_eq!(p.status(&"a".repeat(32)), Status::Unconfirmed);
}

#[test]
fn a_new_file_is_created_and_a_vanished_one_is_reported() {
    let dir = scratch();
    let (ok, _) = finish(probe(&dir, "", 0));
    assert!(ok);
    assert_eq!(dest(&dir), NEW);
    // Pending run on a new destination that was killed before the rename resolves to NotPublished.
    let dir = scratch();
    let mut child = probe(&dir, "pause:before_rename", 15_000);
    reach(&mut child, "before_rename");
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(!dir.join("out/saved.bin").exists());
    assert_eq!(
        publisher(&dir).status(&receipt_ids(&dir)[0]),
        Status::NotPublished
    );
}
