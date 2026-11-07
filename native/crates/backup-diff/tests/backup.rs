use dfv_table_backup_diff::*;
use dfv_table_publication::{Kind, Protection, Publisher, Status};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

struct Dir(PathBuf);
impl Dir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "dfv-backup-diff-{tag}-{}-{:x}",
            std::process::id(),
            std::time::Instant::now().elapsed().as_nanos() ^ tag.len() as u128
        ));
        let p = p.join(format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(self.0.parent().unwrap());
    }
}
fn publisher(d: &Dir) -> Publisher {
    Publisher::new(&d.0.join("receipts"), Protection::default()).unwrap()
}
fn source(d: &Dir, name: &str, bytes: &[u8]) -> PathBuf {
    let p = d.0.join(name);
    fs::write(&p, bytes).unwrap();
    p
}
fn backups(d: &Dir) -> Vec<String> {
    let mut v: Vec<_> = fs::read_dir(&d.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".backup-"))
        .collect();
    v.sort();
    v
}
fn leftovers(d: &Dir) -> Vec<String> {
    fs::read_dir(&d.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".dfv-table-"))
        .filter(|n| !is_writer_lock(&d.0.join(n)))
        .collect()
}

// Shared locks persist so separate hosts cannot lock different inodes for the same destination.
fn is_writer_lock(path: &Path) -> bool {
    let Some(id) = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(".dfv-table-lock-"))
    else {
        return false;
    };
    id.len() == 64
        && id.bytes().all(|b| b.is_ascii_hexdigit())
        && fs::symlink_metadata(path)
            .is_ok_and(|m| m.is_file() && m.len() == 0 && m.permissions().mode() & 0o777 == 0o600)
}

#[test]
fn backup_is_an_exact_verified_sibling_named_like_the_ts() {
    let d = Dir::new("ok");
    let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let src = source(&d, "sales.2026.csv", &data);
    fs::set_permissions(&src, fs::Permissions::from_mode(0o640)).unwrap();
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    let mut flushed = false;
    let b = create_backup(
        &p,
        &lock,
        || {
            flushed = true;
            Ok(())
        },
        &Options::default(),
    )
    .unwrap();
    assert!(flushed);
    assert_eq!(fs::read(&b.path).unwrap(), data);
    let name = b.path.file_name().unwrap().to_str().unwrap().to_owned();
    // <stem>.backup-YYYYMMDD-HHMMSS-<8 hex>.<ext>, in the source's directory
    let rest = name
        .strip_prefix("sales.2026.backup-")
        .and_then(|r| r.strip_suffix(".csv"))
        .unwrap_or_else(|| panic!("{name}"));
    let (stamp, nonce) = rest.rsplit_once('-').unwrap();
    assert_eq!(stamp.len(), 15);
    assert!(
        stamp.as_bytes()[8] == b'-'
            && stamp
                .bytes()
                .filter(|c| *c != b'-')
                .all(|c| c.is_ascii_digit())
    );
    assert!(nonce.len() == 8 && nonce.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(b.path.parent(), src.canonicalize().unwrap().parent());
    assert_eq!(
        fs::metadata(&b.path).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert!(b.intact());
    assert_eq!(
        p.status(&b.receipt.id),
        Status::Published {
            finalized: true,
            durable: true
        }
    );
    assert!(leftovers(&d).is_empty());
    assert_eq!(fs::read(&src).unwrap(), data, "source untouched");
}

#[test]
fn repeated_backups_never_overwrite_each_other() {
    let d = Dir::new("repeat");
    let src = source(&d, "t.parquet", b"one");
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    let a = create_backup(&p, &lock, || Ok(()), &Options::default()).unwrap();
    fs::write(&src, b"two").unwrap();
    let b = create_backup(&p, &lock, || Ok(()), &Options::default()).unwrap();
    assert_ne!(a.path, b.path);
    assert_eq!(fs::read(&a.path).unwrap(), b"one");
    assert_eq!(fs::read(&b.path).unwrap(), b"two");
    assert_eq!(backups(&d).len(), 2);
}

#[test]
fn a_failed_flush_or_inapplicable_format_makes_no_file() {
    let d = Dir::new("flush");
    let src = source(&d, "t.db", b"data");
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    assert!(
        matches!(create_backup(&p, &lock, || Err("checkpoint failed".into()), &Options::default()), Err(BackupError::Flush(m)) if m == "checkpoint failed")
    );
    let o = Options {
        applicable: false,
        ..Options::default()
    };
    assert!(matches!(
        create_backup(
            &p,
            &lock,
            || unreachable!("no flush for read-only formats"),
            &o
        ),
        Err(BackupError::NotApplicable)
    ));
    assert!(backups(&d).is_empty() && leftovers(&d).is_empty());
}

#[test]
fn oversized_and_missing_sources_are_refused_before_any_copy() {
    let d = Dir::new("big");
    let src = source(&d, "big.csv", &[7u8; 100]);
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    let o = Options {
        max_bytes: 99,
        ..Options::default()
    };
    assert!(matches!(
        create_backup(&p, &lock, || Ok(()), &o),
        Err(BackupError::TooLarge {
            length: 100,
            max: 99
        })
    ));
    fs::remove_file(&src).unwrap();
    assert!(create_backup(&p, &lock, || Ok(()), &Options::default()).is_err());
    assert!(backups(&d).is_empty() && leftovers(&d).is_empty());
}

#[test]
fn the_source_lock_is_held_across_the_backup_and_a_second_writer_is_refused() {
    let d = Dir::new("lock");
    let src = source(&d, "t.csv", b"a,b\n1,2\n");
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    let other = p.lock(&src).err().expect("second writer refused");
    assert_eq!(other.kind, Kind::Locked);
    create_backup(
        &p,
        &lock,
        || {
            // still locked inside the flush, i.e. while the snapshot is being prepared
            assert_eq!(p.lock(&src).err().unwrap().kind, Kind::Locked);
            Ok(())
        },
        &Options::default(),
    )
    .unwrap();
    // and still held afterwards, so the save that follows needs no second acquisition
    assert_eq!(p.lock(&src).err().unwrap().kind, Kind::Locked);
    drop(lock);
    assert!(p.lock(&src).is_ok());
}

#[test]
fn an_unwritable_directory_fails_and_leaves_nothing_behind() {
    if unsafe { libc_geteuid() } == 0 {
        return;
    } // root ignores directory permissions
    let d = Dir::new("ro");
    let sub = d.0.join("locked");
    fs::create_dir(&sub).unwrap();
    let src = sub.join("t.csv");
    fs::write(&src, b"x").unwrap();
    let p = Publisher::new(&d.0.join("receipts"), Protection::default()).unwrap();
    let lock = p.lock(&src).unwrap();
    fs::set_permissions(&sub, fs::Permissions::from_mode(0o500)).unwrap();
    let r = create_backup(&p, &lock, || Ok(()), &Options::default());
    fs::set_permissions(&sub, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(r, Err(BackupError::Publish(_))), "{r:?}");
    let names: Vec<_> = fs::read_dir(&sub)
        .unwrap()
        .filter(|e| !is_writer_lock(&e.as_ref().unwrap().path()))
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 1, "only the source remains: {names:?}");
}
unsafe extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}

#[test]
fn tampering_or_deleting_the_backup_is_detected_before_a_diff_trusts_it() {
    let d = Dir::new("tamper");
    let src = source(&d, "t.csv", b"abc");
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    let b = create_backup(&p, &lock, || Ok(()), &Options::default()).unwrap();
    assert!(b.intact());
    fs::write(&b.path, b"abd").unwrap();
    assert!(!b.intact());
    fs::remove_file(&b.path).unwrap();
    assert!(!b.intact());
}

#[test]
fn safe_mode_stays_on_when_the_backup_fails_and_turns_off_when_it_works() {
    let d = Dir::new("mode");
    let src = source(&d, "t.csv", b"abc");
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    let mut m = SafeMode::default();
    assert!(m.enabled() && !m.edits_allowed());
    let failed = m.turn_off(|| create_backup(&p, &lock, || Err("no".into()), &Options::default()));
    assert!(failed.is_err());
    assert!(
        m.enabled() && !m.edits_allowed() && !m.has_backup(),
        "a failed backup must not drop the protection"
    );
    let ok = m
        .turn_off(|| create_backup(&p, &lock, || Ok(()), &Options::default()))
        .unwrap();
    assert!(ok.is_some() && !m.enabled() && m.edits_allowed() && m.has_backup());
    assert!(m.should_auto_diff(10, 10) && !m.should_auto_diff(11, 10));
    assert!(
        m.turn_on(),
        "re-locking with a backup asks for the comparison"
    );
    assert!(!m.turn_on(), "already on: nothing to compare");

    let mut skip = SafeMode::default();
    skip.backup_before_write = false;
    assert!(
        skip.turn_off(|| unreachable!()).unwrap().is_none()
            && !skip.enabled()
            && !skip.has_backup()
    );
    assert!(!skip.turn_on(), "no backup, no comparison");
    let mut quiet = SafeMode::default();
    quiet.check_for_changes = false;
    quiet
        .turn_off(|| create_backup(&p, &lock, || Ok(()), &Options::default()))
        .unwrap();
    assert!(!quiet.should_auto_diff(1, 10) && !quiet.turn_on());
}

#[test]
fn safe_mode_rejects_nondurable_or_already_corrupted_backups() {
    let d = Dir::new("unverified");
    let src = source(&d, "t.csv", b"original");
    let p = publisher(&d);
    let lock = p.lock(&src).unwrap();
    for corrupt in [false, true] {
        let mut backup = create_backup(&p, &lock, || Ok(()), &Options::default()).unwrap();
        if corrupt {
            fs::write(&backup.path, b"changed").unwrap();
        } else {
            backup.receipt.durable = false;
        }
        let mut mode = SafeMode::default();
        assert!(mode.turn_off(|| Ok(backup)).is_err());
        assert!(mode.enabled() && !mode.edits_allowed() && !mode.has_backup());
    }
}

#[test]
fn local_stamp_is_fifteen_chars() {
    let s = local_stamp(0);
    assert_eq!(s.len(), 15);
    let _ = Path::new(&s);
}
