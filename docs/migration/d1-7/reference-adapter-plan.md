# D1.7 first reference adapter step

Base: 76e662e. D1.1/D1.6 prerequisite acceptance is recorded by parent in Kod commit 0513f73. This isolated checkout owns no D1.8/9 contract drafts or main resource-baseline edits.

Create backend/types.ts with explicit existing file/open/result types, independent of DuckDbFile and VS Code. Move shared public type declarations from duckdbConnection.ts and preserve compatibility reexports. ViewerFile implements the explicit contract and retains its compatibility DocumentFile export. No value/wire transformation.

Create backend/reference.ts with production restricted-reader ViewerFile and raw reference DuckDbFile factories. Capture reopening strategy per document, including deliberate raw test injection. Route provider initial opens and reconnects through that strategy; expose save notices as an optional contract member instead of provider instanceof. Preserve exact native error objects, options, file identity and all 21 read operations; no proxy, mutation retry or alternative writer.

Keep queue, execution-time trust, cache invalidation, close/drain and filesystem locks unchanged in this responsibility-sized commit. Session ownership extraction and MOD02/PERFX1/SAFEX1 remain open; this does not accept D1.7.

Validate explicit-contract compatibility/21-method coverage; factory injection/reopen failures/option forwarding/no retry; late save-notice routing after disposal; backend import graph forbids vscode and PDF; existing queue/trust/drain and real provider/worker tests. Run typecheck and proportional unit/security suites. Build/package from changed source and run selected installed-host checks under the shared heavy-test lock after pending PDF gate. Record exact exits/source hashes and actual limitations.
