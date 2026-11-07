//! Test-only document engine (feature `test-doc`, selected at run time by `DFV_TABLE_TEST_DOC=1`).
//! It exercises sessions, handles, queues and cancellation end to end over the real protocol. It
//! reads files byte-for-byte and means nothing as a table format; it is never in a default build.
use crate::resource::{self, Resources};
use crate::session::Sessions;
use dfv_table_protocol::errors::{MALFORMED_VALUE, STALE_SOURCE};
use dfv_table_protocol::{Capabilities, Control, ErrorBody, Lane, Route};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::time::Duration;

pub struct TestDoc {
    sessions: Sessions,
    resources: Resources,
}

impl Default for TestDoc {
    fn default() -> Self {
        Self {
            sessions: Sessions::new(8),
            resources: Resources::default(),
        }
    }
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, ErrorBody> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ErrorBody::new(MALFORMED_VALUE, format!("`{key}` must be a string.")))
}
fn number(args: &Map<String, Value>, key: &str) -> Result<Option<u64>, ErrorBody> {
    match args.get(key) {
        None => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or_else(|| {
            ErrorBody::new(MALFORMED_VALUE, format!("`{key}` must be a whole number."))
        }),
    }
}

impl Lane for TestDoc {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            name: "dfv-table-testdoc",
            version: env!("CARGO_PKG_VERSION"),
            methods: vec![
                "ping",
                "testOpen",
                "testRefresh",
                "testRead",
                "testPage",
                "testRelease",
                "testClose",
                "testStatus",
            ],
            formats: vec![],
            value_tags: vec![],
            time_units: vec![],
        }
    }

    fn router(&self) -> fn(&str, &Map<String, Value>) -> Route {
        |method, args| {
            let session = match method {
                "testRefresh" | "testRead" | "testClose" => args
                    .get("session")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                "testPage" | "testRelease" => args
                    .get("resource")
                    .and_then(Value::as_str)
                    .and_then(resource::session_of),
                _ => None,
            };
            Route {
                closes: method == "testClose" && session.is_some(),
                session,
            }
        }
    }

    fn call(
        &mut self,
        method: &str,
        args: &Map<String, Value>,
        control: &Control,
    ) -> Result<Value, ErrorBody> {
        match method {
            "testOpen" => {
                let s = self.sessions.open(Path::new(text(args, "path")?))?;
                Ok(
                    json!({"session": s.id, "revision": s.current.revision, "size": s.current.identity.size}),
                )
            }
            "testRefresh" => {
                let (g, changed) = self.sessions.refresh(text(args, "session")?)?;
                Ok(json!({"revision": g.revision, "changed": changed}))
            }
            "testRead" => {
                let session = text(args, "session")?;
                // The generation is captured once: whatever happens next, this read sees only it.
                let generation = self.sessions.get(session)?.current.clone();
                if number(args, "expected_revision")?.is_some_and(|r| r != generation.revision) {
                    return Err(ErrorBody::new(
                        STALE_SOURCE,
                        "The document changed since it was read.",
                    ));
                }
                // Simulated long read that honours cancellation and the deadline.
                let mut left = number(args, "hold_ms")?.unwrap_or(0);
                while left > 0 {
                    control.check()?;
                    let step = left.min(5);
                    std::thread::sleep(Duration::from_millis(step));
                    left -= step;
                }
                control.check()?;
                // Generations no longer hold bytes: read them now, and refuse if the file moved off this generation.
                let bytes = std::fs::read(&generation.identity.path).map_err(|_| {
                    ErrorBody::new(STALE_SOURCE, "The document could not be read again.")
                })?;
                if bytes.len() as u64 != generation.identity.size {
                    return Err(ErrorBody::new(
                        STALE_SOURCE,
                        "The document changed since it was read.",
                    ));
                }
                let length = bytes.len();
                let handle = self
                    .resources
                    .add(session, generation.revision, bytes.into())?;
                Ok(json!({"resource": handle, "revision": generation.revision, "length": length}))
            }
            "testPage" => {
                let handle = text(args, "resource")?;
                let entry = self.resources.get(handle)?;
                let session = self
                    .sessions
                    .get(&resource::session_of(handle).unwrap_or_default())?;
                // A page of another revision is refused, never mixed.
                if entry.revision != session.current.revision {
                    return Err(ErrorBody::new(
                        STALE_SOURCE,
                        "The document changed since this result was read.",
                    ));
                }
                let offset = number(args, "offset")?.unwrap_or(0) as usize;
                let len = (number(args, "len")?.unwrap_or(16) as usize).min(4096);
                let page = entry
                    .data
                    .get(offset.min(entry.data.len())..(offset + len).min(entry.data.len()))
                    .unwrap_or(&[]);
                Ok(json!({"hex": page.iter().map(|b| format!("{b:02x}")).collect::<String>()}))
            }
            "testRelease" => {
                Ok(json!({"released": self.resources.release(text(args, "resource")?)}))
            }
            "testClose" => {
                let id = text(args, "session")?;
                let closed = self.sessions.close(id);
                Ok(json!({"closed": closed, "released": self.resources.release_session(id)}))
            }
            "testStatus" => Ok(
                json!({"sessions": self.sessions.count(), "resources": self.resources.count(), "held_bytes": self.resources.held_bytes()}),
            ),
            _ => Ok(json!({})),
        }
    }
    fn discard(&mut self, method: &str, result: Value) {
        match method {
            "testOpen" => {
                if let Some(id) = result["session"].as_str() {
                    self.resources.release_session(id);
                    self.sessions.close(id);
                }
            }
            "testRead" => {
                if let Some(handle) = result["resource"].as_str() {
                    self.resources.release(handle);
                }
            }
            _ => {}
        }
    }
}
