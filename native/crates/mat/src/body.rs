//! Byte access: the source file (read-only, positional) or a bounded decompressed buffer.
use crate::types::*;
use flate2::read::ZlibDecoder;
use std::{borrow::Cow, fs::File, io::Read, path::PathBuf, sync::Arc};

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Gen {
    dev: u64,
    ino: u64,
    len: u64,
    mtime_ns: i128,
}
fn gen_of(m: &std::fs::Metadata) -> Gen {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Gen {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            mtime_ns: i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
        }
    }
    #[cfg(not(unix))]
    {
        let t = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        Gen {
            dev: 0,
            ino: 0,
            len: m.len(),
            mtime_ns: t.map_or(0, |d| d.as_nanos() as i128),
        }
    }
}
pub(crate) fn fnv(seed: u64, bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(seed, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3))
}

pub(crate) enum Source {
    Mem(Vec<u8>),
    File {
        file: File,
        path: PathBuf,
        gen_: Gen,
    },
}
impl Source {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let mut options = File::options();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "A MAT source must be a regular file.",
            )
            .into());
        }
        let gen_ = gen_of(&metadata);
        Ok(Self::File {
            file,
            path: path.into(),
            gen_,
        })
    }
    pub fn len(&self) -> u64 {
        match self {
            Self::Mem(v) => v.len() as u64,
            Self::File { gen_, .. } => gen_.len,
        }
    }
    /// Cheap identity of this source version, folded with the header into the handle generation.
    pub fn fingerprint(&self) -> u64 {
        match self {
            Self::Mem(v) => fnv(0xcbf29ce484222325, &(v.len() as u64).to_le_bytes()),
            Self::File { gen_, .. } => {
                let h = fnv(0xcbf29ce484222325, &gen_.dev.to_le_bytes());
                let h = fnv(h, &gen_.ino.to_le_bytes());
                let h = fnv(h, &gen_.len.to_le_bytes());
                fnv(h, &gen_.mtime_ns.to_le_bytes())
            }
        }
    }
    /// Stale when the open file was modified in place or the path now names another file.
    pub fn check_current(&self) -> Result<()> {
        if let Self::File { file, path, gen_ } = self {
            let same = file
                .metadata()
                .map(|m| gen_of(&m) == *gen_)
                .unwrap_or(false)
                && std::fs::metadata(path)
                    .map(|m| gen_of(&m) == *gen_)
                    .unwrap_or(false);
            if !same {
                return Err(Error::Stale);
            }
        }
        Ok(())
    }
    fn read(&self, off: u64, n: u64) -> Result<Cow<'_, [u8]>> {
        let end = off.checked_add(n).filter(|e| *e <= self.len());
        let Some(end) = end else {
            return truncated("The MAT file ends inside an element.");
        };
        match self {
            Self::Mem(v) => Ok(Cow::Borrowed(&v[off as usize..end as usize])),
            Self::File { file, .. } => {
                let mut buf = vec![0u8; n as usize];
                read_exact_at(file, &mut buf, off)?;
                Ok(Cow::Owned(buf))
            }
        }
    }
}
#[cfg(unix)]
fn read_exact_at(f: &File, buf: &mut [u8], off: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(f, buf, off)
}
#[cfg(windows)]
fn read_exact_at(f: &File, mut buf: &mut [u8], mut off: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        let n = std::os::windows::fs::FileExt::seek_read(f, buf, off)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf = &mut buf[n..];
        off += n as u64;
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) enum Store {
    Src(Arc<Source>),
    Buf(Arc<Vec<u8>>),
}
/// A window `[off, off+len)` of a store; all offsets taken by its methods are window-relative.
#[derive(Clone)]
pub(crate) struct Body {
    store: Store,
    off: u64,
    len: u64,
}
impl Body {
    pub fn of_source(src: Arc<Source>, off: u64, len: u64) -> Result<Self> {
        let all = src.len();
        Self {
            store: Store::Src(src),
            off: 0,
            len: all,
        }
        .sub(off, len)
    }
    pub fn of_buf(buf: Arc<Vec<u8>>) -> Self {
        let len = buf.len() as u64;
        Self {
            store: Store::Buf(buf),
            off: 0,
            len,
        }
    }
    pub fn len(&self) -> u64 {
        self.len
    }
    pub fn sub(&self, off: u64, len: u64) -> Result<Self> {
        match off.checked_add(len) {
            Some(e) if e <= self.len => Ok(Self {
                store: self.store.clone(),
                off: self.off + off,
                len,
            }),
            _ => truncated("An element is larger than its container."),
        }
    }
    pub fn read(&self, off: u64, n: u64) -> Result<Cow<'_, [u8]>> {
        if off.checked_add(n).is_none_or(|e| e > self.len) {
            return truncated("An element is larger than its container.");
        }
        bound("read", n.into(), 1 << 31)?;
        let (o, e) = (self.off + off, self.off + off + n);
        match &self.store {
            Store::Src(s) => s.read(o, n),
            Store::Buf(b) => Ok(Cow::Borrowed(&b[o as usize..e as usize])),
        }
    }
}

fn u32_at(b: &[u8], le: bool) -> u32 {
    let a = [b[0], b[1], b[2], b[3]];
    if le {
        u32::from_le_bytes(a)
    } else {
        u32::from_be_bytes(a)
    }
}
pub(crate) const MI_MATRIX: u32 = 14;
pub(crate) const MI_COMPRESSED: u32 = 15;

/// Decompress one element to a buffer that begins with its miMATRIX tag, bounded and size-exact.
pub(crate) fn inflate_all(z: &[u8], le: bool, cap: u64) -> Result<Vec<u8>> {
    let mut d = ZlibDecoder::new(z);
    let mut out = Vec::new();
    let n = inner_size(&mut d, le, cap, &mut out)?;
    out.reserve((n as usize).min(z.len().saturating_mul(64) + (1 << 20)));
    let got = d
        .by_ref()
        .take(n + 1)
        .read_to_end(&mut out)
        .map_err(bad_zlib)? as u64;
    if got != n {
        return corrupt("The decompressed size differs from the declared element size.");
    }
    Ok(out)
}
/// Decompress at most `max` leading bytes (header peek); a short stream must match its tag exactly.
pub(crate) fn inflate_prefix(z: &[u8], le: bool, cap: u64, max: u64) -> Result<Vec<u8>> {
    let mut d = ZlibDecoder::new(z);
    let mut out = Vec::new();
    let n = inner_size(&mut d, le, cap, &mut out)?;
    let want = n.min(max.saturating_sub(8));
    let got = d
        .by_ref()
        .take(want)
        .read_to_end(&mut out)
        .map_err(bad_zlib)? as u64;
    if got != want {
        return corrupt("The compressed element ends before its declared size.");
    }
    Ok(out)
}
fn inner_size(d: &mut impl Read, le: bool, cap: u64, out: &mut Vec<u8>) -> Result<u64> {
    let mut tag = [0u8; 8];
    d.read_exact(&mut tag).map_err(bad_zlib)?;
    out.extend_from_slice(&tag);
    let (t, n) = (u32_at(&tag, le), u64::from(u32_at(&tag[4..], le)));
    if t != MI_MATRIX {
        return corrupt("A compressed element does not contain a matrix.");
    }
    bound("compressed variable", (n + 8).into(), cap.into())?;
    Ok(n)
}
fn bad_zlib(e: std::io::Error) -> Error {
    Error::Corrupt(format!("Corrupt compressed data: {e}"))
}
