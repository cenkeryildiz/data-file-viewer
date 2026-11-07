//! `envelope.v1.schema.json` request/cancel decoding and response encoding.
use crate::errors::{ErrorBody, MALFORMED_REQUEST, UNSUPPORTED};
use crate::{PROTOCOL, UNADDRESSED_ID, VERSION};
use serde_json::{Map, Value, json};

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: String,
        method: String,
        args: Map<String, Value>,
        deadline_ms: Option<u64>,
    },
    Cancel {
        id: String,
    },
}

/// Canonical decimal text of a uint64 (`uint64Text`).
fn uint64_text(v: &Value) -> Option<u64> {
    let s = v.as_str()?;
    if s.len() > 20 || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    s.parse().ok()
}

fn bad(id: &str, message: &str) -> (String, ErrorBody) {
    (id.to_owned(), ErrorBody::new(MALFORMED_REQUEST, message))
}

/// Decode one frame. On error the pair is the id to answer (`"0"` if unusable) and the refusal.
pub fn decode(raw: &[u8]) -> Result<Incoming, (String, ErrorBody)> {
    decode_for(raw, PROTOCOL)
}

/// The same bounded envelope with a feature-specific transport identity.
pub fn decode_for(raw: &[u8], protocol: &str) -> Result<Incoming, (String, ErrorBody)> {
    let text =
        std::str::from_utf8(raw).map_err(|_| bad(UNADDRESSED_ID, "Frame is not valid UTF-8."))?;
    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(text) else {
        return Err(bad(UNADDRESSED_ID, "Frame is not a JSON object."));
    };
    let id = msg
        .get("id")
        .filter(|v| uint64_text(v).is_some())
        .and_then(Value::as_str)
        .map(str::to_owned);
    let addr = id.as_deref().unwrap_or(UNADDRESSED_ID);
    if msg.get("protocol").and_then(Value::as_str) != Some(protocol) {
        return Err(bad(addr, "Unknown protocol."));
    }
    match msg.get("version").and_then(Value::as_u64) {
        Some(VERSION) => {}
        Some(other) => {
            return Err((
                addr.to_owned(),
                ErrorBody::new(
                    UNSUPPORTED,
                    format!(
                        "Protocol version {other} is not supported; this worker speaks {VERSION}."
                    ),
                ),
            ));
        }
        None => return Err(bad(addr, "Version must be an integer.")),
    }
    let Some(id) = id else {
        return Err(bad(UNADDRESSED_ID, "id must be canonical uint64 text."));
    };
    let allowed: &[&str] = match msg.get("kind").and_then(Value::as_str) {
        Some("request") => &[
            "protocol",
            "version",
            "kind",
            "id",
            "method",
            "args",
            "deadline_ms",
        ],
        Some("cancel") => &["protocol", "version", "kind", "id"],
        _ => return Err(bad(&id, "kind must be request or cancel.")),
    };
    if msg.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(bad(&id, "Unexpected field."));
    }
    if msg["kind"] == "cancel" {
        return Ok(Incoming::Cancel { id });
    }
    let method = msg.get("method").and_then(Value::as_str).filter(|m| {
        m.starts_with(|c: char| c.is_ascii_lowercase())
            && m.bytes().all(|b| b.is_ascii_alphanumeric())
    });
    let Some(method) = method else {
        return Err(bad(&id, "method must match ^[a-z][A-Za-z0-9]*$."));
    };
    let Some(Value::Object(args)) = msg.get("args") else {
        return Err(bad(&id, "args must be an object."));
    };
    let deadline_ms = match msg.get("deadline_ms") {
        None => None,
        Some(v) => Some(
            uint64_text(v).ok_or_else(|| bad(&id, "deadline_ms must be canonical uint64 text."))?,
        ),
    };
    Ok(Incoming::Request {
        id,
        method: method.to_owned(),
        args: args.clone(),
        deadline_ms,
    })
}

pub fn success(id: &str, result: Value) -> Value {
    success_for(id, result, PROTOCOL)
}
pub fn success_for(id: &str, result: Value, protocol: &str) -> Value {
    json!({"protocol": protocol, "version": VERSION, "kind": "response", "id": id, "ok": true, "result": result})
}

pub fn failure(id: &str, error: &ErrorBody) -> Value {
    failure_for(id, error, PROTOCOL)
}
pub fn failure_for(id: &str, error: &ErrorBody, protocol: &str) -> Value {
    json!({"protocol": protocol, "version": VERSION, "kind": "response", "id": id, "ok": false, "error": error.to_value()})
}
