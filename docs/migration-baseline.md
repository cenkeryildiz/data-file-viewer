# B0 migration baseline — Data File Viewer

Recorded 2026-10-09 on macOS 15.8.1 ARM64, Node 26.4.0, npm 11.17.0.
Baseline: `48510a0aa3ef762101d6db53267ca6843cd6dc16`, version 0.0.19.
Status: baseline tools, installed-host validation and repeated resource samples
implemented. B0 acceptance remains open. No application feature, Rust backend,
MAT viewer or PDF integration is enabled by this change. PDF is deferred.

## Changes

- `docs/baseline/run.py`, `workloads.json` and `test_runner.py`: repeatable command/deadline/provenance/resource capture, with failure and source-change checks.
- `docs/baseline/fixtures.json`: synthetic generator hashes, sizes and seeds.
- `docs/baseline/build_foreign.py`: reuse the existing independent foreign-format generators while retaining their generated manifest under ignored test output; the tracked manifest is not rewritten.
- `test/resources/{profile,equivalence}.test.ts`: `DFV_BASELINE_SYNTHETIC=1` excludes optional personal desktop files. Default test behavior is unchanged. B0 always selects synthetic inputs.

Evidence stays under the existing ignored `test/stress/_work/migration-baseline/`.
Baseline sources are under `docs/`, which the VSIX already excludes. No sibling
project content or runtime dependency was added to this public repository.

## Validation

| Gate | Observed result |
|---|---|
| Typecheck/build | Passed |
| Unit tests after foreign fixtures | 798 passed, 0 failed, 0 skipped, 4 TODOs |
| Security suite | Passed at its default campaign size |
| Browser workflows | Passed |
| Package and independent archive checks | Passed; local 0.0.19 VSIX, 1,488 entries |
| Installed VS Code | Passed using a disposable profile: workbook/table selection, draft restore, SQL date filtering, 100-row result and unchanged input bytes |
| Routine stress after foreign fixtures | 277 passed, 0 failed, 0 skipped, 4 known failures |
| Resource/equivalence | 8 checks passed; all 12 synthetic equivalence files matched; no embedded profile errors |
| Extended seeded fuzz | **Failed**, reproducible seed 538030117, 20,000-run campaign |
| Baseline launcher checks | 5 passed |

The first unit/stress run skipped absent foreign fixtures. Those skips were
resolved by building the corpus and rerunning both suites; the first logs remain
available. Resource tests initially refused missing profiling fixtures. The
recorded equivalence baseline was then established from unchanged application
code and compared in a separate run. Equality against this newly captured
baseline establishes reproducibility, not independent correctness by itself.

## Reproducible baseline defect

Extended message fuzzing fails `SEC-14–17` at seed **538030117**, iteration
**3881**. A malformed `sortQuery` message triggers `TypeError: Cannot convert
object to primitive value` instead of the required typed policy refusal. The
20,000-case scanner/parser differential portion still passes. This explains why
the smaller ordinary security suite can pass while the extended gate fails.

```sh
npm run test:fuzz -- --seed 538030117 --runs 20000
```

The input and stack are retained in the ignored evidence logs. Application
validation code was not changed to hide or fix this baseline finding.

## Measurements

Two warmups plus seven measured fresh-process resource-suite runs, sequential,
same generated corpus, no forced OS cache eviction. All seven passed with zero
equivalence differences. Command median: **17.050 s**; nearest-rank p95:
**17.381 s**. Maximum sampled aggregate process-tree RSS: **2,312,617,984 bytes**.
This includes concurrently running resource-test processes; it is not a single
worker's memory allocation or a production host budget.

For the synthetic 40,000-row XLSX, median existing viewer-worker timings were:

| Stage | Median |
|---|---:|
| Open | 110 ms |
| First use | 496 ms |
| First query | 133 ms |
| Warm query | 3 ms |
| Worker round trip | 15 ms |
| Edit | 155 ms |
| Query following edit | 618 ms |

The existing profiler also records in-process SQL and row transport for CSV,
Parquet, Arrow, Feather, DTA, DuckDB and SQLite. These are backend measurements,
not first-visible UI latency. DuckDB already performs native work; these samples
do not demonstrate that a Rust wrapper will improve it. No Rust speedup is claimed.

## Existing policy captured

The existing editor identities, configuration and format registration remain in
`package.json`; B0 fingerprints that file rather than creating a competing
configuration. Tables retain their current query/edit paths and kdb stays read-only.
`src/queryPolicy.ts` sets 256 KiB SQL, 32 MiB result, 4 MiB cell, 1 MiB catalog,
100 filters, 4,000 filter characters, 8 queued requests and a 30-second deadline.
DuckDB uses a 512 MB limit, half available CPU cores (minimum one), no temporary
spill, restricted selected paths, disabled external access/autoload/install,
disabled persistent secrets and locked configuration. These are existing
restrictions, not a claim of an OS sandbox or an aggregate host memory limit.

## Reproduce

From this repository, with Conda `myproject` available for evidence and foreign
fixture generation:

```sh
conda run --no-capture-output -n myproject python docs/baseline/run.py --workload install
conda run --no-capture-output -n myproject python docs/baseline/run.py --workload profile-fixtures --workload foreign-fixtures
conda run --no-capture-output -n myproject python docs/baseline/run.py --workload typecheck --workload test --workload test:security --workload test:browser --workload package --workload test:package --workload test:host --workload stress
conda run --no-capture-output -n myproject python docs/baseline/run.py --workload resource-record
conda run --no-capture-output -n myproject python docs/baseline/run.py --workload test:resources --benchmark
conda run --no-capture-output -n myproject python docs/baseline/run.py --workload test:fuzz
```

Record equivalence **only once for a newly frozen baseline**; do not regenerate it
to make a later backend change pass. On an existing baseline, skip `resource-record`.
`test:host` needs the local VS Code application or `DFV_VSCODE_EXECUTABLE`; optional
`DFV_VSIX` selects the exact package. No installation into the user's normal profile
is performed. The runner's exclusive lock protects shared fixture paths.

## Evidence and remaining acceptance

- Initial sources: `test/stress/_work/migration-baseline/initial-source.json`.
- Original host/package/fuzz run: `test/stress/_work/migration-baseline/20261009T094847.367084Z-70404/`.
- Fixture setup, equivalence and fuzz replay: `test/stress/_work/migration-baseline/20261009T095221.224672Z-77862/`.
- Complete unit corpus: `test/stress/_work/migration-baseline/20261009T095345.147230Z-78818/`.
- Complete routine stress: `test/stress/_work/migration-baseline/20261009T095810.296631Z-90889/`.
- Repeated resource sample: `test/stress/_work/migration-baseline/20261009T131635.966036Z-11385/`.
- Saved behavior reference: `test/stress/_work/equivalence/baseline.json`.

B0 still needs the cross-project acceptance review, resolved or explicitly
carried-forward defects/TODOs, measured first-visible/local-control and
cancellation latency, 100 actual-host open/close cycles, a 30-minute mixed-load
soak and aggregate capacity calibration. Windows/Linux and physical constrained
hardware are unverified. 50 ms sampled RSS/CPU can miss short-lived children and
peaks; no disk-I/O or power/cache-controlled comparison is claimed.

Rollback removes only baseline files and generated test output and restores the
two test-file changes. Keep review evidence as needed. Application source,
configuration, editor registration and normal installed extension are unchanged.
No commit, push or release was performed.

## Native Parquet cell writer qualification — 2026-11-01

`native/crates/parquet-write` provides a standalone, snapshot-bound one-cell editor
and `save_cell` integration with the shared destination lock / verified atomic
publication primitive. Worker/host routing, packaging and cross-platform acceptance
remain separate work. Source reads use no-follow, nonblocking regular descriptors;
the private snapshot must match the captured source SHA-256 before any decoding.
The complete staged file is reopened and every Arrow batch is compared against the
original with precisely the requested replacement before publication.

| Reconstruction | Policy |
| --- | --- |
| Physical/logical schema, root name, field IDs, Arrow/schema metadata, ordered duplicate file key/value metadata | Preserve exactly; staged mismatch refuses publication |
| Rows, nulls, exact Decimal128, untouched nested list/struct/binary, row-group boundaries | Preserve; one unambiguous row identity and a representable scalar replacement required |
| Compression | Preserve each column's algorithm: uncompressed, Snappy, gzip, Zstd, LZ4 raw; codec levels use writer defaults because original levels are absent from Parquet metadata |
| Derived offsets, encoding details, size/value statistics | Rebuild for the new bytes/values; `created_by` truthfully identifies Data File Viewer / parquet-rs 58.4.0 |
| Empty row groups, sorting metadata, external chunks, bloom filters, page indexes/checksums, per-row-group codec/dictionary-policy variation, INT96, embedded fixed-size lists, custom column key/value or unknown preservation fields, Brotli/LZO/legacy LZ4 | Typed refusal before publication; sources remain unchanged |
| Unsupported target types, inexact values, null in required column, missing/duplicate row matches | Typed refusal; nested/binary values may remain untouched but cannot themselves be edited |

Default limits: source and stage **256 MiB**, footer **16 MiB**, encoded/decoded
page **16 MiB**, row-group decoded/fixed-width expansion **128 MiB**, 4,000,000
values, 100,000 metadata items/pages, 8,192 schema nodes, 2,048 leaf columns,
4,096 row groups and depth 32. Compact-Thrift counts and physical-schema depth
are checked before the upstream metadata parser allocates; embedded Arrow field
counts/depth are checked before schema conversion. Gzip output is independently
bounded and Snappy's decoded-length prefix verified before their normal decoder.

The required codec is pinned `parquet = 58.4.0` (Apache-2.0, Rust >=1.85), matching
all existing Arrow 58.4.0 packages. Only Arrow/Snappy/Zstd/LZ4/gzip-rust features
are enabled. New locked transitive crates are byteorder 1.5.0 (MIT/Unlicense),
integer-encoding 3.0.4 and ordered-float 2.10.1 (MIT), snap 1.1.1 (BSD-3-Clause),
thrift 0.17.0 (Apache-2.0), paste 1.0.15 and seq-macro 0.3.6 (MIT/Apache-2.0).
Registry manifests supplied the licence proof; all existing locked package
versions/checksums remain unchanged. Arrow scalar/replace/type-check helpers are
reused through visibility-only exports.

Validation in the isolated private checkout, with `DFV_REF_PYTHON` pointing to
Conda `myproject`, `PYTHONDONTWRITEBYTECODE=1`, a private `TMPDIR`, isolated
`CARGO_TARGET_DIR` and `-j2`: `cargo test -p dfv-table-parquet-write` passed
**5 unit + 4 integration tests**; `cargo clippy -p dfv-table-parquet-write
--all-targets -- -D warnings` passed. The reusable producer/oracle checks **41
artifacts** independently with PyArrow, Polars and DuckDB: five codecs × V1/V2
pages × string/null/int64-max/38-digit-decimal edits plus atomic publication.
It compares the full physical and Arrow schemas, user metadata, row-group/codec
policy and all values, including NaN/signed-zero bits, uint64, timestamps and
nested binary/null values. Further tests cover ordered duplicate metadata,
refusals/budgets/truncation, gzip/Snappy expansion claims, changed-source atomic
publication refusal, metadata-unchanged changed-stream snapshot refusal,
read-only stage handles and nonblocking FIFO/symlink rejection. This is local
macOS/APFS evidence, not installed-extension or release acceptance.


## D3.17 operation coverage checkpoint — 1 November 2026

This is preparation, not D3.17 acceptance. The generated D1.8 inventory and
`queryProtocol.ts::READ_METHODS` agree on **22 read methods**, including
`retrySheetPreparation`; the plan's earlier prose list has 21. The native table
worker currently advertises 13 total methods and routes eight of those reference
reads. The remaining 14 read routes must be completed; no Node fallback or
capability-only stub counts as coverage.

`npm run test:migration:native-operations` runs a strict source/inventory/native
capability-and-dispatch assertion. Five Node self-checks pass, including inventory
drift, duplicate names, missing advertised arms and a nested argument match that
must not count as a method. The final strict assertion currently exits 1 and lists
all 14 missing native routes. It is deliberately a blocked qualification gate,
not a release-ready test claim. It also accepts rustfmt-style combined method arms.

The new `duckdb-query::operations` module provides optional cadence/frequency reads
from the primary approved source and a pure quoted combined-query builder.
Metadata text is bounded to 1 MiB before Rust conversion, fixed builtins are
qualified, row matching is parameterized, optional malformed values return no
hint, and source/cancellation errors remain errors. The frequency vocabulary and
JavaScript whitespace rules reuse the current reference. Combined SQL uses the
shared conventional time-column priority, a newest-row tail sorted chronologically,
unbounded union-by-name when no shared time column exists, exact identifier quoting
and a default 500-row window. Source identities/attachment, hot-first metadata
fallback and operation dispatch remain the owning session's responsibility.

Six Rust integration tests passed for actual combined SQL, exact identifier
quoting, union-by-name/duplicates, metadata type/size/macro-shadow handling and
stale-source refusal. The exact tested Rust checkpoint is
`7f0ec2e22e20c8ac4948368c425aa98be3413748`, transferred into the DuckDB writer's
owned warm checkout without source changes. Commands from its `native/` directory:

- `cargo test -p dfv-table-db-write -p dfv-table-duckdb --features dfv-table-db-write/test-mutations --test operations --offline --locked -j2`;
  six passed (1.96 s build, 0.13 s tests).
- `cargo clippy -p dfv-table-db-write -p dfv-table-duckdb --features dfv-table-db-write/test-mutations --all-targets --offline --locked -j2 -- -D warnings`;
  passed.
- `node --test test/migration/nativeOperations.test.mjs`;
  five self-checks passed in the final helper branch. The strict coverage CLI still
  correctly exits 1 for the 14 missing routes and grants no acceptance credit.
- `cargo fmt --manifest-path native/Cargo.toml --all --check` and
  `git diff --check`; passed.

Selecting both Rust packages and the already qualified test-mutations feature was
necessary to reuse the warm dependency feature graph; a query-only selection
would have rebuilt DuckDB's C++ variant. No shared Cargo target or new dependency
was introduced. All eight final changed source/test/config/doc files at private
`work/dfv-operations-20261101` were independently fetched and byte-compared.
Completed helper test outputs/checkouts can be removed after verification; the
DuckDB writer's still-active checkout/build remains its owner's responsibility.

Remaining boundaries: native table-source integration and session transport,
SQLite/hot-cold attachment, XLSX-derived/detected queries, Safe Mode diff routing,
all advertised operation result/refusal fixtures, read metadata and SQL-RANGE-01.
The strict coverage gate may close only when those routes are real and qualified.


## Combined native checkpoint and plotting handoff — 1 November 2026

Combined writer/query verification in an outside-Kod owned checkout passed 183
Rust tests: database42, CSV18, Arrow writer3, Parquet9, XLSX18 and query93
(including operation helpers6). The configured XLSX differential executed101 cases
rather than its unconfigured placeholder;62 Rust outputs were produced and61
reopened independently in openpyxl, with one unchanged original-load limitation.
Independent Arrow PyArrow/Polars readback passed19 cases (the original dictionary-
delta source is unsupported by Polars; PyArrow verified it). CSV's12 cases passed
all four independent readers after compiling this checkout's TS oracle. No source
or data correction was needed for the initial missing compiled oracle.

The selected package set was `dfv-table-db-write`, `dfv-table-duckdb`,
`dfv-table-csv-write`, `dfv-table-arrow-write`, `dfv-table-parquet-write`,
`dfv-table-xlsx-patch`, with the database `test-mutations` feature, offline/locked
Cargo, an isolated target, installed myproject Python and `-j2`. Strict
all-targets clippy, workspace fmt and diff checks passed. The final five Node
native-operation checker self-tests pass; its strict route gate still identifies
14 missing reads, so D3.17 is not accepted. No VSIX/public release acceptance is
claimed. The source-lock lifetime comment now correctly names the descriptor-
owned OFD lock alongside its read-only connection.

The canonical plotting plan and source-to-port map are in
[`Projects/PDF_VIEWER_RESEARCH.md`, Plotting additions and upstream references](../../../PDF_VIEWER_RESEARCH.md#plotting-additions-and-upstream-references--user-decisions-1-november-2026)
in the Kod workspace. That plan records actual R/ETL symbols, hashes, extension
consumers and affected tests, including the difference between the standalone
`Projects/Rust/ETL` Python checkout and its historical Python-project copy.
When this repository is viewed alone on GitHub, consult that file in the private
Kod checkpoint; the cross-project relative link requires the Kod layout.

Pending PLOT-01–04: refresh applicable R-reference styling; plot one numeric
column against row numbers; preserve automatic date inference and add a plot-only
selected-column date override; add the upstream drift gate. These requests do not
bundle R, rename source columns or execute personal R database scripts. No chart
behavior has been changed by this documentation checkpoint. Next implementation
must review `long_run_3.R`, `helpers_core.R`, `helpers_echarts.R` against
`src/chartSpec.ts`, `src/chartView.ts`, the host/webview chart callers and query
backends, using the mapped tests. Source data and intentional viewer differences
stay preserved.

### PLOT-02/03 checkpoint (2 November 2026, branch `plot23-axis`)

Implemented in the viewer: row-number axis (`xIsRow`), plot-only "Plot axis"
choice (Automatic, Row numbers, or any column read as dates, `xDateColumn`),
exact explicit-date reading in `DuckDbFile.runExplicitDateChart` (refuses with a
count, never guesses day/month text, integers or mixed UTC offsets; null dates
are left out and counted in the chart heading). Native Rust `runChartQuery`
row/date support is out of scope: `nativeDocument.runChartQuery` still throws
unsupported.

Tests live only in `kod_phases` branch `work/dfv-plot23-20261102`:
`test/plotAxis.test.ts` (18 cases, real DuckDB and CSV, source hashes), changed
`test/chartSpec.test.ts` (no-axis result now offers every numeric column),
`test/queryMessages.test.ts`, `test/browser/plotAxis.cjs`, regenerated
`test/migration/table-operations.json` (re-run the generator with the D0.4
reuse file present after merging; the committed `reuse` records were kept).
Commands: `tsc --noEmit` (0), `npm test` (1027-1028 pass; the only failures were
the D1.8 inventory, since fixed, `migrationTableOperations` 8/8 pass), chartDetail,
sqlWorkflow and plotAxis browser scripts pass. A final full rerun after the
inventory fix was interrupted by the checkpoint request.

## PLOT-01 R-reference chart refresh — 2 November 2026

Implemented in `src/chartSpec.ts` (`huePalette`, R's `all.equal` no-span rule in
`padValueRange`), `src/chartView.ts` and `media/main.css`; nothing from R is
executed or bundled and the MA/trend/average/zero/event/crisis overlays stay off.

- **Ported:** series colours are `scales::hue_pal()(n)` (a lone series is
  `#F8766D`, not navy); the y range treats a relative gap under 1.5e-8 as "no
  span" like `compute_echarts_y_range`; crosshair snap to the nearest row while
  the detail popup is on and `tooltip.transitionDuration: 0`; double-click resets
  zoom only inside the plot area (a legend double-click no longer does); serif
  bold 14 title and the reset button at top 8 / right 8.
- **Already matching (now pinned by R-generated fixtures):** line width 1.4,
  scatter size 7.2, axis rule 1.5, gridline `rgb(229,229,229)` at 0.5, serif
  labels 10, legend 11, grid left/right 10, 8 y ticks from the unpadded extent,
  x padding 2%/4%, quarterly/semiannual/weekly tick wording, `connectNulls`.
- **Intentional viewer differences** are listed in the comment block above
  `INK` in `src/chartView.ts`: darker text ink, HTML title bar instead of the
  in-canvas title (so no 40/65 px grid bands), zoom-adaptive x ticks instead of
  six pinned dates, exact tooltip values with the exact timestamp, no inferred
  percent axis, 6 px minimum drag, no overlays.
- **R-side drift noted, R sources not edited:** `compute_echarts_x_range`
  formats a fractional `Date`, so R truncates the padding to a whole day while
  the viewer keeps milliseconds (compared on the UTC day in the test).
- **Tests** (private `kod_phases`, branch `work/dfv-plot01-20261102`):
  `test/chartReference.test.ts` + `test/fixtures/rReference/` (generator
  `generate_chart_reference.R`, fixture records R 4.6.1, scales 1.4.0, farver
  2.1.2 and the sha256 of both helpers; set `DFV_R_HELPERS_DIR` to turn helper
  drift into a failure) and the extended `test/browser/chartDetail.cjs`
  (palette, ranges/ticks, chrome, dark-theme page, legend vs plot double-click,
  hover escaping, snap). `tsc --noEmit` clean; `node test/browser/chartDetail.cjs`
  passes; `npm test` 1090 tests, 1015 pass, 64 skipped (native workers not built),
  2 fail, both caused by the separate PLOT-02 patch: `chartSpec.test.ts` "no axis
  means no plottable columns" (behaviour intentionally changed) and the D1.8
  `table-operations.json` inventory (needs `xIsRow` regenerated).

## Plot integration (2 November 2026, branch `plot-integration-20261102`)

`plot23-axis` (PLOT-02/03), `plot01-r-style` (PLOT-01) and `plot04-drift`
(PLOT-04) merged onto `f5d5b73`; the PLOT-02 hunks duplicated in `plot01-r-style`
resolved to the `plot23-axis` code. Combined tests live in `kod_phases` branch
`work/dfv-plotint-20261102`. In a clean checkout with those tests: `tsc --noEmit`
0; `npm test` 1111 tests, 1037 pass, 0 fail, 65 skipped, 9 todo;
`npm run test:upstream-drift` OK; browser `sqlWorkflow`, `chartDetail`,
`plotAxis`, `ex02Selection`, `safeX1Preparation` all pass. `table-operations.json`
regenerated with the D0.4 reuse file (sha256 b2e19cba...). Open gap reported by
the drift gate, not fixed: all-caps `TARİH` (dotted capital İ) is a date name in
ETL but not in `DATE_COL_PATTERN`.
