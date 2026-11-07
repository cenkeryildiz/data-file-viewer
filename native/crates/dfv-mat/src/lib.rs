//! Dedicated read-only MAT v1 lane. Handles are opaque and session-owned.
#![forbid(unsafe_code)]
use dfv_table_mat::{MatFile, Node, Region};
use dfv_table_protocol::errors::*;
use dfv_table_protocol::{Capabilities, Control, ErrorBody, Lane, Route};
use serde_json::{Map, Value, json};
use std::{collections::HashMap, path::PathBuf};

pub const PROTOCOL: &str = "dfv-mat";
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 4;
const MAX_HANDLES: usize = 16384;
const PAGE: u64 = 1000;
const CELLS: u64 = 10000;
const METHODS: &[&str] = &[
    "open", "catalog", "describe", "slice", "sparse", "children", "close", "release",
];
#[derive(Default)]
pub struct Worker {
    sessions: HashMap<String, Session>,
    next: u64,
    handle: u64,
}
struct Session {
    file: MatFile,
    path: PathBuf,
    generation: String,
    handles: HashMap<String, Node>,
}
fn err(code: &'static str) -> ErrorBody {
    ErrorBody::new(
        code,
        match code {
            STALE_SOURCE => "The source generation changed; reopen the file.",
            RESOURCE_LIMIT => "The MAT resource limit was exceeded.",
            NOT_OPEN => "The MAT session or handle is not open.",
            UNSUPPORTED => "This MAT version or value class is unsupported.",
            QUERY_FAILED => "The MAT source could not be read.",
            ALREADY_OPEN => "The MAT source is already open.",
            _ => "The MAT request is invalid.",
        },
    )
}
fn codec(e: dfv_table_mat::Error) -> ErrorBody {
    use dfv_table_mat::Error::*;
    err(match e {
        Stale => STALE_SOURCE,
        TooLarge { .. } => RESOURCE_LIMIT,
        Unsupported { .. } | NotMat(_) => UNSUPPORTED,
        BadRequest(_) => MALFORMED_VALUE,
        ReadOnly(_) => READ_ONLY,
        _ => QUERY_FAILED,
    })
}
fn text<'a>(a: &'a Map<String, Value>, k: &str) -> Result<&'a str, ErrorBody> {
    a.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| err(MALFORMED_VALUE))
}
fn uint(v: &Value) -> Result<u64, ErrorBody> {
    let s = v.as_str().ok_or_else(|| err(MALFORMED_VALUE))?;
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(err(MALFORMED_VALUE));
    }
    s.parse().map_err(|_| err(MALFORMED_VALUE))
}
fn num(a: &Map<String, Value>, k: &str) -> Result<u64, ErrorBody> {
    uint(a.get(k).ok_or_else(|| err(MALFORMED_VALUE))?)
}
fn page(a: &Map<String, Value>, max: u64) -> Result<(u64, u64), ErrorBody> {
    let o = num(a, "offset")?;
    let l = num(a, "limit")?;
    if l == 0 || l > max {
        return Err(err(RESOURCE_LIMIT));
    }
    Ok((o, l))
}
fn strings(v: &[u64]) -> Vec<String> {
    v.iter().map(u64::to_string).collect()
}
fn region(a: &Map<String, Value>, dims: &[u64], dense: bool) -> Result<Region, ErrorBody> {
    let read = |k| {
        a.get(k)
            .and_then(Value::as_array)
            .ok_or_else(|| err(MALFORMED_VALUE))?
            .iter()
            .map(uint)
            .collect::<Result<Vec<_>, _>>()
    };
    let start = read("start")?;
    let count = read("count")?;
    if start.len() != dims.len() || count.len() != dims.len() {
        return Err(err(MALFORMED_VALUE));
    }
    let mut cells = 1u128;
    for ((&s, &c), &d) in start.iter().zip(&count).zip(dims) {
        if s == 0 || (d == 0 && (s != 1 || c != 0)) || (d > 0 && (c == 0 || s > d || c > d - s + 1))
        {
            return Err(err(MALFORMED_VALUE));
        }
        if dense {
            cells = cells
                .checked_mul(u128::from(c))
                .ok_or_else(|| err(RESOURCE_LIMIT))?;
        }
    }
    if dense && cells > u128::from(CELLS) {
        return Err(err(RESOURCE_LIMIT));
    }
    Ok(Region { start, count })
}
impl Worker {
    fn issue(&mut self, sid: &str, nodes: Vec<Node>) -> Result<Vec<String>, ErrorBody> {
        let used: usize = self.sessions.values().map(|s| s.handles.len()).sum();
        if used + nodes.len() > MAX_HANDLES {
            return Err(err(RESOURCE_LIMIT));
        }
        self.handle
            .checked_add(nodes.len() as u64)
            .ok_or_else(|| err(RESOURCE_LIMIT))?;
        let s = self.sessions.get_mut(sid).ok_or_else(|| err(NOT_OPEN))?;
        Ok(nodes
            .into_iter()
            .map(|n| {
                self.handle += 1;
                let h = format!("n{}", self.handle);
                s.handles.insert(h.clone(), n);
                h
            })
            .collect())
    }
    fn session(&mut self, a: &Map<String, Value>) -> Result<String, ErrorBody> {
        let sid = text(a, "session")?.to_owned();
        let generation = text(a, "generation")?;
        num(a, "generation")?;
        let s = self.sessions.get(&sid).ok_or_else(|| err(NOT_OPEN))?;
        if generation != s.generation {
            return Err(err(STALE_SOURCE));
        }
        if s.file.verify_source().is_err() {
            self.sessions.remove(&sid);
            return Err(err(STALE_SOURCE));
        }
        Ok(sid)
    }
    fn execute(
        &mut self,
        m: &str,
        a: &Map<String, Value>,
        c: &Control,
    ) -> Result<Value, ErrorBody> {
        c.check()?;
        let keys: &[&str] = match m {
            "open" => &["path"],
            "catalog" => &["session", "generation", "offset", "limit"],
            "describe" => &["session", "generation", "handle"],
            "slice" => &["session", "generation", "handle", "start", "count"],
            "sparse" => &[
                "session",
                "generation",
                "handle",
                "start",
                "count",
                "offset",
                "limit",
            ],
            "children" => &["session", "generation", "handle", "offset", "limit"],
            "release" => &["session", "generation", "handles"],
            "close" => &["session", "generation"],
            _ => return Err(err(UNKNOWN_METHOD)),
        };
        if a.len() != keys.len() || a.keys().any(|k| !keys.contains(&k.as_str())) {
            return Err(err(MALFORMED_REQUEST));
        }
        if m == "open" {
            if self.sessions.len() >= MAX_SESSIONS {
                return Err(err(RESOURCE_LIMIT));
            }
            let path = std::fs::canonicalize(text(a, "path")?).map_err(|_| err(QUERY_FAILED))?;
            if self.sessions.values().any(|s| s.path == path) {
                return Err(err(ALREADY_OPEN));
            }
            let file = MatFile::open(&path, &Default::default()).map_err(codec)?;
            c.check()?;
            self.next = self
                .next
                .checked_add(1)
                .ok_or_else(|| err(RESOURCE_LIMIT))?;
            let sid = format!("s{}", self.next);
            let generation = self.next.to_string();
            let out = json!({"session":sid,"generation":generation,"variables":file.catalog().len().to_string(),"read_only":true});
            self.sessions.insert(
                sid,
                Session {
                    file,
                    path,
                    generation,
                    handles: HashMap::new(),
                },
            );
            return Ok(out);
        }
        let sid = self.session(a)?;
        if m == "close" {
            self.sessions.remove(&sid);
            return Ok(json!({"closed":true}));
        }
        if m == "release" {
            let hs = a["handles"]
                .as_array()
                .filter(|h| h.len() <= PAGE as usize)
                .ok_or_else(|| err(MALFORMED_VALUE))?;
            let hs = hs
                .iter()
                .map(|h| h.as_str().ok_or_else(|| err(MALFORMED_VALUE)))
                .collect::<Result<Vec<_>, _>>()?;
            let s = self.sessions.get_mut(&sid).unwrap();
            let n = hs
                .iter()
                .filter(|h| s.handles.remove(**h).is_some())
                .count();
            return Ok(json!({"released":n.to_string()}));
        }
        let s = &self.sessions[&sid];
        let generation = s.generation.clone();
        let (mut out, nodes) = if m == "catalog" {
            let (o, l) = page(a, PAGE)?;
            let o = usize::try_from(o).map_err(|_| err(RESOURCE_LIMIT))?;
            let entries = s.file.catalog_page(o, l as usize);
            (
                json!({"total":s.file.catalog().len().to_string(),"offset":o.to_string(),"items":entries.iter().map(|e|json!({"info":e.info.to_wire()})).collect::<Vec<_>>()}),
                entries.iter().map(|e| e.node.clone()).collect(),
            )
        } else {
            let node = s
                .handles
                .get(text(a, "handle")?)
                .ok_or_else(|| err(NOT_OPEN))?;
            let info = s.file.describe(node).map_err(codec)?;
            match m {
                "describe" => (json!({"info":info.to_wire()}), vec![]),
                "slice" => {
                    let r = region(a, &info.dims, true)?;
                    let v = s.file.read_slice(node, &r).map_err(codec)?;
                    (
                        json!({"dims":strings(&v.dims),"start":strings(&r.start),"count":strings(&r.count),"index_base":"1","order":"column-major","data":v.data.to_wire()}),
                        vec![],
                    )
                }
                "sparse" => {
                    let r = region(a, &info.dims, false)?;
                    let (o, l) = page(a, CELLS)?;
                    let v = s.file.read_sparse(node, &r, o, l).map_err(codec)?;
                    (
                        json!({"shape":strings(&v.shape),"nnz":v.nnz.to_string(),"offset":v.skipped.to_string(),"has_more":v.has_more,"implicit_zero":true,"index_base":"1","order":"column-major","entries":v.entries.iter().map(|e|json!({"row":e.row.to_string(),"col":e.col.to_string(),"re":e.re.to_wire(v.class),"im":e.im.map(|x|x.to_wire(v.class))})).collect::<Vec<_>>()}),
                        vec![],
                    )
                }
                "children" => {
                    let (o, l) = page(a, PAGE)?;
                    let v = s.file.children(node, o, l).map_err(codec)?;
                    (
                        json!({"total":v.total.to_string(),"offset":v.offset.to_string(),"items":v.items.iter().map(|i|json!({"label":i.label,"info":i.info.to_wire(),"preview":i.preview.as_ref().map(|p|p.to_wire())})).collect::<Vec<_>>()}),
                        v.items.into_iter().map(|i| i.node).collect(),
                    )
                }
                _ => return Err(err(UNKNOWN_METHOD)),
            }
        };
        c.check()?;
        if self.sessions[&sid].file.verify_source().is_err() {
            self.sessions.remove(&sid);
            return Err(err(STALE_SOURCE));
        }
        let handles = self.issue(&sid, nodes)?;
        if let Some(items) = out.get_mut("items").and_then(Value::as_array_mut) {
            for (item, h) in items.iter_mut().zip(handles) {
                item["handle"] = json!(h);
            }
        }
        out["session"] = json!(sid);
        out["generation"] = json!(generation);
        Ok(out)
    }
}
impl Lane for Worker {
    fn protocol(&self) -> &'static str {
        PROTOCOL
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            name: "dfv-mat",
            version: env!("CARGO_PKG_VERSION"),
            methods: METHODS.to_vec(),
            formats: vec![
                json!({"format":"mat","schema":"dfv-mat.v1","read_only":true,"versions":["v5","v6","v7"],"v7_3":false,"limits":{"sessions":MAX_SESSIONS.to_string(),"handles":MAX_HANDLES.to_string(),"page":PAGE.to_string(),"cells":CELLS.to_string(),"variable_bytes":"268435456"}}),
            ],
            value_tags: vec![
                "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
                "float32", "float64",
            ],
            time_units: vec![],
        }
    }
    fn router(&self) -> dfv_table_protocol::sched::Router {
        |m, a| Route {
            session: a.get("session").and_then(Value::as_str).map(str::to_owned),
            closes: m == "close",
        }
    }
    fn call(&mut self, m: &str, a: &Map<String, Value>, c: &Control) -> Result<Value, ErrorBody> {
        self.execute(m, a, c)
    }
    fn discard(&mut self, m: &str, v: Value) {
        if let Some(sid) = v["session"].as_str() {
            if m == "open" {
                self.sessions.remove(sid);
            } else if let Some(s) = self.sessions.get_mut(sid)
                && let Some(items) = v["items"].as_array()
            {
                for i in items {
                    if let Some(h) = i["handle"].as_str() {
                        s.handles.remove(h);
                    }
                }
            }
        }
    }
}
