//! D3.17 writes, support half: wire values as the writers need them, the durable mutation ledger (the
//! outcome-by-id lookup that makes a blind retry unnecessary), publish-error reconciliation and receipt JSON.
use dfv_table_protocol::ErrorBody;
use dfv_table_protocol::errors::*;
use dfv_table_publication::{Kind, PublishError, PublishedDetails, Publisher, Receipt, Status};
use serde_json::{Map, Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

/// A cell value as a writer needs it. Rich wire tags (date, timestamp, time, decimal, uuid) arrive as their
/// canonical display text; tags that no writer can store exactly (binary, interval, nested) are refused.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Scalar {
    Null,
    Bool(bool),
    Int(i128),
    Float(f64),
    Text(String),
}

fn unsupported(tag: &str) -> ErrorBody {
    ErrorBody::new(
        UNSUPPORTED,
        format!("Editing rows that hold {tag} values is not supported."),
    )
    .outcome("not-published")
}
fn malformed(what: &str) -> ErrorBody {
    ErrorBody::new(MALFORMED_VALUE, what.to_owned()).outcome("not-published")
}

/// Proleptic Gregorian date of a day count since 1970-01-01 (Hinnant's civil_from_days).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
/// Day count since 1970-01-01 of a calendar date, `None` when it is not a real date.
#[cfg(test)]
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let last = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ][m as usize - 1];
    if d > last {
        return None;
    }
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    Some(era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468)
}
fn ticks(unit: &str) -> Option<i128> {
    Some(match unit {
        "s" => 1,
        "ms" => 1_000,
        "us" => 1_000_000,
        "ns" => 1_000_000_000,
        _ => return None,
    })
}
fn clock(seconds: i128, fraction: i128, per: i128) -> String {
    let mut text = format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60
    );
    if fraction != 0 {
        let digits = per.to_string().len() - 1;
        text.push('.');
        text.push_str(format!("{fraction:0digits$}").trim_end_matches('0'));
    }
    text
}
fn date_text(days: i64) -> String {
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `{"$t":..,"v":..}` and plain JSON scalars, as the host sends them.
pub(crate) fn scalar(value: &Value) -> Result<Scalar, ErrorBody> {
    match value {
        Value::Null => Ok(Scalar::Null),
        Value::Bool(b) => Ok(Scalar::Bool(*b)),
        Value::String(s) => Ok(Scalar::Text(s.clone())),
        Value::Number(n) => Ok(n
            .as_i64()
            .map(|i| Scalar::Int(i128::from(i)))
            .or_else(|| n.as_u64().map(|u| Scalar::Int(i128::from(u))))
            .or_else(|| n.as_f64().map(Scalar::Float))
            .expect("a JSON number is an integer or a float")),
        Value::Object(map) => tagged(map),
        Value::Array(_) => Err(unsupported("nested")),
    }
}
fn tagged(map: &Map<String, Value>) -> Result<Scalar, ErrorBody> {
    let tag = map.get("$t").and_then(Value::as_str);
    let v = map.get("v").and_then(Value::as_str);
    let (Some(tag), Some(v)) = (tag, v) else {
        return Err(unsupported("nested"));
    };
    let bad = || malformed("A typed value is not in its canonical form.");
    match tag {
        "int8" | "int16" | "int32" | "int64" | "int128" | "uint8" | "uint16" | "uint32"
        | "uint64" | "uint128" => v.parse().map(Scalar::Int).map_err(|_| bad()),
        "float32" | "float64" => v.parse().map(Scalar::Float).map_err(|_| bad()),
        "decimal" | "uuid" => Ok(Scalar::Text(v.to_owned())),
        "date" => v
            .parse::<i32>()
            .map(|days| Scalar::Text(date_text(i64::from(days))))
            .map_err(|_| bad()),
        "time" | "timestamp" => {
            let per =
                ticks(map.get("unit").and_then(Value::as_str).unwrap_or("")).ok_or_else(bad)?;
            let n: i128 = v.parse().map_err(|_| bad())?;
            let (secs, frac) = (n.div_euclid(per), n.rem_euclid(per));
            if tag == "time" {
                if !(0..86_400).contains(&secs) {
                    return Err(bad());
                }
                return Ok(Scalar::Text(clock(secs, frac, per)));
            }
            let days = i32::try_from(secs.div_euclid(86_400)).map_err(|_| bad())?;
            let utc = map.get("tz").is_some_and(|tz| !tz.is_null());
            Ok(Scalar::Text(format!(
                "{} {}{}",
                date_text(i64::from(days)),
                clock(secs.rem_euclid(86_400), frac, per),
                if utc { "+00" } else { "" }
            )))
        }
        other => Err(unsupported(other)),
    }
}

impl Scalar {
    /// The text a text-based writer matches or stores; `None` is NULL.
    pub(crate) fn text(&self) -> Option<String> {
        match self {
            Self::Null => None,
            Self::Bool(b) => Some(b.to_string()),
            Self::Int(i) => Some(i.to_string()),
            Self::Float(f) => Some(dfv_table_xlsx_patch::xlsx_patch::js_number_string(*f)),
            Self::Text(s) => Some(s.clone()),
        }
    }
}

/// The writer's failure: what to tell the caller, and the publication record to look up if one exists.
pub(crate) struct Fail {
    pub body: ErrorBody,
    pub receipt_id: Option<String>,
}
impl From<ErrorBody> for Fail {
    fn from(body: ErrorBody) -> Self {
        Self {
            body,
            receipt_id: None,
        }
    }
}

/// A refusal before anything was written.
pub(crate) fn refuse(code: &'static str, message: &str) -> Fail {
    ErrorBody::new(code, message.to_owned())
        .outcome("not-published")
        .into()
}

pub(crate) enum Published {
    /// The destination holds the new bytes. `reconciled` when the writer could not say so itself.
    /// `receipt` is `None` for an in-place commit (SQLite), which publishes nothing by rename.
    Yes {
        receipt: Option<Receipt>,
        reconciled: bool,
    },
    /// Nothing matched; nothing was written.
    NoMatch,
}

/// Turn a publication failure into the truth. A failure that might have landed is resolved from the durable
/// record, never replayed: published becomes a reconciled success, anything unclear is `mutation_unknown`.
pub(crate) fn reconcile(publisher: &Publisher, e: PublishError) -> Result<Published, Fail> {
    if let Some(id) = e.receipt_id.clone() {
        return match publisher.status(&id) {
            Status::Published { durable, .. } => Ok(Published::Yes {
                receipt: Some(Receipt {
                    id,
                    durable,
                }),
                reconciled: true,
            }),
            Status::NotPublished => Err(Fail {
                body: ErrorBody::new(
                    MUTATION_NOT_PUBLISHED,
                    "The save did not complete; the file still holds its earlier content.",
                )
                .outcome("not-published"),
                receipt_id: Some(id),
            }),
            Status::Unconfirmed | Status::Absent => Err(Fail {
                body: ErrorBody::new(
                    MUTATION_UNKNOWN,
                    "The save may or may not have completed. Look the outcome up before editing again.",
                )
                .outcome("unknown"),
                receipt_id: Some(id),
            }),
        };
    }
    let (code, message, outcome) = match e.kind {
        Kind::Refused => (
            POLICY_REFUSED,
            "The destination may not be replaced.",
            "not-published",
        ),
        Kind::Locked => (
            RUNTIME_BUSY,
            "Another writer is saving this file.",
            "not-published",
        ),
        Kind::DiskFull => (
            RESOURCE_LIMIT,
            "The disk or quota is full.",
            "not-published",
        ),
        Kind::Changed => (
            STALE_SOURCE,
            "The file changed after it was read; reopen it.",
            "not-published",
        ),
        Kind::Io | Kind::Mismatch => (
            QUERY_FAILED,
            "The file could not be saved.",
            "not-published",
        ),
        Kind::Unconfirmed => (
            MUTATION_UNKNOWN,
            "The save may or may not have completed. Look the outcome up before editing again.",
            "unknown",
        ),
    };
    Err(ErrorBody::new(code, message).outcome(outcome).into())
}

/// `Receipt` -> `mutation-receipt.v1` `directory_sync`.
fn sync_word(durable: bool) -> &'static str {
    if durable { "synced" } else { "failed" }
}

pub(crate) fn mtime_json(ns: u128) -> Value {
    json!({"$t":"timestamp","v":ns.to_string(),"unit":"ns","tz":"UTC"})
}

pub(crate) fn file_identity(path: &Path) -> std::io::Result<(u64, u128)> {
    let meta = fs::metadata(path)?;
    let ns = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    Ok((meta.len(), ns))
}

/// `mutation-receipt.v1`. `after` is the destination as it is now (`None` for a backup, which leaves the source alone).
pub(crate) struct ReceiptJson<'a> {
    pub operation: &'static str,
    pub rows_changed: u64,
    pub kind: &'a str,
    pub path: &'a Path,
    pub before: (u64, u128, &'a str, u64),
    pub after: Option<(u64, u128)>,
    pub backup_path: Option<&'a Path>,
    pub receipt: Option<(&'a Receipt, bool)>,
}
impl ReceiptJson<'_> {
    pub(crate) fn value(&self) -> Value {
        let (size, mtime, sha, revision) = self.before;
        let identity = |size: u64, mtime: u128, sha: Option<&str>, revision: u64| {
            let mut v = json!({"file_kind":self.kind,"path":self.path.to_string_lossy(),
                "size":size.to_string(),"mtime":mtime_json(mtime),"revision":revision.to_string()});
            if let Some(sha) = sha {
                v["sha256"] = json!(sha);
            }
            v
        };
        let mut out = json!({"operation":self.operation,"outcome":"published",
            "rows_changed":self.rows_changed.to_string(),
            "source_before":identity(size, mtime, Some(sha), revision),
            // The session publishes the next generation when it next sees the changed file.
            "source_after":self.after.map_or(Value::Null, |(s, m)| identity(s, m, None, revision + 1)),
            "reconciled":self.receipt.is_some_and(|(_, r)| r),
            "directory_sync":self.receipt.map_or("unsupported", |(r, _)| sync_word(r.durable)),
            "recovered":[],"notices":[]});
        if let Some(path) = self.backup_path {
            out["backup_path"] = json!(path.to_string_lossy());
        }
        out
    }
}

/// One small file per mutation id under the state directory, so a worker that dies mid-save can still be asked
/// what happened. `pending` is written before anything changes; `done` records the settled outcome.
pub(crate) struct Ledger(pub PathBuf);
impl Ledger {
    fn file(&self, id: &str) -> PathBuf {
        self.0.join(format!("mutation-{id}.json"))
    }
    fn write(&self, id: &str, record: &Value, create: bool) -> std::io::Result<()> {
        let tmp = self.0.join(format!(".mutation-{id}.tmp"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        file.write_all(record.to_string().as_bytes())?;
        file.sync_all()?;
        let result = if create {
            // The id is single-use: linking fails if a record already exists.
            let linked = fs::hard_link(&tmp, self.file(id));
            let _ = fs::remove_file(&tmp);
            linked
        } else {
            fs::rename(&tmp, self.file(id))
        };
        result?;
        fs::File::open(&self.0)?.sync_all()
    }
    pub(crate) fn begin(
        &self,
        id: &str,
        template: &Value,
        publication_id: Option<&str>,
    ) -> Result<(), ErrorBody> {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.0)
            .and_then(|()| {
                self.write(
                    id,
                    &json!({"format":"dfv-table-mutation","version":1,"state":"pending","receipt_template":template,"receipt_id":publication_id}),
                    true,
                )
            })
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    malformed("This mutation id was already used; look up its outcome instead of repeating it.")
                } else {
                    ErrorBody::new(QUERY_FAILED, "The mutation ledger could not be written.")
                        .outcome("not-published")
                }
            })
    }
    pub(crate) fn finish(&self, id: &str, state: &str, receipt_id: Option<&str>) {
        let mut record = self.read(id).unwrap_or_else(|| json!({}));
        record["state"] = json!(state);
        if let Some(rid) = receipt_id {
            if record["receipt_id"].is_null() {
                record["receipt_id"] = json!(rid);
            } else if record["receipt_id"] != rid {
                record["state"] = json!("unknown");
            }
        }
        // Best effort: the publication receipt is the durable truth; this only names it.
        let _ = self.write(id, &record, false);
    }
    pub(crate) fn read(&self, id: &str) -> Option<Value> {
        let meta = fs::symlink_metadata(self.file(id)).ok()?;
        if !meta.is_file() || meta.len() > 1 << 20 {
            return None;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.file(id))
            .ok()?;
        serde_json::from_reader(file).ok()
    }
    pub(crate) fn finish_result(
        &self,
        id: &str,
        receipt: &Value,
        receipt_id: Option<&str>,
    ) -> Result<(), ErrorBody> {
        let mut record = self.read(id).ok_or_else(|| {
            ErrorBody::new(MUTATION_UNKNOWN, "The save result could not be recorded.")
                .outcome("unknown")
        })?;
        if receipt_id.is_some_and(|rid| {
            record["receipt_id"]
                .as_str()
                .is_some_and(|bound| bound != rid)
        }) {
            return Err(ErrorBody::new(
                MUTATION_UNKNOWN,
                "The publication does not match the reserved mutation.",
            )
            .outcome("unknown"));
        }
        record["state"] = json!("published");
        record["receipt"] = receipt.clone();
        if let Some(id) = receipt_id {
            record["receipt_id"] = json!(id);
        }
        self.write(id, &record, false).map_err(|_| {
            ErrorBody::new(
                MUTATION_UNKNOWN,
                "The save result could not be recorded; look it up before trying again.",
            )
            .outcome("unknown")
        })
    }

    pub(crate) fn resolve(&self, id: &str, publisher: &Publisher) -> Value {
        let unknown = || json!({"outcome":"unknown"});
        let Some(record) = self.read(id) else {
            return unknown();
        };
        if let Some(receipt) = record.get("receipt") {
            return json!({"outcome":"published","receipt":receipt});
        }
        if record["state"] == "not-published" {
            return json!({"outcome":"not-published"});
        }
        if record["format"] != "dfv-table-mutation" || record["version"] != 1 {
            return unknown();
        }
        let Some(publication_id) = record["receipt_id"].as_str() else {
            return unknown();
        };
        match publisher.inspect_matching(publication_id, |target, original| {
            publication_matches(&record["receipt_template"], target, original)
        }) {
            Ok(published) => {
                let Some(receipt) = recovered_receipt(&record["receipt_template"], &published)
                else {
                    return unknown();
                };
                // The existing durable mapping and publication proof suffice even if this optional cache write fails.
                let _ = self.finish_result(id, &receipt, Some(publication_id));
                json!({"outcome":"published","receipt":receipt})
            }
            Err(Status::NotPublished) => {
                self.finish(id, "not-published", Some(publication_id));
                json!({"outcome":"not-published"})
            }
            Err(_) => unknown(),
        }
    }
}

fn publication_matches(template: &Value, target: &Path, original: Option<(u64, &str)>) -> bool {
    let check = || {
        let before = template.get("source_before")?;
        let source = Path::new(before.get("path")?.as_str()?);
        let kind = before.get("file_kind")?.as_str()?;
        let size = before.get("size")?.as_str()?.parse::<u64>().ok()?;
        let sha = before.get("sha256")?.as_str()?;
        Some(match template.get("operation")?.as_str()? {
            "updateCell" => kind != "sqlite" && target == source && original == Some((size, sha)),
            "createBackup" => original.is_none() && is_backup_target(source, target),
            _ => false,
        })
    };
    check() == Some(true)
}

fn recovered_receipt(template: &Value, published: &PublishedDetails) -> Option<Value> {
    let before = template.get("source_before")?.as_object()?;
    let source = Path::new(before.get("path")?.as_str()?);
    if !source.is_absolute() {
        return None;
    }
    let old_size = before.get("size")?.as_str()?.parse::<u64>().ok()?;
    let revision = before.get("revision")?.as_str()?.parse::<u64>().ok()?;
    let sha = before.get("sha256")?.as_str()?;
    let kind = before.get("file_kind")?.as_str()?;
    let canonical_size = old_size.to_string();
    let canonical_revision = revision.to_string();
    if !matches!(
        kind,
        "csv" | "parquet" | "arrow" | "feather" | "duckdb" | "sqlite" | "xlsx"
    ) || sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || before["size"].as_str()? != canonical_size
        || before["revision"].as_str()? != canonical_revision
    {
        return None;
    }
    let mut result = template.clone();
    match template["operation"].as_str()? {
        "updateCell" => {
            if kind == "sqlite"
                || published.target != source
                || !matches!(&published.original,Some((size,hash)) if *size==old_size && hash==sha)
            {
                return None;
            }
            let mut after = Value::Object(before.clone());
            after["size"] = json!(published.length.to_string());
            after["mtime"] = mtime_json(published.mtime_ns);
            after["sha256"] = json!(published.sha256);
            after["revision"] = json!(revision.checked_add(1)?.to_string());
            result["source_after"] = after;
            result["rows_changed"] = json!("1");
        }
        "createBackup" => {
            if published.original.is_some()
                || !is_backup_target(source, &published.target)
                || (kind != "sqlite" && (published.length != old_size || published.sha256 != sha))
            {
                return None;
            }
            result["backup_path"] = json!(published.target.to_str()?);
            result["source_after"] = Value::Null;
            result["rows_changed"] = json!("0");
        }
        _ => return None,
    }
    result["outcome"] = json!("published");
    result["reconciled"] = json!(true);
    result["directory_sync"] = json!(sync_word(published.receipt.durable));
    Some(result)
}

pub(crate) fn is_backup_target(source: &Path, target: &Path) -> bool {
    let check = || {
        if source.parent() != target.parent() || source == target {
            return None;
        }
        let stem = source.file_stem()?.to_str()?;
        let extension = source
            .extension()
            .map_or(Some(String::new()), |e| Some(format!(".{}", e.to_str()?)))?;
        let name = target
            .file_name()?
            .to_str()?
            .strip_prefix(&format!("{stem}.backup-"))?
            .strip_suffix(&extension)?;
        let (stamp, nonce) = name.rsplit_once('-')?;
        Some(
            stamp.len() == 15
                && stamp.bytes().enumerate().all(|(i, b)| {
                    if i == 8 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
                && nonce.len() == 8
                && nonce
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        )
    };
    check() == Some(true)
}

pub(crate) fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_publication_recovers_lost_result_and_refuses_unbound_proof() {
        let dir = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(dir.path()).unwrap().join("rows.csv");
        let old = b"id,name\n1,alpha\n";
        fs::write(&path, old).unwrap();
        let sha = dfv_table_publication::publication::digest(old);
        let template = ReceiptJson {
            operation: "updateCell",
            rows_changed: 1,
            kind: "csv",
            path: &path,
            before: (old.len() as u64, 0, &sha, 7),
            after: None,
            backup_path: None,
            receipt: None,
        }
        .value();
        let (publisher, rid) = Publisher::new(&dir.path().join("receipts"), Default::default())
            .unwrap()
            .reserve()
            .unwrap();
        let ledger = Ledger(dir.path().join("ledger"));
        ledger.begin("lost", &template, Some(&rid)).unwrap();
        assert_eq!(ledger.resolve("lost", &publisher)["outcome"], "unknown");
        let lock = publisher.lock(&path).unwrap();
        publisher
            .publish(&lock, b"id,name\n1,changed\n", None)
            .unwrap();
        let receipt_path = dir.path().join("receipts").join(format!("{rid}.json"));
        let original_record = fs::read(&receipt_path).unwrap();
        fs::write(&receipt_path, b"not json").unwrap();
        assert_eq!(ledger.resolve("lost", &publisher)["outcome"], "unknown");
        fs::remove_file(&receipt_path).unwrap();
        assert_eq!(ledger.resolve("lost", &publisher)["outcome"], "unknown");
        fs::write(&receipt_path, original_record).unwrap();
        assert!(
            ledger
                .finish_result("lost", &json!({}), Some("foreign"))
                .is_err()
        );
        let recovered = ledger.resolve("lost", &publisher);
        assert_eq!(recovered["outcome"], "published");
        assert_eq!(recovered["receipt"]["source_after"]["revision"], "8");
        assert_eq!(recovered["receipt"]["reconciled"], true);
        assert_eq!(ledger.resolve("lost", &publisher), recovered);
        assert!(ledger.begin("lost", &template, Some(&rid)).is_err());
        let mut wrong = template.clone();
        wrong["source_before"]["path"] = json!(dir.path().join("other.csv"));
        ledger.begin("wrong", &wrong, Some(&rid)).unwrap();
        assert_eq!(ledger.resolve("wrong", &publisher)["outcome"], "unknown");
        let mut sqlite = template;
        sqlite["source_before"]["file_kind"] = json!("sqlite");
        ledger.begin("sqlite", &sqlite, None).unwrap();
        assert_eq!(ledger.resolve("sqlite", &publisher)["outcome"], "unknown");
    }

    #[test]
    fn dates_round_trip_and_reject_impossible_days() {
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (1969, 12, 31), (2024, 12, 31)] {
            let days = days_from_civil(y, m, d).unwrap();
            assert_eq!(civil(days), (y, m, d));
        }
        assert_eq!(days_from_civil(1900, 2, 29), None);
        assert_eq!(days_from_civil(2024, 13, 1), None);
    }
    #[test]
    fn wire_values_keep_exact_integers_and_refuse_binary() {
        assert_eq!(
            scalar(&json!({"$t":"int64","v":"9007199254740993"})).unwrap(),
            Scalar::Int(9_007_199_254_740_993)
        );
        assert_eq!(
            scalar(&json!({"$t":"date","v":"19723"})).unwrap(),
            Scalar::Text("2024-01-01".into())
        );
        assert_eq!(
            scalar(&json!({"$t":"timestamp","v":"1500000","unit":"ms","tz":null})).unwrap(),
            Scalar::Text("1970-01-01 00:25:00".into())
        );
        let err = scalar(&json!({"$t":"binary","encoding":"base64","v":"AA=="})).unwrap_err();
        assert_eq!(
            (err.code, err.mutation_outcome),
            (UNSUPPORTED, Some("not-published"))
        );
        assert_eq!(scalar(&json!(1.5)).unwrap().text().as_deref(), Some("1.5"));
    }
    #[test]
    fn a_mutation_id_is_single_use_and_settles() {
        let dir = std::env::temp_dir().join(format!("dfv-ledger-{}", std::process::id()));
        let ledger = Ledger(dir.clone());
        ledger.begin("a-1", &json!({}), None).unwrap();
        assert_eq!(
            ledger.begin("a-1", &json!({}), None).unwrap_err().code,
            MALFORMED_VALUE
        );
        ledger.finish("a-1", "published", Some("r1"));
        let record = ledger.read("a-1").unwrap();
        assert_eq!(
            (record["state"].as_str(), record["receipt_id"].as_str()),
            (Some("published"), Some("r1"))
        );
        assert!(!valid_id("../x") && valid_id("a_1-B"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hostile_temporal_values_and_ledger_symlinks_are_refused() {
        assert!(scalar(&json!({"$t":"date","v":"9223372036854775807"})).is_err());
        assert!(scalar(&json!({"$t":"time","v":"86400","unit":"s"})).is_err());
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        fs::write(&outside, b"preserve me").unwrap();
        let ledger = Ledger(dir.path().join("ledger"));
        fs::create_dir(&ledger.0).unwrap();
        std::os::unix::fs::symlink(&outside, ledger.0.join(".mutation-a.tmp")).unwrap();
        assert!(ledger.begin("a", &json!({}), None).is_err());
        std::os::unix::fs::symlink(&outside, ledger.file("b")).unwrap();
        assert!(ledger.read("b").is_none());
        assert_eq!(fs::read(outside).unwrap(), b"preserve me");
    }

    #[test]
    fn reconciliation_keeps_finalized_but_unsynced_publication_not_durable() {
        let directory = tempfile::tempdir().unwrap();
        let receipts = directory.path().join("receipts");
        let publisher = Publisher::new(&receipts, Default::default()).unwrap();
        let target = directory.path().join("saved.bin");
        let lock = publisher.lock(&target).unwrap();
        let original = publisher
            .publish(&lock, b"verified new bytes", None)
            .unwrap();
        let path = receipts.join(format!("{}.json", original.id));
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // Model the valid finalized record left by a failed directory flush and a later lost reply.
        record["durable"] = json!(false);
        fs::write(path, record.to_string()).unwrap();
        assert_eq!(
            publisher.status(&original.id),
            Status::Published {
                finalized: true,
                durable: false
            }
        );
        let late_error = PublishError {
            kind: Kind::Unconfirmed,
            reason: "test_lost_reply",
            message: "The publication reply was lost.".into(),
            receipt_id: Some(original.id),
        };
        let Published::Yes {
            receipt: Some(recovered),
            reconciled: true,
        } = reconcile(&publisher, late_error)
            .unwrap_or_else(|_| panic!("the verified publication should reconcile"))
        else {
            panic!("expected a reconciled publication")
        };
        assert!(!recovered.durable);
        let old_hash = dfv_table_publication::digest(b"");
        let result = ReceiptJson {
            operation: "updateCell",
            rows_changed: 1,
            kind: "csv",
            path: &target,
            before: (0, 0, &old_hash, 1),
            after: None,
            backup_path: None,
            receipt: Some((&recovered, true)),
        }
        .value();
        assert_eq!(result["directory_sync"], "failed");
    }
}
