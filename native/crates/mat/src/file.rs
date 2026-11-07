use crate::body::*;
use crate::parse::*;
use crate::read::*;
use crate::types::*;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

const PEEK: u64 = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct FileHeader {
    pub description: String,
    /// 0x0100 for Level 5 (v5/v6/v7).
    pub version: u16,
    pub little_endian: bool,
    pub size: u64,
    /// True when the header points at a subsystem block (needed by MATLAB class instances).
    pub has_subsystem: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub node: Node,
    pub info: Info,
}
#[derive(Clone, Copy)]
enum Loc {
    Raw { off: u64, n: u64 },
    Zlib { off: u64, n: u64 },
}

/// A read-only Level-5 MAT-file. Handles from `catalog` are valid only for this open generation.
pub struct MatFile {
    src: Arc<Source>,
    le: bool,
    lim: Limits,
    header: FileHeader,
    generation: u64,
    locs: Vec<Loc>,
    entries: Vec<Entry>,
    cache: Mutex<Option<(usize, Arc<Vec<u8>>)>>,
}

impl MatFile {
    pub fn open(path: &Path, lim: &Limits) -> Result<Self> {
        Self::from_source(Source::open(path)?, lim)
    }
    pub fn from_bytes(bytes: Vec<u8>, lim: &Limits) -> Result<Self> {
        Self::from_source(Source::Mem(bytes), lim)
    }
    fn from_source(src: Source, lim: &Limits) -> Result<Self> {
        let src = Arc::new(src);
        let all = Body::of_source(src.clone(), 0, src.len())?;
        let (header, le) = read_header(&all)?;
        let generation = fnv(src.fingerprint(), &all.read(0, 128)?);
        let (mut locs, mut entries, mut pos) = (vec![], vec![], 128u64);
        while pos < src.len() {
            if src.len() - pos < 8 {
                return truncated("The MAT file ends inside an element tag.");
            }
            bound("variables", locs.len() as u128 + 1, lim.variables as u128)?;
            let tag = all.read(pos, 8)?;
            let (dtype, n) = (u32_at(&tag, le), u64::from(u32_at(&tag[4..], le)));
            let end = pos + 8 + n;
            if end > src.len() {
                return truncated("The MAT file ends inside a variable.");
            }
            let (lay, loc) = match dtype {
                MI_MATRIX => (
                    layout(&all.sub(pos + 8, n)?, le, lim)?,
                    Loc::Raw { off: pos, n },
                ),
                MI_COMPRESSED => {
                    let z = all.sub(pos + 8, n)?;
                    let buf =
                        inflate_prefix(&z.read(0, n.min(1 << 16))?, le, lim.variable_bytes, PEEK)?;
                    let inner = Body::of_buf(Arc::new(buf));
                    let m = inner.sub(8, inner.len() - 8)?;
                    (layout(&m, le, lim)?, Loc::Zlib { off: pos, n })
                }
                _ => return corrupt("A top-level element is neither a matrix nor compressed."),
            };
            pos = end;
            // MATLAB keeps class-instance support data in an unnamed variable; it is not user data.
            if lay.name.is_empty() {
                continue;
            }
            let node = Node {
                generation,
                variable: locs.len(),
                path: vec![],
            };
            entries.push(Entry {
                node,
                info: lay.info(),
            });
            locs.push(loc);
        }
        Ok(Self {
            src,
            le,
            lim: lim.clone(),
            header,
            generation,
            locs,
            entries,
            cache: Mutex::new(None),
        })
    }

    pub fn header(&self) -> &FileHeader {
        &self.header
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// Fails with `Stale` when the file changed (or was replaced) since it was opened.
    pub fn verify_source(&self) -> Result<()> {
        self.src.check_current()
    }
    pub fn catalog(&self) -> &[Entry] {
        &self.entries
    }
    pub fn catalog_page(&self, offset: usize, limit: usize) -> &[Entry] {
        let a = offset.min(self.entries.len());
        &self.entries[a..a.saturating_add(limit).min(self.entries.len())]
    }

    fn guarded<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.src.check_current()?;
        let v = f()?;
        self.src.check_current()?;
        Ok(v)
    }
    fn root(&self, i: usize) -> Result<Body> {
        match self.locs[i] {
            Loc::Raw { off, n } => Body::of_source(self.src.clone(), off + 8, n),
            Loc::Zlib { off, n } => {
                let cached = self
                    .cache
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|c| c.0 == i)
                    .map(|c| c.1.clone());
                let buf = match cached {
                    Some(b) => b,
                    None => {
                        bound(
                            "compressed variable",
                            n.into(),
                            self.lim.variable_bytes.into(),
                        )?;
                        let z = Body::of_source(self.src.clone(), off + 8, n)?;
                        let b = Arc::new(inflate_all(
                            &z.read(0, n)?,
                            self.le,
                            self.lim.variable_bytes,
                        )?);
                        *self.cache.lock().unwrap() = Some((i, b.clone()));
                        b
                    }
                };
                let body = Body::of_buf(buf);
                body.sub(8, body.len() - 8)
            }
        }
    }
    /// Walk a node path to its body and header.
    fn resolve(&self, node: &Node) -> Result<(Body, Layout)> {
        if node.generation != self.generation || node.variable >= self.locs.len() {
            return Err(Error::Stale);
        }
        bound(
            "path depth",
            node.path.len() as u128,
            self.lim.depth as u128,
        )?;
        let mut b = self.root(node.variable)?;
        let mut lay = layout(&b, self.le, &self.lim)?;
        for step in &node.path {
            let pos = match (step, lay.class) {
                (Step::Cell(i), Class::Cell) => {
                    let n = self.cell_count(&b, &lay)?;
                    if *i == 0 || *i > n {
                        return Err(Error::BadRequest(
                            "The cell index is outside the cell array.".into(),
                        ));
                    }
                    nth_child(&b, lay.next, i - 1, self.le)?
                }
                (Step::Field { element, field }, Class::Struct) => {
                    let (names, first) = struct_fields(&b, &lay, self.le, &self.lim)?;
                    let ne = self.cell_count(&b, &lay)?;
                    if *element == 0 || *element > ne || *field as usize >= names.len() {
                        return Err(Error::BadRequest(
                            "The struct element or field is outside the struct.".into(),
                        ));
                    }
                    nth_child(
                        &b,
                        first,
                        (element - 1) * names.len() as u64 + u64::from(*field),
                        self.le,
                    )?
                }
                _ => {
                    return Err(Error::BadRequest(
                        "The path does not match the variable's class.".into(),
                    ));
                }
            };
            b = matrix_at(&b, pos, self.le)?;
            lay = layout(&b, self.le, &self.lim)?;
        }
        Ok((b, lay))
    }
    fn cell_count(&self, b: &Body, lay: &Layout) -> Result<u64> {
        let n = lay.numel()?;
        bound("cell elements", n.into(), self.lim.cell_elements.into())?;
        if n > b.len() / 8 && n > 0 && matches!(lay.class, Class::Cell) {
            return corrupt("The cell count exceeds the bytes available.");
        }
        Ok(n)
    }

    fn full_info(&self, b: &Body, lay: &Layout) -> Result<Info> {
        let mut info = lay.info();
        match lay.class {
            Class::Cell => info.children = Some(self.cell_count(b, lay)?),
            Class::Struct => {
                let (names, _) = struct_fields(b, lay, self.le, &self.lim)?;
                let ne = self.cell_count(b, lay)?;
                info.children = Some(ne.saturating_mul(names.len() as u64));
                info.fields = names;
            }
            _ if lay.sparse => info.nnz = Some(sparse_nnz(b, lay, self.le)?),
            _ => {}
        }
        Ok(info)
    }
    /// Full metadata for one node (struct fields, sparse nonzero count, child count).
    pub fn describe(&self, node: &Node) -> Result<Info> {
        self.guarded(|| {
            let (b, lay) = self.resolve(node)?;
            self.full_info(&b, &lay)
        })
    }

    /// Dense, text or sparse-window region read; see `Region::first_page` for a default preview.
    pub fn read_slice(&self, node: &Node, region: &Region) -> Result<Slice> {
        self.guarded(|| {
            let (b, lay) = self.resolve(node)?;
            let data = slice_body(&b, &lay, region, self.le, &self.lim)?;
            Ok(Slice {
                dims: lay.dims.clone(),
                region: region.clone(),
                data,
            })
        })
    }
    /// Sparse coordinate listing of a 2-D region: skip `skip` entries, return at most `limit`.
    pub fn read_sparse(
        &self,
        node: &Node,
        region: &Region,
        skip: u64,
        limit: u64,
    ) -> Result<SparseSlice> {
        self.guarded(|| {
            let (b, lay) = self.resolve(node)?;
            if !lay.sparse {
                return Err(Error::BadRequest("The variable is not sparse.".into()));
            }
            sparse_slice(
                &b,
                &lay,
                region,
                skip,
                limit.min(self.lim.page_cells),
                self.le,
            )
        })
    }

    /// One page of cell elements or struct fields (struct arrays list element by element).
    pub fn children(&self, node: &Node, offset: u64, limit: u64) -> Result<ChildPage> {
        self.guarded(|| {
            let (b, lay) = self.resolve(node)?;
            let (names, first, per) = match lay.class {
                Class::Cell => (vec![], lay.next, 1),
                Class::Struct => {
                    let (n, f) = struct_fields(&b, &lay, self.le, &self.lim)?;
                    let per = n.len() as u64;
                    (n, f, per)
                }
                _ => {
                    return Err(Error::BadRequest(
                        "Only cells and structs have children.".into(),
                    ));
                }
            };
            let total = self.cell_count(&b, &lay)?.saturating_mul(per);
            let end = offset
                .saturating_add(limit.min(self.lim.children_page))
                .min(total);
            if offset < end {
                bound(
                    "path depth",
                    node.path.len() as u128 + 1,
                    self.lim.depth as u128,
                )?;
            }
            let mut items = vec![];
            let mut pos = if offset < end {
                nth_child(&b, first, offset, self.le)?
            } else {
                0
            };
            for k in offset..end {
                let e = elem(&b, pos, self.le)?;
                let cb = matrix_at(&b, pos, self.le)?;
                pos = e.next;
                let cl = layout(&cb, self.le, &self.lim)?;
                let (step, label) = if per == 1 && names.is_empty() {
                    (
                        Step::Cell(k + 1),
                        format!("{{{}}}", subscripts(k, &lay.dims)),
                    )
                } else {
                    let (el, f) = (k / per, (k % per) as usize);
                    let l = if lay.dims.iter().all(|d| *d == 1) {
                        format!(".{}", names[f])
                    } else {
                        format!("({}).{}", subscripts(el, &lay.dims), names[f])
                    };
                    (
                        Step::Field {
                            element: el + 1,
                            field: f as u32,
                        },
                        l,
                    )
                };
                let mut path = node.path.clone();
                path.push(step);
                items.push(Child {
                    node: Node {
                        generation: self.generation,
                        variable: node.variable,
                        path,
                    },
                    label,
                    preview: self.preview(&cb, &cl),
                    info: cl.info(),
                });
            }
            Ok(ChildPage {
                total,
                offset,
                items,
            })
        })
    }
    fn preview(&self, b: &Body, lay: &Layout) -> Option<Data> {
        let small = |cap: u64| lay.numel().is_ok_and(|n| n <= cap);
        let ok = match lay.class {
            Class::Char => lay.dims.len() == 2 && small(256),
            Class::Cell | Class::Struct => false,
            _ => !lay.sparse && small(16) && matches!(lay.support(), Support::Full),
        };
        if !ok {
            return None;
        }
        let r = Region::first_page(&lay.dims, 256);
        slice_body(b, lay, &r, self.le, &self.lim).ok()
    }
}

/// One-based subscripts of zero-based column-major linear index `k`.
fn subscripts(mut k: u64, dims: &[u64]) -> String {
    let mut out = vec![];
    for d in dims {
        let d = (*d).max(1);
        out.push((k % d + 1).to_string());
        k /= d;
    }
    out.join(",")
}

fn read_header(all: &Body) -> Result<(FileHeader, bool)> {
    if all.len() < 128 {
        let head = all.read(0, all.len())?;
        return if head.starts_with(b"MATLAB") {
            truncated("The MAT file ends inside its header.")
        } else if is_v4(&head) {
            Err(v4())
        } else {
            Err(Error::NotMat(
                "The file is too short to be a MAT-file.".into(),
            ))
        };
    }
    let h = all.read(0, 128)?;
    let le = match &h[126..128] {
        b"IM" => true,
        b"MI" => false,
        _ => return Err(not_v5(&h)),
    };
    let rd16 = |a: &[u8]| {
        if le {
            u16::from_le_bytes([a[0], a[1]])
        } else {
            u16::from_be_bytes([a[0], a[1]])
        }
    };
    let version = rd16(&h[124..126]);
    if !h.starts_with(b"MATLAB") {
        return Err(not_v5(&h));
    }
    if version == 0x0200 {
        return Err(Error::Unsupported {
            code: "unsupported_version_v73",
            detail: "MATLAB v7.3 (HDF5) files are not supported by this reader yet.".into(),
        });
    }
    if version != 0x0100 {
        return Err(Error::Unsupported {
            code: "unsupported_version",
            detail: format!("MAT-file version 0x{version:04x} is not supported."),
        });
    }
    let sub = if le {
        u64::from_le_bytes(h[116..124].try_into().unwrap())
    } else {
        u64::from_be_bytes(h[116..124].try_into().unwrap())
    };
    let description = String::from_utf8_lossy(&h[..116])
        .trim_end_matches([' ', '\0'])
        .to_string();
    Ok((
        FileHeader {
            description,
            version,
            little_endian: le,
            size: all.len(),
            has_subsystem: sub != 0,
        },
        le,
    ))
}
fn v4() -> Error {
    Error::Unsupported {
        code: "unsupported_version_v4",
        detail: "MATLAB Level 4 MAT-files are not supported.".into(),
    }
}
/// A Level 4 file starts with `[type, mrows, ncols, imagf, namlen]` (int32) and a name; type is MOPT.
fn is_v4(h: &[u8]) -> bool {
    if h.len() < 20 || h.starts_with(b"MATLAB") {
        return false;
    }
    [true, false].into_iter().any(|le| {
        let w = |i: usize| u64::from(u32_at(&h[4 * i..], le));
        let (t, imagf, namlen) = (w(0), w(3), w(4));
        (t / 1000) <= 4
            && (t / 100) % 10 == 0
            && (t / 10) % 10 <= 5
            && t % 10 <= 2
            && imagf <= 1
            && namlen >= 1
            && 20 + namlen <= h.len() as u64
    })
}
fn not_v5(h: &[u8]) -> Error {
    if is_v4(h) {
        v4()
    } else {
        Error::NotMat("The file does not have a MATLAB 5 MAT-file header.".into())
    }
}
