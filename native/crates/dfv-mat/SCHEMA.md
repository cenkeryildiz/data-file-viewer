# MAT worker v1 (integrated read-only contract)

No prior frozen MAT RPC document was found. This schema implements the V-MAT1
read-only contract; host/supervisor integration and acceptance remain separate.
Transport is scheduled NDJSON using protocol `dfv-mat`, version 1. Requests have
`kind:request`, canonical unsigned decimal string `id`, `method`, object `args`,
and optional canonical decimal string `deadline_ms`. Cancellation has
`kind:cancel` and the request id. Startup emits capabilities. Replies use the
shared protocol result/error envelopes. No SQL or write methods exist.

All argument objects are closed: missing and extra fields are rejected. Every
method except open requires `session` and `generation` from open. Handles are
opaque, belong to one session, and are invalidated by close/source replacement.
They must not be reconstructed or shared between sessions. All counts, indices,
offsets, dimensions and generations are canonical uint64 decimal strings.

| Method | Additional required args | Result |
|---|---|---|
| open | path (absolute or relative local regular file) | session,generation,variables,read_only |
| catalog | offset,limit (1..1000) | total,offset,items [{handle,info}] |
| describe | handle | info |
| slice | handle,start,count (arrays per dimension) | dims,start,count,index_base,order,data |
| sparse | handle,start,count,offset,limit (1..10000) | shape,nnz,offset,has_more,implicit_zero,entries |
| children | handle,offset,limit (1..1000) | total,offset,items [{handle,label,info,preview}] |
| release | handles (at most1000 strings) | released (count of owned handles actually removed) |
| close | none | closed:true (unknown session returns not_open) |

Catalog, describe, slice, sparse and children results also contain session and
generation. Each catalog/children response allocates fresh handles; release old
page handles when replacing pages. Late cancelled result handles are reclaimed.
Limits:4 sessions,16384 total handles,8MiB frames,10000 dense preview cells,
256MiB decompressed variable,1000 catalog/child entries. Empty dimensions require
start1,count0; nonempty dimensions require start>=1,count>=1 within bounds.
Dense values use MATLAB column-major order. Sparse pages enumerate coordinates,
including shape and implicit zero information; they never allocate shape-sized
storage. Dense slice of sparse is limited to10000 cells.

Metadata and data retain the codec Info/Data wire forms. Int64/uint64 use exact
`{"$t":"int64|uint64","v":"decimal"}`. Floating tags use textual values,
including NaN, Infinity, -Infinity and -0. Complex data has separate re/im arrays.
Character previews retain rows and report lossy UTF16 replacement. Cells/structs
are navigated through children, never silently flattened. Unsupported object
classes remain catalog metadata and return explicit unsupported read errors.

No source bytes are written. Ordinary metadata/header source replacement is
checked before and after reads; this is not a cryptographic full-content identity.
Cancellation answers promptly via the scheduler and reclaims late state. The
bounded codec call itself is cooperative only at call boundaries; hard process
kill/restart and host stale-generation routing remain D6.2 integration work.

## V12 codec support and evidence map (05 November 2026)

This maps the V-MAT1 codec scope separately from installed host acceptance.
`reader.rs` compares complete catalogs, MATLAB `whos` class/dimensions, exact
integer decimal values and float bit patterns against independent load oracles.
Its `compare_file` now also compares the original bytes before and after every
supported fixture read. Refusal tests retain the same source integrity checks.
Application code never invokes MATLAB, SciPy or Python. These are fixture tools.

| Advertised scope | Independent input/oracle and exact check | Boundary/refusal proof |
|---|---|---|
| Level-5 v5/v6/v7 | SciPy v5 plain/zlib and its reader oracle; genuine MATLAB R2026b projection_v6/v7 and native_v7 load/whos oracles | Level-5 container version0x0100; v5/v6 have the same container signature, not separately detected release labels. Big-endian synthetic fixture has exact numeric/text oracle. |
| double/single | MATLAB projection_v6/v7 + SciPy float32/64, exact bit comparisons for subnormal/extreme/NaN/Infinity/signed zero | Invalid precision/storage conversion typed corrupt; no silent integer-to-float rounding. |
| int8/uint8/int16/uint16/int32/uint32/int64/uint64 | All8 SciPy classes; genuine MATLAB native/projection fixtures include exact64bit extremes and2^53+1 | Wire uses tagged decimal integers; actual stdio uint64 max18446744073709551615 verified. Complete genuine support_v6/v7 corpus now checks all8classes, including min/max boundaries, against MATLAB decimal oracles. |
| logical | Genuine MATLAB logical_values and exact bits, distinct from uint8 | Nonrepresentable logical data rejected by hostile cases. |
| dense scalar/row/column/2-D/empty | MATLAB native/projection + SciPy fixtures; every dimension/order/value checked | Worker validates one-based start/count even for empty dimensions; dense output<=10000cells. |
| N-D dense | Genuine MATLAB tensor2x3x4 and SciPy cube, exact column-major values; cut-window test | Wrong rank, zero start, out-of-range window and preview-cell limit refused. |
| complex | Genuine MATLAB complex_values and SciPy complex128, independent real/imaginary bit arrays | Wire preserves separate re/im; support_v6/v7 complex-single real/imaginary bit oracles pass. |
| sparse coordinates/dense windows | Genuine MATLAB million-by-million sparse with2nnz and SciPy sparse oracle; coordinate order, skip pages, implicit zeros and small dense windows checked | Trillion-cell dense request refused; huge-shape hostile allocation probe; malformed CSC rejected. support_v6/v7 complex/logical/empty sparse coordinate and imaginary-bit oracles pass. |
| char/text | Genuine MATLAB Unicode/Turkish/surrogate-pair/multirow/empty text and UTF16 code-unit oracle; synthetic lone-surrogate test | Text retains row structure/spaces; lossy replacement flag for lone surrogates. A char N-D request must select one2-D plane. support_v6/v7 newline UTF16 oracle passes. |
| cell/nested scalar struct | Genuine MATLAB projection/refusals/native recursive load oracle and direct child paging/label/value tests | Children pages<=1000; depth/field/count limits and wrong-kind children requests refused. |
| struct arrays/N-D cells and structs | Genuine existing struct-array metadata/labels; support_v6/v7 full independent member-value oracles for2element/twofield struct arrays and8element N-D structs; N-D cell values match MATLAB load oracles | Paths use one-based MATLAB element indices; preview handles are session-owned. |
| unsupported class | Genuine MATLAB string/table/datetime/function_handle catalog-class oracle, metadata-only support status, explicit unsupported reads | Unknown/object/opaque classes remain metadata-only or typed refusal; no guessed values/shapes for MCOS internals. |
| unsupported version | Genuine native_v73 and h5py HDF5, SciPy v4, non-MAT input | Explicit unsupported version/not-MAT mapping; v4/v7.3 decoding is outside this Level-5 scope. |
| malformed/untrusted source |18 hostile codec tests including compressed-size ceilings, truncated/flipped bytes, invalid dimensions/CSC/storage/fields/depth/FIFO | No panic or claimed-size allocation; regular source opened read-only; original bytes retained. |

The generation identity is metadata/header based, not a cryptographic full-file
hash. Codec source mutation, stale worker handles, cross-session rejection and
source-byte preservation are verified separately. Aggregate RSS, low-memory
hardware and installed host load/refresh/crash behavior are not codec acceptance.

Additional genuine support corpus gate: **verified05November2026,20:34CET**.
Initial default MATLAB batch startup produced no output after104seconds and was
stopped. One different authorized no-JVM/no-display run reached DFV_READY and
completed in18.63seconds, with no licence, sign-in or service changes. The
unsupported supplied `-nosplash` flag was ignored; no claim that it fixed startup.
Both new files contain18variables; all6 fixture/oracle files and2generator inputs
are SHA-256/size bound in `../mat/tests/fixtures/support-manifest.json`.

`../mat/tests/fixtures/create_support_fixtures.m` writes only support_v6/v7
fixtures and independent MATLAB load/bit/member-value oracles, preserving every
original fixture. Headless reproduction with the installed existing MATLAB:
`matlab -nodisplay -nojvm -batch "run('/absolute/path/create_support_fixtures.m')"`.
MATLAB is a test fixture producer only, never an application dependency.

Focused new oracle test passed in0.01s. Full codec gate **31/31passes, zero
ignored/skipped**:18hostile tests(3.17s) plus13reader tests(0.22s), followed by
strict all-targets Clippy(0.17s). Command from the native integration root:
`cargo +1.99.1 test --manifest-path native/Cargo.toml --offline -j2 -p dfv-table-mat --test reader --test hostile`.
The former pending test is enabled; no missing-fixture skip remains. All supported
oracle comparisons assert original source bytes before/after; explicit unsupported
version/class/refusal tests remain intact. This is codec signoff evidence, not
whole installed V-MAT1, supervisor, aggregate resource or release acceptance.

## V17 worker and host boundaries

Parent FIRST_VSIX_PLAN.md V1.1 freezes the4point worker parent into3core/1host.
These are planning judgments about the named scope, not measured time or an
additional award from this audit. The earlier2/2 suggestion was not adopted.

| Parent gate | Weight | Required proof and current state |
|---|---:|---|
| V17.1: integrated dedicated worker |3| Separate dfv-mat binary/protocol; eight read-only methods; oracle/exact stdio result; bounded pages/sessions/handles/frames; source/cross-session handle checks; cancellation/deadline late-state reclamation; default table protocol regression. Verified8worker+29codec+26protocol tests and strictClippy before this independent audit; current31codec tests pass with no ignored tests. |
| V17.2: lifecycle/supervisor boundary |1| Real extension owns independent MAT process; selection/source generation drops stale replies; timeout/crash/restart closes handles; worker kill leaves tables usable; repeated open/close and aggregate budget proof. Host/adapter ownership; not implied by worker tests. Shared supervisor/aggregate acceptance also remains in parentV19/V20; no double credit. |

V12's3point codec scope, V17's4point parent and viewer/installed release gates
remain distinct. A green compiler or one new fixture does not establish a
percentage, package acceptance or whole V-MAT1 delivery.

Empty-char allocation review: `slice_body` returns empty char rows before
`char_region` whenever a source dimension is zero. The hostile regression
`huge_empty_char_dimensions_never_allocate_one_string_per_claimed_row` verifies
both [2147483647,0] and [0,2147483647], full requested counts, exact empty result
and largest allocation below64KiB. Nonempty shapes reject zero requested count.
The reported row-loop risk is unreachable through the public codec API; no
production workaround was added. Latest gate:18hostile+13reader pass, zero ignored tests; strict all-targets
codec Clippy passes.
