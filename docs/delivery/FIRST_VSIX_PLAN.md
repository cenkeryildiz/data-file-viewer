# Frozen delivery ledger and0.1.1PDFUI patch checkpoint

Publication/real-profile verification follows this immutable source commit; final results are archived privately with the authoritative parent plan.

Created 5 November 2026, Europe/Madrid. Scoring version: **V1.1** (same 100-point weights; finer acceptance gates).

**Accepted completion: 100/100 points (100%). Remaining: 0/100 (0%).**
This measures accepted scope toward the first full-DFV VSIX, not time remaining,
probability of success, or the 48.797403% whole-programme score. Existing work is
credited from the acceptance records linked below; those historical gates were
not all rerun today. Recent partial improvements do not receive extra credit.

## Objective and boundaries

Deliver one working macOS arm64 VSIX retaining extension identity and the qualified
PDF MVP, with the complete promised native Data File Viewer, MAT V-MAT1 and required
safety/integration checks. A user can inspect supported data, perform supported
cell saves with truthful recovery, inspect MAT without editing, and continue using
qualified PDF features. No development checkout, Conda, Python data processor or
reference Node processing backend may be required by the installed package.

This file owns **first-release weights and progress reporting**. The parent
[PDF_VIEWER_RESEARCH.md](PDF_VIEWER_RESEARCH.md) remains authoritative for detailed
feature contracts, evidence history and the larger programme. This is a separate
milestone ledger requested by the user, not a replacement or duplicate of those
contracts. Resolve contradictions using the latest explicit user decisions.

Included: every full-DFV requirement; native reads/writes and operations; Safe Mode,
backup/diff and mutation outcome recovery; SQL-RANGE-01 and promised plot behaviour;
MAT codec/worker/viewer; independent worker supervision; resource/performance/fault
and mixed-feature qualification; retained PDF MVP regression; D7.0 UI/smooth zoom;
package assets/licences/identity/docs, clean-profile acceptance and verified delivery.

Excluded from this denominator: full remaining PDF engine parity, advanced PDF
font/shaping/math/formula work and the associated full-parity corpus; other platforms;
new optional features; installation into the real profile. Exclusions do not permit
regressions in the qualified PDF MVP. D7.0 was explicitly scheduled before packaging
and remains included. Public release is not required to have a working local VSIX.

**No VSIX may be produced before full DFV implementation and its prerequisite
acceptance pass.** D3.19's earlier preliminary-package instruction is overridden:
use unpacked development-host checks first; package only at V23. Retain unique
unfinished source and original inputs. Never silently retry an uncertain mutation.

## Weights and scoring

Weights are planning judgments about implementation breadth, integration and failure
consequences, fixed now before further acceptance. They are not measured hours.
Every leaf gate earns either its full weight after its gate passes, or zero. Parent
rows sum their accepted child gates; no estimated partial percentages. Changing scope/weights requires an explicit dated revision,
old/new totals and reason; do not move weight to improve the displayed score.
A failed regression reopens the affected row and removes its credit. Component
acceptance does not imply integrated release acceptance: those have separate rows.

A = accepted component/profile, I = in progress (only accepted child gates earn credit),
P = pending (zero). Parent rows with child gates remain I until every child passes.

| ID | Milestone / parent mapping | Weight | State | Earned | Acceptance boundary / current evidence |
|---|---|---:|:---:|---:|---|
| V01 | Owned baseline and existing portable contracts; accepted D0/D1 subsets | 2 | A | 2 | Carry accepted inventory/schema/ownership work only; full new candidate provenance still V24. Parent accepted-task ledger. |
| V02 | Native table transport/session/resources; D3.1–3.3 | 4 | A | 4 | Accepted 31 October protocol, handshake, framing, cancellation and owned resources; host supervision separately V19. |
| V03 | SQL policy and core queries; D3.4–3.5 | 4 | A | 4 | Accepted 31 October security and query primitives; whole operation inventory separately V13. |
| V04 | CSV/Parquet readers; D3.6 | 4 | A | 4 | Accepted 31 October exact/read/refusal profile. |
| V05 | SQLite/XLSX readers; D3.7–3.8 | 4 | A | 4 | Accepted 1 November source identity, raw sheet geometry and codec profiles. |
| V06 | Arrow/Feather, DTA and kdb readers; D3.9–3.11 | 4 | A | 4 | Accepted 1 November codec profiles; new Arrow guard regression 10 hostile + 13 supported tests. |
| V07 | Publication and backup primitives; D3.12–3.13 | 4 | A | 4 | Accepted 1 November publication/backup contracts; end-to-end mutation binding remains V15. |
| V08 | Database writers; D3.14 | 5 | A | 5 | Accepted 1 November DuckDB/SQLite standalone writer profiles, independent readback. |
| V09 | CSV/Parquet/Arrow writers; D3.15a–c | 7 | A | 7 | Accepted 1 November standalone byte/type/metadata preservation and refusals. |
| V10 | XLSX patch writer; D3.16 | 4 | A | 4 | Accepted 1 November intended-cell/ZIP member preservation and independent workbook readback. |
| V11 | Retained qualified PDF MVP | 8 | A | 8 | Existing bounded packaged MVP profile; parent records ten packaged workflows, source/draft/export checks. New combined package must regress it again at V20/V23. No full PDF parity credit. |
| V12 | MAT codec whole proof; D6.7 / V-MAT1 | 3 | A | 3 | Level-5 bounded support signed off:31 codec tests, zero ignored/skipped; genuine MATLAB v6/v7 class/member oracles, support map and8 SHA/size provenance bindings verified. Host/resource/package acceptance remains separate. |
| V13 | Complete native operation inventory; D3.17 | 5 | A | 5 | All reference methods need real result/refusal and dispatch coverage, including sibling/combined/frequency/catalog/edit/backup paths. Integrated subset passes are supporting evidence. |
| V14 | Native viewer/provider/browser/host; D3.18 | 6 | A | 6 | SQL, EX02 and plot-control workflows passed; full native security/failure/retry coverage and coherent integration remain. Plot harness interception does not prove canvas output. |
| V15 | Integrated save, lost reply and crash recovery | 4 | A | 4 | Receipt-bound backup reopen and exact-type diff repaired; actual host compare/diff/tampering proof,50client/operation regressions and212native regressions pass. Recovery remains status-only; SQLite in-place unknown is conservative. |
| V16 | Remaining promised table features, including SQL-RANGE-01 and plots | 4 | A | 4 | Explicit stable-order, bounded exact range/generation handling and actual native plot data/render path; audit all parent full-DFV rows for omissions. |
| V17 | MAT worker; D6.8 | 4 | A | 4 | Separate bounded protocol/worker, exact scalars, source-bound opaque handles, cancellation and real stdio oracle; implementation underway. |
| V18 | MAT viewer; D6.9 | 4 | A | 4 | Actual host read-only catalog, N-D/sparse/text/cell/struct controls within V-MAT1; no Save/edit/dirty controls or Python dependency. |
| V19 | Shared supervisor and feature isolation; D6.1–6.2 | 4 | A | 4 | Independent PDF/table/MAT lifecycle, crash isolation, queued-call settlement, no mutation replay, aggregate ownership and bounded restart behaviour. Accepted 7 November 13:3x on dfv-table 4373174b…, dfv-mat 1bab58cb…, dfv-pdf af044680… (see checkpoint); 30-min soak is V21, not here. |
| V20 | Independent full-DFV/fault/resource/performance acceptance; D5 applicable subset | 5 | A | 5 | Fresh source/build, external readers, all-format refusals/security, disk/flush/replace/cancel/kill faults, measured aggregate budgets, PDF MVP regression. Full deferred PDF-parity gate excluded. |
| V21 | Mixed-feature soak; D6.10 | 3 | A | 3 | Two PDFs/four datasets/MAT, bounded 30-minute repeated operations/kill soak, independent integrity and resource plateau/no orphans.  Accepted by the owning run on 7 November 2026 at 22:13; full results in the integrated checkpoint below. |
| V22 | Scheduled PDF UI and smooth zoom; D7.0 | 2 | A | 2 | Accepted 7 November: table + PDF UI narrow/theme/keyboard/axe-style checks in browser and unpacked VS Code host, user-reported real-trackpad PASS (6 Nov). Packaged-VSIX trackpad recheck stays a V23 manual step. |
| V23 | Reproducible VSIX and clean-profile acceptance; D7.1–7.4 | 3 | A | 3 | Only after V12–V22 pass: assets/licences/README/identity, build inventory, packaged native workers offline without development paths, real table/MAT/PDF workflows and SHA. |
| V24 | Freeze, verified source backup and working artifact handoff; D7.5 / completion rules | 3 | A | 3 | Complete intended source/docs/tests/assets snapshot on established GitHub destination, verify remote tree/commit, local VSIX path/hash and rollback recipe; scoped cleanup after verification. No real-profile install. |
| | **Total** | **100** | | **100** | **0 points remain.** |

## Accepted child gates — V1.1 refinement

5 November 2026: the user correctly questioned whether coarse V1 acceptance
measured remaining work fairly. Keep every original parent weight and release
requirement unchanged. Split V14/V15/V17/V18 into binary gates below; previously
uncredited, bounded verified work earns 11 points. This is a reporting refinement
plus newly verified work, **not evidence that 11% of the remaining effort vanished**.
No claim of measured time remaining is made. Historical V1 score remains 50/100;
V1.1 initially recorded61/100; later accepted gates update the headline total.
Postponed PDF parity stays excluded.

| Gate | Weight | State | Earned | Concrete acceptance / supporting evidence / remaining action |
|---|---:|:---:|---:|---|
| V14.1 Native client/provider binding | 2 | A | 2 | Actual default-worker adapter/document/provider gate43 passes; exact scalar round-trips and native-only binding, no reference fallback. Regress after integration changes. |
| V14.2 Native browser core workflows | 2 | A | 2 | SQL, EX02 (13 checks), plot controls and actual Rust SAFE-X1 failure/raw/retry (3 checks) pass with source integrity. Plot canvas excluded from this gate, required by V16. |
| V14.3 Complete native host/security/failure matrix | 2 | A | 2 | SQL/EX02 unpacked host subset passed; cover remaining host/native security/lifecycle paths and preserve profile isolation before accepting. Use V14 commands and audit actual-backend assertions. |
| V15.1 Integrated saves and backup integrity | 1 | A | 1 | Reaccepted6November after receipt-bound reopen/compare/diff, tamper refusals, exact integer/text/decimal/date/nested snapshot proof,50client/operation and212native regressions; six-format/WAL/source-byte proof retained. |
| V15.2 Native process-kill receipt recovery | 1 | A | 1 | Actual six SIGKILL/restart cases plus93 native/fault tests: pre/post publish, lost receipt, missing/corrupt/externally changed outcome classifications; no mutation replay. |
| V15.3 Actual host restart/status lookup | 1 | A | 1 | Six actual NativeDocument SIGKILL cases pass, including requalification after backup/type repairs: one mutation send, one same-ID lookup and one reopen, with no automatic replay. |
| V15.4 Host uncertain-result/default-build safeguards | 1 | A | 1 | Prove unknown missing/corrupt/foreign/external cases remain unknown in real host, normal build excludes test faults, and conservative SQLite in-place contract remains covered; no actual SQLite kill claim without test. |
| V17.1 Isolated worker plus combined protocol integration | 3 | A | 3 | Combined63 tests (worker8,codec29,default-tableprotocol26), strictClippy/fmt; actual MAT stdio, ownership/stale/quota/cancel/source checks, empty sparse results; table defaults preserved. |
| V17.2 Host ownership and supervisor binding | 1 | A | 1 | Actual host startup/close/restart/cancel/resource reclamation using separate MAT protocol. Closed 7 November with V19 (host mixedIsolation + matLifecycle in actual unpacked VS Code, exit 0). |
| V18.1 Read-only exact MAT client | 1 | A | 1 | Two actual worker client tests, no skips, exact uint64/complex/Unicode/N-D/sparse values and handle release with unchanged source; no Python dependency. |
| V18.2 MAT browser core | 1 | A | 1 | Actual-worker browser passes dense ND dimension controls, sparse coordinates, text/complex, empty and cell/struct navigation, bounded invalid request/no Save/no network and source SHA. |
| V18.3 Complete viewer paging, refresh and installed-host proof | 2 | A | 2 | Catalog pagination and selection among1,000 variables/child paging, explicit source refresh/stale handles/cancel, actual disposable VSCode MAT host with lifecycle and source integrity. Browser gate alone cannot accept. |

Parent weight checks: V14=2+2+2=6; V15=1+1+1+1=4;
V17=3+1=4; V18=1+1+2=4. Sum accepted children11; existing baseline50;
initially accepted61, remaining39. Current accepted child total is13; adding the
50-point baseline and accepted V12's3points gives66. These children are acceptance boundaries within the
existing implementation steps below, not new feature scope or duplicated work.

## Shared execution setup and safety

Current paths (verify on resume; do not create replacement workspaces):

- Kod: `/Users/macc/Desktop/Kod`, branch `cleanup/code-only`, HEAD `4e7eb4e`.
- Native integration N: `/Users/macc/dfv-xlsx-resume-20261103`, branch
  `work/dfv-xlsx-resume-20261103`, HEAD `8c2585e` plus unfinished integration.
- UI U: `/Users/macc/dfv-ui-native-integration-20261104`, HEAD `9efc4bb` plus
  unfinished adapter/provider source. `node_modules` is an existing symlink; never commit it.
- MAT M: `/Users/macc/dfv-mat-resume-20261103`, HEAD `5e72f86` plus worker work.
- Native target: `/Users/macc/dfv-resume-20261103-target`, checkpoint-required while
  integration builds remain active; N uses a shared object-store parent that must remain.
- Pinned Rust: `/Users/macc/.rustup/toolchains/1.99.1-aarch64-apple-darwin/bin`.
- Python oracle when needed: `/Users/macc/miniforge3/envs/myproject/bin/python`.

Before any heavy gate, use the existing `Kod/.codex-work/pdf-resume-20261016/lock.sh`
inside its live shell: acquire a unique task tag, stop on acquisition failure, and
register release with `trap ... EXIT`. Never release another owner's live lock.
Set PATH to pinned Rust and CARGO_TARGET_DIR to the retained target. Native gates
below use `--offline -j2`; retain the lockfile, use `--locked` for frozen-candidate
reproduction, and stop/investigate if dependency resolution changes unexpectedly.
Do not activate a Rust language server that starts Cargo outside the heavy lock.

Inputs are source/data files; use redistributable fixtures/private temporary copies,
never user datasets as mutation fixtures. Protect host persistent recovery storage;
never log credentials or data payloads. No external transfers except authorized
source backup to the established repository after inspecting the intended tree.
Reads/refusals preserve source hashes. Writes require canonical source identity,
locks, exact intended-cell readback and recoverable publication. Missing/corrupt
receipts produce unknown, never fabricated success or automatic replay. Retain
unknown recovery artifacts and unique unpushed source when a gate fails.

## Remaining execution steps

Dependencies below are gates to final acceptance. Independent implementation and
small feasibility tests may proceed earlier without claiming dependent acceptance.
For every step: record exact commands/exit codes, source commit/dirty disposition,
fixture/output identity and bounded limitations in the parent evidence checkpoint;
update this ledger only after the whole row passes. Do not rerun accepted expensive
suites unless changed code, failure or a stated integration gate requires it.

The command catalogue is intentionally limited to verified existing commands. A
new test/worker/script path must be discovered or implemented, then its actual
command added before claiming a pass; do not invent an existing test name.

**V12 — codec signoff.** Inputs N's integrated `native/crates/mat` and genuine
MATLAB fixtures; dependency accepted reader contracts, no table engine dependency.
In N run `cargo test --manifest-path native/Cargo.toml --offline -j2 -p
dfv-table-mat --test reader --test hostile`, focused Clippy and formatting.
Map every V-MAT1 class/shape/error/support label to an independent oracle fixture.
The31-test pass and complete support/provenance map close this bounded codec gate. On mismatch keep
raw fixtures and source, fix codec/labels, block worker capability advertising.

**V13 — native operation coverage.** Dependencies V02–V10. In N run the stable
combined graph `cargo test --manifest-path native/Cargo.toml --offline -j2 -p
dfv-table -p dfv-table-engine -p dfv-table-xlsx-ops -p dfv-table-duckdb -p
dfv-table-protocol -p dfv-table-publication --lib --test format_routes --test
catalog_routes`; expand to the full method inventory after bounded discovery via
`rg -n 'READ_METHODS|retrySheetPreparation' src native/crates/table/src`.
Expected complete result/refusal coverage, not merely matching method names.
Repair missing implementation/fixtures on failure; keep V13 uncredited.

**V14 — viewer integration.** Dependencies V13/V15/V16 for final acceptance.
In U run `node_modules/.bin/tsc -p tsconfig.test.json`, then actual native browser
scripts `node test/browser/sqlWorkflow.cjs`, `node test/browser/ex02Selection.cjs`,
`node test/browser/plotAxis.cjs` with DFV_BACKEND=native and DFV_TABLE_WORKER set to
N's verified built worker. Native SAFE-X1 needs a real Rust failure fixture first;
its current reference-only injection must not count. Existing `npm run test:security`
is a discovery starting point: classify real native versus reference paths.
For unpacked host: `npm run build`, set DFV_EXTENSION_DEVELOPMENT_PATH to U,
DFV_BACKEND/DFV_TABLE_WORKER as above, unset DFV_VSIX/DFV_HOST_ROOT and run
`node test/host/sqlWorkflow.cjs` then `node test/host/ex02Selection.cjs` in disposable
profiles. No real profile or package build. On failure retain bounded diagnostics,
repair underlying fault, do not mask timeouts with arbitrary sleeps.

**V15 — save recovery.** Dependencies V07–V10. N's focused V13 graph now includes
reserved-ID/recovered-result unit checks. Discover actual fault hooks/tests with
`rg -n 'test-mutations|SIGKILL|queryMutationOutcome' native test`. Build test-enabled
worker only for explicit kill fixtures, keep it distinct from default deliverable.
Kill before publish, after publish and before result persistence/reply; restart
and verify exact source/destination/backup and committed/not-published/unknown
classification via actual worker and host. Never infer rollback for SQLite in-place
writes from an absent receipt. Restore verified default binary after test builds.
On failure retain receipt/source copies and block mutation release acceptance.

**V16 — full feature closure.** Depends V13; cross-check all full-DFV requirement
IDs in parent before acceptance. In U/N inspect `rg -n 'SQL-RANGE-01|PLOT-02|PLOT-03'
/Users/macc/Desktop/Kod/Projects/PDF_VIEWER_RESEARCH.md`, trace current callers and
implement whole vertical slices with tests. Range tests prove one-based raw-sheet
versus SQL-result coordinates, stable ordering, exact paging, boundaries and stale
result generation. Plot tests must run actual worker data and chart rendering,
not intercept the chart request. Start with tiny duplicate/order/boundary cases;
failures stop broader feature acceptance. Add precise new runnable test commands
once implemented; no existing full feature-suite command verified yet.

**V17 — MAT worker.** Dependencies V12/V19 for final acceptance. M only; preserve
separate protocol/capability namespace and default table behaviour. Discover worker
manifest through `rg --files native | rg 'Cargo.toml|schema'`, implement bounded
open/catalog/describe/slice/sparse/children/close/release with canonical integers
and opaque generation/session handles. Add real stdio fixture/oracle and stale,
cross-session, quota, cancel, huge sparse and malformed/compressed-input tests;
record actual package/test commands after worker exists. Failure limits advertised
support, blocks V18; no dense fallback for huge sparse data.

**V18 — MAT viewer.** Dependencies V17. U's `src/features/mat/` is a planned path;
verify before creating. Reuse existing host transport/lifecycle, implement read-only
one-based controls and paged children/sparse/ND data with explicit support labels.
Run U typecheck and add actual disposable-host fixture workflows; record new
commands when written. Assert no edit/Save/dirty path and unchanged MAT hash.
On failure keep provider disabled rather than claim MAT completion.

**V19 — supervision.** Inputs native table, PDF MVP and MAT worker protocols.
Implement independent process lifecycle in U; inspect existing native worker/client
helpers with bounded symbol searches before adding code. Add actual child-death,
stale-reply, queue/cancel/close and restart-bound tests; integrate MAT protocol
without breaking table defaults. Measure total active workers/resources. Exact new
supervisor test command is a discovery output, not an assumed existing script.
Failures preserve source/drafts and block mixed acceptance, never replay mutations.

**V20 — independent acceptance.** Dependencies V12–V19. Freeze intended source into
a temporary checkout outside Kod without copying unrelated dirt; establish fresh
build from pinned lockfiles. Reuse completed external-reader/fault fixtures and
inventory actual existing commands via `rg --files test native | rg 'fault|resource|write|format'`.
Run all advertised format read/write/refusal and security/host paths plus retained
PDF MVP. Measure source/output integrity, total RSS/CPU/IPC/temp/handle use and
representative open/query/save latency. Freeze workload-specific budgets from
existing parent contracts before measurement; unresolved numeric budgets are a
required discovery, not permission to invent pass thresholds. On mismatch preserve
failed inputs/receipts, reopen affected component and stop V21–V23 acceptance.

**V21 — mixed soak.** Dependencies V18–V20 and retained PDF MVP. Two PDFs, four
active datasets and MAT; repeat open/close/refresh/edit and kill workers for the
parent-required 30 minutes. Reuse existing host harness; locate or implement the
mixed runner and record actual command before starting. Track aggregate resource
plateau and no orphan processes; independent source/output checks after run.
Timebox once per changed coherent candidate. Failure keeps useful bounded evidence
and returns to the owning implementation; interrupted runs receive zero credit.

**V22 — PDF UI/zoom.** Dependency V21 for final scheduling; existing UI reused.
Follow D7.0/UI-03 and current `media/pdf-vscode/` assets in parent. First inspect
packaged/development asset provenance so missing-media warning is resolved without
copying stale bundles. Exercise theme/narrow layout/keyboard and actual physical
trackpad smooth zoom plus supported edit/export/recovery. Manual physical-input
acceptance cannot be replaced with synthetic events. Record runnable UI tests and
manual outcomes; if unavailable mark pending, do not silently defer beyond release.

**V23 — package.** All V01–V22 accepted first; this is the first permitted VSIX
build. Inspect actual build/package scripts and installed/remote version identity;
add/verify D7.1 packaging recipe rather than assume a release script exists.
Include exact workers/UI/fonts/licences, supported capability README and inventory;
exclude development paths, user inputs and test switches. Build, SHA-256 and unpack,
then disposable-profile offline host acceptance with development runtimes hidden.
Read outputs independently. Failed package is undeliverable: preserve minimal
failure evidence, fix/rebuild, and do not install in the real profile.

**V24 — freeze and handoff.** Dependency V23. Inspect established remotes/visibility
and intended diff, commit intended full source/docs/tests/assets/this plan, push
under existing completion authorization and verify remote commit/tree with Git.
Never force push, guess visibility or delete unique local files before verification.
Deliver absolute VSIX path, SHA, version/platform, concise validation and limitations.
Clean completed generated outputs/disposable test copies only after required remote
readback; retain application source, requested VSIX and unknown recovery evidence.
On failed push retain local source/artifact and report the blocker. Public release,
deployment and real-profile installation are outside this milestone.

## Pace and current checkpoint

Timeboxes are investigation checkpoints, not delivery promises: 20–30 minutes per
new codec/worker feasibility slice; 10–15 minutes per focused host reproduction;
compare elapsed time to concrete accepted outcomes, revise approach after a failed
slice instead of silently retrying. The 30-minute soak and fresh/package acceptance
are mandatory gates, not estimated optional polish. Resource budgets come from V20
contract discovery before its acceptance.

**5 November 2026, 11:20 CET — checkpoint (root).** Weights V1 sum to 100;
accepted component/profile weights sum to 50. Current work: V13/V14/V15/V17.
Recent root Arrow corpus 13/13 passes; previous hostile 10/10 retained. Combined
native publication/table/catalog/format gate 86 tests across seven suites passes,
17.31s; includes current Arrow integration and live XLSX retry metadata. First new
recovery fixture exposed `/var` versus `/private` path alias in the fixture; canonical
fixture repaired, production already canonical. Adapter TypeScript check plus eight
scripted tests passes, including atomic retry metadata replacement/rejection; source
uncommitted with required nativeOperations/nativeSelect dependencies. Actual native
SAFE-X1 failure/retry browser remains pending. Earlier actual unpacked table SQL and
EX02 host run exit 0 is checkpoint-reported, not a new run today; table-only scope.
MAT worker remains partial. Source dirty in N/U/M; do not commit a broken subset.
No new VSIX. Writer owns actual process-kill harness next; engine agent owns MAT
worker. Inspect the shared lock before any new heavy gate; owner/process changes
must be recorded in parent checkpoint. Required retained artifacts: native target,
source checkouts and unfinished fixtures. Next root action: validate this ledger
arithmetic/scope against parent and publish the first-VSIX progress figure locally;
next implementation gate: writer's actual kill/reconcile check, then native viewer
failure coverage and MAT worker fixture proof. Parent owns detailed live process
updates; this checkpoint records the milestone boundary without duplicating logs.

**11:29 CET update:** writer reports final focused publication/unit gate 93 tests
across six suites passes, plus six actual SIGKILL scenarios including missing or
corrupt receipt and externally replaced destination yielding unknown. Default
(non-test-feature) worker restored and independently hashed:
`1449dd3a7e503569d3b85cfbb9a86a2d932e1c5181884e0e836850d7286b32e4`.
Strict lint found two new owned-comparison warnings; repaired, final lint and
all staged-writer regressions still pending. MAT further hostile/lint gate owned
by engine agent. No row promoted: first-release acceptance remains **50/100**.

**11:52 CET review:** engine independently reviewed V1.1 scope/credit boundaries;
3-point standalone/combined MAT worker versus1-point host binding is a planning
judgment, not an effort measurement. Retained unchanged; fixed V18 parent state to
in-progress and removed stale native-kill-pending wording. Catalog requirement is
selection among1,000 variables with real pagination, not an invented >1,000 scope.
Root actual native range/provider gate passes (2.43s): exact multi-letter pages,
equivalent SQL independently run through native worker, unordered/stale/sort/source
change refusals. First failed expectation used JS numbers rather than exact integer
display strings; corrected test, application values unchanged. Range browser pending.

## Current interruption checkpoint — 2026-11-05 20:05:11 CET

One agent reported the usage limit. Work stops at a safe boundary; heavy lock is
free, root range browser session44792 finished exit0, no owned Cargo/browser/host
process remains. N HEAD8c2585e, U HEAD9efc4bb, M HEAD5e72f86 plus preserved dirty
source/tests; Kod cleanup/code-only HEAD4e7eb4e. No commits/push/VSIX created.

Latest accepted V15.3/V15.4 actual host proofs add2 points: **63 accepted,37
remaining**. Six actual NativeDocument worker-kill cases verify one status lookup
of the same mutation ID, one mutation send, one reopen and no automatic replay;
missing/corrupt/external outcomes remain unknown. Normal worker SHA
`514fc5a2c44cb0bff41b73099bb6a4ea0f8e728a18ac3366b2d3af88f5386401`.
The standalone source-operation matrix passed23 tests/all22 read methods with83
typed refusals and original/backup/workbook/database byte checks; V13 remains
uncredited until SQL-RANGE host contract/inventory and whole-row closure reviewed.

SQL-RANGE actual native browser now PASS: raw worksheet multi-letter rectangle,
100-row paged results beyond initial preview, exact stable SQL snapshot cells,
equivalent SQL independently read through native worker, bounds/order/sort stale
refusal, unchanged source/no writes/no network/errors. Root first diagnosed valid
range beyond100-row initial preview, then fixed on-demand bounded raw-sheet read;
subsequent test found default row-limit0 means uncapped, fixed guard accordingly.
Actual native CSV provider test passes too; full UI tsc --noEmit passed after
fixing a rangeContext undefined narrowing issue. Tests: U/test/queryRange.test.ts,
test/nativeProvider.test.ts (captures exact range), test/browser/queryRange.cjs.
Remaining range closure: add frozen host schema/inventory entry, bound total page
cells for extremely wide selections, regression across actual sort/live/source
refresh and client stale-response races, then review complete requirement acceptance.
Do not mark the whole V16 (also plots) accepted from this range gate.

MAT client6/6 and actual browser + unpacked VSCode host pass with genuine1000variable
catalog paging, exact uint64/sparse/ND/cell/struct/text, invalid bounds, unsupported
metadata, refresh and source integrity. Metadata-only opaque MATLAB objects can
have unrecorded rank; client accepts absent rank only there, not dense arrays.
MAT/table isolation2 real Node tests and actual Code host pass: pending calls settle
on child death, other feature remains usable, explicit refresh creates exactly one
worker/discards old handles,10 cancellation/open/close cycles leave no owned PIDs.
Worker MAT SHA5020653889f47b80e93e55dd705e38f5a1ae1fbe66eede1cf0519c66b701346e.
No full V19 credit: PDF/shared aggregate and resource campaign remain unverified.

PDF assets restored/pinned: U/native/pdf-mvp-assets.json and16 retained runtime
files exactly match qualified31October artifact; build passes without missing-PDF
warning. PDF worker U/media/pdf/bin/dfv-pdf SHA
`af044680f79db92fee47998c290669d6d97d7cc1122aa3d0b57627be995e8138`.
Pin invalid/missing/hash refusal3tests plus7 existing explicit-bundle refusal checks
pass. Source-native rebuild binding remains unverified, not silently claimed.

V12 remains0. Existing MAT18 hostile+12 reader tests pass, source bytes and struct
array members now checked; huge empty-char regression disproved suspected allocation
bug (<64KiB for2.147billionx0 shape through existing early-return). One explicit
ignored test awaits additional genuine class/oracle fixtures. MATLAB batch startup
produced no fixtures/output after104sec and only the owned process was terminated;
no repeated attempt. Preserve unfinished generator/support scripts and fixtures.

Exact next actions: read this checkpoint and parent, verify Git/locks/processes,
run U `node_modules/.bin/tsc -p tsconfig.json --noEmit` if source changed, finish
range host contract/schema and source-level review; then actual three-feature
PDF/table/MAT failure isolation with the retained verified PDF worker, independent
resource/performance campaign, remaining plot rendering/feature audit and MAT
corpus blocker. All full-DFV gates before any VSIX. Preserve active shared native
target, out-test, staged16 PDF runtime assets and unique external source/test
checkouts; U/node_modules is a symlink, not deliverable. Completed private fixtures
from gates were removed by owning harnesses; dist may remain for active next host
gate, inspect owner/use before cleanup. Never delete source or unknown recovery data.

**Resumed 2026-11-05 20:27:18 CET:** parent agent remains available despite one subagent quota
error; earlier stop reason was mistaken and work resumes. Root owns range/schema
closure, engine PDF/table/MAT integration isolation, writer actual plot rendering.
No score or scope change until their acceptance gates finish. Heavy tests serialize.

**2026-11-05 20:32:29 CET focused acceptance:** range contracts/bounds/stale reply browser suite
nowpasses; V13 operation closure awaits current plot-cap fix regression review.
Actualthree-featureVSCode isolationpasses (separate from aggregate resource/soak and
dirtyPDFrecovery). New realnative chart test found UI default200000 vs backend100000
cap mismatch; fixing as a chart-only limit, never silently downsampling. V16 remains
unaccepted until actualplot renderingpasses. MAT extra corpus oneheadless/no-JVM
attempt underway; inherited ServiceHost remains untouched. No packaging permitted.

## Current interruption checkpoint — 2026-11-06 01:30 CET

Resumed from the preserved uncommitted N/U work. Kod HEAD4e7eb4e, N HEAD8c2585e,
U HEAD9efc4bb. No former test workers were running; lock was free at entry.
V12 now accepted3 after reviewing the completed31-test/strict-Clippy codec proof,
complete bounded support map and independently verifying all8 fixture/generator
SHA/size bindings. Current total **66 accepted,34 remaining**; weights unchanged.
Earlier61/63 figures above are historical snapshots, not the current total.

Three active agents: paging_finish (N table resource/store/page), excel_finish
(EX04/EX06 native and selected-context/metadata integration), resource_recover
(focused three-worker resource test). Root owns plans/contract audit. See parent
current checkpoint near its beginning for exact work paths, recovery boundaries
and next actions. No VSIX produced. Full DFV, resource/fault qualification, mixed
soak, scheduled PDF UI, reproducible packaging and handoff remain mandatory.

## Checkpoint — 2026-11-06 20:55 CET (Claude, MAT lifecycle review)

**V18.3 accepted (+2): 68 accepted, 32 remaining.** Evidence (agent report, root spot-checked
files exist, no skips): U untracked `test/matLifecycle.test.ts` (5 tests), `test/ownershipHolder.cjs`,
`test/resources/createMatChildren.py`, `test/host/matLifecycle.cjs`; all exit 0 under heavy lock
`MATGATE-V18-V19` with pinned dfv-mat SHA 3709812f… and dfv-table SHA 1bd6511e…. Covers 250 cell/struct
children paged 100/100/50 in client and unpacked VS Code host, in-flight cancel settling, hung-worker
cancel `worker_timeout` at 35,002 ms, replaced source `stale_source`, refresh replaces one worker,
tab close reclaims only its worker. Limits: host cancel test accepts cancelled-or-completed (fixtures
too small to prove a mid-read `cancelled` reply); replacement tested by rename, not in-place overwrite.
**V17.2 held** (plan: depends on V19); V19 lacks aggregate RSS/CPU/temp budgets and 30-min soak.
Worker SHAs differ from the 20653889 MAT SHA above (target rebuilt); re-pin at V20/V23.
New U files are uncommitted. V13 and V16 agents still running; no VSIX.

**20:58 CET V16 evidence (agent report; V16 NOT credited).** Cap fix present (UI/nativeDocument/native: 200000 chart, 100000 read);
native runChartQuery row/date implemented. `test/browser/nativePlot.cjs` (real worker -> ChartPanel -> ECharts canvas, pixel
assertions: row, date, 150k ramp, inline worksheet table, cap + malformed-date refusals) passes 4x; queryRange browser/test and
118-test chart/range/migration set pass (2 skips: R-helper fixture, absent D0.4 reuse inventory); cargo chart_axes 4/4. Run via
`npm run test:browser:native` (U, untracked test edits). Audit found no native/host evidence for EX-07 (narrow 420x800 layout +
keyboard), SAFE-X3 (100 grow/shrink edits + export/reopen), SAFE-X4 (ZIP-budget/write-integrity suites); EX-04/06, PERF-X1,
MOD-03/04/05 unaudited/open; wide raw-worksheet range read has no cell cap when maxResultRows=0 (untested); unpacked-host
plot/range run belongs to V14.3. V16 stays 0 until those pass.

**21:05 CET V22 manual trackpad item — user-reported PASS (V22 NOT credited as a row).** Real Mac trackpad, unpacked
development build (pinned copy of U, disposable profile, no VSIX): user reported "zoom is perfect" on the mixed/rotated-page,
400-page and active-draft PDFs. No frame-time/latency/anchor-drift numbers were measured (no instrumentation); this is a
recorded manual smoothness check only. Still required for V22: narrow-layout/theme/keyboard/accessibility checks and a
packaged-VSIX trackpad recheck at V23. First launch failed only because the launcher passed relative PDF paths (fixed; not an
extension fault). Test profile and fixtures pending deletion (see user).

## Checkpoint — 2026-11-06 21:35 CET (Claude, V13 accepted)

**V13 accepted (+5): 73 accepted, 27 remaining.** Evidence (agent report, under heavy lock): plan V13 cargo command exit 0
(catalog_routes 11/11, format_routes 7/7); `nativeOperationCoverage.test.js` 23/23 — all 22 read methods, concrete result +
typed not_open/stale_source/malformed_value on the real worker; `nativeDocumentOperations.test.ts` 25/25 — all 24 viewer
operations through NativeDocument; full UI suite with every env set: 1238 tests, 1191 pass, 0 fail, 38 skipped (28 Tier-B
foreign corpus, 6 SIGKILL host cases = V15.3, 2 resource phases = V20/V21, 1 opt-in R-helper gate, 1 absent D0.4 file), 9 todo
(EX-06/EX-01 known-issue markers); clippy -D warnings + fmt --check pass for dfv-table-engine/dfv-table. Inventory: 22 reads
== READ_METHODS; SQL-RANGE items are host views only (query-range.v1 schema). Fixed: testdoc.rs compile break (D3.1 tests had
been skipping), adapter locateXlsxEdit row-ordinal number-vs-string, matLifecycle/pdfHost leaks and unbounded waits,
nativeBackend exit-listener race. **Default worker re-built: dfv-table SHA a32e1c28…8343a5 (was 1bd6511e…); re-pin anything
pinned to the old SHA.** Open risks: edited test/host/matLifecycle.cjs not re-run since V18.3 acceptance (re-run once under the
lock); matLifecycle defaults hard-code /Users/macc paths; xlsx-ops/tests/operations.rs fmt drift (Excel agent). V16 still
blocked on EX-07, SAFE-X3, SAFE-X4. All source uncommitted; no VSIX.

**21:45 CET SAFE-X3/SAFE-X4 evidence (agent report; V16 NOT yet credited — EX-07 pending).** New N tests (package
dfv-table-engine, dir crates/table/tests): `xlsx_edit_cycle.rs` (100 alternating grow/shrink updateCell edits with unique
mutation ids; per edit: same receipt via queryMutationOutcome, ZIP member names/order and all non-sheet members byte-identical,
text present once, no backup rewritten; every 10 edits close/reopen; native reader + openpyxl readback; exact reproducible
sizes; RSS 86-89 MiB) and `xlsx_zip_refusals.rs` (4 tests: encrypted=unsupported; overlap/alias/missing-central/truncated/empty
=malformed_value; zip64 markers + DOCTYPE=resource_limit; 257 MiB part, lying-size bomb, 3x200 MiB, declared 300 MiB
=resource_limit under production limits; edit refusals leave source/backup/published files unchanged, stale/replaced/deleted
source = stale_source). Existing xlsx(budget 13/hostile 5/workbook 19), xlsx-patch, backup-diff, publication (+25 with
test-mutations) suites rerun green. Run: heavy lock, pinned PATH, shared target, DFV_REF_PYTHON, private 0700
DFV_TABLE_STATE_DIR; `cargo test --manifest-path native/Cargo.toml --offline -j2 -p dfv-table-engine --test xlsx_edit_cycle
--test xlsx_zip_refusals`. Only product-adjacent change: table/Cargo.toml dev-deps crc32fast =1.5.3, flate2 =1.1.10 (already
locked). LIMITS (real): each updateCell leaves ~2 small files (~2.1 KB) in the state dir with no pruning (213 files/216 KB after
100 edits); each reopen adds one hidden .dfv-table-lock-* sidecar beside the source; each explicit unlock after reopen adds one
rows.backup-* file; size bounds come from one tiny compressible fixture; clippy not run on the new test files.

**21:55 CET EX-07 narrow-layout/keyboard evidence (agent report; V16 NOT credited).** U: `media/main.css` (@media max-width 600px
block: sidebar strip <=18vh, wrapping toolbars, editor <=24vh), `src/webview.ts` (sheet items tabIndex=0, Enter/Space preview,
focus kept across renderTables), new `test/browser/ex07Narrow.cjs` (8 checks at 420x800: no horizontal overflow, all controls
inside viewport/not overlapping, a11y labels/roles, Tab reaches every control, keyboard-only sheet/SQL/range/axis flows, no
page errors/requests, workbook bytes unchanged). Red baseline on old CSS: exit 1 "horizontal overflow 509". Green with
sqlWorkflow, ex02Selection, plotAxis, nativePlot (all exit 0) under lock EX07-NARROW. Not done (EX-07 text 3193/3321): installed-host
recording, loading/retry/empty-sheet/settings-off states, 100 rapid switches, Live-interval geometry; no arrow-key roving or
collapsible sidebar. Not yet in package.json test:browser scripts. V16 remaining: those EX-07 items, EX-04/EX-06 (9 todo markers),
PERF-X1, MOD-03/04/05 audit, wide raw-worksheet range cap, unpacked-host plot/range (V14.3).

## Checkpoint — 2026-11-07 02:55 CET (Claude resuming; no source changed)

Resumed from the 6 Nov 21:55 checkpoint. Verified: no cargo/browser/native workers running; Kod HEAD 4e7eb4e, N 8c2585e, U 9efc4bb
(all work still uncommitted). The heavy lock was STALE (owner pid 25351, EX07-ALL, dead): moved to
`heavy-test.lock.interrupted-ex07all-20261107-stale`. Header score corrected 66 -> 73 (V13 +5, V18.3 +2 recorded above).
Evidence (heavy lock, DFV_BACKEND=native, worker = shared target debug/dfv-table): `ex07Narrow.cjs` 8 checks and `ex07States.cjs`
8 checks pass (100 rapid sheet switches -> 12 host queries, 2 paints, final Gamma); wide raw-worksheet range cell cap
(`RANGE_READ_CELLS` 2,000,000, `assertRangeReadWithinCells`) already exists with test `wide range pages bound cells as well as rows`.
`cargo test -p dfv-table-xlsx-ops --test operations` 13/13 incl. declared corpus tables (explicit-single/adjacent/stacked match
ground truth natively), malformed/overlapping relationships refuse, manual header rectangle, detector columns == derived columns.
The 5 EX-06 `todo` markers in U `test/xlsxCorpus.test.ts` target the TypeScript reference reader, not the native worker.
Real gap: native `multilevel-header` fixture is still a KNOWN_TS_DEFECT (only manual header selection covers it; acceptance text
for EX-06 does not require multi-level headers). V16 stays 0: PERF-X1 has NO measurements yet, MOD-03/04/05 unaudited, EX-07
installed-host recording not done, unpacked-host plot/range = V14.3. Removed U `test/stress/_work` (42 MB, gitignored, regenerated).
**Next:** PERF-X1 measurement plan (preflight, selected-sheet parse, readGrid, detection, derived prep, catalog serialization,
render timed separately on a representative large workbook, native worker), then MOD-03/04/05 audit, then V14.3 host matrix.

## Checkpoint — 2026-11-07 (Claude, agent reports: MOD audit, V19; PERF-X1 and V14.3 still running)

**MOD-03/04/05 audit (read-only agent):** MOD-03/05 satisfied for table+MAT (PDF engine is a prebuilt hash-pinned binary, no source
here). MOD-04 (component-manifest.json, export script, retrieval notes) is MISSING entirely; export needs a committed tree. Scope
call (include data-only/MAT part, record PDF-only archive as excluded) is awaiting the user. Small gaps: no test asserts a data-only
host starts no PDF/MAT worker; protocol `is_mutation` hard-codes table routes; no MAT version-2 refusal test.

**V19 / V17.2 — NOT credited yet (held).** Agent evidence, pinned workers (dfv-table a32e1c28…, dfv-mat 3709812f…, dfv-pdf af044680…,
debug builds), heavy lock: tsc 0; 28 node tests (supervisor, pdfHostBounds, matIsolation, matLifecycle, pdfHostFailure, pdfBackup)
28/0 fail; nativeBackend 17 pass/3 skip; host mixedIsolation + matLifecycle exit 0; nativeResources limits + seven-document phases pass.
Seven-document peaks (MiB): table CSV 449, PDF image-heavy 188, MAT 66.6, aggregate native 826.5 (earlier 650.2) vs frozen 2048.
**Blocker:** in the hostile *limits* phase one CSV table worker reached 869 MiB, above the frozen `table_worker_each` = 768 "contract"
(basis: 512 MB DuckDB memory_limit + 256 MiB held cap — evidently not a true RSS bound). Budgets were frozen before measurement; they are
not raised after a violation without a dated revision. Decision needed: relabel (e.g. operational 1024) with old/new values and reason,
or fix the worker to honour 768. Agent edited only U `native/resource-policy.json` (added a `measurements` block; frozen blocks unchanged).
Not run: V21 soak (`DFV_NATIVE_RESOURCE_PHASE=soak DFV_SOAK_SECONDS=1800`), release-build remeasure. Two 12 KB temp dirs leaked by
pdfBackup/pdfHostFailure tests (agent removed its private TMPDIR; cause not investigated).

**PERF-X1 measured (agent report; V16 still NOT credited).** Debug worker (a32e1c28…), Apple M4, `test/perf/perfX1Bench.cjs --backend native`
(U; fixtures private, deleted), heavy lock PERFX1-CLAUDE. EX-04 PASS: with 9 unopened 40k×10 sheets the selected-sheet work is identical to
a 1-sheet file (1 detector call, 202 cells, detect ~5.3 ms, parse ~4.1 ms, cache 2 objects/17 KB); visiting all 9 big sheets kept the cache
≤55.1 MB under the 67.1 MB cap (16 evictions, 0 failures; worker RSS 340 MB vs 91 MB). Workbook preflight scales with bytes (~0.37 s/MB
compressed, ZIP budget validation, not to be trimmed per SAFE-X4). Selected-sheet first query: 40k×10 9.4 s, dense 20k×25 11.8 s,
tall 200k×3 15.2 s, wide 200×1000 4.7 s (peak RSS 220/262/340/487 MB); warm 70–110 ms (wide 585 ms). Catalog serialization 0–0.7 ms.
Findings (unfixed): (1) selected sheet parsed 3× on first open (`load_raw`, `detect_and_bind`, `declared_tables` in xlsx-ops/src/lib.rs;
25–45% of first-open cost); (2) a sheet over the 64 MiB cache cap is evicted every read (sparse 10M-extent: warm 3.08 s, RSS 763 MB);
(3) `text_grid` allocates by extent, not populated cells (bounded by the 10M extent limit, ~242 MB/grid copy). Not measured: render,
250 ms cancellation, release build. The plan has no numeric open-time budget, so these are recorded, not pass/failed.

**V14.3 host matrix (agent report; NOT credited — two product defects open).** Six unpacked-host scripts exit 0 in one lock hold
(V143-FINAL), native worker only, dfv-table a32e1c28…, disposable /tmp profiles, no VSIX: sqlWorkflow, ex02Selection, nativeHostRefusals,
nativeHostRange, nativeHostPlot (new), nativeHostLifecycle (`npm run test:host:native` added). Covered: 21 hostile statements + 5
URL/path forms refused with typed text; readonly 0444 Stata offers no Save; damaged xlsx spawn no worker / good sheet still reads;
unlock+edit changes exactly one ZIP member; SIGSTOP+SIGKILL mid-save = visible failure, no restart/replay, bytes unchanged; replaced
workbook save refused; real profile fingerprint unchanged; SQL-RANGE pages 100/100/4 + 5 bad rectangles refused + stale-source refusal;
plot row/date axis, 150k painted, cap refusals (canvas pixel quadrants, 10% tolerance). Earlier nativeHost*.cjs drafts had tautological
assertions; rewritten. DEFECTS (unfixed): (1) after any successful save, SELECT on a detected-table name ("Data · Table 1") fails with
generic policy_refused until the sheet is re-selected; (2) worker-loss / stale-source / bad-date-axis failures all show the generic
"query could not be completed" text (`queryDiagnostic` fall-through in src/queryDiagnostics.ts). Not covered: mid-read cancel in host;
final run not repeated twice. Sidecars created by design: `<file>.dfv.lock`, `.dfv-table-lock-*`, one `book.backup-*.xlsx`.

**Chart hover (user request, in scope as PLOT polish; not scored).** Popup shortened (label + ≤6 values, 4 significant digits); exact
values + ISO timestamp moved to a corner readout (`.chart-readout`) in the corner with fewest visible points (never top-right: toolbar).
U src/chartView.ts, media/main.css, test/browser/chartDetail.cjs (readout exact, popup not exact, no point under readout). chartDetail,
plotAxis, nativePlot browser suites + upstream drift pass. R helper tooltip NOT changed (drift gate records the difference).

**V14.3 defect 2 FIXED (agent report, root grepped test/host + test/browser: nothing pins the old generic text).** U
`src/queryDiagnostics.ts` new `nativeDiagnostic()` maps typed native codes to fixed, non-leaking text (stale_source, table_changed,
ambiguous_row, no_matching_row, mutation_not_published, worker_exited/timeout/failed, not_open, read_only, unsupported, frame_too_large,
malformed_value, any unknown mutation outcome = "The save was not confirmed…" — never claims saved/retried when unknown);
`duckdbEditorProvider.ts` date-axis catch passes `dateAxis`. policy_refused, runtime_busy, queue_full, deadline_exceeded, cancelled,
resource_limit unchanged. New test in test/queryDiagnostics.test.ts (24 code/outcome cases). 48/48 pass (queryDiagnostics, securityMatrix,
queryMessages, restrictedQueries, nativeDocumentOperations) with the real worker. Not rerun: host scripts. Defect 1 fix in progress.

## Checkpoint — 2026-11-07 04:00 CET (Claude): V14.3 accepted (+2): 75 accepted, 25 remaining

Defect 1 FIXED (agent report): root cause — a successful `updateCell` reopened the workbook from saved bytes (`write_dispatch.rs`), losing
detected/derived tables, so a SELECT on "Data · Table 1" hit `policy_refused`. Fix: after the reopen, carry table settings
(`xlsx::copy_options`) and re-detect previously detected sheets from the SAVED bytes (`xlsx::mirror_selected`); a failed re-detect adds a
save notice instead of silent refusal. Regression tests (fail before / pass after): N `table/tests/xlsx_edit_cycle.rs`
`a_detected_table_stays_queryable_by_name_after_a_save`; U `nativeDocumentOperations.test.ts`. Cargo (dfv-table-engine + xlsx-ops, 33+11+7+6+4+1+7
+2+4 +2+13) green; U nativeDocumentOperations + nativeOperationCoverage 49/49. Not run: clippy on the new test.
**Worker rebuilt: dfv-table debug SHA-256 `9eee35900f00ba5281cbd08d93b25c996d772767f3f3ef4e057c436c94823ed6` (was a32e1c28…). Re-pin anything
pinned to the old SHA (V19/V13/V14.3 evidence refers to the superseded binary; V19 resource run must be repeated on the new SHA).**
Root rerun under lock V143-RERUN-20261107 against the new worker: sqlWorkflow, ex02Selection, nativeHostRefusals, nativeHostRange,
nativeHostPlot exit 0; nativeHostLifecycle failed once on its own over-strict regex (rejected the new stale text "Nothing was saved.");
assertion corrected to require "changed on disk" and reject success wording; rerun exit 0 (V143-RERUN2). Limitation: that host test
freezes the worker before `updateCell` is sent (the pending call is `setSafeMode`), so the "save not confirmed" wording is only
unit-tested (24 cases) and covered by V15.3 SIGKILL tests, not by this host script. Credit basis: V14.3 text (host/native security,
lifecycle, plot/range, profile isolation, actual-backend assertions) satisfied; both defects closed. V14 parent now A (6/6).
Still open: V16 (MOD-04 scope decision, EX-07 installed-host recording, PERF-X1 findings 1–3 undecided), V17.2/V19 (budget decision 768 vs
1024 MiB + rerun on new SHA), V20, V21 soak, V22 (narrow/theme/a11y/packaged trackpad), V23, V24. No commit/push/VSIX.

## Checkpoint — 2026-11-07 12:15 Europe/Madrid (Claude; user decisions recorded)

**User decisions:** (1) V19 table-worker budget revised from 768 "contract" to 1024 MiB operational (dated revision to be written into
`native/resource-policy.json` by the V19 run; frozen `pdf_host` untouched). (2) MOD-04 EXCLUDED from the first VSIX (user: MAT is
review-only; component-archive packaging not wanted now; reversible). (3) PERF-X1 finding 1 FIX approved. (4) User wants the VSIX as
fast as possible and asked for parallel agents; the gate "no VSIX before full DFV acceptance" still stands, so the work is the shortest
path through V16/V17.2/V19/V20/V21/V22/V23/V24.

**PERF-X1 finding 1 fixed (N, uncommitted):** `crates/xlsx-ops/src/lib.rs` — `load_raw` stages the parsed sheet + raw grid
(`staged`) for the detection that follows, so the first open of the selected sheet decodes its grid once (was twice; `declared_tables`
still rescans the sheet XML for tablePart ids — small, not changed). New test
`first_open_of_the_selected_sheet_decodes_its_grid_once` (fails with count 2 when staging is disabled, passes with fix). Evidence:
xlsx-ops 18 tests, strict clippy clean, whole native workspace 541 passed / 0 failed (needs `DFV_REF_PYTHON` and a private
`DFV_TABLE_STATE_DIR`). **New dfv-table debug SHA 4373174b38c48fa7…** (supersedes 9eee3590…). Findings 2 and 3 remain recorded, not fixed.

## Checkpoint — 2026-11-07 ~12:50 Europe/Madrid (Claude; STOPPED at user request)

User asked to stop. Three agents (V19 resource rerun, V22/EX-07 UI checks, V23 VSIX rehearsal) were stopped mid-run; their processes
were killed, the heavy lock is free (two stale/aborted holds released), and the V23 rehearsal build dir was deleted. Score unchanged:
**75/100**. No VSIX, no commit, no push.

State left behind (U, uncommitted): `native/resource-policy.json` already shows `table_worker_each` = 1024 operational (user-approved
revision) but V19/V17.2 are NOT credited — the resource rerun on SHA 4373174b… did not finish. Agent edits to U `test/` files may be
partial (V22/EX-07); re-run the browser/host suites before trusting them. N: PERF-X1 single-parse fix is complete and verified
(541 native tests passed). Decisions recorded above (1024 MiB, MOD-04 excluded, triple-parse fix).

Resume with: (1) V19/V17.2 resource rerun on dfv-table 4373174b…; (2) V22 + EX-07 UI checks; (3) V20; (4) V21 30-min soak;
(5) V23 release-build rehearsal then final VSIX; (6) V24. Take the heavy lock before any heavy run.

## Checkpoint — 2026-11-07 13:15 CET (Claude V22/EX-07 UI agent): V22 accepted (+2): 77 accepted, 23 remaining

Dev copy U, worker dfv-table 4373174b…, DFV_BACKEND=native, heavy lock V22-AGENT (released). Earlier partial agent edits to U
(`media/main.css` contrast/narrow, `src/webview.ts` keyboard sheets, `test/browser/{a11yScan,ex07Narrow,ex07States}.cjs`,
`test/host/{ex07Host,pdfUiHost}.cjs`, `test/pdfTheme.cjs`) were audited and kept as sound; chart hover work untouched.
Results (exit 0 each): `ex07Narrow.cjs` 12 checks (420x800 and 320x568 reflow; OS light/dark, the four VS Code theme body classes,
forced-colors; Tab order, keyboard-only sheet/SQL/range/axis/Safe Mode flows; axe-style scan = contrast, names, ids, ARIA refs);
`ex07States.cjs` 8 checks (loading+Cancel, empty sheet, pending, failed+limited with keyboard Retry, Live geometry, settings off, 100
rapid switches -> 12 host queries, 2 paints, final Gamma, draft kept); `test/host/ex07Host.cjs` (ACTUAL unpacked VS Code, disposable
profile, native worker, 410px webview, real keys) 8 cases: layout, keyboard, loading with frozen worker, empty sheet, 100 rapid
switches (burst 228 ms, no foreign/late paint, draft kept, same worker), four live themes, damaged sheet reported, settings off;
`test/host/pdfUiHost.cjs` (real dfv-pdf in unpacked host, 410px): four themes clean, toolbar inside, Enter on Zoom in 81%->101%,
PDF unchanged; `pdfTheme.cjs` 6 PASS; sheetTables+webviewState unit 56/56; sqlWorkflow, chartDetail, plotAxis, ex02Selection,
nativePlot, queryRange browser suites pass. **EX-07 acceptance met** (keyboard, narrow, loading, retry/failure, empty, settings off,
100 switches). V16 is NOT credited here: EX-04/EX-06 todo markers, PERF-X1 findings 2-3, MOD-03/04/05 remain.
Not run: `safeX1Preparation.cjs` under native needs a worker built with `dfv-table-xlsx-ops/test-detection-failure` and
`DFV_TEST_XLSX_FAIL_ONCE_SHEET=Data` (exit 1 on the default worker is that precondition; V14.2 recorded it passing on the fault build).
Limits: axe-style scan is an in-repo rule subset, not axe-core or a screen reader; damaged-sheet host case showed no Retry for that
failure class (Retry is covered in the browser suite); PDF host check covers chrome/themes/zoom keyboard, not edit/export (V11).
Manual left for the user: packaged-VSIX trackpad recheck (V23); optional VoiceOver pass.

## Checkpoint — 2026-11-07 ~13:35 Europe/Madrid (Claude, V19 agent): V19 (+4) and V17.2 (+1) accepted: 82 accepted, 18 remaining

Workers (SHA-256 prefixes, debug builds, Apple M4/16 GiB): dfv-table **4373174b38c48fa7**, dfv-mat **1bab58cb2d4375ff** (the shared
/Users/macc/dfv-resume-20261103-target/debug build; the older 3709812f pin is superseded), dfv-pdf **af044680f79db92f** (U media/pdf/bin).
Policy: U `native/resource-policy.json` carries `table_worker_each` = 1024 operational with a dated (2026-11-07, user-approved) revision
record (previous 768 contract); no test or source asserts 768 (tests read the JSON); all other budgets and `pdf_host` unchanged. Its
`measurements` block was re-pinned/updated to this run (the remaining a32e1c28 mentions are labelled superseded history).
Gates, heavy lock V19-AGENT (released), DFV_BACKEND=native, tsc exit 0:
- Supervisor/lifecycle units (nativeSupervisor, pdfHostBounds, matIsolation, matLifecycle, pdfHostFailure, pdfBackup, nativeBackend with
  DFV_PDF_BIN set): 48 tests, 45 pass, 0 fail, 3 skipped (needs a `--features test-doc` table build; skipped before as well, not claimed).
- Hostile-limits run (nativeResources): pass; table worker sampled peak **745.1 MiB** (<= 1024), native aggregate 759.3 MiB (<= 2048).
- Seven-document run (nativeResources, 20 rounds, 49.2 s, 494 samples): pass. Peak RSS MiB: CSV 447.4, Parquet 123.0, SQLite 122.5, XLSX
  83.9, PDF simple 49.0, PDF image-heavy 191.0, MAT 67.8 (budgets 1024/512/512); simultaneous native **825.3** vs 2048; with Node host
  1121.1. FDs <= 6 (<=128); table/MAT IPC peak 5.58 MB; temp: scratch 5.27 MB (<= CSV size), PDF work 15.75 MB, recovery 15.75 MB
  (<= 2 x PDFs); scratch empty and all seven workers reaped after shutdown.
- V17.2 host (actual unpacked VS Code, disposable profile): test/host/mixedIsolation.cjs exit 0 (three features, ownership, isolation),
  test/host/matLifecycle.cjs exit 0 (cancel, child paging, stale/refresh, close reclamation, hung close, reopen, no orphans, sources intact).
Notes: (1) the first seven-document attempt failed only because DFV_MAT_FIXTURE pointed at a directory without many_v7.mat; rerun with the
crate fixture dir passed. (2) pdfBackup/pdfHostFailure tests leave a ~12 KB recovery directory each in the temp dir (intentional kill
cases; test hygiene, not a process leak; deleted). Not run: 30-min soak (V21), release-build remeasure, test-doc feature build.
No commit/push/VSIX. Next: V20, V21 soak, V23 rehearsal, V24, V16 remainder.


## Current checkpoint — 2026-11-07 14:40 Europe/Madrid (Codex resumed Claude)

Objective remains the first full-DFV macOS arm64 VSIX; no packaging before prerequisite acceptance. Verified Kod `cleanup/code-only` HEAD `4e7eb4e`, N HEAD `8c2585e`, U HEAD `9efc4bb`; unfinished source/test changes remain in N/U/M and are preserved. No native/browser/Cargo gate processes running; heavy lock free. Rehashed actual debug workers: table `4373174b38c48fa711c18db5e931f119ad18d6c429122a3061455c3b31b9268b`, MAT `1bab58cb2d4375ff92ddeeab9b4fdad91a12cb4e4bc3c2bf7be022ebf904a8d4`, PDF `af044680f79db92fee47998c290669d6d97d7cc1122aa3d0b57627be995e8138`. These match the later V19 checkpoint; do not rerun accepted V19 merely because the earlier stop note predates it. Latest accepted score is 82, not the stale total-row 66 (corrected). User-approved 1024 MiB operational table budget and MOD-04 exclusion retained.

**Current step V16 (in progress):** inspect native coverage for the reference-only XLSX TODO cases and PERF-X1 measurements; run full UI/unit native regressions as the smallest integration feasibility check. Inputs N/U and synthetic/committed fixtures only; private temporary state, no user data. Scope: acceptance defects and required tests/docs only. No advanced PDF/math expansion, unrelated Kod changes, real-profile installation or publishing.

**Execution / completion gates:**
- R1 (V16, depends V13): in U, compile `npx --no-install tsc -p tsconfig.test.json`, run the native-enabled Node suite under the heavy lock, pinned table/MAT/PDF and myproject oracle. Pass: no unexpected failures, explicit reference-only TODO inventory, native EX04/EX06/range/plot evidence. On failure repair root cause before downstream acceptance. Investigation timebox 20 minutes; record pace/results here.
- R2 (V20, depends V16): freeze N native + U host intended tree into an isolated checkout outside Kod, record a file-hash inventory, fresh locked build, all-format external-reader/security/fault/retained-PDF checks. Discover exact build/test commands from manifests; do not infer a pass from old binaries. Record workload budgets from resource-policy.json before measurement. Recover by preserving unfinished source and minimal failed evidence; never replay unknown writes.
- R3 (V21, depends V20): use `test/nativeResources.test.ts` soak with `DFV_NATIVE_RESOURCES=1 DFV_NATIVE_RESOURCE_PHASE=soak DFV_SOAK_SECONDS=1800`; seven workers, class kills, independent integrity and resource plateau. Short run first only if runner unproven. Pass: full 1800 seconds, zero integrity failures/orphans, frozen budgets. Interrupted/failed run earns zero; investigate before retry.
- R4 (V23, depends V01–V22): inspect/reuse `scripts/stage-vsix.sh` after all prerequisites. Release workers, accurate inventory/licences, actual offline disposable-profile installed package workflows; retain VSIX deliverable. Physical packaged trackpad check remains manual; do not fabricate it.
- R5 (V24, depends V23): use established private archive and viewer mapping, inspect complete intended diff, commit/push/remote-tree verify before deleting unique local tests/plans. Preserve source, inputs, requested VSIX and unfinished work. No visibility change/force push/deployment.

No new long-running process or lock owned yet. Exact next action: R1 compiler and native-enabled full Node suite in U; expected green or actionable failure. Shared target remains checkpoint-required; do not delete while gates need its binaries. No new scratch files created.

**R1 result — 2026-11-07 14:44 Europe/Madrid:** U TypeScript compiler passed; full native-enabled top-level Node suite: 1242 tests, 1182 passed, 1 unexpected failure, 50 skipped, 9 TODO, 110.9 seconds. The unexpected failure was an unfinished test harness accessing `queryResult.result.columns/rows` although the real provider emits flat `columns/rows`. Corrected only U `test/nativeRangeCap.test.ts`; focused range + actual MAT viewer/isolation + supervisor rerun **14/14 passed, zero skips**, supplying the genuine native_v7.mat fixture that the broad run lacked. No product regression found. Remaining TODOs are explicit reference-backend cases, not native acceptance. Fixture/test-feature-dependent skips remain inventoried for V20; no credit fabricated.

**R1 PERF-X1 in progress:** U `test/perf/perfX1Bench.cjs` now exercises actual native cold-sheet cancellation (previously skipped for native), checks source integrity/cancelled outcomes and exits nonzero for failed fixture/cancel children. Added grid message-to-two-animation-frames timing to the existing native plot browser test, outside production code. Native benchmark running under `CODEX-PERFX1` lock, shell PID 15722, exec session 62289, private `/tmp/dfv-codex-r1.G2LqSr`, output `perf.json`; table hash unchanged. Command in U: `node test/perf/perfX1Bench.cjs --backend native --only sheets-1,sheets-20,sheets-100,tall,wide,sparse,dense,sparse-extent --cold 3 --warm 5 --fixtures /tmp/dfv-codex-r1.G2LqSr/perf-fixtures --out /tmp/dfv-codex-r1.G2LqSr/perf.json`. Three cold samples give descriptive p95, not a statistically stable tail estimate.

**R2 preparation:** task-created `/Users/macc/dfv-acceptance-20261107`, branch `work/dfv-acceptance-20261107`, cloned from U (HEAD 9efc4bb; shared objects, preserve U until completion). Overlay contains U intended source/tests/docs/pinned PDF assets + N Cargo workspace/crates and mutation recovery runner. Excludes U generated dist/out-test/evidence, node_modules contents, .serena and Git internals. Existing dependency symlink reused. No build/test has yet run there, no freeze acceptance or remote backup claimed. Re-sync the three currently edited U test files after PERF-X1 finishes, record file hashes, then build/test with a new isolated target under the lock. Native fresh-build inputs require DFV_REF_PYTHON=myproject and private DFV_TABLE_STATE_DIR. Keep scratch/compiled output only while this active batch needs it; clean after concise evidence is recorded.

## Current checkpoint — 2026-11-07 14:47 Europe/Madrid (Codex): V16 accepted, 86/100

**V16 accepted (+4), 14 remaining.** No production engine/provider changes in this continuation; repaired and completed required qualification evidence. U range regression was a harness-only nested-vs-flat message error, fixed and verified. MOD-03/05 gaps closed by actual data-only startup test: zero workers before open, exactly one table/no PDF/MAT worker while reading, zero after close, Node data processors denied; 2/2 pass. N MAT actual-stdio test now sends protocol version 2 and checks typed `unsupported`, then successfully uses version 1 on the same pipe; 8/8 worker tests pass. Initial new test used a noncanonical request ID and correctly received unaddressed ID 0; corrected fixture ID to canonical `6`, no production change. Native xlsx-ops operations 14/14 pass, including committed corpus explicit single/adjacent/stacked bounds/names/columns/logical rows, malformed/overlap refusal, manual rectangle/header correction and column agreement for every fixture. Reference-only XLSX TODOs do not describe native defects. Multi-level header automatic grouping is not promised by EX-06; explicit header/range selection remains the supported correction. MOD-04 exclusion is the explicit user decision above; do not add component archives.

**PERF-X1 on Apple M4/16 GiB, pinned debug table 4373174b…, 3 cold/5 warm samples per fixture:** selected Active first-query p50 81.1/82.1/84.7 ms in 1/20/100-sheet workbooks; exactly one detector call each run, active-only 202 cells. Open/preflight p50 187.8/532.4/2012.5 ms, reported separately. Tall 200k×3 first query p50 15.16 s, warm 72.7 ms; wide 200×1000 4.81 s/603.4 ms; sparse 5000×151 439.7/115.6 ms; dense 20k×25 12.08 s/78.8 ms. Sparse 10M-cell extent first 4.12 s/warm 3.16 s, sampled RSS 705.7 MiB; retained known limits: over-cache sheets reload every read and grid memory follows extent. U README documents these limits. They remain inside the existing bounded approach/resource limits; no numeric open-time gate exists and no optional optimization authorized/added. The user-approved single-grid-decode fix remains covered by the native regression; cache eviction/cap proof from Claude retained.

Cold tall-sheet cancellation now runs on the actual native document: 5/5 cancelled, acknowledgment 0.210–0.452 ms (p95 0.452 ms) versus the proposed 250 ms target, host event-loop max delay 15.76 ms. Hash checks prove source unchanged. Native plot/browser gate 7/7 passes (actual worker, actual ECharts canvas including 150k ramp and declared worksheet data). Separately measured grid message-to-two-animation-frame latency 21.7–32.0 ms across 8 paints; this includes frame scheduling, not pure CPU time. No UI-thread detection runs: native parsing/detection is in the child. Source bytes/no external browser requests assertions remain intact. Previous V22 EX-07 host/theme/keyboard/100-switch acceptance retained.

**Current step R2 / V20 in progress.** Next: sync completed test/docs into `/Users/macc/dfv-acceptance-20261107`, record intended source/lock/asset fingerprints, build and test the entire native workspace from an empty `/Users/macc/dfv-acceptance-target-20261107` with pinned Rust, offline locked dependencies, -j2, myproject oracle and private state. This is a fresh release-build acceptance run, not packaging; V23 remains blocked. Existing workers/binaries unchanged. Heavy lock free after CODEX-V16-MOD; all native/browser gate processes completed. Approximate elapsed R1 8 minutes, V16 accepted inside 20-minute investigation timebox. Private `/tmp/dfv-codex-r1.G2LqSr` contains completed outputs now summarized here; delete after source snapshot and needed metrics are extracted. U out-test/dist are reproducible, remove after this batch; retained shared target is still required by active checkpoints.

**R2 live operation — 2026-11-07 14:48 Europe/Madrid:** acceptance snapshot `/Users/macc/dfv-acceptance-20261107`, branch `work/dfv-acceptance-20261107`, base HEAD 9efc4bb, dirty combined intended N/U tree (no commit/push). `native/acceptance-candidate.json` freezes 643 source/test/fixture/build/doc files, aggregate inventory SHA-256 `a1d17e5b9c70cc3159ba3c663d615b775f1a1090b6fe9f6ea173ac6531659c07`; pinned PDF assets independently remain the qualified MVP. Source dirs N/U/M preserved apart from the recorded test/docs changes.

Fresh run owned by Codex: exec session **26957**, live shell PID **22808**, heavy lock **CODEX-V20-FRESH**. Logs/private temp/state `/tmp/dfv-codex-v20.N3cS4r`; new target `/Users/macc/dfv-acceptance-target-20261107` verified absent before launch. Inspect `tail -20 /tmp/dfv-codex-v20.N3cS4r/native.log` and lock status; no other heavy Cargo/browser gate while held. Command from snapshot: `cargo test --manifest-path native/Cargo.toml --release --workspace --offline --locked -j2`. Environment: pinned Rust PATH + RUSTUP_TOOLCHAIN=1.99.1-aarch64-apple-darwin, RUSTUP_AUTO_INSTALL=0, CARGO_TARGET_DIR=new target, CARGO_PROFILE_RELEASE_STRIP=symbols; RUSTFLAGS remap `/Users/macc` to `/build` and snapshot native path to `/src`, CFLAGS/CXXFLAGS `-ffile-prefix-map=/Users/macc=/build`; DFV_REF_PYTHON=myproject Python, TMPDIR=private dir, DFV_TABLE_STATE_DIR=private dir/state (0700). Timebox: inspect compiler/test progress by 15 minutes, revise if stalled; preserve locked/offline and integrity checks. Expected fresh release workspace/external-reader tests green; currently running, unaccepted. On failure retain minimal evidence and repair before V21.

Completed R1 private outputs and U out-test are reproducible and summarized above; scoped cleanup now due. Retain both native targets while this candidate is under qualification and older checkpoints reference debug workers. Next: release worker hashes, snapshot host/security/PDF/format/fault and seven-document resource checks; test-only feature builds separate from default package workers. Then full 1800-second V21 soak.

**R2 preflight revision — 2026-11-07 14:53 Europe/Madrid:** before acceptance, `strings` on the freshly compiled XLSX library proved the inherited package recipe still embedded `/build/.cargo/registry/...`; `test/package.cjs` explicitly forbids `.cargo/registry`. Stopped only owned Cargo/build children (session 26957 exit 143, lock released) before completing expensive DuckDB compilation. Corrected U/snapshot `scripts/stage-vsix.sh`: explicitly remap the Cargo registry to `/cargo-registry` for Rust/C/C++; also fixed its EXIT cleanup trap referencing a function-local staging variable after scope ended (minimal Bash reproducer failed before, succeeds after; bash -n passed). No runtime Rust/Cargo inputs changed. Snapshot inventory revised from a1d17e5b9c70cc3159ba3c663d615b775f1a1090b6fe9f6ea173ac6531659c07 to 67e8c57562f135ac756130aa0c1b8bc4200a6bad7acaf404aba63881f0f2312e; revision recorded in manifest. Removed only this task-created interrupted target, 0.640 GB, verified absent and no owned build child still running. This was preflight repair, no test acceptance and no score change. Next: restart fresh release workspace tests with corrected flags and a verified empty target, then inspect compiled path strings early.

**R2 replacement live operation — 2026-11-07 14:54 Europe/Madrid:** session **9570**, shell PID **24234**, lock **CODEX-V20-FRESH2**; same snapshot/new target/private log paths as above. Fresh compile restarted successfully with explicit additional Rust registry remap `--remap-path-prefix=/Users/macc/.cargo/registry=/cargo-registry` and C/C++ `-ffile-prefix-map=/Users/macc/.cargo/registry=/cargo-registry`. Previous session 26957 completed/interrupted; do not resume it. Current log `native.log` belongs to attempt 2. Next early check: library strings must contain `/cargo-registry/` and no `.cargo/registry` or `/Users/`, then allow compile/tests to finish. Added required snapshot `native/qualifications.json` D5.1 checklist (18 requirement groups, 13 runnable command groups, all fresh acceptance pending); maps source paths/tests, exact private environment, feature-only builds, resource/soak and packaging prerequisites. It does not confer acceptance or duplicate the authoritative plan evidence.

**R2 progress — 2026-11-07 14:56 Europe/Madrid:** corrected early XLSX library strings now use `/cargo-registry/...` (no `.cargo/registry` or `/Users/` matches in this probe). All 643 frozen candidate file hashes reverified unchanged after restart. N MAT source is newer than M: adds validated empty-dimension slicing and complete genuine support oracle fixtures; snapshot correctly uses N, not stale M. Physical host is macOS 15.8.2 build 24H232; current accepted debug worker Mach-O minimum OS is 11.0 with SDK 26.2. Fresh release compilation remains running, no test acceptance yet.

**R2 toolchain note — 2026-11-07 14:57 Europe/Madrid:** cold release compilation emits nonfatal rust-objcopy warnings because its rpath misses pinned toolchain/lib/libLLVM.dylib. Verified `DYLD_LIBRARY_PATH=/Users/macc/.rustup/toolchains/1.99.1-aarch64-apple-darwin/lib .../rust-objcopy --version` succeeds (LLVM 23.1.1). Added this build-subprocess-only library path to the packaging recipe; no global/toolchain/project-environment changes. Current build continues (warnings, no compiler error); do not restart merely to suppress already-emitted warnings. Future feature/default-worker build commands must export that library path. New recipe-only inventory hash df9844b30e07e7d90b75a79acd7ebc982358187db04029aa74e5561c48d17307; native source/Cargo fingerprints unchanged.

**R2 fresh native result — 2026-11-07 15:04 Europe/Madrid:** session 9570 completed exit 0, lock released. Fresh release workspace: **541 passed, zero failures/ignored**, from empty target, 9–10 minutes. Corrected registry remap removes private registry paths. Artifact-level byte scan then caught `/Users/macc/.rustup/...libstd...rlib` stabs/debug-symbol paths left by the earlier nonfatal rust-objcopy warning; `strings` alone did not expose them. Added deterministic macOS `strip` then ad-hoc `codesign` to U/snapshot package recipe; no source/runtime logic change. Stripped/signed copies in checkpoint-required `/Users/macc/dfv-acceptance-default-workers-20261107` pass raw-byte forbidden-path/test-switch scans and codesign verification; dynamic links system libraries only; minimum OS 11.0/SDK 26.2. Table SHA `e438f85267a68a6789895e02ce2440b70e607b98d225b3e31ac12f530a8e81b2` (53,322,144 bytes), MAT SHA `2605868b5ce9bda699447524f482f27b4157d49ed78804706ed2e16cb41b7a40` (919,296 bytes). `workers.json` records them. PDF MVP hash unchanged. Do not package a later feature-test binary from the Cargo target; use these retained default copies.

The first UI preflight session 95650 was aborted/unaccepted because the artifact-copy check failed before MAT was copied (shell follow-on diagnostics masked its failed preflight exit). Stopped only owned UI descendants, released lock, completed both worker checks, and restarted correctly. Current **session 43762**, shell PID **28001**, lock **CODEX-V20-UI2**, uses default stripped/signed workers, real MAT fixture, native security matrix, private `qualified-state`. Command: top-level Node suite with concurrency 2, then PDF pin refusals and `npm run test:browser:native`; outputs `ui.log`, `pdf-pin.log`, `browser.log` under the V20 private directory. Session ID verified against the tool return. No V20 credit until full host/fault/resource campaign.

**R2/V23 preparation — 2026-11-07 15:07 Europe/Madrid:** snapshot host/test compile and `npm run build` pass, qualified 16-asset PDF pin verified. Reused existing `test/host/matViewer.cjs` for required V23 MAT coverage by adding an optional DFV_VSIX installed mode: only disposable install, clears development/backend/worker overrides, resolves installed package/version and asserts actual installed MAT/table worker paths. Existing unpacked mode retained and will run in V20; installed branch awaits V23, no VSIX built early. Syntax check passed. Production native/UI sources unchanged. Candidate inventory revision now 7d41b5427d7eaeaeb23ff76288e47f669aa8b5264211ca4bdc47d945dae8e793 for recipe/test-only changes, recorded with prior hashes; no need to redo the already-fresh native compile.

**R2 UI result — 2026-11-07 15:08 Europe/Madrid:** session 43762 completed exit 0, lock released. Fresh snapshot on stripped/signed release workers: **1242 Node cases, 1190 passed, zero failed/cancelled, 43 explicit skips, 9 reference-backend TODOs**, 112.24 s; DFV_SECURITY_BACKEND=native so hostile security matrix ran against actual Rust. PDF pin refusal tests **3/3**. Native browser plot 7 cases (150k actual canvas), exact raw/SQL range/manual correction/stale refusals, plot-axis workflow, EX07 narrow **12**, EX07 states **8** all passed. Grid paint acknowledgment 21.1–29.7 ms (8 paints); 100 rapid choices -> 38 queries/8 paints, final Gamma, no source/draft corruption. TODO diagnostics are printed by Node under its failing-tests footer but suite fail count is zero; do not misclassify them as fresh native failures. Remaining fixture/feature-only skips are not acceptance evidence and receive explicit fault/test-doc checks next.

**R2 live host/resource operation:** session **90383**, shell PID **29757**, heavy lock **CODEX-V20-HOST**, logs in `/tmp/dfv-codex-v20.N3cS4r`. Fresh snapshot/unpacked VS Code, release default worker pins above; `DFV_EXTENSION_DEVELOPMENT_PATH=/Users/macc/dfv-acceptance-20261107`, genuine native_v7.mat, all oracle/fixture Python vars = myproject. Runs `npm run test:host:native`, then host sqlWorkflow/ex02Selection/mixedIsolation/matLifecycle, then `DFV_MAT_ISOLATION=1 node test/host/matViewer.cjs`, followed by nativeResources limits + seven-document phases with frozen resource-policy budgets. No release acceptance yet; on failure retain concise evidence and repair owning gate. Next: feature-only publication/kill/test-doc/detection build/tests in fresh target (same corrected remaps plus DYLD_LIBRARY_PATH), retain default-worker copies unchanged, then 65-second soak runner feasibility and full required 1800-second soak.

**R2 host/resource result — 2026-11-07 15:13 Europe/Madrid:** session 90383 completed exit 0, lock released. All six `test:host:native` workflows pass on fresh signed/stripped release table/MAT workers + pinned PDF; SQL/EX02, mixedIsolation, MAT lifecycle and updated MAT viewer with real worker-kill isolation also pass. Real profile fingerprint/source bytes unchanged; exact range pages, 150k canvas, cap/security/save/stale failures, narrow/theme/keyboard states verified. Host runners remove their disposable profiles and assert worker reclamation.

Release resource limits passed (25.18 s): 50-cycle RSS delta -7.05 MiB, scratch empty; cancellation acknowledgment 0.923 ms; queue burst 35 bounded refusals, no accumulation. Seven-document gate passed (19.40 s overall; measured work 15.80 s, 20 rounds/161 samples/100 ms): simultaneous native peak **515.56 MiB** vs frozen 2048; native+Node **664.73 MiB**. Per-worker sampled MiB peaks CSV389.84, Parquet91.06, SQLite67.17, XLSX42.11, PDF24.56/102.78, MAT32.52; fd peaks 5–6 vs128; table/MAT encoded IPC peak5,578,041 bytes. Scratch5,266,692 bytes, PDF work15,745,898, recovery15,747,395 inside frozen budgets; all workers reaped and scratch empty at shutdown. Query p95 CSV164.90 ms, Parquet71.06, SQLite74.28; detected-XLSX63.53; sort/stats/chart p95 CSV597.88 ms; PDF renders p95 47.25/203.95 ms. Cold opens CSV399.66, Parquet28.16, SQLite252.50, XLSX32.44, MAT8.93 ms. Sampling can miss shorter peaks; Code/Chromium excluded, host shown separately. No budget changed after these measurements. Hardware independently verified Apple M4/16 GiB.

**Current live operation:** session **1920**, shell PID **33156**, lock **CODEX-V20-FAULTS**. Command in snapshot: `cargo test --manifest-path native/Cargo.toml --release --workspace --offline --locked -j2 --features dfv-table/test-doc,dfv-table-engine/test-detection-failure,dfv-table-db-write/test-mutations`, same corrected remaps/private environment plus DYLD_LIBRARY_PATH=pinned toolchain/lib. Then `DFV_TEST_MUTATION_RECOVERY=1 node --test out-test/test/nativeMutationRecovery.test.js out-test/test/nativeBackend.test.js` with DFV_TABLE_WORKER/DFV_TABLE_TESTDOC_WORKER pointing to the FEATURE binary in target/release (never deliver it), followed by SAFE-X1 browser with DFV_TEST_XLSX_FAIL_ONCE_SHEET=Data. Logs faults.log/fault-host.log/detection-fault.log. Default workers retained separately and unchanged. Next: if fault checks pass, V20 accept; run 65-second soak feasibility, then full1800 seconds.

V23 preparation also corrected the inherited packaging recipe's universal target to explicit `--target darwin-arm64`, with a required archive-manifest target assertion in existing package.cjs (syntax checks pass; actual archive test awaits V23). Current source inventory f26bafcf54a0a9f5a3614439d481ec7d6db2e07320ed46684fa76d3b41c82aff, recipe/test-only revision; runtime native/UI sources unchanged. No VSIX yet.

## Current checkpoint — 2026-11-07 15:16 Europe/Madrid (Codex): V20 accepted, 91/100

Fresh independent V20 acceptance complete (+5). Default native541/0/0; feature-only workspace **607 passed, zero failed/ignored** (publication/flush/disk-full/replace/kill, test-doc lifecycle, real detection faults). Actual host adapter/recovery/test-doc gate **26/26**, zero skips, includes six mutation SIGKILL/missing/corrupt/external-change outcomes with no replay. SAFE-X1 actual fault-worker browser **3/3**, readable raw sheet + typed failure, no automatic retry loop, explicit Retry fresh generation succeeds. Session1920 exit0/lock released. All native/UI source files remain the frozen fresh candidate; recipe/test-only revisions recorded. Required `native/qualifications.json` and `native/accepted-ports.json` bind candidate/pins/capabilities/platform/limits and measured evidence; complete V21/V23/V24 still pending. Default signed/stripped table/MAT hashes reverified unchanged after feature builds; test-capable target worker must never ship.

**Current step V21:** 65-second runner feasibility started under **CODEX-V21-SMOKE**, session shown by current tool return, default release workers, private V20 TMPDIR, genuine native_v7.mat fixture dir + myproject fixture writer. Command `DFV_NATIVE_RESOURCES=1 DFV_NATIVE_RESOURCE_PHASE=soak DFV_SOAK_SECONDS=65 node --test out-test/test/nativeResources.test.js`, log `soak-smoke.log`. Short run earns zero V21 credit; catches runner defects before spending30minutes. If green, immediately run exactly1800seconds with the same default worker pins/frozen budgets and a fresh private temp directory, then V23 first VSIX. Remaining weights: V21=3, V23=3, V24=3. Still no VSIX/commit/push/real-profile change.

## Current checkpoint — 2026-11-07 15:20 Europe/Madrid (Codex): full V21 soak running

**V21 feasibility passed, no credit:** 65.20 seconds, 204 cycles, 34 independently byte-verified CSV edits, 51 reopens, kills table2/PDF1/MAT1, 96 distinct owned workers reaped; sampled native peak477.86MiB, class RSS drift table+10.20/PDF-29.81/MAT-6.02MiB, no integrity failure/orphan/scratch leak. Session1331 completed exit0, heavy lock released.

**Required full run now active:** session **75137**, shell owner PID **37773**, heavy lock **CODEX-V21-FULL**, start **15:19:10 CET**. Private root **`/tmp/dfv-codex-soak.6ItfeV`**, log `soak.log`; actual synthetic inputs/state are task-created nested directories below that root. Default signed/stripped release table `e438f852…`, MAT `2605868b…`, pinned PDF `af044680…`; **never substitute the feature-enabled target binary**. Command from acceptance snapshot: `DFV_NATIVE_RESOURCES=1 DFV_NATIVE_RESOURCE_PHASE=soak DFV_SOAK_SECONDS=1800 node --test out-test/test/nativeResources.test.js`, DFV_BACKEND=native, workers/fixture/runtime paths as above, TMPDIR=new private root. Full elapsed minimum1800seconds; expected earliest finish around **15:49:10 CET**, plus final integrity/reaping assertions. Inspect `tail -3 /tmp/dfv-codex-soak.6ItfeV/soak.log` and lock status. Poll session75137 for exit; do not start another heavy gate/VSIX while running. On interruption/failure, zero V21 credit; preserve minimal failure input/evidence, repair owning gate before retry. Accepted score remains **91/100**.

R2 completed outputs/private state `/tmp/dfv-codex-v20.N3cS4r` are now fully summarized (541 default native,607 feature native,1190 UI,26 recovery, all host/browser/pin/resource gates); remove that completed scratch tree only. Current full-soak root, accepted release-worker copies, snapshot application/test source, out-test needed by active qualification, native targets and unique N/U/M source remain required. `native/accepted-ports.json` freezes tested capabilities/pins/platform/limits; `native/qualifications.json` lists executed/pending groups. Next after green full soak: accept V21 (+3 to94), bump candidate package/lock metadata consistently, first `scripts/stage-vsix.sh package` with DFV_NATIVE_DIR=snapshot/native and DFV_WORKER_DIR=retained default copies, target darwin-arm64; inspect VSIX then actual offline installed table/PDF/MAT workflows. V23 manual packaged trackpad remains explicitly unverified.

## CURRENT STOP CHECKPOINT — 2026-11-07T15:31:44+01:00 (Europe/Madrid, Codex; stopped at user request)

**STOPPED. Accepted 91/100; V21/V23/V24 pending. No VSIX produced, no commit/push, no real-profile install.** User explicitly asked to stop and save checkpoint. All owned soak descendants were terminated, session **75137** completed exit1 due forced interruption, and **CODEX-V21-FULL lock released / verified free**. Process inspection found no actual table/MAT/PDF stdio worker or soak runner left alive. The final test-runner "Promise resolution is still pending" diagnostic was produced by termination, not an independently reproduced product failure. Do not credit or resume this partial run as a completed soak.

**Last progress before interruption:** `{"phase":"soak-progress","cycle":1950,"elapsedSeconds":645.014763791,"counts":{"cycles":1950,"edits":325,"reopens":487,"kills":{"table":2,"pdf":1,"mat":1}},"latest":{"t":645.014720958,"table":236.171875,"pdf":100.171875,"mat":65.4375,"workers":7,"scratch":0}}`. This is supporting partial evidence only, never 30-minute acceptance. Full log and synthetic interrupted inputs/state retained under **`/tmp/dfv-codex-soak.6ItfeV`** as checkpoint-required interruption evidence; no user source/data lives there. On resume inspect any interrupted CSV transaction outcome if investigating, then regenerate a fresh workload and run the full1800seconds from zero. Do not replay an unknown mutation. Earlier 65-second feasibility passed204cycles/34edits/51reopens, kills table2/PDF1/MAT1; it earns no V21 credit.

**Verified completed this continuation:** V16(+4), V20(+5): native corpus/range/plot/module/performance evidence; fresh empty-target default release workspace541/0; feature-only workspace607/0; release UI1190passes/0fail (43 explicit skips/9 reference TODOs); recovery/test-doc adapter26/26; native browser/host/MAT/PDF-pin/security/resource matrices pass. Seven-document native peak515.56MiB against2048, no budget relaxed, integrity/cleanup pass. Source/runtime changes from this continuation are qualification/docs/packaging fixes, no additional feature phase. See detailed results above.

**Files / Git:** Kod `/Users/macc/Desktop/Kod`, branch cleanup/code-only HEAD4e7eb4e: parent plan + this milestone plan dirty (FIRST_VSIX_PLAN untracked), unrelated existing Data_Science/LaTeX/RTF changes preserved. N `/Users/macc/dfv-xlsx-resume-20261103`, HEAD8c2585e, preserves Claude's native integration plus this turn's MAT protocol-version regression. U `/Users/macc/dfv-ui-native-integration-20261104`, HEAD9efc4bb, preserves Claude's host integration plus scoped README, package recipe and qualification-harness edits. M `/Users/macc/dfv-mat-resume-20261103`, HEAD5e72f86, preserved; N MAT source is newer and authoritative for the candidate. Main `Projects/Rust/data-file-viewer` remains branch main with seven pre-existing dirty source files; do not overwrite or clean it. Its public origin is cenkeryildiz/data-file-viewer; archive remote is existing private cenkeryildiz/kod_phases. GitHub connector verified archive remains private and writable; no writes performed.

**Canonical fresh candidate:** `/Users/macc/dfv-acceptance-20261107`, branch work/dfv-acceptance-20261107, HEAD9efc4bb +211 changed/new files (~27,694 insertions/988 deletions). New files were added with **git add -N** only (intent-to-add, no commit); production native/UI inputs correspond to completed fresh qualification. `native/acceptance-candidate.json` last inventory SHA **f26bafcf54a0a9f5a3614439d481ec7d6db2e07320ed46684fa76d3b41c82aff** binds643 files; recipe/test-only revisions recorded. `native/accepted-ports.json` binds V20 pins/capabilities/platform/limits, explicitly pending soak/package. `native/qualifications.json` records command groups and stopped soak state. No source freeze acceptance is implied for later unfinished packaging work. Candidate has node_modules symlink to main project's installed deps, plus out-test/dist needed for next gates; never commit them.

**Required artifacts:** retained production worker copies `/Users/macc/dfv-acceptance-default-workers-20261107/dfv-table` SHA **e438f85267a68a6789895e02ce2440b70e607b98d225b3e31ac12f530a8e81b2**, 53,322,144bytes; `dfv-mat` SHA **2605868b5ce9bda699447524f482f27b4157d49ed78804706ed2e16cb41b7a40**,919,296bytes. workers.json records both. They are stripped/ad-hoc signed, codesign/forbidden-path/test-switch checked, and all V20 UI/host/resource tests used them. PDF `snapshot/media/pdf/bin/dfv-pdf` SHA **af044680f79db92fee47998c290669d6d97d7cc1122aa3d0b57627be995e8138**, all16 assets pinned by native/pdf-mvp-assets.json. New target `/Users/macc/dfv-acceptance-target-20261107` currently holds a **feature-enabled test worker**, not a deliverable; never package its table binary. Old shared `/Users/macc/dfv-resume-20261103-target` remains required by older unfinished checkpoints; preserve until ownership/remote/source needs reviewed. No live compiler or host process remains.

**Packaging repairs already applied U + snapshot:** stage-vsix.sh keeps its staging variable alive for EXIT cleanup, maps registry paths explicitly, supplies toolchain LLVM path for build subprocess, strips/signs workers, and declares target darwin-arm64. Existing package.cjs asserts target. Existing MAT host runner now accepts optional DFV_VSIX installed mode, clears development/worker/backend overrides and checks installed worker paths; unpacked branch passed V20, installed branch is untested until first VSIX. PDF pin/build/refusal tests passed. Package.json/lock are still0.0.20; bump consistently to an appropriate new candidate version before actual V23. No packaging operation has run.

**Last unfinished discovery — V23 required notices/source snapshot:** inherited licence generator covers table+MAT, not the retained PDF worker's Rust dependencies. Source `/Users/macc/Desktop/Kod/.codex-work/dfv-pdf-native-prebackup-20261025` HEAD7274031 is clean; its Cargo.toml/Cargo.lock and three crate manifests are byte-identical to qualified PDF source revision **28fd698413fa9d882bd74b95dc2876fa3f8be7b2** (git diff empty). A read-only offline cargo-metadata licence inventory using existing scripts/third_party_licenses.py helper was attempted; it **did not write** native/pdf-third-party-licenses.txt because alloc-stdlib0.2.4 publishes no licence file. Every other dependency's text was found, including pdfcraft root MIT/Apache notices. alloc-stdlib Cargo metadata declares BSD-3-Clause, repository dropbox/rust-alloc-no-stdlib, packaged VCS revision **ae42d22078b98549e987d2f03d12df7b984fde47**. GitHub connector fetched the exact repository LICENSE at that revision; blob **cd496ba72eb37e83a44958358d1f89a8a28cbc15**, URL **https://github.com/dropbox/rust-alloc-no-stdlib/blob/ae42d22078b98549e987d2f03d12df7b984fde47/LICENSE**. It matches the installed alloc-no-stdlib2.0.4 LICENSE text (Copyright2016Dropbox, BSD3); re-fetch exact immutable blob or verify local text before using. No new dependency installed; no licence text added to package yet. Finish this required notice inventory and append it to package THIRD_PARTY_LICENSES via existing recipe; add/assert a PDF notice marker in package check, then verify actual archive. Do not infer licence completeness from current table/MAT-only inventory.

Required PDF runtime assets are currently ignored/untracked by Git (`git ls-files media/pdf`=0). For V24 complete source/required-asset backup, verify and include the exact16 pinned runtime files in the private source snapshot (11MiB); no force-add performed yet. README still says generated assets remain outside Git; reconcile that once snapshot policy is concrete. Do not add unrelated caches/output/user inputs. Quick secret-pattern scan of intended source found no matches; raw git diff--check has two nonfunctional diagnostics: intentional malformed fixture not_mat.bin trailing spaces (preserve its bytes) and an existing extra EOF blank line in contentSignature.ts. Excluding malformed fixture and blank-at-EOF checking gives clean whitespace check.

**Exact resume sequence:** read this checkpoint first; verify branches/dirt, all worker hashes, no live processes and lock free. (1) Complete PDF notice/source-asset discovery above without expanding features. (2) Re-run V21 from a fresh private TMPDIR using retained default workers: from snapshot, export DFV_BACKEND=native, DFV_TABLE_WORKER=/Users/macc/dfv-acceptance-default-workers-20261107/dfv-table, DFV_MAT_WORKER=same-dir/dfv-mat, DFV_PDF_BIN=snapshot/media/pdf/bin/dfv-pdf, DFV_MAT_FIXTURE=snapshot/native/crates/mat/tests/fixtures/native_v7.mat, DFV_FIXTURE_PYTHON=/Users/macc/miniforge3/envs/myproject/bin/python; acquire existing lock in a live shell with EXIT trap; run `DFV_NATIVE_RESOURCES=1 DFV_NATIVE_RESOURCE_PHASE=soak DFV_SOAK_SECONDS=1800 node --test out-test/test/nativeResources.test.js`. Pass only full1800seconds plus integrity/plateau/orphan assertions. (3) Accept V21 (+3 to94), then V23 recipe package using DFV_NATIVE_DIR=snapshot/native and **DFV_WORKER_DIR=retained default copies**, accurate version/lock/notices/platform. Inspect archive and actual offline disposable-profile table/PDF/MAT workflows with development overrides cleared. Physical packaged trackpad recheck remains manual/unverified. (4) V24 source/config/assets/tests/plans private backup, verify remote commit/tree, then standing-authorized scoped cleanup; preserve unrelated main dirt and required source stores. No releases/deployment/real-profile install authorized.

**Cleanup already complete:** completed R1 scratch/out-test U removed; interrupted first cold target0.640GB removed; completed `/tmp/dfv-codex-v20.N3cS4r` (all native/UI/host/resource/fault/smoke logs/fixtures) removed after results recorded. Active interruption root and required workers/targets/source preserved deliberately. Stop here until user resumes.

## CURRENT RESUMED CHECKPOINT — 2026-11-07T21:43:08.844102+01:00 (Codex)

User resumed. Same objective/scope/completion gates from stop checkpoint; no feature expansion. Verified Kod/N/U/candidate HEADs unchanged, candidate branch work/dfv-acceptance-20261107 HEAD9efc4bb, dirty integration preserved. All three retained default worker SHA256 values match the stop checkpoint; initial process scan found no owned live worker and heavy lock free. Accepted remains91/100.

V21 restarted from zero under CODEX-V21-RESUME, shellPID45696, exec session45098, start21:42:33 CET, expected earliest completion22:12:33 CET plus final assertions. Private TMPDIR/log `/tmp/dfv-codex-soak-resume.Igkk3K/soak.log`; command/environment exactly as prior checkpoint,1800seconds, default copies only. Do not launch another heavy gate while running. On failure preserve minimal evidence, no V21 credit; on interruption restart full run. Next while it runs: finish PDF dependency notices, version/lock metadata and installed-workflow preparation; package only after green V21. New Serena session5501d92e activates canonical candidate; no language server active, bounded native searches used.

**V23 preparation — 2026-11-07T21:46:00.355285+01:00:** generated `native/pdf-third-party-licenses.txt` from158 normal retained-PDF dependencies; missing alloc-stdlib0.2.4 licence resolved against exact upstream Git blobcd496ba72eb37e83a44958358d1f89a8a28cbc15 (local text Git-blob hash matched). PDF source-qualified lock/manifests unchanged; no rebuild/new feature. Full notice generator passed130table/MAT Rust+30npm runtime packages, combined with PDF3,097,880bytes; temporary combined output deleted. Stage recipe appends required PDF notices; archive checker requires exact notice text. All16pinned PDF runtime files verified11,985,024bytes/no symlinks.

Version/lock consistently0.0.21 (local candidate only, no release); README explains private runtime-asset snapshot. Reused existing nativeHostHarness/matViewer to support disposable installed mode, strip DFV overrides, use system-only PATH and dead external proxies, assert exact installed native worker and absent Node DuckDB. Existing tables smoke now routes MAT to its separate catalog gate. Syntax checks pass; actual installed branch remains pending V23. Production code/native/UI unchanged, no reason to rerun accepted build. Candidate inventory revision `d3c133e24bf70dfc7c9007b871873953f51ce782d3222b1883c5486462eeccc0` records recipe/test/docs/version-only drift. Full soak session45098 remains active; next inspect log, wait for1800second result, then package under heavy lock.

**V23 notice completeness / harness review — 2026-11-07T21:48:43.014962+01:00:** crate-level licence inventory omitted bundled DuckDB C/C++ texts because libduckdb-sys source archive drops licence files. Read its embedded pragma_version.cpp: v1.5.5/source d8cdaa33fd; resolved immutable upstream commitd8cdaa33fda8df955cc76ef58a280f68f4cd43fa. Added28 exact upstream licence/notice texts covering the27third_party groups present in that archive plus DuckDB root (omits unbundled jemalloc/snowball). `native/duckdb-third-party-licenses.txt` records source URLs/Git blob hashes; recipe appends it and archive test requires exact contents. No product/source feature change. All modified CJS/MJS/Bash syntax checks pass. Installed host launch now uses absolute Code executable/CLI so system-only child PATH cannot prevent installation; failure cleanup preserved. Candidate inventory `1d7969e01e6c88e40802fa1923badcfac200a8e261aa3a9d65a69469c283cefa`. Soak still running, session45098/root as above; next V21 final result then V23 package.

**V21 safe-boundary update — 2026-11-07T21:51:59.150752+01:00:** session45098/livePID45696/lockCODEX-V21-RESUME unchanged. Latest progress530s/1775cycles/295edits/443reopens; kills table2/PDF1/MAT1,7workers,scratch0. Native source348 inventoried files remain byte-identical; no source symlinks/missing inventory inputs. Intended645file credential-pattern scan no matches. Private GitHub archive confirmed private+writable; new work/dfv-vsix-20261107 ref absent, existing viewer archive a742260... accessible. Qualified PDF source28fd698... read back from private archive successfully. No external writes. Remaining next action: wait full1800seconds and final assertions, then V23 package; manual packaged trackpad remains unverified.

**V21 live checkpoint — 2026-11-07T22:01:46.278934+01:00:** session45098/shellPID45696/lockCODEX-V21-RESUME still active; latest `{"phase":"soak-progress","cycle":3850,"elapsedSeconds":1149.237884334,"counts":{"cycles":3850,"edits":641,"reopens":962,"kills":{"table":5,"pdf":2,"mat":1}},"latest":{"t":1149.237847417,"table":233.609375,"pdf":141.1875,"mat":108.40625,"workers":7,"scratch":0}}`. No failure reported; no acceptance credit before1800seconds and final integrity/plateau/reaping assertions. Packaging preparations complete, no VSIX yet. Source candidate branch/HEAD unchanged9efc4bb, dirty preparation paths preserved; inventory1d7969e01e6c88e40802fa1923badcfac200a8e261aa3a9d65a69469c283cefa. Removed only node_modules intent-to-add index entry (symlink remains for builds), excluded agent navigation .serena from delivery via local Git exclude. No external writes. Exact next action: poll session45098 at/after22:12:33 CET; if exit0, update V21(+3) then acquire CODEX-V23 and run pinned recipe package to main viewer's ignored data-file-viewer-0.0.21-darwin-arm64.vsix. If any failure, retain bounded evidence and repair owning gate.

**V21 live checkpoint — 2026-11-07T22:09:58.542123+01:00:** same live session45098/PID45696/CODEX-V21-RESUME, private logunchanged. Latest1629.84seconds/5475cycles/912verifiededits/1368reopens; forced kills table6/PDF4/MAT2;7workers,scratch0. No failure reported; still no credit until1800seconds/final plateau/integrity/reaping. No source changes since notice/harness preparation. Exact next action remains poll45098 after22:12:33CET; on pass record totals, acceptV21(+3), run V23 recipe with default-worker copies and then installed-profile workflows. Artifact planned `/Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/data-file-viewer-0.0.21-darwin-arm64.vsix`; no VSIX produced yet. No commit/push/real-profile change.
## CURRENT CHECKPOINT — 2026-11-07T22:13:15.612893+01:00 (Codex): V21 accepted,94/100

Full fresh1800-second soak session45098 completed exit0; CODEX-V21-RESUME released/free. Measured `{"phase":"soak-measurement","seconds":1800.3516884590001,"counts":{"cycles":6052,"edits":1008,"reopens":1513,"kills":{"table":7,"pdf":4,"mat":2}},"samples":2041,"peakNativeMiB":644.4375,"driftMiB":{"table":2.5625,"pdf":71.328125,"mat":3.875},"peakByClassMiB":{"table":288.671875,"pdf":257.765625,"mat":119.40625},"scratchPeakBytes":0,"cycleMs":{"p50":210.56670800002757,"p95":935.793624999933},"distinctWorkersSeen":2541}`. Peak644.4375MiB vs2048. Last-third versus middle-third drift table+2.5625MiB (4workers,budget256), PDF+71.328125MiB (2workers,budget128), MAT+3.875MiB (1worker,budget64). No budget changed. Independent exact CSV edits and read-only source hashes passed;2541distinct workers reaped, no scratch/orphan children. Two nonselected test phases skipped by design, no missing soak assertions. V21+3accepted; V01–V22 prerequisite acceptance met.

V23 in progress: first permitted package now. Candidate path/branch/HEAD unchanged; default copies exact pinned hashes. Run `PATH=pinned-Rust:$PATH DFV_NATIVE_DIR=$PWD/native DFV_WORKER_DIR=/Users/macc/dfv-acceptance-default-workers-20261107 scripts/stage-vsix.sh package /Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/data-file-viewer-0.0.21-darwin-arm64.vsix` under CODEX-V23 lock. Expect archive checks pass; on failure preserve minimal logs/fix/rebuild. Then native installed-host refusals/range/plot/lifecycle+MAT, every table format and supported PDF edit/export/recovery workflows; disposable profile only, development overrides removed, no public release. Physical packaged trackpad remains manual/unverified; do not mark it passed. No commit/push yet. Completed soak temporary outputs can be deleted once result recorded; retained source/defaultworkers still required.


**V23 build / reconciliation — 2026-11-07T22:15:14.207484+01:00:** first package session95933 exit0; archive1326files/32,727,956bytes/version0.0.21/targetdarwin-arm64, exact table/MAT/PDF worker pins and all notices,7invalid asset inputs refused, PKG checks pass. VSIX SHA256`34e09462a76afd052e56be5ec15262bab57925254f1a613fcbef156fd23053cc` at main viewer's ignored artifact path. Stage cleanup completed/lockfree. Installed host session15879 failed only worker identity matcher: actual XLSX grid already rendered, but /tmp→/private/tmp symlink aliases made command-path comparison miss the running worker. Canonicalized disposable root in shared native harness and MAT harness (test-only fix); actual rerun follows. No runtime change/repackage required.

Concurrent documentation work consolidated the milestone ledger/checkpoints into this parent (`merged-first-vsix-body` section); FIRST_VSIX_PLAN is now compatibility redirect. Preserved the consolidation, V21 result already migrated by that work, corrected integrated score/table94. Future updates go here only. No unrelated edits reverted. Next: rerun installed workflows with canonical roots; keep failed log until rerun resolves. No real-profile install/commit/push.


**V23 physical-input acceptance / current installed run — 2026-11-07T22:16:11.126615+01:00:** user explicitly reports packaged VSIX0.0.21 physical PDF trackpad zoom **smooth**. This closes the manual packaged-input item (user-reported, not fabricated automation). Session31747/PID61027/lockCODEX-V23-INSTALLED2 now runs installed native suites from exact delivered VSIX; security/refusal and range gates passed after canonical-root harness repair. Actual installed worker command `/private/tmp/dfvh-range-.../extensions/cenker-local.data-file-viewer-0.0.21/bin/dfv-table --stdio` confirms package identity; source/profile checks clean. Remaining plot/lifecycle/EX07/PDFUI/MAT/all-format and PDF edit/export/recovery gates remain pending. No runtime changes, no commit/push. Completed fresh/superseded interrupted synthetic-soak roots removed after durable results;1,774,761,523bytes reclaimed (~1.775GB), both absent.


## CURRENT CHECKPOINT — 2026-11-07T22:23:28.382284+01:00 (Codex):94/100, temporary package qualification

User explicitly changed delivery: remove the visible pre-final VSIX, complete remaining checks, push final source/matching newest VSIX to GitHub, and update README. Visible main-viewer VSIX path is now **absent**; exact package34e09462... retained only as `/tmp/dfv-codex-v23.MJeF3c/candidate.vsix` for qualification. No final artifact promised before checks/source publication. GitHub metadata confirms cenkeryildiz/data-file-viewer public+writable; main8acac008... is an ancestor of candidate9efc4bb, no conflict/force-push needed. User's latest explicit publication instruction authorizes versioned release/upload; retain prior versions, no destructive rolling-tag replacement. Private archive remains appropriate full-plan/source backup as well.

Installed suites passed (actual package, no development overrides/system-only PATH/dead proxies): refusal/security21hostile SQLs/read-only/damaged files; exact range/stale/plot; actual150kcanvas/caps/date axes; lifecycle/save/backup/no-replay; EX07eightcases/themes/narrow/100switches; PDFchrome/themes/keyboard; MATexactvalues/1000variables/sparse/refresh/killisolation. User reports physical packaged PDF zoom smooth. Session31747 exited1 only at inherited all-format smoke: it leaves8data documents open, deliberately reaching supervisorcap8 at ninthformat. Stopped only owned remaining format processes, lockreleased. Test-only repair closes each format and adds genuine q-written kdb folder fixture; first keyboard-close revision left one worker afterParquet, so switched to explicit Code tab-close button+tab disappearance assertion. Further format rerun pending; product runtime unchanged.

Current heavy run: **session53387**, shellPID62968, lockCODEX-V23-PDF. Temporary candidate, eight existing installed PDF scripts sequentially: workflow/save_text/paragraph/features/discard/restart/backup_reopen/failure. workflow already passes real render/rotate/export/independentPyMuPDF/sourceunchanged/reopen. Logs same V23root; next inspect currentPDFlog. Then rerun repaired all-format smoke, repair any actual defect before finalpackage. README updated0.0.21/platform/capabilities/soak/limits/install/versionedGitHublink; legacy workflow manual-only and destructive auto-release disabled to prevent overwriting new native release. Need rebuild finalpackage for README and verify runtime entries byte-identical to qualified candidate; actual final smoke afterrebuild.

Publication privacy scope: do not upload user-supplied MRW1992data MAT dataset/derivedoracle (provenance not established for public redistribution); originals remain N/U/M and source input preserved. Removed that one dataset from default reader test's corpuslist; remaining6genuineMATLABfixtures still1060variables (>1050assertion unchanged). Run focused genuine-MAT reader test under lock before publish, exclude its two datafiles from both new public/private snapshots while keeping all generated reusable fixtures. No processing/runtimecode change. No commit/push/release yet.


## CURRENT CHECKPOINT — 2026-11-07T22:33:13.714813+01:00 (Codex): V23 accepted,97/100

All installed format/native/PDF gates complete on temporary candidate; physical packaged trackpad user-reported smooth. PDF A save/close passed, basic textB and Unicode paragraph/export exact-reader checks passed; inline/separate-marker removal preserves dirty draft and unrelated rows; annotations/pages/history, repeated save/discard, crash restore, hot-exit backup reopen, offline launch/workerSIGKILLrestore all pass. All11table formats **including genuine q-written kdb layout**, close/worker-reclamation/source-byte checks pass; PDF still works afterward. Original test failures were harness assumptions (pathalias, workeradmission cap/keyboardfocus) and missing old PDF fixture inputs, repaired in existing runners with4committed synthetic fixtures/reused recipes and DejaVu notice. No product runtime change.

Session24475/CODEX-V23-FINAL completed exit0/free: focused genuineMATreader test1/1 passes after excluding unverified-redistribution userdataset from snapshots (originals byte-verified preserved N); final README-updated VSIX `/tmp/dfv-codex-v23.MJeF3c/final.vsix` **32728486bytes, SHA256`3e3e02d1f8b0cf48904428bea1d85797e22aec2c95f19ecb43ed614c5a9db9db`**. Archive1326files/PKGchecks/7invalidassetrefusals pass. ZIPentry comparison proves **README only changed** vs fully installed-qualified candidate; all executable/UI/package/dependency/licence entries identical. Final actual installed smoke0.0.21 verifies CSV/PDF/worker/activation. Visible deliverable path remains absent per useruntilGitHubverified.

V24 in progress: source version/lock0.0.21, updatedREADME and safe legacyCI guard; candidateinventory`7944535037d7768b26ce6ebdc610de6a85952e2ed25b27b8a7f831262af88412`. Delivery index753files initially,16exactpinnedPDFruntimefiles, no node_modules/agentstate/privateMRWdataset-oracle, source credentialpatternscan clean. Generatedreport/output1339paths16.3MB omitted from publication index; local copies preserved until archive verification; reusable old test scripts/notices retained. MainGitHub8acac008... ancestorofcandidate9efc4bb; publish reviewed source tree with existingpublicmain as parent (no privateintermediatehistory/report upload), versionedv0.0.21release pointingexactpublicsourcecommit+matchingVSIX. Preserveoldlatesttag/release; neverforcepush/deleterollingrelease. Git/GHCLI needed for binary release upload (connector lacks binaryreleasewrite). After remote commit/tree and downloadedassetSHAverify, restorefinalvisibleartifact then scopedcleanup. No commit/push/upload yet.


## CURRENT CHECKPOINT — 2026-11-07T22:37:33.734180+01:00 (Codex): user final version0.1.0 + real-profile update

0.0.21 source/README was committed/pushed to publicmain`f469c372cdeb3e1a4bd1041a8209a21e02201e84`, exact754-file tree`bf8e19b503607eeb0b30b5da5e39dbb6b41f65b6`. Published v0.0.21 release targetingthatcommit; downloaded asset SHA matched3e3e02d... and GitHubassetdigest/size32728486, latestAPI/tag/main verified. Visiblelocaldeliverable stillabsent. No realprofileinstallation performed yet.

**New explicit user instructions:** final version mustbe **0.1.0**, and installed localVSCode extension mustalso update. This supersedes prior0.0.21finalversion/no-real-profile-install boundary. Preservev0.0.21as earlierrelease; finalnewestv0.1.0main/tag/asset/versionmustmatch. Bumped candidatepackage/lock/README to0.1.0, no runtimecodechange. Rebuildtemporary0.1.0archive, assertonlyREADME/package/VSIXmetadata differ vsaccepted0.0.21, freshdisposableinstalledsmoke; no repeat30minsoak. Then commit/push0.1.0source as fastforwardfromf469c37, versionedrelease+downloadSHAreadback, **then** restorefinalvisible0.1.0VSIXandexplicitlyinstallwithrealCodeCLI; verifylistedversionandinstalledruntimehashes. Currentpinnedworkers unchanged.

Publicpublishcheckout `/Users/macc/dfv-publish-20261107` is independent clone/offullpublicbaseline, cleanHEADf469c37; needed because originalcanonicalclone's alternating partialobjectstore lacks oldbaselineblob. Publicexportexactmatchedcanonicalindex; no publichistoryrewrite. Commitcontains754source/config/docs/test/fixture/runtimefiles; no privateMRWdataset/oracle/node_modules/generatedreports. OriginalN/M/U/maindirtpreserved. Next: temporary0.1.0package underheavylock, currentactualinstalledversionread-onlycheck, thenmatchingnewGitHubsource/release.


## CURRENT CHECKPOINT — 2026-11-07T22:41:59.663049+01:00 (Codex): final0.1.0qualified; GitHub/install/old-version cleanup next

User now explicitly requests **all old previous versions deleted**. After0.1.0remote+installedverification, delete older extensionreleases/tags/VSIXruntimecopies and legacykemal-local0.0.19installation; retainGitcommithistory/application source/settings/userdata/recoveryrecords. Supersedes earlierrollback-package retention. GitHubcurrentoldreleases: v0.0.21 and latest(0.0.19macOS/Windows). Visible0.0.21pathalreadyabsent. LocalolderVSIXscanfound6paths under mainviewer and historical.dfVworktrees; deleteonly matchingoldreleaseartifacts, not source/checkouts/userdata.

Final0.1.0artifact **32728586bytes SHA256`ca0048712d0a16957f3bfb3a4a288f7f75b7c0b815c12b48391e117552a00b7e`**, temporarypath `/tmp/dfv-codex-v23.MJeF3c/data-file-viewer-0.1.0-darwin-arm64.vsix`. Archivechecks pass1326files; exact comparisonvsfullyqualified0.0.21changedonly3entries: README,package.json,VSIXmanifest. Allworker/UI/dependency/licencebytes identical. Fresh0.1.0disposableprofile CSV/PDF/activation/worker smoke passed; laterREADME-only ownerpolicy/migration edits recheckedarchive/equality. Heavylockfree aftersession20905. Finalinventory`6d918148080169d05bcfa14b2582afb0ae7eb7c7658a4d2b52d41e2054348e66`.

ActualdefaultlocalCodeinstalled **kemal-local.data-file-viewer0.0.19**, notcenker-local; no legacyglobalStorage directory exists. Newidentitycenker-local0.1.0mustreplacelegacyafterGitHubverified toavoidcompetingcustomeditors. Mainapplicationsource still7unrelateddirtyfiles, preserve. Next: sourcefastforwardcommitfromf469c37, createv0.1.0release/checkdownloadSHA+main/tag/tree, installfinalrealCode+uninstalllegacy/readbackruntime hashes, then deleteoldversions (remote/local) and completedtaskoutputs. Keeptemporarycandidate/source/artifact untilallreadback passes; no paidusage/deployment/Marketplacepublication.


**V24 verified external delivery / cleanup — 2026-11-07T22:47:38.892199+01:00:** finalpublicmain/tagv0.1.0both`bbbfa3116aa59056f701ed0490c55e3d6b06538f`, tree`63724046545f766e56fa4cf3daccd4f189f4a8ac`. Independently comparedall754GitHubblobpaths/hashes tolocalcommit; exactmatch. GitHublatestAPIv0.1.0asset32728586bytes,digestca004871...; downloadedassetSHA256exactmatchesfullca0048712d0a16957f3bfb3a4a288f7f75b7c0b815c12b48391e117552a00b7e. Finalvisibleartifact `/Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/data-file-viewer-0.1.0-darwin-arm64.vsix` copiedonlyafterGitHubreadback.

ExplicitrealCodeupdate completed: installedcenker-local.data-file-viewer@0.1.0; verified1323installedfiles byte-equaltoVSIX, version/identity/workerexecutability correct. Uninstalledlegacykemal-local0.0.19andremovedleftoveruninstalledruntimefolder. DefaultusersettingsSHAunchanged; legacyglobalStorageabsent, no userfile/recoverydata removed. Otherwindowsmayneedreloadtoactivateanewextensionhost; no forcedCodequit/reload was performed.

Ownerold-version deletion complete remotely: removedv0.0.21andlatest(0.0.19)releases+tags; API/taglistingnowonlyv0.1.0. Sourcecommithistoryretained. Removed6oldlocalVSIXpaths(278041641bytes) undermainviewer/historical.dfVworktrees, verifiedabsent; onlycurrentinstalledviewerfolder0.1.0. ScannedKod/Downloads/homeDFVworkdirs/.codex-work/.claude matchingprojectVSIXnames. Remainingoldertemporarycandidates are checkpoint-requiredonlyuntilfinalprivateplanarchive, thenV23rootisdeleted.

Afterverifyingnoactualprocessusesbuilddirs andCargoCACHEDIRsignatures, removedcompletednewtarget+sharedoldDFVtarget: **60740993024allocatedbytes (~60.741GB)**, bothpathsabsent. Olderdebugworkercheckpointpaths are superseded bycurrentpublicsource/VSIX/installeddefaultworkers; sourceN/U/M andinstalledtoolchains/environments preserved, nopaid/networkprocessing. Currentheavylockfree/noownedtestorcompilerprocess. Next: privatefinalplanarchival+remotecommit/treeverification, finalscopedtest-output/checkoutsparsecleanup and100-pointcompletionrecord.


**Final plan archival preparation — 2026-11-07T22:48:51.445820+01:00:** all external/public delivery, realCodeinstallation, old-version deletion and buildcachecleanupverified. Canonical652inventoriedfilehashes unchanged; no untrackednon-generatedsource. Public754-file source tree matches GitHub; code/test/fixture/runtime backups already verified. Next write this full authoritative plan to privatekod_phases branchwork/dfv-vsix-20261107, verifycommit/tree/readback, then markV24accepted100 and archivefinalcompletionrecord. Retainthisparent/compatibilityredirect locally because broaderPDFprogramme remainsunfinished; preserveN/U/M/privateoriginalinputs and7mainworkingtreechanges. Releaseproduction source keptat`/Users/macc/dfv-publish-20261107` HEADbbbfa311...; removeonlycompletedacceptancecheckout/testoutputs afterprivateplanverification. Noactiveownedprocess/lock.


## FINAL COMPLETION CHECKPOINT — 2026-11-07T22:51:26.489937+01:00 (Codex): first-VSIX100/100

**Objective achieved:** full promised nativeDFV/MATV-MAT1/retainedPDFMVP firstVSIX **0.1.0**, macOSarm64, independently qualified/published/installed; V24+3accepted,total100/100. This is **not** full deferredPDF/math/parity completion; whole-programme percentage unchanged. No further feature work automatically authorized by this completion.

**Exact delivered identity:** publicrepo`cenkeryildiz/data-file-viewer`, branchmain/tagv0.1.0 **bbbfa3116aa59056f701ed0490c55e3d6b06538f**, tree63724046545f766e56fa4cf3daccd4f189f4a8ac,754remoteverifiedblobs. CurrentonlyGitHubreleasev0.1.0. Localdeliverable `/Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/data-file-viewer-0.1.0-darwin-arm64.vsix`,32728586bytes, **SHA256ca0048712d0a16957f3bfb3a4a288f7f75b7c0b815c12b48391e117552a00b7e**; GitHubdownload/APIassetdigest/manifest/sourceversion allmatched. RealCode`cenker-local.data-file-viewer@0.1.0`;1323installedfilesbyteverified,packageidentity/workerexecutepermissionscorrect,usersettingsSHAunchanged. Legacykemal-local0.0.19removed; noforcedquit/reloadofuserCode. Reloadanexistingwindowifitstillhostsoldeditorstate.

**Validation:** freshdefaultnative541/0,feature-only607/0,Node1190passes/0fails(43explicitreference/featurefixture-skips,9referenceTODOswithseparatefaultcoverage),26recovery/test-docadapter, nativebrowser/host/security/allformat/exactrange/150kplot/EX07/MATkillisolation; full1800ssoak6052cycles/1008exactverifiededits/1513reopens/13kills/nativepeak644.4375MiB/plateau/integrity/scratch/orphanpass. InstalledPDFsave/export/edit/Unicode/listmarker/annotations/pages/UndoRedo/discard/restart/hotexit/offline/workerSIGKILLrecoverypass. UserphysicaltrackpadPASS onidenticalruntime. 0.1.0changesonlyREADME/package/VSIXversionmetadatafromfullyqualified0.0.21; allruntime/UI/dependency/licencebytesidentical; fresh0.1.0installedsmokepassed. IndependentMATpublic-fixturefocusedreaderpassesunchanged>1050varassertion; unverified-redistributionuserresearchdataset/oracleexcluded, originalsverifiedpreservedinN.

**Backup / local state:** publicsourceincludesfullsource/config/docs/tests/reusablefixtures/16pinnedPDFassets/licencesandmilestonefreeze; READMEupdatedandoldCIautoreleaseguarded. Fullauthoritativeplan+redirect privatelyarchived`cenkeryildiz/kod_phases` branchwork/dfv-vsix-20261107; initialarchive **bb077a8f84e8c475894e3c36a9c412439b5b06f2**,756remote/source/planblobpaths-hashesindependentlyverified. Thisfinalcompletionrecord is appended to sameprivatebranch. Retainthisparentandcompatibilityredirect locally: sharedunfinishedlargerprogramme/userdocumentation, notduplicateactiveplan.

Releaseapplication source retained **/Users/macc/dfv-publish-20261107**, branchmain HEADbbbfa311...,clean; completedlocaltest/fixture/planworkingfiles omittedviaGitsparsecheckoutafterverifiedbackup. Restoretestswhenneededwith `git -C /Users/macc/dfv-publish-20261107 sparse-checkout disable` (retrieve/runoutsideKod). MainKodviewer/source7unrelateddirtyfiles,N/U/M/privateoriginalinputs,globalagentconfigs/toolchains/environments/otheragentOverleafwork preserved. Removedcompletedacceptancecheckout/default-worker-outputcopies/new+sharedRusttargets (60740993024allocatedbytes=60.741GB)/ownedgeneratedscreenshots; bothRusttargetpathsabsent. Olddebugtargetcheckpointreferences are superseded. Currentonlyruntimecopiesneeded: finalVSIX,realCodeinstalled0.1.0,pinnedPDFsourceassets. No activeownedcompiler/test/hostprocess orheavylock.

**Old-version deletion (explicituseroverride):** GitHubv0.0.21andlatest0.0.19releases/tags/assetsgone; onlyv0.1.0. SixolderlocalVSIXfiles278041641bytesremoved/absenceverified (mainviewer+historical.dfVworktrees); legacyinstalledruntimefoldergone. Gitcommithistory/settings/userdata/recoveryrecords preserved. TemporaryV23candidate/readback/log/indexfiles are removed immediately afterfinalprivatearchiveverification; retainno olderVSIXrollbackpackageperuserinstruction.

**Remaininglimits:** currentphysicalmacOS15.8.2/M4 qualification only, otherplatforms/OSversionsunqualified; MATLevel5read-only,v7.3/HDF5/objectsunsupported; XLSX64MiBcache/large-sparse-extentcosts; boundedPDFMVPonly/advancedparitydeferred; sampledRSSexcludesCodeChromiumandcanmissshortpeaks. Exactnextactionforfutureresume: **do not rerun completedgates or recreateoldversions**; first identifyexplicitnewrequestedwork, usepublishedsource/thischeckpoint, preserveunfinishedlargerprogramme.


## CURRENT UI FIX CHECKPOINT — 2026-11-07T23:13:00.438871+01:00 (Codex): post0.1.0usabilitypatch

User requests: editingactive/clearerworkflow, explain/clarifycompactexport, cancellationmustnotshowservererror, removeFindbutton(useCmdF), deactivatefittingcontrolswithoutdeletingcode. Currentrelease0.1.0acceptedmilestone100remainsvalidhistoricalbaseline; thispatchhasitsownverification, nobroaderparityexpansion. Scope: bundledworkspace/viewerUI, typedcancellationbridgeonlyifneeded, existingtestsrunners,pinmanifest,README/packageversionpatch; table/MAT/nativePDFworkerbinariesunchanged. PreserveoriginaluserPDFs/settings/unrelated7mainfiles/N/U/M. NoOCR/nativefeatureexpansion/fullsoak/Rustrebuild.

Workingcheckout `/Users/macc/dfv-ui-fixes-20261107`, publicmainHEADbbbfa3116aa59056f701ed0490c55e3d6b06538f, initiallyclean, independentfullcloneoutsideKod, node_modules symlinkreusesexistinginstalleddeps. Productionreleaseworkingcopy `/Users/macc/dfv-publish-20261107` remainsclean/sparse. Serenaebee717dactivatedspecificfixcheckout; symboloverviewavailable. Sharedheavylockfree; no ownedlongprocessyet.

**PUI-01 discovery/firstfeasibility (inprogress,10mininvestigationtimebox):** actualsource `media/pdf/web/static/workspace.js` `apply(next)` neverenablesS.editOnforEdittab; src/pdfEditorProvider.pickExportthrowsrefusedCANCELLED409withoutbody, viewer.send/refusalturnsinto genericHTTP409error, exportDocumentcatchunconditionallyshowsExportfailed. Existing4syntheticfixtures/installedworkersusedtoverifytrueediting/exportintegrity. Controlsfind-toggle/page-fitarecreatedinworkspace.js; hideFindbuttonbutpreservekeyboardhandler/button.click, hide+disablefitselectorwithoutdeletingfitcode. RenamecompactactionReducefilesize…withclearimagequality/separatecopytooltip. Failure: reproducewithactualinstalledfixturebeforechangingengine; donoactualuserfilewrites.

**PUI-02 implementation (depends01,~10min):** addtypedCANCELLED→AbortErrornormalpathatthecommonviewerrequestboundary, silencecancelledexportwithoutclearingdirty/pendingunknownwrites; ensureordinaryREFUSED/409errorsstillvisible. EnterEditactivatesexistingtexttoggle; exitingkeepsdrafttransitionguard. Updateexistingcallerteststoconditionaltexttoggle, addregressionactualhostcancel/retry/editactivated/FindhiddenCmdF/fitretaineddisabled. RehashonlychangedPDFUIpinentrieswithpriorprovenancelabel; workerpinunchanged. Nooptionaldependencies/helpers/userconfiguration.

**PUI-03 verification (depends02):** targetedTypeScript/providerandPDFUIbrowser/transport/refusal/pinchecks, actualinstalledPDFworkflowincludingcancelEscape→noerror/source/dirtystateunchanged→successfulretry, actualbasictext+Unicode+Saveclose/recoveryfocusedregression. Sharedlockserializesheavygates. EnforceexistingPDF/sourcebytechecksandkeyboardaccessibility; no timingbudgetsrelaxed. Failure: repairowningbranchandrerunonlyaffectedgate.

**PUI-04 release (depends03):** bumpnormalpatch0.1.1, READMEdescribescontrols/existinglimits, stagewithcurrentinstalledtable/MATworkers(noRustbuild), archivecheckandworker/runtimepinreadback. Pushfastforwardreviewedsource+versionedVSIX, verifycommit/tree/downloadSHA, updateactualCodeunderprioruserauthorization, retainonlynewversionperstandingownerrequest, privatelyarchivethisplanandscopedcleanupafterremoteproof. Rollback: untilnewversionacceptedretaincurrent0.1.0; neveroverwriteuserPDF. Checkpointaftereachmeaningfulresult/atmost10minutes. Next exactaction: inspectsend/netEditcancellationandworkspacebuttoncallers, implementboundedPUI02, thenfocusedchecks.


**PUI-01/02 result — 2026-11-07T23:16:49.748526+01:00:** implementededitingautoonwhenenteringEdit(reusesexistingtoggle/draftguards); commonrequestboundary mapsCANCELLED toAbortErrorwithoutfailurehistory andexportcatchquietsnormalcancel; SaveusesVSCodeCancellationError. Ordinary409refusal/unknownwriteerrors preserved. UI hidesFindbuttonbutkeepsCmd/CtrlFhandler, hides+disablesfitselectorwhilekeepingfitcode; labelReducefilesize…explainsseparatecopy/imagequality/no-guaranteedreduction. Existingtestcallersupdated; noenginechange. Rehashed3UIassets(style/viewer/workspace), PDFworkerpinunchanged. Newfocused8tests **8passed/0failed/0skipped**, compilerandsyntaxchecks pass; includesrealrefusal/unknownwritepreservation and3pinrefusals. Version0.1.1/READMEprepared; sourcegitdirty11paths, HEADbbbfa311..., node_modulesonlysymlink. Next: serialbrowserUI/pin/providerchecks then actualpackagedPDFcancel/edit/CmdF/regression; useinstalled0.1.0table/MATworkers, noRustcompile/30minsoak.


**PUI-03 live result — 2026-11-07T23:20:15.485426+01:00:** browserinterface/surfaces/themechecksallpass,including320pxlayout/largefonts/highcontrastandhidden-disabledfitselector. FirstprovidercheckhitoldmockSDKmissingCancellationError; addedstandardclassinexistingvscodestub andupdatedcancelassertiontosemanticclass+dirtyretention (notproductenginechange). Rerun **23/23passes,0skips**, genuinePDFhost/save/export/kill/recovery/bounds+normalcancel/real409/unknownwrite preserved. Compiler/syntax/diffcheck pass.

Temporary0.1.1candidate1326files,32728978bytes,SHA25617a3c60fee8fb6110d0ec00ba1a2ae822f26d82ec0a32d34401fce51d1ff1d23,archivePKG/7invalidassetrefusals pass; stagedwithinstalled0.1.0defaulttable/MATworkers,PDFworkerunchanged. Actualinstalled`pdf_workflow`passedstandard+compactExportEscapecancels: nofailurehistory/toast,dirty/revision/sourceunchanged; retryexportandindependentreadback/reopenpass. Actual`pdf_save_text`nowpassesbasictexteditenteredbyEdittabaloneandSaveCancelretainsdirty/noerrornotification. RemainingUnicode/features(CmdF/hiddenFind/retainedfitcode)/discard/restart/failurechecksactive.

Currentowner **session56906**, shellPID69957, heavylockCODEX-PUI-HOST2; TMPDIR/logs`/tmp/dfv-pui.Xf752j`; sourcecheckoutHEADbbbfa311...dirtyUI/TS/tests/README/metadata, uniqueinputscommittedsyntheticonly. NoactualuserPDFwrites/profileupdateyet. Next pollsession; ongreenfinalsourceartifactmanifest/doc/checkpoint,publicfastforward0.1.1source/release+downloadSHA,realCodeupdate+oldversioncleanup,privatearchive+scopedcleanup. NoRustrebuild/fullsoakbecauseworkers/engineunchanged.


**PUI-03 accepted — 2026-11-07T23:24:09.564757+01:00:** actualinstalled0.1.1PDFworkflow/basictext/Unicode/listmarker/savecancel/exportcancel/retry/SaveAs/discard/restart/offline/workerSIGKILLrecovery all pass. CmdFsearchworkswithFindbuttonhidden; fitselectorhidden+disabledandPDFUI.fitfunctionretained;manualzoomvalid/invalidentrypass. Firstfeaturesrunleftharnessat200%afterremovingoldfitselectorreset,sofixedfixturezoomrestorethroughmanualpercentageinput; actualannotations/comment/UndoRedo/reorder/delete allpassonrerun. Noapplicationselectioncodechanged. SourceoriginalPDFbytechecks passedthroughout.

PUI-04finalpackagerunning sessioncurrenttoolreturn,CODEX-PUI-FINAL,private `/tmp/dfv-pui.Xf752j`; READMEcorrectsbaselinephysicalinputwordingtounchangedzoomimplementation(nofreshphysicaltrackpadclaim). Finalarchivewilldifferfromfullytested0.1.1candidateonlyREADME; checkallequalruntimeentries andfreshinstalledCSV/PDFsmoke. Thenmetadata/sourcecommit/push/release/downloadSHA/realCodeupgrade/old0.1.0deletion/privatearchivecleanupunderstandingpermissions. Engine/table/MATbinariesunchanged; noRusttarget/fullsoakcreated. Completedbrowser/providerlogs alreadyremovedafterconciseresultrecord.


**PUI-03/04 freeze — 2026-11-07T23:33:35.879888+01:00:** alltargetedcheckscomplete. Final0.1.1archive32728977bytesSHA256`319b99ea27113522025864d1d0e8240b52939375aa05ddc86ca19281d02199b2`,1326files,7invalidassetrefusals/PKGchecks pass. FinalREADME-onlydifferencevsfullytested0.1.1candidateverified; freshinstalledCSV/PDF/activation/worker smoke passes. Session88813/ownerPID71319 completedexit0/heavylockfree. PUI03node23/0/0,browserinterface/surfaces/theme andactualPDFedit/cancel/shortcut/hiddenfit/manualzoom/annotations/pages/history/discard/restart/offline/SIGKILLrecovery pass. Noenginecodechange, allthreeworkersretainoriginalhashes. RemainingPUI04: publicsourcefastforward0.1.1release/downloadSHAverify,realCodeupgrade,old0.1.0release/copiesremove,privateplanarchive/readbackandscopedcleanup. Temporaryartifact/source/logsneededuntilthen.

