//! Safe Mode backup: a verified, never-partial sibling copy of the source, published through the publication crate.
use dfv_table_publication::{
    PublishError, Publisher, Receipt, SourceState, WriterLock, digest_reader, verify_file,
};
use std::fs;
use std::io::{Read, Seek};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum BackupError {
    /// Read-only formats (including kdb+, Stata and MATLAB) have no edit/backup workflow.
    NotApplicable,
    /// The caller's flush (checkpoint) failed; nothing was copied.
    Flush(String),
    /// The source changed while it was being read, so the bytes would not be a consistent snapshot.
    SourceChanged,
    /// Safe Mode cannot trust a non-durable, missing or modified backup.
    Unverified,
    TooLarge {
        length: u64,
        max: u64,
    },
    Io(String),
    Publish(PublishError),
}
impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotApplicable => write!(f, "Safe Mode isn't applicable to a read-only table."),
            Self::Flush(m) => write!(f, "flush before backup failed: {m}"),
            Self::SourceChanged => write!(f, "the source changed while the backup was read"),
            Self::Unverified => write!(
                f,
                "the backup is not durable and intact; Safe Mode stays on"
            ),
            Self::TooLarge { length, max } => {
                write!(f, "source is {length} bytes; the backup limit is {max}")
            }
            Self::Io(m) => write!(f, "{m}"),
            Self::Publish(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for BackupError {}
impl From<PublishError> for BackupError {
    fn from(e: PublishError) -> Self {
        Self::Publish(e)
    }
}
fn io(e: std::io::Error) -> BackupError {
    BackupError::Io(e.to_string())
}

pub struct Options {
    /// False for read-only formats.
    pub applicable: bool,
    /// Largest source eligible for a streaming backup.
    pub max_bytes: u64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            applicable: true,
            max_bytes: 2 << 30,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Backup {
    pub path: PathBuf,
    pub length: u64,
    pub sha256: String,
    /// The source as it was when read; a later change to the source is expected, a change during the read is refused.
    pub source: SourceState,
    pub receipt: Receipt,
}
impl Backup {
    /// The backup still holds exactly the bytes that were published; a diff against a modified or missing backup is wrong.
    pub fn intact(&self) -> bool {
        verify_file(&self.path, self.length, &self.sha256).is_ok()
    }
}

/// `YYYYMMDD-HHMMSS` in local time, like the TS `formatTimestamp`.
pub fn local_stamp(epoch_secs: i64) -> String {
    // SAFETY: `tm` is zeroed plain data and both pointers are valid for the call.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        let t: libc::time_t = epoch_secs as libc::time_t;
        libc::localtime_r(&t, &mut tm);
        tm
    };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

pub fn backup_path(source: &Path, stamp: &str, nonce: [u8; 4]) -> PathBuf {
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let base = source.file_stem().unwrap_or_default().to_string_lossy();
    let hex: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    source.with_file_name(format!("{base}.backup-{stamp}-{hex}{ext}"))
}

/// Takes the backup. `source_lock` is the writer lock the caller keeps for the whole edit-and-save, so no save can start
/// or finish between the flush and the copy and no other writer can interleave.
pub fn create_backup(
    publisher: &Publisher,
    source_lock: &WriterLock,
    flush: impl FnOnce() -> Result<(), String>,
    options: &Options,
) -> Result<Backup, BackupError> {
    create_backup_from(publisher, source_lock, source_lock.target(), flush, options)
}

/// Publish a private format-consistent snapshot while fencing changes to the original source.
pub fn create_backup_from(
    publisher: &Publisher,
    source_lock: &WriterLock,
    snapshot: &Path,
    flush: impl FnOnce() -> Result<(), String>,
    options: &Options,
) -> Result<Backup, BackupError> {
    if !options.applicable {
        return Err(BackupError::NotApplicable);
    }
    let source = source_lock.target();
    flush().map_err(BackupError::Flush)?;
    let before = SourceState::capture(source)?;
    let mut source_file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(snapshot)
        .map_err(io)?;
    let metadata = source_file.metadata().map_err(io)?;
    if !metadata.is_file() {
        return Err(BackupError::SourceChanged);
    }
    let length = metadata.len();
    let source_mode = metadata.permissions().mode() & 0o7777;
    if length > options.max_bytes {
        return Err(BackupError::TooLarge {
            length,
            max: options.max_bytes,
        });
    }
    let sha256 = digest_reader(&mut source_file, length)?;
    source_file.rewind().map_err(io)?;
    if SourceState::capture(source)? != before {
        return Err(BackupError::SourceChanged);
    }
    let mut nonce = [0u8; 4];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut nonce))
        .map_err(io)?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let path = backup_path(source, &local_stamp(secs), nonce);
    // The name must be new (the TS copies with COPYFILE_EXCL): expecting "absent" makes publish refuse if it appears first.
    let expected = SourceState::capture(&path)?;
    let lock = publisher.lock(&path)?;
    let receipt = publisher.publish_reader(&lock, source_file, length, &sha256, Some(&expected))?;
    if SourceState::capture(source)? != before {
        return Err(BackupError::SourceChanged);
    }
    // Mirror the source's mode so a locked-down file does not get a more permissive copy; best effort, as in the TS.
    if let Ok(mut copy) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(&path)
        && copy
            .metadata()
            .is_ok_and(|m| m.is_file() && m.nlink() == 1 && m.len() == length)
        && digest_reader(&mut copy, length).is_ok_and(|sha| sha == sha256)
    {
        let _ = copy.set_permissions(fs::Permissions::from_mode(source_mode));
    }
    Ok(Backup {
        path,
        length,
        sha256,
        source: before,
        receipt,
    })
}
