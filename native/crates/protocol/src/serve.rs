//! The serve loop: capabilities first, then one reply per request, until input ends.
use crate::envelope::{self, Incoming};
use crate::errors::{ErrorBody, MALFORMED_REQUEST, RESOURCE_LIMIT, UNKNOWN_METHOD};
use crate::framing::{Frame, FrameReader, is_blank};
use crate::sched::Limits;
use crate::{MAX_FRAME_BYTES, PROTOCOL, UNADDRESSED_ID, VERSION};
use serde_json::{Map, Value, json};
use std::io::{self, BufRead, Write};

/// What the engine can really do. Nothing absent here is inferred or answered.
pub struct Capabilities {
    pub name: &'static str,
    pub version: &'static str,
    /// Must be non-empty (schema `minItems: 1`).
    pub methods: Vec<&'static str>,
    pub formats: Vec<Value>,
    pub value_tags: Vec<&'static str>,
    pub time_units: Vec<&'static str>,
}

pub trait Engine {
    fn capabilities(&self) -> Capabilities;
    /// Called only for methods listed in the capabilities.
    fn call(&mut self, method: &str, args: &Map<String, Value>) -> Result<Value, ErrorBody>;
}

pub(crate) fn capabilities_frame(c: &Capabilities, max_frame: usize, limits: &Limits) -> Value {
    capabilities_frame_for(c, max_frame, limits, PROTOCOL)
}
pub(crate) fn capabilities_frame_for(
    c: &Capabilities,
    max_frame: usize,
    limits: &Limits,
    protocol: &str,
) -> Value {
    let mut frame = json!({"protocol": protocol, "version": VERSION, "kind": "capabilities",
        "engine": {"name": c.name, "version": c.version}, "methods": c.methods, "formats": c.formats,
        "value_tags": c.value_tags, "time_units": c.time_units,
        "limits": {"max_frame_bytes": max_frame.to_string(), "sql_bytes": "262144", "result_bytes": "33554432",
            "cell_bytes": "4194304", "queued_requests": limits.queued.to_string(), "deadline_ms": limits.deadline_ms.to_string()}});
    if protocol != PROTOCOL {
        // Feature-specific limits live in that feature's format capability, never implied SQL support.
        let limits = frame["limits"].as_object_mut().expect("object above");
        for key in ["sql_bytes", "result_bytes", "cell_bytes"] {
            limits.remove(key);
        }
    }
    frame
}

pub(crate) fn send(
    out: &mut impl Write,
    frame: &Value,
    max_frame: usize,
    id: &str,
) -> io::Result<bool> {
    send_for(out, frame, max_frame, id, PROTOCOL)
}
pub(crate) fn send_for(
    out: &mut impl Write,
    frame: &Value,
    max_frame: usize,
    id: &str,
    protocol: &str,
) -> io::Result<bool> {
    let mut bytes = serde_json::to_vec(frame).map_err(io::Error::other)?;
    let delivered = bytes.len() <= max_frame;
    if !delivered {
        let e = ErrorBody::new(RESOURCE_LIMIT, "The reply exceeds the frame size limit.");
        bytes = serde_json::to_vec(&envelope::failure_for(id, &e, protocol))
            .map_err(io::Error::other)?;
    }
    bytes.push(b'\n');
    out.write_all(&bytes)?;
    out.flush()?;
    Ok(delivered)
}

pub fn serve<E: Engine>(engine: E, input: impl BufRead, output: impl Write) -> io::Result<i32> {
    serve_with(engine, input, output, MAX_FRAME_BYTES)
}

/// Returns the exit status: 0 when input ends (cleanly or mid-frame); I/O errors propagate.
pub fn serve_with<E: Engine>(
    mut engine: E,
    input: impl BufRead,
    mut out: impl Write,
    max_frame: usize,
) -> io::Result<i32> {
    let caps = engine.capabilities();
    if caps.methods.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "capabilities list no methods",
        ));
    }
    send(
        &mut out,
        &capabilities_frame(&caps, max_frame, &Limits::default()),
        max_frame,
        UNADDRESSED_ID,
    )?;
    let mut frames = FrameReader::new(input, max_frame);
    while let Some(frame) = frames.next_frame()? {
        let line = match frame {
            Frame::Line(line) if is_blank(&line) => continue,
            Frame::Line(line) => line,
            Frame::Oversized => {
                let e = ErrorBody::new(
                    MALFORMED_REQUEST,
                    format!("Frame exceeds {max_frame} bytes."),
                );
                send(
                    &mut out,
                    &envelope::failure(UNADDRESSED_ID, &e),
                    max_frame,
                    UNADDRESSED_ID,
                )?;
                continue;
            }
            Frame::Truncated => {
                let e = ErrorBody::new(MALFORMED_REQUEST, "Input ended inside a frame.");
                send(
                    &mut out,
                    &envelope::failure(UNADDRESSED_ID, &e),
                    max_frame,
                    UNADDRESSED_ID,
                )?;
                break;
            }
        };
        let (id, reply) = match envelope::decode(&line) {
            Err((id, e)) => (id.clone(), envelope::failure(&id, &e)),
            // Requests run to completion synchronously, so a cancel never finds one in flight (D3.3 queues).
            Ok(Incoming::Cancel { .. }) => continue,
            Ok(Incoming::Request {
                id, method, args, ..
            }) => {
                let result = if caps.methods.contains(&method.as_str()) {
                    engine.call(&method, &args)
                } else {
                    Err(ErrorBody::new(UNKNOWN_METHOD, "Unknown method."))
                };
                let reply = match result {
                    Ok(v) => envelope::success(&id, v),
                    Err(e) => envelope::failure(&id, &e),
                };
                (id, reply)
            }
        };
        send(&mut out, &reply, max_frame, &id)?;
    }
    Ok(0)
}
