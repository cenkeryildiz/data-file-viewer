//! DuckDB values as JSON, exactly. Integers past 2^53 and every decimal become strings so a JS-side
//! consumer never rounds them; dates and times use DuckDB's own text form (`cast(x as varchar)`).
use duckdb::types::{TimeUnit, Value};
use serde_json::Value as J;

pub const WIRE_TAGS: [&str; 22] = [
    "int8",
    "int16",
    "int32",
    "int64",
    "int128",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uint128",
    "float32",
    "float64",
    "decimal",
    "date",
    "time",
    "timestamp",
    "interval",
    "binary",
    "uuid",
    "list",
    "struct",
    "map",
];

const MAX_SAFE: i128 = 9_007_199_254_740_991;

fn int(v: i128) -> J {
    if (-MAX_SAFE..=MAX_SAFE).contains(&v) {
        J::from(v as i64)
    } else {
        J::String(v.to_string())
    }
}
fn float(v: f64) -> J {
    // JSON has no NaN/Infinity; the text keeps the distinction instead of a silent null.
    serde_json::Number::from_f64(v).map_or_else(|| J::String(v.to_string()), J::Number)
}

/// (year, month, day) of a day count since 1970-01-01 (proleptic Gregorian; Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}
fn date_text(days: i64) -> String {
    let (y, m, d) = civil(days);
    if y > 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{:04}-{m:02}-{d:02} (BC)", 1 - y)
    }
}
fn clock(nanos_of_day: i64, digits: usize) -> String {
    let (s, frac) = (
        nanos_of_day.div_euclid(1_000_000_000),
        nanos_of_day.rem_euclid(1_000_000_000),
    );
    let mut out = format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60);
    if frac != 0 {
        let text = format!("{frac:09}");
        out.push('.');
        out.push_str(text[..digits].trim_end_matches('0'));
    }
    out
}
fn per_second(unit: TimeUnit) -> i64 {
    match unit {
        TimeUnit::Second => 1,
        TimeUnit::Millisecond => 1_000,
        TimeUnit::Microsecond => 1_000_000,
        TimeUnit::Nanosecond => 1_000_000_000,
    }
}
fn nanos(unit: TimeUnit, v: i64) -> i128 {
    i128::from(v) * i128::from(1_000_000_000 / per_second(unit))
}
fn digits(unit: TimeUnit) -> usize {
    match unit {
        TimeUnit::Second => 0,
        TimeUnit::Millisecond => 3,
        TimeUnit::Microsecond => 6,
        TimeUnit::Nanosecond => 9,
    }
}
fn timestamp(unit: TimeUnit, v: i64) -> String {
    if v == i64::MAX {
        return "infinity".into();
    }
    if v == -i64::MAX {
        return "-infinity".into();
    }
    let n = nanos(unit, v);
    let (days, rem) = (
        n.div_euclid(86_400_000_000_000),
        n.rem_euclid(86_400_000_000_000),
    );
    format!("{} {}", date_text(days as i64), clock(rem as i64, 9))
}
fn interval(months: i32, days: i32, nanos: i64) -> String {
    let mut parts = vec![];
    let (years, months) = (months / 12, months % 12);
    for (n, unit) in [(years, "year"), (months, "month"), (days, "day")] {
        if n != 0 {
            parts.push(format!(
                "{n} {unit}{}",
                if matches!(n, -1 | 1) { "" } else { "s" }
            ));
        }
    }
    if nanos != 0 || parts.is_empty() {
        let sign = if nanos < 0 { "-" } else { "" };
        parts.push(format!("{sign}{}", clock(nanos.abs(), 6)));
    }
    parts.join(" ")
}
/// DuckDB prints printable ASCII as is and every other byte (and the backslash) as `\xHH`.
fn blob(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, b| {
        if (0x20..0x7f).contains(b) && *b != b'\\' && *b != b'\'' && *b != b'"' {
            out.push(*b as char);
        } else {
            out.push_str(&format!("\\x{b:02X}"));
        }
        out
    })
}

pub fn to_json(value: Value) -> J {
    match value {
        Value::Null => J::Null,
        Value::Boolean(b) => J::Bool(b),
        Value::TinyInt(v) => int(v.into()),
        Value::SmallInt(v) => int(v.into()),
        Value::Int(v) => int(v.into()),
        Value::BigInt(v) => int(v.into()),
        Value::HugeInt(v) => int(v),
        Value::UTinyInt(v) => int(v.into()),
        Value::USmallInt(v) => int(v.into()),
        Value::UInt(v) => int(v.into()),
        Value::UBigInt(v) => int(v.into()),
        Value::UHugeInt(v) => i128::try_from(v).map_or_else(|_| J::String(v.to_string()), int),
        Value::Float(v) => float(f64::from(v)),
        Value::Double(v) => float(v),
        Value::Decimal(d) => J::String(d.to_string()),
        Value::Timestamp(unit, v) => J::String(timestamp(unit, v)),
        Value::Date32(d) if d == i32::MAX => J::String("infinity".into()),
        Value::Date32(d) if d == -i32::MAX => J::String("-infinity".into()),
        Value::Date32(d) => J::String(date_text(d.into())),
        Value::Time64(unit, v) => J::String(clock(nanos(unit, v) as i64, digits(unit).max(6))),
        Value::Interval { months, days, nanos } => J::String(interval(months, days, nanos)),
        Value::Text(s) | Value::Enum(s) => J::String(s),
        Value::Blob(b) | Value::Geometry(b) => J::String(blob(&b)),
        Value::List(v) | Value::Array(v) => J::Array(v.into_iter().map(to_json).collect()),
        Value::Struct(map) => J::Object(map.iter().map(|(k, v)| (k.clone(), to_json(v.clone()))).collect()),
        // The JS driver's shape for a MAP: a list of {key, value}.
        Value::Map(map) => J::Array(
            map.iter()
                .map(|(k, v)| serde_json::json!({"key": to_json(k.clone()), "value": to_json(v.clone())}))
                .collect(),
        ),
        Value::Union(inner) => to_json(*inner),
        // `Value` is non-exhaustive; a variant added later must not become silent data loss.
        other => J::String(format!("{other:?}")),
    }
}

/// The logical type, rather than Arrow's optional timezone metadata, determines UTC display.
pub fn to_json_with_timezone(value: Value, utc: bool) -> J {
    match to_json(value) {
        J::String(text) if utc && !text.ends_with("infinity") => J::String(text + "+00"),
        other => other,
    }
}

/// A column's exact protocol type; unsupported logical types never become display strings.
pub fn wire_type(t: &duckdb::core::LogicalTypeHandle) -> Result<J, crate::Error> {
    wire_type_at(t, 0)
}
fn wire_type_at(t: &duckdb::core::LogicalTypeHandle, depth: usize) -> Result<J, crate::Error> {
    if depth > 32 {
        return Err(crate::Error::Unsupported(
            "Nested types exceed the supported depth of 32.".into(),
        ));
    }
    use duckdb::core::LogicalTypeId::*;
    let id = match t.id() {
        SqlNull => "null",
        Boolean => "bool",
        Tinyint => "int8",
        Smallint => "int16",
        Integer => "int32",
        Bigint => "int64",
        Hugeint => "int128",
        UTinyint => "uint8",
        USmallint => "uint16",
        UInteger => "uint32",
        UBigint => "uint64",
        UHugeint => "uint128",
        Float => "float32",
        Double => "float64",
        Varchar | Enum | StringLiteral => "utf8",
        Blob => "binary",
        Uuid => "uuid",
        Date => "date",
        Interval => "interval",
        Decimal => {
            return Ok(
                serde_json::json!({"id":"decimal","precision":t.decimal_width(),"scale":t.decimal_scale()}),
            );
        }
        Time => return Ok(serde_json::json!({"id":"time","unit":"us"})),
        TimeNs => return Ok(serde_json::json!({"id":"time","unit":"ns"})),
        Timestamp | TimestampS | TimestampMs | TimestampNs | TimestampTZ => {
            return Ok(
                serde_json::json!({"id":"timestamp","unit":match t.id(){TimestampS=>"s",TimestampMs=>"ms",TimestampNs=>"ns",_=>"us"},"tz":if t.id()==TimestampTZ{Some("UTC")}else{None}}),
            );
        }
        List | Array => {
            return Ok(
                serde_json::json!({"id":"list","child":wire_type_at(&t.child(0), depth + 1)?}),
            );
        }
        Struct => {
            let mut names = std::collections::HashSet::new();
            let fields = (0..t.num_children()).map(|i| {
                let name = t.try_child_name(i)?;
                if !names.insert(name.clone()) {
                    return Err(crate::Error::Unsupported("Duplicate struct field names cannot be represented exactly.".into()));
                }
                Ok(serde_json::json!({"name":name,"type":wire_type_at(&t.child(i), depth + 1)?}))
            }).collect::<Result<Vec<J>, crate::Error>>()?;
            return Ok(serde_json::json!({"id":"struct","fields":fields}));
        }
        Map => {
            return Ok(
                serde_json::json!({"id":"map","key":wire_type_at(&t.child(0), depth + 1)?,"value":wire_type_at(&t.child(1), depth + 1)?}),
            );
        }
        _ => {
            return Err(crate::Error::Unsupported(format!(
                "The native wire profile does not yet support {t:?}."
            )));
        }
    };
    Ok(serde_json::json!({"id":id}))
}
fn wire_unit(unit: TimeUnit) -> &'static str {
    match unit {
        TimeUnit::Second => "s",
        TimeUnit::Millisecond => "ms",
        TimeUnit::Microsecond => "us",
        TimeUnit::Nanosecond => "ns",
    }
}
fn wire_float(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        value.to_string()
    }
}
/// Values carry their original storage type and canonical decimal text across the JSON boundary.
pub fn to_wire(value: Value, column: &J) -> Result<J, crate::Error> {
    wire_value_at(value, column, 0)
}
fn wire_value_at(value: Value, column: &J, depth: usize) -> Result<J, crate::Error> {
    if depth > 32 {
        return Err(crate::Error::Unsupported(
            "Nested values exceed the supported depth of 32.".into(),
        ));
    }
    use base64::Engine as _;
    let tagged = |tag: &str, text: String| serde_json::json!({"$t":tag,"v":text});
    let result = match value {
        Value::Null => J::Null,
        Value::Boolean(v) => J::Bool(v),
        Value::TinyInt(v) => tagged("int8", v.to_string()),
        Value::SmallInt(v) => tagged("int16", v.to_string()),
        Value::Int(v) => tagged("int32", v.to_string()),
        Value::BigInt(v) => tagged("int64", v.to_string()),
        Value::HugeInt(v) => tagged("int128", v.to_string()),
        Value::UTinyInt(v) => tagged("uint8", v.to_string()),
        Value::USmallInt(v) => tagged("uint16", v.to_string()),
        Value::UInt(v) => tagged("uint32", v.to_string()),
        Value::UBigInt(v) => tagged("uint64", v.to_string()),
        Value::UHugeInt(v) => tagged("uint128", v.to_string()),
        Value::Float(v) => tagged("float32", wire_float(f64::from(v))),
        Value::Double(v) => tagged("float64", wire_float(v)),
        Value::Decimal(v) => {
            serde_json::json!({"$t":"decimal","v":v.to_string(),"precision":v.width(),"scale":v.scale()})
        }
        Value::Timestamp(unit, v) => {
            serde_json::json!({"$t":"timestamp","v":v.to_string(),"unit":wire_unit(unit),"tz":column["tz"]})
        }
        Value::Date32(v) => tagged("date", v.to_string()),
        Value::Time64(unit, v) => {
            serde_json::json!({"$t":"time","v":v.to_string(),"unit":wire_unit(unit)})
        }
        Value::Interval {
            months,
            days,
            nanos,
        } => {
            serde_json::json!({"$t":"interval","months":months.to_string(),"days":days.to_string(),"nanos":nanos.to_string()})
        }
        Value::Text(v) if column["id"] == "uuid" => tagged("uuid", v.to_ascii_lowercase()),
        Value::Text(v) | Value::Enum(v) => J::String(v),
        Value::Blob(v) => {
            serde_json::json!({"$t":"binary","encoding":"base64","v":base64::engine::general_purpose::STANDARD.encode(v)})
        }
        Value::List(values) | Value::Array(values) if column["id"] == "list" => {
            let cells = values
                .into_iter()
                .map(|v| wire_value_at(v, &column["child"], depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            serde_json::json!({"$t":"list","v":cells})
        }
        Value::Struct(values) if column["id"] == "struct" => {
            let fields = column["fields"].as_array().ok_or_else(|| {
                crate::Error::Unsupported("The struct field metadata is missing.".into())
            })?;
            let mut pairs = vec![];
            for ((name, value), field) in values.iter().zip(fields) {
                if field["name"] != *name {
                    return Err(crate::Error::Unsupported(
                        "The struct value and its field metadata disagree.".into(),
                    ));
                }
                pairs.push(serde_json::json!([
                    name,
                    wire_value_at(value.clone(), &field["type"], depth + 1)?
                ]));
            }
            if pairs.len() != fields.len() || values.iter().count() != fields.len() {
                return Err(crate::Error::Unsupported(
                    "The struct value and its field metadata disagree.".into(),
                ));
            }
            serde_json::json!({"$t":"struct","v":pairs})
        }
        Value::Map(values) if column["id"] == "map" => {
            let pairs = values
                .iter()
                .map(|(key, value)| {
                    Ok(serde_json::json!([
                        wire_value_at(key.clone(), &column["key"], depth + 1)?,
                        wire_value_at(value.clone(), &column["value"], depth + 1)?
                    ]))
                })
                .collect::<Result<Vec<J>, crate::Error>>()?;
            serde_json::json!({"$t":"map","v":pairs})
        }
        _ => {
            return Err(crate::Error::Unsupported(
                "This value cannot be represented by the native wire profile.".into(),
            ));
        }
    };
    if !result.is_null() {
        let actual = if result.is_boolean() {
            "bool"
        } else if result.is_string() {
            "utf8"
        } else {
            result["$t"].as_str().unwrap_or("")
        };
        if Some(actual) != column["id"].as_str() {
            return Err(crate::Error::Unsupported(
                "The query value and its declared logical type disagree.".into(),
            ));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimum_interval_days_never_overflows() {
        assert_eq!(
            to_json(Value::Interval {
                months: 0,
                days: i32::MIN,
                nanos: 0
            }),
            J::String("-2147483648 days".into())
        );
    }
    #[test]
    fn minimum_huge_integer_never_overflows_or_rounds() {
        assert_eq!(
            to_json(Value::HugeInt(i128::MIN)),
            J::String(i128::MIN.to_string())
        );
        assert_eq!(
            to_json(Value::BigInt(9_007_199_254_740_992)),
            J::String("9007199254740992".into())
        );
        assert_eq!(
            to_wire(
                Value::HugeInt(i128::MIN),
                &serde_json::json!({"id":"int128"})
            )
            .unwrap(),
            serde_json::json!({"$t":"int128","v":i128::MIN.to_string()})
        );
    }
}
