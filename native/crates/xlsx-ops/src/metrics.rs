use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Instant;

/// Accounted decoded payload retained as SQL tables, not DuckDB allocator usage or worker RSS.
pub const CACHE_MAX_BYTES: u64 = 64 << 20;

#[derive(Clone, Default)]
struct Phase {
    count: u64,
    total_ms: f64,
    max_ms: f64,
    last_ms: f64,
}

#[derive(Clone, Default)]
pub(crate) struct Metrics {
    phases: BTreeMap<&'static str, Phase>,
    pub detector_calls: u64,
    pub grid_cells: u64,
    pub grid_decoded_bytes: u64,
    pub cache_evictions: u64,
    pub cache_restores: u64,
}

impl Metrics {
    pub fn record(&mut self, key: &'static str, start: Instant) {
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let p = self.phases.entry(key).or_default();
        p.count += 1;
        p.total_ms += ms;
        p.max_ms = p.max_ms.max(ms);
        p.last_ms = ms;
    }
    pub fn snapshot(&self, cells: u64, objects: usize, bytes: u64, max_bytes: u64) -> Value {
        let phases: BTreeMap<_,_> = self.phases.iter().map(|(key,p)|(*key,json!({"count":p.count,"total_ms":p.total_ms,"max_ms":p.max_ms,"last_ms":p.last_ms}))).collect();
        json!({"phases":phases,"detector_calls":self.detector_calls,"grid_cells":self.grid_cells.to_string(),"grid_decoded_bytes":self.grid_decoded_bytes.to_string(),
            "cached_cells":cells.to_string(),"cached_objects":objects,"cache_max_cells":(max_bytes/size_of::<Option<String>>() as u64).to_string(),
            "cache_estimated_bytes":bytes.to_string(),"cache_max_bytes":max_bytes.to_string(),"cache_accounting":"decoded-payload-v1",
            "cache_evictions":self.cache_evictions,"cache_restores":self.cache_restores})
    }
}

pub(crate) fn grid_bytes(grid: &[Vec<Option<String>>]) -> u64 {
    size_of_val(grid) as u64
        + grid
            .iter()
            .map(|row| {
                (row.capacity() * size_of::<Option<String>>()) as u64
                    + row
                        .iter()
                        .flatten()
                        .map(|s| s.capacity() as u64)
                        .sum::<u64>()
            })
            .sum::<u64>()
}
