//! Through the production lane, then independent PyArrow/DuckDB/Openpyxl readback.
use dfv_table_engine::Tables;
use dfv_table_protocol::{Control, ErrorBody, Lane};
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn call(t: &mut Tables, m: &str, v: Value) -> Result<Value, ErrorBody> {
    t.call(m, v.as_object().unwrap(), &Control::unbounded())
}
fn mid() -> String {
    format!(
        "independent-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn oracle(args: &[&Path]) {
    let python =
        std::env::var("DFV_REF_PYTHON").expect("use myproject Python for independent readback");
    let result = Command::new(python)
        .arg("-B")
        .arg("-c")
        .arg(ORACLE)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn typed_file_round_trip(kind: &str, ext: &str) {
    let dir = tempfile::tempdir().unwrap();
    oracle(&[Path::new("generate"), dir.path()]);
    let path = dir.path().join(kind).join(format!("rows.{ext}"));
    let original = dir.path().join(kind).join(format!("original.{ext}"));
    std::fs::copy(&path, &original).unwrap();
    let mut t = Tables::default();
    let o = call(&mut t, "open", json!({"path":path})).unwrap();
    let s = o["session"].as_str().unwrap();
    let r = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select * from rows order by id desc"}),
    )
    .unwrap();
    let row_values = r["columns"]
        .as_array()
        .unwrap()
        .iter()
        .zip(r["rows"][0].as_array().unwrap())
        .map(|(c, v)| (c["name"].as_str().unwrap().to_owned(), v.clone()))
        .collect::<serde_json::Map<_, _>>();
    call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let id = mid();
    let receipt=call(&mut t,"updateCell",json!({"session":s,"expected_revision":"1","mutation_id":id,"table":"rows","column":"label","new_value":"changed Ω","row_values":row_values})).unwrap();
    assert_eq!(receipt["rows_changed"], "1", "{kind}");
    let status = call(&mut t, "queryMutationOutcome", json!({"mutation_id":id})).unwrap();
    assert_eq!(status["receipt"], receipt, "{kind}");
    let r = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select label from rows order by id desc"}),
    )
    .unwrap();
    assert_eq!(r["rows"][0][0], "changed Ω", "{kind}");
    call(&mut t, "close", json!({"session":s})).unwrap();
    oracle(&[Path::new("verify"), &original, &path]);
}
#[test]
fn parquet_round_trip() {
    typed_file_round_trip("parquet", "parquet");
}
#[test]
fn arrow_round_trip() {
    typed_file_round_trip("arrow", "arrow");
}
#[test]
fn stream_round_trip() {
    typed_file_round_trip("stream", "arrows");
}
#[test]
fn feather_round_trip() {
    typed_file_round_trip("feather", "feather");
}
#[test]
fn duckdb_round_trip() {
    typed_file_round_trip("duckdb", "duckdb");
}
#[test]
fn repeated_header_workbook_publishes_the_physical_cell_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.xlsx");
    let original = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/xlsx-corpus/repeated.xlsx");
    std::fs::copy(&original, &path).unwrap();
    let mut t = Tables::default();
    let o = call(&mut t, "open", json!({"path":path})).unwrap();
    let s = o["session"].as_str().unwrap();
    let selected = call(
        &mut t,
        "runQuery",
        json!({"session":s,"sql":"select * from Sheet","prepare_sheet":"Sheet"}),
    )
    .unwrap();
    let table = selected["workbook_metadata"]["detected_tables"][0]["name"]
        .as_str()
        .unwrap();
    call(
        &mut t,
        "setSafeMode",
        json!({"session":s,"enabled":false,"expected_revision":"1"}),
    )
    .unwrap();
    let id = mid();
    let receipt=call(&mut t,"updateCell",json!({"session":s,"expected_revision":"1","mutation_id":id,"table":table,"column":"Value","new_value":{"$t":"int64","v":"9"},"row_values":{"Name":"Bob","Value":{"$t":"float64","v":"2"}}})).unwrap();
    assert_eq!(receipt["rows_changed"], "1");
    let status = call(&mut t, "queryMutationOutcome", json!({"mutation_id":id})).unwrap();
    assert_eq!(status["receipt"], receipt);
    call(&mut t, "close", json!({"session":s})).unwrap();
    oracle(&[Path::new("verify"), &original, &path]);
}

// Python is the independent oracle, using the existing myproject libraries.
const ORACLE: &str = r###"
"""Synthetic production-dispatch fixtures and independent typed readback; never reads user files."""
from pathlib import Path
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.feather as feather
import pyarrow.parquet as parquet
import duckdb
import openpyxl
import polars as pl
import zipfile


def table():
    schema = pa.schema([
        pa.field('id', pa.int64(), metadata={b'role': b'exact identifier'}),
        pa.field('label', pa.string()),
        pa.field('amount', pa.decimal128(20, 4)),
        pa.field('day', pa.date32()),
        pa.field('when_utc', pa.timestamp('us', tz='UTC')),
        pa.field('flag', pa.bool_()),
    ], metadata={b'producer': b'independent dispatch qualification'})
    return pa.Table.from_pylist([
        dict(id=9007199254740993, label='alpha', amount=Decimal('1234567890123456.1234'), day=date(2024, 2, 29), when_utc=datetime(2024, 2, 29, 12, 30, 1, 123456, tzinfo=timezone.utc), flag=True),
        dict(id=2, label='beta', amount=Decimal('-2.5000'), day=None, when_utc=None, flag=False),
    ], schema=schema)


def read(path):
    if path.suffix == '.parquet':
        return parquet.read_table(path)
    if path.suffix == '.arrows':
        with path.open('rb') as f:
            return ipc.open_stream(f).read_all()
    with path.open('rb') as f:
        return ipc.open_file(f).read_all()


def main():
    command, root = sys.argv[1], Path(sys.argv[2])
    if command == 'generate':
        original = table()
        for kind, ext in [('parquet', '.parquet'), ('arrow', '.arrow'), ('stream', '.arrows'), ('feather', '.feather')]:
            dest = root / kind / ('rows' + ext)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if kind == 'parquet':
                parquet.write_table(original, dest, compression='snappy', row_group_size=1)
            elif kind == 'feather':
                feather.write_feather(original.drop(['amount']), dest, compression='zstd', version=2)
            else:
                out_table = original.drop(['amount']) if kind == 'stream' else original
                options = ipc.IpcWriteOptions(compression='lz4' if kind == 'stream' else None)
                with dest.open('wb') as out, (ipc.new_stream if kind == 'stream' else ipc.new_file)(out, out_table.schema, options=options) as writer:
                    writer.write_table(out_table)
        dest = root / 'duckdb' / 'rows.duckdb'
        dest.parent.mkdir(parents=True, exist_ok=True)
        # The oracle is DuckDB 2.x; generate the native 1.5.x worker's declared storage profile.
        with duckdb.connect(str(dest), config={'storage_compatibility_version': 'v1.4.0'}) as c:
            c.execute('create table rows(id bigint, label varchar)')
            c.execute('insert into rows values (?, ?), (?, ?)', [9007199254740993, 'alpha', 2, 'beta'])
    elif command == 'verify':
        before, after = Path(sys.argv[2]), Path(sys.argv[3])
        if after.suffix == '.duckdb':
            with duckdb.connect(str(after), read_only=True) as c:
                assert c.execute('select * from rows order by id desc').fetchall() == [(9007199254740993, 'changed Ω'), (2, 'beta')]
        elif after.suffix == '.xlsx':
            assert openpyxl.load_workbook(after, data_only=False).active['B5'].value == 9
            with zipfile.ZipFile(before) as old, zipfile.ZipFile(after) as new:
                assert old.namelist() == new.namelist()
                for member in old.namelist():
                    if member != 'xl/worksheets/sheet1.xml':
                        assert old.read(member) == new.read(member), member
            workbook = openpyxl.load_workbook(after, data_only=False)
            assert workbook.active['A5'].value == 'Bob'
            assert workbook.active['B4'].value == 'Value'
        else:
            old, new = read(before), read(after)
            expected = old.to_pylist()
            expected[0]['label'] = 'changed Ω'
            assert new.schema.equals(old.schema, check_metadata=True), (new.schema, old.schema)
            assert new.to_pylist() == expected, (new.to_pylist(), expected)
            frame = pl.read_parquet(after) if after.suffix == '.parquet' else (pl.read_ipc_stream(after) if after.suffix == '.arrows' else pl.read_ipc(after))
            assert frame.to_dicts() == expected, (frame.to_dicts(), expected)
        print('independent readback passed:', after.suffix)
    else:
        raise ValueError(command)


if __name__ == '__main__':
    main()
"###;
