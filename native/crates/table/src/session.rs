//! Document sessions. A session is one open source with an immutable read generation: readers hold
//! an `Arc<Generation>`, a refresh publishes a new one and never edits the old. Sources are only
//! ever opened read-only, so a worker that dies at any point cannot have changed one.
use dfv_table_protocol::ErrorBody;
use dfv_table_protocol::errors::{
    ALREADY_OPEN, NOT_OPEN, QUERY_FAILED, RUNTIME_BUSY, STALE_SOURCE,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ns: u128,
    pub fingerprint: String,
}

/// One immutable read generation of a source. `revision` is the session's own publish counter.
/// The bytes are never held: the format crates read the file themselves, and the identity (size,
/// mtime, streamed SHA-256) is what proves which bytes a generation described.
pub struct Generation {
    pub revision: u64,
    pub identity: Identity,
}

pub struct Session {
    pub id: String,
    pub current: Arc<Generation>,
}

pub struct Sessions {
    next: u64,
    by_id: HashMap<String, Session>,
    max_sessions: usize,
}

fn unreadable() -> ErrorBody {
    ErrorBody::new(QUERY_FAILED, "The source could not be read.")
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos())
}

/// Read-only by construction: `File::open` and nothing else touches the source. The hash is streamed
/// (constant memory), and a source that changes while it is hashed is refused.
fn identify(path: &Path) -> Result<Identity, ErrorBody> {
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
        return Err(unreadable());
    }
    let mut file = std::fs::File::open(path).map_err(|_| unreadable())?;
    let meta = file.metadata().map_err(|_| unreadable())?;
    if !meta.is_file() {
        return Err(unreadable());
    }
    let mut hash = Sha256::new();
    let mut chunk = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut chunk).map_err(|_| unreadable())?;
        if n == 0 {
            break;
        }
        hash.update(&chunk[..n]);
        size += n as u64;
    }
    let after = file.metadata().map_err(|_| unreadable())?;
    if after.len() != meta.len()
        || after.modified().ok() != meta.modified().ok()
        || size != meta.len()
    {
        return Err(ErrorBody::new(
            STALE_SOURCE,
            "The source changed while it was being read.",
        ));
    }
    Ok(Identity {
        path: path.to_owned(),
        size,
        mtime_ns: mtime_ns(&meta),
        fingerprint: hash.finalize().iter().map(|b| format!("{b:02x}")).collect(),
    })
}

impl Sessions {
    pub fn new(max_sessions: usize) -> Self {
        Self {
            next: 0,
            by_id: HashMap::new(),
            max_sessions,
        }
    }

    /// Ids are never reused, so a handle or request naming a closed session can never reach a new one.
    pub fn open(&mut self, path: &Path) -> Result<&Session, ErrorBody> {
        let path = std::fs::canonicalize(path).map_err(|_| unreadable())?;
        if self.by_id.values().any(|s| s.current.identity.path == path) {
            return Err(ErrorBody::new(ALREADY_OPEN, "This source is already open."));
        }
        if self.by_id.len() >= self.max_sessions {
            return Err(ErrorBody::new(
                RUNTIME_BUSY,
                "Too many documents are open; close one first.",
            ));
        }
        let identity = identify(&path)?;
        self.next += 1;
        let id = format!("s{}", self.next);
        let current = Arc::new(Generation {
            revision: 1,
            identity,
        });
        Ok(self
            .by_id
            .entry(id.clone())
            .or_insert(Session { id, current }))
    }

    pub fn get(&self, id: &str) -> Result<&Session, ErrorBody> {
        self.by_id
            .get(id)
            .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such document (closed or never opened)."))
    }

    /// Checks the source against the current generation (size and mtime; the fingerprint is recomputed
    /// only when they moved). A new generation is published only if its identity changed; earlier
    /// generations stay valid for whoever still holds them.
    pub fn refresh(&mut self, id: &str) -> Result<(Arc<Generation>, bool), ErrorBody> {
        let session = self.by_id.get_mut(id).ok_or_else(|| {
            ErrorBody::new(NOT_OPEN, "No such document (closed or never opened).")
        })?;
        let known = &session.current.identity;
        let meta = std::fs::metadata(&known.path).map_err(|_| unreadable())?;
        if meta.is_file() && meta.len() == known.size && mtime_ns(&meta) == known.mtime_ns {
            return Ok((session.current.clone(), false));
        }
        let identity = identify(&known.path)?;
        if identity == *known {
            return Ok((session.current.clone(), false));
        }
        session.current = Arc::new(Generation {
            revision: session.current.revision + 1,
            identity,
        });
        Ok((session.current.clone(), true))
    }

    /// Closing twice is defined: the second call finds nothing and returns false.
    pub fn close(&mut self, id: &str) -> bool {
        self.by_id.remove(id).is_some()
    }

    pub fn count(&self) -> usize {
        self.by_id.len()
    }

    /// A verified write publishes a new generation even when size and mtime did not change.
    pub fn publish(&mut self, id: &str) -> Result<Arc<Generation>, ErrorBody> {
        let session = self
            .by_id
            .get_mut(id)
            .ok_or_else(|| ErrorBody::new(NOT_OPEN, "No such document."))?;
        let identity = identify(&session.current.identity.path)?;
        session.current = Arc::new(Generation {
            revision: session.current.revision + 1,
            identity,
        });
        Ok(session.current.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::File::create(&p).unwrap().write_all(body).unwrap();
        p
    }
    fn tmp(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("dfv-table-session-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn open_identifies_the_source_and_refuses_a_second_open_of_the_same_file() {
        let d = tmp("open");
        let p = file(&d, "a.bin", b"abc");
        let mut s = Sessions::new(4);
        let (id, rev) = {
            let o = s.open(&p).unwrap();
            (o.id.clone(), o.current.revision)
        };
        assert_eq!((id.as_str(), rev), ("s1", 1));
        assert_eq!(
            s.get(&id).unwrap().current.identity.fingerprint,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // the same file through a different spelling is still the same document
        assert_eq!(
            s.open(&d.join(".").join("a.bin")).err().unwrap().code,
            ALREADY_OPEN
        );
        assert_eq!(s.open(&d.join("missing")).err().unwrap().code, QUERY_FAILED);
        assert_eq!(
            s.open(&d).err().unwrap().code,
            QUERY_FAILED,
            "a directory is not a source"
        );
    }

    #[test]
    fn refresh_publishes_a_new_generation_only_on_change_and_keeps_the_old_one_intact() {
        let d = tmp("refresh");
        let p = file(&d, "a.bin", b"one");
        let mut s = Sessions::new(4);
        let id = s.open(&p).unwrap().id.clone();
        let first = s.get(&id).unwrap().current.clone();
        let (same, changed) = s.refresh(&id).unwrap();
        assert!(!changed && Arc::ptr_eq(&same, &first));
        std::fs::write(&p, b"two!").unwrap();
        let (next, changed) = s.refresh(&id).unwrap();
        assert!(changed && next.revision == 2 && next.identity.size == 4);
        assert_eq!(
            (first.revision, first.identity.size),
            (1, 3),
            "readers of generation 1 are unaffected"
        );
    }

    #[test]
    fn ids_are_not_reused_and_close_twice_is_defined() {
        let d = tmp("close");
        let p = file(&d, "a.bin", b"x");
        let mut s = Sessions::new(4);
        let id = s.open(&p).unwrap().id.clone();
        assert!(s.close(&id) && !s.close(&id));
        assert_eq!(s.get(&id).err().unwrap().code, NOT_OPEN);
        assert_eq!(s.refresh(&id).err().unwrap().code, NOT_OPEN);
        assert_eq!(s.open(&p).unwrap().id, "s2");
    }

    #[test]
    fn the_session_limit_refuses_and_a_large_source_is_hashed_in_constant_memory() {
        let d = tmp("limits");
        let a = file(&d, "a.bin", b"a");
        let b = file(&d, "b.bin", b"b");
        let mut s = Sessions::new(1);
        s.open(&a).unwrap();
        assert_eq!(s.open(&b).err().unwrap().code, RUNTIME_BUSY);
        // Bigger than one hashing chunk: the streamed digest equals the one-shot digest.
        let big = vec![7u8; (1 << 20) * 2 + 5];
        let c = file(&d, "c.bin", &big);
        let mut s = Sessions::new(1);
        let id = s.open(&c).unwrap().id.clone();
        let expected: String = Sha256::digest(&big)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(s.get(&id).unwrap().current.identity.fingerprint, expected);
    }

    #[test]
    fn the_table_engine_sources_have_no_write_apis() {
        // The "a dead worker cannot have mutated a source" guarantee is that nothing here can write.
        for src in [
            include_str!("session.rs"),
            include_str!("resource.rs"),
            include_str!("source.rs"),
            include_str!("formats.rs"),
        ] {
            let code = src.split("#[cfg(test)]").next().unwrap();
            for banned in [
                "OpenOptions",
                "File::create",
                "fs::write",
                "remove_file",
                "rename(",
                "set_len",
                "set_permissions",
            ] {
                assert!(!code.contains(banned), "{banned}");
            }
        }
    }
}
