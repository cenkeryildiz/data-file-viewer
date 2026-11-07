//! Parquet reads for the viewer. A Parquet footer DECLARES its column types, so unlike a CSV nothing here is
//! sniffed or reinterpreted (`DECLARES_COLUMN_TYPES`); the file's physical and logical schema, key-value
//! metadata and footer counts are reported from the file, so DECIMAL precision/scale and nested
//! (LIST / STRUCT / MAP) shape are not inferred from DuckDB's display type. Types the pinned engine cannot
//! read faithfully are refused at open, before their values can reach a query result.
use crate::duckdb::{Engine, Error, Kind, quote_ident, quote_literal};

/// Where a table's column types come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaProvenance {
    /// The file states them (Parquet footer, `.duckdb` catalog): never reinterpreted.
    Declared,
    /// The reader infers them from the values (CSV sniffer, then the locale and text decisions).
    Inferred,
}

/// DuckDB's widest exact decimal. A Parquet DECIMAL past it is read as DOUBLE and loses digits.
const MAX_EXACT_DECIMAL_PRECISION: i64 = 38;
/// How much of a key-value metadata value is reported; `value_len` always carries the real size.
const KV_VALUE_PREVIEW_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParquetKeyValue {
    pub key: String,
    /// The first [`KV_VALUE_PREVIEW_BYTES`] bytes, lossily decoded.
    pub value: String,
    pub value_len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParquetColumn {
    pub name: String,
    /// Physical type; `None` for a group (nested) node.
    pub physical_type: Option<String>,
    pub logical_type: Option<String>,
    pub converted_type: Option<String>,
    pub repetition: Option<String>,
    pub precision: Option<i64>,
    pub scale: Option<i64>,
    /// Number of children for a group node; `None` for a leaf.
    pub num_children: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParquetInfo {
    pub num_rows: i64,
    pub row_groups: i64,
    pub created_by: Option<String>,
    /// The schema in file order; the first entry is the root node.
    pub schema: Vec<ParquetColumn>,
    /// The footer's key-value metadata (`ARROW:schema`, `pandas`, ...): where the writer's types came from.
    pub key_value_metadata: Vec<ParquetKeyValue>,
}

impl Kind {
    pub fn schema_provenance(self) -> SchemaProvenance {
        match self {
            Self::Csv | Self::Xlsx => SchemaProvenance::Inferred,
            Self::Duckdb
            | Self::Parquet
            | Self::Sqlite
            | Self::Arrow
            | Self::Feather
            | Self::Dta
            | Self::Kdb => SchemaProvenance::Declared,
        }
    }
}

impl Engine {
    /// Bind the single view over the file and record what DuckDB cannot read exactly.
    pub(crate) fn open_parquet(&mut self, stem: &str) -> Result<(), Error> {
        let path = quote_literal(&self.path.to_string_lossy());
        self.create_view(stem, &format!("read_parquet({path})"))?;
        let mut stmt = self.conn.prepare(&format!(
            "select name, precision, scale from parquet_schema({path}) \
             where precision > {MAX_EXACT_DECIMAL_PRECISION}"
        ))?;
        let wide: Vec<(String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        if !wide.is_empty() {
            let list: Vec<String> = wide
                .iter()
                .map(|(n, p, s)| format!("{} (DECIMAL({p},{s}))", quote_ident(n)))
                .collect();
            // shortcut: wider decimals require an exact reader; enable them when the engine preserves their values.
            return Err(Error::Unsupported(format!(
                "{} hold decimals wider than {MAX_EXACT_DECIMAL_PRECISION} digits, which this reader cannot read exactly. The file was not opened.",
                list.join(", ")
            )));
        }
        Ok(())
    }

    pub fn parquet_info(&self) -> Result<ParquetInfo, Error> {
        if self.kind != Kind::Parquet {
            return Err(Error::Unsupported(
                "Parquet metadata is only available for a .parquet file.".into(),
            ));
        }
        let path = quote_literal(&self.path.to_string_lossy());
        let (num_rows, row_groups, created_by) = self.conn.query_row(
            &format!(
                "select num_rows, num_row_groups, created_by from parquet_file_metadata({path})"
            ),
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        let mut stmt = self.conn.prepare(&format!(
            "select name, type, logical_type, converted_type, repetition_type, precision, scale, num_children \
             from parquet_schema({path})"
        ))?;
        let schema = stmt
            .query_map([], |r| {
                Ok(ParquetColumn {
                    name: r.get(0)?,
                    physical_type: r.get(1)?,
                    logical_type: r.get(2)?,
                    converted_type: r.get(3)?,
                    repetition: r.get(4)?,
                    precision: r.get(5)?,
                    scale: r.get(6)?,
                    num_children: r.get(7)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt = self.conn.prepare(&format!(
            "select key, value from parquet_kv_metadata({path}) order by key"
        ))?;
        let key_value_metadata = stmt
            .query_map([], |r| {
                let (key, value): (Vec<u8>, Vec<u8>) = (r.get(0)?, r.get(1)?);
                Ok(ParquetKeyValue {
                    key: String::from_utf8_lossy(&key).into_owned(),
                    value: String::from_utf8_lossy(
                        &value[..value.len().min(KV_VALUE_PREVIEW_BYTES)],
                    )
                    .into_owned(),
                    value_len: value.len(),
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(ParquetInfo {
            num_rows,
            row_groups,
            created_by,
            schema,
            key_value_metadata,
        })
    }
}
