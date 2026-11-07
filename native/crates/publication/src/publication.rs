//! Atomic sibling-staged replace with a durable, restart-safe receipt.
//!
//! Approach (D0.4's atomic-write library is not accepted, so this uses std + libc only): hold a per-target advisory
//! writer lock (`flock`, released by the kernel if the process dies), record a durable *pending* intent, stage a sibling
//! file, flush and independently verify it, then atomically create or swap the destination. Verify the displaced
//! original before removing it; preserve unexpected contents for recovery. Flush the directory and finalize the receipt.
//! `status` inspects both the destination and any displaced file instead of trusting the record alone.
#[cfg(not(unix))]
compile_error!("publication is qualified on unix only (identity, flock and O_NOFOLLOW checks)");

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Refused,
    Locked,
    DiskFull,
    Io,
    Changed,
    Mismatch,
    /// The destination may or may not hold the new bytes; `status` decides after inspection.
    Unconfirmed,
}
#[derive(Debug)]
pub struct PublishError {
    pub kind: Kind,
    pub reason: &'static str,
    pub message: String,
    /// Present if publication may have happened; use `Publisher::status` instead of replaying the write.
    pub receipt_id: Option<String>,
}
impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}/{}: {}", self.kind, self.reason, self.message)
    }
}
impl std::error::Error for PublishError {}
fn err(kind: Kind, reason: &'static str, message: &str) -> PublishError {
    PublishError {
        kind,
        reason,
        message: message.to_owned(),
        receipt_id: None,
    }
}
fn io(error: std::io::Error) -> PublishError {
    // ENOSPC is 28 everywhere; EDQUOT is 69 on macOS and 122 on Linux.
    let full = matches!(error.raw_os_error(), Some(28 | 69 | 122));
    if full {
        err(Kind::DiskFull, "disk_full", "The disk or quota is full.")
    } else {
        PublishError {
            kind: Kind::Io,
            reason: "io_failed",
            message: error.to_string(),
            receipt_id: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    device: u64,
    inode: u64,
}
impl Identity {
    pub fn of(m: &Metadata) -> Self {
        Self {
            device: m.dev(),
            inode: m.ino(),
        }
    }
}

/// What the caller saw when it read the destination; `publish` refuses if the file changed since.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceState(Option<(Identity, u64, Option<std::time::SystemTime>, i64, i64)>);
impl SourceState {
    pub fn capture(path: &Path) -> Result<Self, PublishError> {
        match fs::symlink_metadata(path) {
            Ok(m) if !m.is_file() => Err(err(
                Kind::Refused,
                "destination_type",
                "The destination is not a regular file.",
            )),
            Ok(m) => Ok(Self(Some((
                Identity::of(&m),
                m.len(),
                m.modified().ok(),
                m.ctime(),
                m.ctime_nsec(),
            )))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self(None)),
            Err(e) => Err(io(e)),
        }
    }
}

/// Destinations that must never be replaced (open documents, working copies, backups).
#[derive(Default)]
pub struct Protection {
    pub paths: Vec<PathBuf>,
    pub identities: Vec<Identity>,
}
impl Protection {
    // shortcut: no recursive scan of protected directories for hardlinks into them, add if a protected tree can hold user-linked files.
    pub fn check(&self, target: &Path) -> Result<(), PublishError> {
        let protected = || {
            err(
                Kind::Refused,
                "protected_destination",
                "That destination belongs to protected storage.",
            )
        };
        let id = fs::metadata(target).ok().map(|m| Identity::of(&m));
        if id.is_some_and(|id| self.identities.contains(&id)) {
            return Err(protected());
        }
        for path in &self.paths {
            let Ok(m) = fs::metadata(path) else { continue };
            let real = canonical(path)?;
            if target == path
                || target == real
                || (m.is_dir() && target.starts_with(&real))
                || id == Some(Identity::of(&m))
            {
                return Err(protected());
            }
        }
        Ok(())
    }
}

pub fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Hash exactly the expected input length without buffering it or following a growing stream.
pub fn digest_reader(reader: impl Read, length: u64) -> Result<String, PublishError> {
    let mut reader = reader.take(length.saturating_add(1));
    let (mut hash, mut total, mut buf) = (Sha256::new(), 0u64, [0u8; 65536]);
    loop {
        let n = reader.read(&mut buf).map_err(io)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hash.update(&buf[..n]);
    }
    if total != length {
        return Err(err(
            Kind::Mismatch,
            "input_length_changed",
            "The input length changed while it was read.",
        ));
    }
    Ok(hex(&hash.finalize()))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads `path` without following links or blocking on FIFOs and checks length and SHA-256 independently of the writer.
pub fn verify_file(path: &Path, length: u64, sha256: &str) -> Result<(), PublishError> {
    verified_metadata(path, length, sha256).map(|_| ())
}

fn verified_metadata(path: &Path, length: u64, sha256: &str) -> Result<Metadata, PublishError> {
    let mismatch = || {
        err(
            Kind::Mismatch,
            "verify_failed",
            "The file does not match the verified bytes.",
        )
    };
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .map_err(io)?;
    let before = file.metadata().map_err(io)?;
    if !before.is_file() || before.len() != length {
        return Err(mismatch());
    }
    let (mut hash, mut total, mut buf) = (Sha256::new(), 0u64, [0u8; 65536]);
    loop {
        let n = file.read(&mut buf).map_err(io)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > length {
            return Err(mismatch());
        }
        hash.update(&buf[..n]);
    }
    let after = file.metadata().map_err(io)?;
    let named = fs::symlink_metadata(path).map_err(io)?;
    if total != length
        || hex(&hash.finalize()) != sha256
        || Identity::of(&after) != Identity::of(&named)
        || !named.is_file()
        || after.len() != length
        || before.modified().ok() != after.modified().ok()
    {
        return Err(mismatch());
    }
    Ok(after)
}

// Fault hooks exist only in the explicit test build; production ignores all test env.
fn checkpoint(stage: &str) -> Result<(), PublishError> {
    #[cfg(feature = "test-mutations")]
    if let Ok(fault) = std::env::var("DFV_TEST_PUBLICATION_FAULT") {
        if fault == format!("pause:{stage}") {
            eprintln!("PUB_TEST checkpoint {stage}");
            let ms = std::env::var("DFV_TEST_PUBLICATION_PAUSE_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(15_000);
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        if fault == format!("fail:{stage}") {
            return Err(io(std::io::Error::other("Injected publication failure")));
        }
        if fault == format!("disk_full:{stage}") {
            return Err(io(std::io::Error::from_raw_os_error(28)));
        }
    }
    let _ = stage;
    Ok(())
}

/// Resolved destination: canonical parent plus file name; a symbolic-link destination is refused.
fn canonical(path: &Path) -> Result<PathBuf, PublishError> {
    let path = fs::canonicalize(path).map_err(io)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        // realpath preserves a caller's case on APFS; the descriptor reports the stored spelling.
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(path)
            .map_err(io)?;
        let mut bytes = [0u8; libc::PATH_MAX as usize];
        // SAFETY: the descriptor is owned here and the kernel receives a PATH_MAX-sized output buffer.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, bytes.as_mut_ptr()) } == -1 {
            return Err(io(std::io::Error::last_os_error()));
        }
        let end = bytes.iter().position(|b| *b == 0).ok_or_else(|| {
            err(
                Kind::Refused,
                "destination_path",
                "The destination path is too long.",
            )
        })?;
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end])))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(path)
    }
}

fn resolve(target: &Path) -> Result<PathBuf, PublishError> {
    let absolute = if target.is_absolute() {
        target.to_path_buf()
    } else {
        std::env::current_dir().map_err(io)?.join(target)
    };
    let name = absolute
        .file_name()
        .ok_or_else(|| err(Kind::Refused, "destination_name", "Give a file name."))?;
    let parent = canonical(
        absolute
            .parent()
            .ok_or_else(|| err(Kind::Refused, "destination_name", "No parent directory."))?,
    )?;
    let resolved = parent.join(name);
    if fs::symlink_metadata(&resolved).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(err(
            Kind::Refused,
            "destination_symlink",
            "Choose a destination that is not a symbolic link.",
        ));
    }
    if fs::symlink_metadata(&resolved).is_ok() {
        canonical(&resolved)
    } else {
        Ok(resolved)
    }
}

/// Exclusive writer lock for one destination. Hold it across the whole save (edit → publish → receipt).
pub struct WriterLock {
    _file: File,
    target: PathBuf,
}
impl WriterLock {
    pub fn target(&self) -> &Path {
        &self.target
    }
}
impl Drop for WriterLock {
    fn drop(&mut self) {
        // A forked child can retain the open file description until its next exec.
        // SAFETY: this guard owns the successfully locked descriptor until drop completes.
        unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
    }
}

pub struct Publisher {
    receipts: PathBuf,
    protection: Protection,
    reserved_id: Option<String>,
    reserved_used: AtomicBool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub id: String,
    /// False when the directory flush failed: the verified copy is in place but may not survive power loss.
    pub durable: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// No record under that id.
    Absent,
    /// A run began but the destination still holds what it held before.
    NotPublished,
    /// The destination holds the new bytes; `finalized` is false if the process died before the receipt was written.
    Published {
        finalized: bool,
        /// A finalized receipt explicitly recorded a successful destination-directory flush.
        durable: bool,
    },
    /// Outcome is uncertain, including an unreadable record or a concurrent file retained for recovery.
    Unconfirmed,
}

/// Details returned only after the publication record, destination and any displaced original agree.
pub struct PublishedDetails {
    pub receipt: Receipt,
    pub finalized: bool,
    pub target: PathBuf,
    pub length: u64,
    pub sha256: String,
    pub mtime_ns: u128,
    pub original: Option<(u64, String)>,
}

fn write_atomic(dir: &Path, name: &str, value: &Value) -> Result<(), PublishError> {
    write_record(dir, name, value, false)
}

fn write_record(dir: &Path, name: &str, value: &Value, create: bool) -> Result<(), PublishError> {
    let tmp = dir.join(format!(".{name}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(io)?;
    let _owned_tmp = Staging(tmp.clone(), Identity::of(&file.metadata().map_err(io)?));
    file.write_all(value.to_string().as_bytes()).map_err(io)?;
    file.sync_all().map_err(io)?;
    if create {
        fs::hard_link(&tmp, dir.join(name)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                err(
                    Kind::Refused,
                    "receipt_id_used",
                    "This publication id has already been used.",
                )
            } else {
                io(e)
            }
        })?;
        fs::remove_file(&tmp).map_err(io)?;
    } else {
        fs::rename(&tmp, dir.join(name)).map_err(io)?;
    }
    File::open(dir).and_then(|d| d.sync_all()).map_err(io)
}
fn random_id() -> Result<String, PublishError> {
    let mut b = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(io)?;
    Ok(hex(&b))
}
fn valid_sha(sha: &str) -> bool {
    sha.len() == 64
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn file_sha(path: &Path) -> Option<(u64, String)> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() {
        return None;
    }
    let length = before.len();
    let sha = digest_reader(&mut file, length).ok()?;
    let after = file.metadata().ok()?;
    let named = fs::symlink_metadata(path).ok()?;
    if after.len() != length
        || !named.is_file()
        || Identity::of(&before) != Identity::of(&named)
        || before.modified().ok() != after.modified().ok()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return None;
    }
    Some((length, sha))
}

fn exchange(first: &Path, second: &Path) -> Result<(), PublishError> {
    use std::os::unix::ffi::OsStrExt;
    let first = std::ffi::CString::new(first.as_os_str().as_bytes()).map_err(|_| {
        err(
            Kind::Refused,
            "destination_path",
            "Invalid destination path.",
        )
    })?;
    let second = std::ffi::CString::new(second.as_os_str().as_bytes()).map_err(|_| {
        err(
            Kind::Refused,
            "destination_path",
            "Invalid destination path.",
        )
    })?;
    // SAFETY: both C strings live through the call. Swap retains the displaced file for verification.
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(first.as_ptr(), second.as_ptr(), libc::RENAME_SWAP) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            first.as_ptr(),
            libc::AT_FDCWD,
            second.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(err(
        Kind::Refused,
        "atomic_exchange_unsupported",
        "Atomic replacement is not supported on this platform.",
    ));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if result == 0 {
        Ok(())
    } else {
        Err(io(std::io::Error::last_os_error()))
    }
}

fn verify_original(path: &Path, id: Identity, length: u64, sha: &str) -> Result<(), PublishError> {
    let m = fs::symlink_metadata(path).map_err(io)?;
    if !m.is_file() || m.nlink() != 1 || Identity::of(&m) != id {
        return Err(err(
            Kind::Changed,
            "displaced_source_changed",
            "The displaced file was not the expected original.",
        ));
    }
    verify_file(path, length, sha)
}

struct Staging(PathBuf, Identity);
impl Drop for Staging {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.0).is_ok_and(|m| Identity::of(&m) == self.1) {
            let _ = fs::remove_file(&self.0);
        }
    }
}
/// Removes the pending intent unless a publication syscall may have changed the destination.
struct Intent(PathBuf, bool);
impl Drop for Intent {
    fn drop(&mut self) {
        if self.1 {
            let _ = fs::remove_file(&self.0);
        }
    }
}

impl Publisher {
    pub fn new(receipts: &Path, protection: Protection) -> Result<Self, PublishError> {
        fs::create_dir_all(receipts).map_err(io)?;
        Ok(Self {
            receipts: canonical(receipts)?,
            protection,
            reserved_id: None,
            reserved_used: AtomicBool::new(false),
        })
    }

    /// Bind a single staged publication to a mutation whose durable ledger records this id before calling a writer.
    pub fn reserve(mut self) -> Result<(Self, String), PublishError> {
        if self.reserved_id.is_some() {
            return Err(err(
                Kind::Refused,
                "receipt_id_used",
                "This publisher already has a reserved id.",
            ));
        }
        let id = random_id()?;
        self.reserved_id = Some(id.clone());
        Ok((self, id))
    }

    // Keep the zero-byte sibling lock: unlinking it could let another host lock a different inode.
    pub fn lock(&self, target: &Path) -> Result<WriterLock, PublishError> {
        let target = resolve(target)?;
        let path = target
            .parent()
            .ok_or_else(|| err(Kind::Refused, "destination_name", "No parent directory."))?
            .join(format!(
                ".dfv-table-lock-{}",
                digest(target.as_os_str().as_encoded_bytes())
            ));
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(path)
            .map_err(io)?;
        let metadata = file.metadata().map_err(io)?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(err(
                Kind::Refused,
                "writer_lock_type",
                "Writer lock is not a private regular file.",
            ));
        }
        // SAFETY: the descriptor is owned by `file` for the whole call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let e = std::io::Error::last_os_error();
            return Err(if e.kind() == std::io::ErrorKind::WouldBlock {
                err(
                    Kind::Locked,
                    "writer_locked",
                    "Another writer is saving this file.",
                )
            } else {
                io(e)
            });
        }
        Ok(WriterLock {
            _file: file,
            target,
        })
    }

    /// Replaces the destination with `bytes`. `expected` is the state the caller read the destination in; `None` skips that check.
    pub fn publish(
        &self,
        lock: &WriterLock,
        bytes: &[u8],
        expected: Option<&SourceState>,
    ) -> Result<Receipt, PublishError> {
        self.publish_reader(lock, bytes, bytes.len() as u64, &digest(bytes), expected)
    }

    /// Stream a previously hashed input into private staging; mismatched length/hash never publishes.
    pub fn publish_reader(
        &self,
        lock: &WriterLock,
        reader: impl Read,
        length: u64,
        sha: &str,
        expected: Option<&SourceState>,
    ) -> Result<Receipt, PublishError> {
        if sha.len() != 64
            || !sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(err(
                Kind::Refused,
                "input_digest",
                "A valid input SHA-256 is required.",
            ));
        }
        let target = lock.target();
        let target_text = target.to_str().ok_or_else(|| {
            err(
                Kind::Refused,
                "destination_encoding",
                "The destination filename cannot be represented by the save protocol.",
            )
        })?;
        if resolve(target)?.as_path() != target {
            return Err(err(
                Kind::Changed,
                "destination_alias_changed",
                "The destination's canonical name changed; acquire a fresh writer lock.",
            ));
        }
        self.protection.check(target)?;
        let parent = target
            .parent()
            .ok_or_else(|| err(Kind::Refused, "destination_name", "No parent directory."))?;
        let parent_id = Identity::of(&fs::metadata(parent).map_err(io)?);
        let initial = SourceState::capture(target)?;
        let existing = fs::metadata(target).ok();
        if existing.as_ref().is_some_and(|m| m.nlink() > 1) {
            // Replacing by rename would silently detach every other name for the file.
            return Err(err(
                Kind::Refused,
                "destination_hardlinked",
                "The destination has other hard links; replacing it would detach them.",
            ));
        }
        if expected.is_some_and(|e| *e != initial) {
            return Err(err(
                Kind::Changed,
                "source_changed",
                "The file changed since it was read; it was left untouched.",
            ));
        }
        let original = file_sha(target);
        if initial.0.is_some() && original.is_none() {
            return Err(err(
                Kind::Changed,
                "original_unverifiable",
                "The original could not be verified; it was left untouched.",
            ));
        }
        let id = if let Some(id) = &self.reserved_id {
            if self.reserved_used.swap(true, Ordering::SeqCst) {
                return Err(err(
                    Kind::Refused,
                    "receipt_id_used",
                    "This publication id has already been used.",
                ));
            }
            id.clone()
        } else {
            random_id()?
        };
        let name = format!("{id}.json");
        let original_id = initial.0.as_ref().map(|s| s.0);
        let staging_path = parent.join(format!(
            ".dfv-table-{}-{}.tmp",
            std::process::id(),
            &id[..16]
        ));
        let record = |state: &str, durable: bool| {
            json!({"format":"dfv-table-publication","version":1,"id":id,"state":state,"target":target_text,
            "staging":staging_path.to_str(),"length":length,"sha256":sha,"durable":durable,
            "original":original.as_ref().map(|(l,s)| json!({"length":l,"sha256":s,"identity":original_id.map(|i| [i.device.to_string(),i.inode.to_string()])}))})
        };
        write_record(&self.receipts, &name, &record("pending", false), true)?;
        let mut intent = Intent(self.receipts.join(&name), true);

        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staging_path)
            .map_err(io)?;
        let staging = Staging(
            staging_path.clone(),
            Identity::of(&file.metadata().map_err(io)?),
        );
        checkpoint("before_write")?;
        let mut reader = reader.take(length.saturating_add(1));
        let (mut total, mut buf) = (0u64, [0u8; 65536]);
        loop {
            let n = reader.read(&mut buf).map_err(io)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > length {
                return Err(err(
                    Kind::Mismatch,
                    "input_length_changed",
                    "The input grew before publication.",
                ));
            }
            file.write_all(&buf[..n]).map_err(io)?;
        }
        if total != length {
            return Err(err(
                Kind::Mismatch,
                "input_length_changed",
                "The input was truncated before publication.",
            ));
        }
        checkpoint("after_write")?;
        file.sync_all().map_err(io)?;
        checkpoint("after_flush")?;
        verify_file(&staging.0, length, sha)?;
        checkpoint("after_verify")?;
        checkpoint("before_rename")?;
        // The final fault boundary must precede revalidation, never sit between it and publication.
        if !fs::symlink_metadata(&staging.0)
            .is_ok_and(|m| m.is_file() && Identity::of(&m) == staging.1)
        {
            return Err(err(
                Kind::Changed,
                "staging_changed",
                "The staged file was replaced; nothing was published.",
            ));
        }
        verify_file(&staging.0, length, sha)?;
        self.protection.check(target)?;
        if Identity::of(&fs::metadata(parent).map_err(io)?) != parent_id
            || SourceState::capture(target)? != initial
        {
            return Err(err(
                Kind::Changed,
                "destination_changed",
                "The destination changed while the copy was staged; it was left untouched.",
            ));
        }
        if let Some(m) = &existing {
            file.set_permissions(fs::Permissions::from_mode(m.mode() & 0o7777))
                .map_err(io)?;
        }
        if initial.0.is_none() {
            checkpoint("before_new_link")?;
            intent.1 = false;
            match fs::hard_link(&staging.0, target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    intent.1 = true;
                    return Err(err(
                        Kind::Changed,
                        "destination_appeared",
                        "Another file appeared at the destination; it was left untouched.",
                    ));
                }
                Err(e) => return Err(unconfirmed(io(e), &id)),
            }
            fs::remove_file(&staging.0).map_err(|e| unconfirmed(io(e), &id))?;
        } else {
            checkpoint("before_exchange")?;
            intent.1 = false;
            exchange(&staging.0, target).map_err(|e| unconfirmed(e, &id))?;
            checkpoint("after_exchange").map_err(|e| unconfirmed(e, &id))?;
            let (old_length, old_sha) = original.as_ref().expect("verified existing original");
            if verify_original(
                &staging.0,
                original_id.expect("existing identity"),
                *old_length,
                old_sha,
            )
            .is_err()
            {
                let _ = write_atomic(&self.receipts, &name, &record("conflict", false));
                let _ = File::open(parent).and_then(|d| d.sync_all());
                return Err(unconfirmed(
                    err(
                        Kind::Changed,
                        "displaced_source_changed",
                        &format!(
                            "The destination changed during publication. Its displaced contents were preserved at {}.",
                            staging.0.display()
                        ),
                    ),
                    &id,
                ));
            }
            fs::remove_file(&staging.0).map_err(|e| unconfirmed(io(e), &id))?;
        }
        checkpoint("after_rename").map_err(|e| unconfirmed(e, &id))?;
        // A replaced or tampered destination must never acquire a receipt.
        verify_file(target, length, sha).map_err(|e| unconfirmed(e, &id))?;
        let durable = File::open(parent).and_then(|d| d.sync_all()).is_ok()
            && checkpoint("directory_flush").is_ok();
        checkpoint("after_parent_flush").map_err(|e| unconfirmed(e, &id))?;
        checkpoint("before_receipt").map_err(|e| unconfirmed(e, &id))?;
        write_atomic(&self.receipts, &name, &record("published", durable))
            .map_err(|e| unconfirmed(e, &id))?;
        checkpoint("after_receipt").map_err(|e| unconfirmed(e, &id))?;
        Ok(Receipt { id, durable })
    }

    /// Resolves a run (also after a crash) by inspecting the destination.
    pub fn status(&self, id: &str) -> Status {
        match self.inspect(id) {
            Ok(published) => Status::Published {
                finalized: published.finalized,
                durable: published.receipt.durable,
            },
            Err(status) => status,
        }
    }

    /// The same checked observation as status, including the data needed to reconstruct a lost mutation receipt.
    pub fn inspect(&self, id: &str) -> Result<PublishedDetails, Status> {
        self.inspect_matching(id, |_, _| true)
    }

    /// Applies a caller's durable mutation binding before proving either publication or non-publication.
    pub fn inspect_matching(
        &self,
        id: &str,
        matches: impl FnOnce(&Path, Option<(u64, &str)>) -> bool,
    ) -> Result<PublishedDetails, Status> {
        if !valid_id(id) {
            return Err(Status::Absent);
        }
        const MAX_RECEIPT_BYTES: u64 = 64 << 10;
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(self.receipts.join(format!("{id}.json")))
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Status::Absent),
            Err(_) => return Err(Status::Unconfirmed),
        };
        if !file
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() <= MAX_RECEIPT_BYTES)
        {
            return Err(Status::Unconfirmed);
        }
        let mut text = String::new();
        if file
            .take(MAX_RECEIPT_BYTES + 1)
            .read_to_string(&mut text)
            .is_err()
            || text.len() as u64 > MAX_RECEIPT_BYTES
        {
            return Err(Status::Unconfirmed);
        }
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            return Err(Status::Unconfirmed);
        };
        if v["format"] != "dfv-table-publication"
            || v["version"] != 1
            || v["id"] != id
            || !matches!(v["state"].as_str(), Some("pending" | "published"))
            || !v["durable"].is_boolean()
            || v.get("original").is_none()
        {
            return Err(Status::Unconfirmed);
        }
        let (Some(target), Some(length), Some(sha), Some(state)) = (
            v["target"].as_str(),
            v["length"].as_u64(),
            v["sha256"].as_str(),
            v["state"].as_str(),
        ) else {
            return Err(Status::Unconfirmed);
        };
        let target = Path::new(target);
        if !target.is_absolute() || !valid_sha(sha) {
            return Err(Status::Unconfirmed);
        }
        let original = match &v["original"] {
            Value::Null => None,
            original => {
                let (Some(length), Some(sha)) =
                    (original["length"].as_u64(), original["sha256"].as_str())
                else {
                    return Err(Status::Unconfirmed);
                };
                if !valid_sha(sha) {
                    return Err(Status::Unconfirmed);
                }
                Some((length, sha))
            }
        };
        if !matches(target, original) {
            return Err(Status::Unconfirmed);
        }
        if let Ok(metadata) = verified_metadata(target, length, sha) {
            if let Some(staging) = v["staging"].as_str() {
                match fs::symlink_metadata(staging) {
                    Ok(_) => {
                        let o = &v["original"];
                        let identity =
                            o["identity"]
                                .as_array()
                                .filter(|a| a.len() == 2)
                                .and_then(|a| {
                                    Some(Identity {
                                        device: a[0].as_str()?.parse().ok()?,
                                        inode: a[1].as_str()?.parse().ok()?,
                                    })
                                });
                        let Some(id) = identity else {
                            return Err(Status::Unconfirmed);
                        };
                        if verify_original(
                            Path::new(staging),
                            id,
                            o["length"].as_u64().unwrap_or(u64::MAX),
                            o["sha256"].as_str().unwrap_or(""),
                        )
                        .is_err()
                        {
                            return Err(Status::Unconfirmed);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(Status::Unconfirmed),
                }
            }
            return Ok(PublishedDetails {
                receipt: Receipt {
                    id: id.to_owned(),
                    durable: state == "published" && v["durable"] == true,
                },
                finalized: state == "published",
                target: target.to_owned(),
                length,
                sha256: sha.to_owned(),
                mtime_ns: metadata
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos()),
                original: original.map(|(length, sha)| (length, sha.to_owned())),
            });
        }
        let unchanged = match (&v["original"], fs::symlink_metadata(target)) {
            (Value::Null, Err(e)) => e.kind() == std::io::ErrorKind::NotFound,
            (o, Ok(_)) if o.is_object() => verify_file(
                target,
                o["length"].as_u64().unwrap_or(u64::MAX),
                o["sha256"].as_str().unwrap_or(""),
            )
            .is_ok(),
            _ => false,
        };
        if state == "pending" && unchanged {
            Err(Status::NotPublished)
        } else {
            Err(Status::Unconfirmed)
        }
    }
}
fn unconfirmed(e: PublishError, id: &str) -> PublishError {
    PublishError {
        kind: Kind::Unconfirmed,
        reason: "publication_unconfirmed",
        message: e.message,
        receipt_id: Some(id.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_ids_are_single_use_and_cannot_overwrite_receipts() {
        let dir = std::env::temp_dir().join(format!("dfv-reserved-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let (publisher, id) = Publisher::new(&dir.join("receipts"), Protection::default())
            .unwrap()
            .reserve()
            .unwrap();
        let target = dir.join("saved.bin");
        let lock = publisher.lock(&target).unwrap();
        assert_eq!(publisher.publish(&lock, b"first", None).unwrap().id, id);
        let receipt = fs::read(dir.join("receipts").join(format!("{id}.json"))).unwrap();
        assert!(publisher.publish(&lock, b"second", None).is_err());
        publisher.reserved_used.store(false, Ordering::SeqCst);
        assert!(publisher.publish(&lock, b"collision", None).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"first");
        assert_eq!(
            fs::read(dir.join("receipts").join(format!("{id}.json"))).unwrap(),
            receipt
        );
        drop(lock);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn new_and_replacement_publications_work_in_the_default_build() {
        let dir =
            std::env::temp_dir().join(format!("dfv-publication-default-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let publisher = Publisher::new(&dir.join("receipts"), Protection::default()).unwrap();
        let target = dir.join("saved.bin");
        let lock = publisher.lock(&target).unwrap();
        for bytes in [b"first".as_slice(), b"replacement".as_slice()] {
            let r = publisher.publish(&lock, bytes, None).unwrap();
            assert!(r.durable);
            assert_eq!(fs::read(&target).unwrap(), bytes);
            assert_eq!(
                publisher.status(&r.id),
                Status::Published {
                    finalized: true,
                    durable: true
                }
            );
        }
        drop(lock);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn dropping_writer_unlocks_even_with_an_inherited_descriptor() {
        let dir = std::env::temp_dir().join(format!(
            "dfv-publication-inherited-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let publisher = Publisher::new(&dir, Protection::default()).unwrap();
        let target = dir.join("saved.bin");
        let writer = publisher.lock(&target).unwrap();
        let inherited = writer._file.try_clone().unwrap();
        assert_eq!(publisher.lock(&target).err().unwrap().kind, Kind::Locked);
        drop(writer);
        let next = publisher.lock(&target).unwrap();
        drop(inherited);
        assert_eq!(publisher.lock(&target).err().unwrap().kind, Kind::Locked);
        drop(next);
        fs::remove_dir_all(dir).unwrap();
    }
}
