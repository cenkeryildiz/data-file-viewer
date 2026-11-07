# D3.1 local dependency proof

`proof.json` records the macOS arm64 `dfv-table` normal/build dependency closure selected by Cargo, including exact versions, enabled features, lock checksums, upstream VCS revisions when packaged, licence expressions and available licence/notice hashes. The tree contains 130 packages: 89 on normal dependency edges and 41 reached only through build edges. These categories describe Cargo dependencies, not dynamically loaded libraries.

All 6,803 packaged source files were compared with the corresponding cached `.crate` archive; every archive SHA-256 matches `Cargo.lock`. Local crate sources, workspace manifests, lockfile and toolchain pin are hashed separately. The generator asserts complete package coverage and rejects checksum drift. No dependency was installed, downloaded or rebuilt for this inspection.

The `duckdb` crate omits licence text from its archive. `upstream-license/` retains the repository's MIT licence from the exact `.cargo_vcs_info.json` commit, fetched using the GitHub connector. Its Git blob SHA is verified; its SHA-256 and provenance are included in the package record. This resolves that retained-text omission without changing the dependency.

The bundled DuckDB source manifest contains `core_functions`, `json` and `parquet`. The selected features use the bundled C++ build; no ICU source members exist in the archive. The observed worker links only macOS system libraries/frameworks listed in `loaded-libraries.txt`, with no external DuckDB or ICU dynamic library. This does not establish unsupported extension or locale behavior. The worker advertises only its implemented read-only CSV, Parquet and DuckDB operations; Arrow/SQLite/XLSX standalone workspace crates are outside this binary dependency closure.

The bundled source archive contains 26 vendor directories and preserves source-header notices, but omits standalone vendor licence/NOTICE files. That omission is resolved for this proof: `upstream-license/duckdb-vendors.json` binds the exact DuckDB submodule commit `d8cdaa33fda8df955cc76ef58a280f68f4cd43fa` from duckdb-rs's pinned Git tree. The cached source archive matches duckdb-rs's Git blob, and all 442 bundled vendor source files match that submodule's Git blobs. The root licence and all 26 vendor licences, including RE2's referenced `LICENSE`, are retained from the same revision and their Git blob SHAs verified. This covers the entire bundled vendor superset for the selected core/json/parquet build. Final binary-package inclusion of these notices remains release work. This is dependency provenance, not legal compliance certification. Build-only `webpki-roots` retains its recorded CDLA-Permissive-2.0 expression and licence hash.

The observed worker SHA `263d129bc252b626bf49ee95c58916659be2c1ababb7ec05df8b06b0a48049e0` matches the production worker identified by the qualification gate; that gate retains the final build/profile evidence. Reproduce from the repository root with the existing pinned toolchain and a specified binary:

```sh
python native/evidence/d3-1-qualification-20261031/dependencies/inspect.py \
  --cargo /path/to/rust-1.99.1/bin/cargo \
  --binary /path/to/qualified/dfv-table
```

Use the approved `myproject` Python environment. Inspection uses local Cargo registry/cache files and the retained upstream licence; it makes no network requests.
