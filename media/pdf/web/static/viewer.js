/* PDF Studio viewer.
 *
 * Pages arrive as images rendered by MuPDF on the server; this file only
 * positions them and draws the text layer on top. It deliberately does not
 * parse the PDF -- a second parser in the browser is how viewers end up
 * disagreeing with the thing that writes the file.
 *
 * Everything cached here is filed under the version of what it came from, and
 * the versions are per page (see web/app.py): each page in get_document_info carries a
 * `look` token, which every image URL of that page carries, and a `geo` token,
 * which its text layer and selection characters are filed under. An edit
 * answers with the pages it changed and their new tokens, so exactly those
 * pages are fetched again -- a highlight changes one page's `look` and no
 * page's `geo`, and the page next to it keeps its image, its characters and
 * its overlay. `revision` is the document's edit count, and only says whether
 * an answer is the next one or whether something was missed in between.
 *
 * A read naming a version the server no longer has is refused with 410 rather
 * than answered with newer bytes, and the viewer then asks for the current
 * tokens (resync). What an edit is POSITIONED with is checked by the server
 * too: an edit or mark sends back the `geo` token of the geometry it was
 * measured on, and a page that has moved on since answers 409 and nothing is
 * changed (E12). See _require and _fresh in web/app.py. */

const $ = (s) => document.querySelector(s);

// Which build of this file the browser is actually running, read off this
// script's own URL (the server stamps it with the file's mtime). Shown in the
// status bar because "is the new code loaded?" has twice been answered wrongly
// by inference, and a cached script looks exactly like a broken feature.
const BUILD = (() => {
  try {
    return new URL(document.currentScript.src).searchParams.get("v") || "dev";
  } catch {
    return "dev";
  }
})();

const S = {
  doc: null,            // get_document_info, with each page's current look/geo tokens
  revision: 0,          // edits the document has had; orders edit answers
  zoom: 1,
  dpr: 1,               // device pixels per CSS pixel, kept current (watchDensity)
  selected: new Set(),
  selectionAnchor: null,
  selectionFocus: 0,
  // Editing is a mode; selecting is not. Dragging across words to highlight,
  // underline, strike through or copy them works on any page at any time, the
  // way it does in Preview. `editOn` gates only the click-a-run-to-retype-it
  // affordance, which is the one thing that genuinely needs arming first.
  editOn: false,
  viewMode: 'fit-page',
  currentPage: 0, // physical index; independent of PDF page labels
  lines: {},            // page -> reading-order characters, for selecting text
  linesPending: {},     // page -> the in-flight request for them, shared by callers
  fonts: new Map(),     // font xref -> the <style> registering its current version
  editorGeneration: 0,
  editGeo: null,        // geo token of the probe the open editor was built from
  editAt: null,         // what the open editor was opened on (see sendEdit)
  editProbe: null,      // AbortController of the probe an editor is being opened from
  editCommit: null,     // the open editor's commit while it is with the server (sendEdit)
  unverified: null,     // a change sent without an answer, until reconcile() settles it
  failures: [],         // the last failed requests: {id, status, code, at}
};

/* ----------------------------- plumbing ----------------------------- */

/* Everything asked of the engine -- JSON reads and changes, page images,
 * embedded fonts, and changes made elsewhere -- goes through this transport
 * (editorTransport.js), by operation name. Standalone uses HTTP; an embedding
 * host can supply the same contract before startup. Nothing below knows a route. */
function initialTransport() {
  const injected = globalThis.PDFStudioHost?.createTransport;
  if (injected === undefined) return EditorTransport.http();
  const supplied = injected.call(globalThis.PDFStudioHost, EditorTransport);
  if (!supplied || typeof supplied.withdraws !== 'boolean' ||
      !['request','resourceKey','openResource','subscribe'].every(key => typeof supplied[key] === 'function')) {
    throw new TypeError('PDFStudioHost.createTransport must return the complete EditorTransport contract.');
  }
  return supplied;
}
let transport = initialTransport();

/* Every request carries an identifier (X-Request-ID). The server logs it on
 * the one line it writes about an edit or an error, and names it in every
 * error it sends back, so a message on screen can be matched to the terminal.
 * The last failures are kept in S.failures, newest last. */
const REQUEST_TAG = Math.random().toString(36).slice(2, 6);
let requestSeq = 0;
const requestId = () => `${REQUEST_TAG}-${(++requestSeq).toString(36)}`;

// Whether an operation changes the document ("change"), only asks ("get",
// "ask"), or names an image or font ("resource"). See editorTransport.js.
const opKind = (op) => EditorTransport.kind(op);

function remember(err) {
  (S.failures ||= []).push({ id: err.requestId, status: err.status ?? null,
                             code: err.code, at: Date.now() });
  if (S.failures.length > 20) S.failures.shift();
  return err;
}

/* A refusal from the transport (the engine answered and declined), as an
 * Error carrying the server's own message (`detail`), its stable `code` and
 * the request identifier. The transport has already read the answer's body,
 * once (see editorTransport.js). */
function refusal(r, id) {
  const body = r.body;
  const detail = body && body.detail;
  const message = typeof detail === "string" && detail ? detail
    : Array.isArray(detail) && detail.length
      ? `The server could not read this request: ${detail.map((d) => d.msg).join("; ")}.`
      : r.status >= 500
        ? `The server failed while handling this request (HTTP ${r.status}) and sent no `
          + "explanation. Its terminal shows the error."
        : `The server refused this request (HTTP ${r.status}).`;
  return remember(Object.assign(new Error(message), {
    status: r.status,
    // The whole answer, for what an editor can act on (an overlap's offers).
    body,
    code: r.code || `http_${r.status}`,
    requestId: r.requestId || id,
  }));
}

/* No answer at all: the connection failed, or the server stopped. For a
 * change to the document that is ambiguous -- it may have been applied before
 * the connection went -- so the error says so and is marked `unanswered`;
 * the change's turn in netEdit then finds out which (reconcile) instead of
 * sending it again. A cancelled request is not a failure and passes through
 * as it is. */
function noAnswer(e, op, id) {
  if (e && e.name === "AbortError") return e;
  const change = opKind(op) === "change";
  return remember(Object.assign(new Error(change
    ? "The connection to the server was lost before it answered, so this change may or "
      + "may not have been saved."
    : "The server did not answer. Check that it is still running in its terminal, then "
      + "try again."), { unanswered: true, code: "connection_lost", requestId: id, cause: e }));
}

// The one place a request actually goes out. Everything reaches it through
// the coordinator below. `signal` is the transport's: see netRead. `timing`
// is the coordinator's note of when it was queued (PERF-01, perfRequest).
async function send(op, params, signal, timing) {
  const id = requestId();
  const rec = perfRequest(op, id, timing);
  let answer;
  try {
    answer = await transport.request(op, params, { requestId: id, signal });
  } catch (e) {
    perfAnswered(rec, e);
    if (!e || !e.refused) {
      // No answer -- or answered and then cut off: for a change, it WAS
      // applied (the status said so), but what it changed is unknown. The
      // same catching up either way.
      throw noAnswer(e, op, id);
    }
    // A version this viewer asked for is gone, so the tokens it holds are
    // behind the document. Catch up; whoever asked still gets the error.
    if (e.status === 410) resync();
    throw refusal(e, id);
  }
  perfAnswered(rec, null, answer);
  return answer;
}

/* A read -- a "get", or an "ask" whose body changes nothing -- or a change
 * to the document (see opKind). `priority`, `signal`, `heavy` and `late` are
 * the coordinator's: see netRead. `perf` is a PDFPerf operation the request
 * belongs to (its id is listed in the operation's record). */
function api(op, params = {}, opts = {}) {
  const { priority, signal, heavy, late, perf } = opts;
  if (opKind(op) === "change") return netEdit(op, params, perf);
  return netRead(op, params, priority, signal, { heavy, late, perf });
}

/* A change to the document: sent one at a time, in the order asked. One whose
 * answer never arrived is not sent again: the document is read back
 * (reconcile) to learn whether it landed, and the error says which. Until that
 * is known, no further change is sent. */
async function post(op, body, perf) {
  return api(op, body || {}, { perf });
}

// A question asked with a body that changes nothing (the text probe).
async function ask(op, body, priority = "edit", signal) {
  return api(op, body || {}, { priority, signal });
}

const OUTCOME = {
  applied: "The connection was lost after the server received this change, and the server "
    + "had saved it: the page now shows it.",
  not_applied: "The connection was lost before the server saved this change, so nothing was "
    + "saved. It was not sent again; your text is kept, and saving again retries it.",
  replaced: "The connection was lost, and the server now has a different document open. "
    + "Nothing was sent again.",
  unknown: "The connection to the server was lost before it answered, and the server is not "
    + "answering now, so it is not known whether this change was saved. Nothing more will be "
    + "sent until it answers; check that it is still running in its terminal.",
};

/* After a change went unanswered: read the document's state back and say
 * whether that change landed. The revision counts committed edits, so a
 * revision past the one the change was sent from means an edit landed after
 * it was sent -- with one change in flight (netEdit), that one. Returns
 * "applied", "not_applied", "replaced" (another document is open) or
 * "unknown" (still no answer -- S.unverified stays set, and settled() asks
 * again before the next change). */
async function reconcile() {
  const pending = S.unverified;
  if (!pending) return "not_applied";
  let info;
  try { info = await api("get_document_info", {}, { priority: "edit" }); } catch { return "unknown"; }
  S.unverified = null;
  if (info.doc !== pending.doc) {
    await load();
    return "replaced";
  }
  const applied = info.revision > pending.revision;
  // Take in whatever the lost answer would have said.
  if (applied) await resync();
  return applied ? "applied" : "not_applied";
}

// Before a change is sent: an earlier one whose fate is unknown is settled
// first, or this one is not sent.
async function settled() {
  if (!S.unverified) return;
  if (await reconcile() !== "unknown") return;
  throw remember(Object.assign(new Error(OUTCOME.unknown),
                               { unanswered: true, code: "unverified", outcome: "unknown" }));
}

// An error as it is shown: the server's message, and which request it was.
const explain = (e) => (e.requestId ? `${e.message} (request ${e.requestId})` : e.message);

/* ----------------------------- the request coordinator -----------------------------
 *
 * Every request the viewer makes goes through here, so what the server is
 * asked to do at once is decided in one place rather than by whichever part
 * of the page asked last. A 1,000-page scroll with the thumbnail rail open
 * used to put a render per page it passed in front of the server, and the
 * server answers one request at a time (web/app.py's gate) -- so a click to
 * edit waited behind every page scrolled past.
 *
 * Reads wait in one line and are sent best first: what an edit in progress
 * is waiting for, then the pages on screen, then the editor's preview
 * (a preparation), then the page next in the direction the view is moving
 * ("ahead"), a neighbour while no direction is known yet ("adjacent"), the
 * page it is moving away from ("behind"), then thumbnails, and last the
 * document search, one page per read (PERF-02). At most
 * NET_READS are with the server at once, at most NET_RASTER of those are
 * images (pages, tiles, thumbnails), which are the slow ones, and at most
 * NET_HEAVY is a preparation, which can be slower still (formulas); the rest
 * of the slots stay free for the small reads viewing and an edit need.
 *
 * A read nobody wants any more -- its page scrolled away, a newer zoom asked
 * for, a draft typed over -- is taken out of the line if it has not been
 * sent. One that has been sent is NOT taken back: the server finishes it
 * either way, so it keeps its slot until it is answered, and the answer goes
 * to no one (or to its `late` hook: a preparation's token is let go there).
 * (A transport that can still withdraw what it was handed is told to; the
 * read keeps its slot until the transport has let it go. See netRead.)
 * Counting it as finished early is exactly how the server ends up with more
 * than it was meant to have. Two requests for the same thing share one.
 *
 * Changes to the document do not wait in that line; they wait for each other.
 * Each is sent only once the one before it has been answered, and one whose
 * answer never arrived is NOT sent again: without an answer there is no
 * knowing whether it was applied, and applying it twice is worse than asking
 * (reconcile, at its turn in the chain -- not when it was asked for, so a
 * change queued behind an unanswered one waits for that answer too). What
 * each one carries -- the geometry or layout token, or the preparation token,
 * it was made against -- is exactly what it was built with, so a change
 * queued behind another is still refused (409) if that one moved the page.
 */
/* Best first. PERF-02 replaced the one symmetric "adjacent" rank for the
 * pages either side of the view with "ahead" and "behind" of the scroll
 * direction (pagePriority), keeping "adjacent" for a neighbour while the
 * direction is unknown and for reads that have no side. "search" is below
 * thumbnails: a search reads one page per request, so whatever the view
 * needs overtakes it between pages, and it never waits for images (they
 * have their own NET_RASTER slots), so an idle view never starves it.
 * These names are the browser's own; the transport is not handed them
 * (docs/ENGINE_HOST_CONTRACT.md, "Browser-side scheduling"). */
const PRIO = ["edit", "visible", "prepare", "ahead", "adjacent", "behind", "thumb", "search"];
const NET_READS = 4;
const NET_RASTER = 2;
const NET_HEAVY = 1;
const NET = {
  queue: [],            // reads not yet sent
  running: 0,           // reads sent and not yet answered
  raster: 0,            // ... of which images
  heavy: 0,             // ... of which preparations
  seq: 0,               // arrival order, to break ties within a priority
  shared: new Map(),    // GET path -> the read another request for it can join
  edits: Promise.resolve(),   // the last change asked for, settled or not
  changes: 0,           // changes asked for and not yet settled
  watch: null,          // told whenever `changes` moves (the Undo and Redo buttons)
  stats: { sent: 0, peak: 0, peak_raster: 0, peak_heavy: 0, dropped: 0, discarded: 0,
           joined: 0, late: 0, edits: 0, edits_unanswered: 0 },
};

/* ----------------------------- timing records (PERF-01) -----------------------------
 *
 * What each request and each page image cost, stage by stage, kept as the
 * last PERF_MAX records of this page (older ones are dropped and counted):
 *
 *   request  queue_ms (put in line -> sent), response_ms (sent -> answered),
 *            the revision it was sent at and the one its answer names, its
 *            outcome, and -- joined by request id from the answer's
 *            Server-Timing header -- the server's lane wait, native run,
 *            render and encode (web/app.py, pdf_stages.request_spans).
 *   image    queue_ms, load_ms (sent -> bytes arrived), decode_ms (sent ->
 *            decoded), display_ms (decoded -> the frame that draws it), its
 *            page, role, dpi, look and revision; server stages joined by URL.
 *   op       one user-level operation (prepare, commit, undo, redo, export,
 *            search): total_ms, named marks, the ids of the requests it made.
 *
 * Names, numbers, ids and version tokens only: no parameter, document text,
 * URL or path is kept. Measuring decides nothing, and a measurement that
 * fails is dropped -- the work goes on as if nothing measured it. Read with
 * PDFPerf.records(). NET_READS, NET_RASTER and NET_HEAVY are not touched. */
const PERF_MAX = 200;
const PERF_SERVER_MAX = 400;     // Server-Timing entries waiting to be joined
const PERF = { records: [], dropped: 0, seq: 0, ops: 0, server: new Map() };

function perfNow() {
  try {
    const t = performance.now();
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}
const perfMs = (a, b) => (a == null || b == null ? null : Math.round((b - a) * 1000) / 1000);
const perfWord = (s) => (typeof s === "string" && /^[a-z_]{1,32}$/.test(s) ? s : null);

function perfKeep(rec) {
  try {
    rec.seq = ++PERF.seq;
    if (PERF.records.length >= PERF_MAX) { PERF.records.shift(); PERF.dropped++; }
    PERF.records.push(rec);
  } catch { /* measuring never fails the work */ }
}

// Numbers and booleans only: a fact is never text.
function perfFacts(facts) {
  const out = {};
  try {
    for (const [k, v] of Object.entries(facts || {}))
      if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
  } catch { /* none */ }
  return out;
}

function perfRequest(op, id, timing) {
  try {
    const now = perfNow();
    if (timing?.op) perfLink(timing.op, id);
    return { kind: "request", op, rid: id, priority: timing?.priority ?? null,
             revision: S.revision ?? null, revision_after: null,
             queue_ms: perfMs(timing?.queuedAt ?? now, now), response_ms: null,
             outcome: null, server: null, _sent: now };
  } catch { return null; }
}

function perfAnswered(rec, err, answer) {
  if (!rec) return;
  try {
    rec.response_ms = perfMs(rec._sent, perfNow());
    if (err) {
      rec.outcome = err.name === "AbortError" ? "aborted" : err.refused ? "refused" : "no_answer";
      if (err.refused) { rec.status = err.status ?? null; rec.code = perfWord(err.code); }
    } else {
      rec.outcome = "ok";
      const rev = answer?.revision ?? answer?.state?.revision;
      rec.revision_after = Number.isFinite(rev) ? rev : null;
    }
    perfKeep(rec);
  } catch { /* dropped */ }
}

// An image, described from its resource key without knowing any route: the
// key's last numeric path segment is its page, its query its dpi and role.
// The key itself is kept only privately, to join the server's stages.
function perfImage(key, look, priority) {
  try {
    const u = new URL(String(key), location.href);
    const m = /(\d+)$/.exec(u.pathname);
    const q = u.searchParams;
    return { kind: "image", role: q.get("tile") ? "tile" : q.get("thumb") ? "thumb" : "page",
             page: m ? Number(m[1]) : null, dpi: Number(q.get("dpi")) || null,
             look: typeof look === "string" ? look : null, revision: S.revision ?? null,
             priority, queue_ms: null, load_ms: null, decode_ms: null, display_ms: null,
             outcome: null, server: null, _queued: perfNow(), _key: u.pathname + u.search };
  } catch { return null; }
}

function perfImageAt(rec, stage) {
  if (!rec) return;
  try {
    const now = perfNow();
    if (stage === "sent") { rec._sent = now; rec.queue_ms = perfMs(rec._queued, now); }
    else if (stage === "load" && rec.load_ms == null) rec.load_ms = perfMs(rec._sent, now);
    else if (stage === "decoded") { rec._decoded = now; rec.decode_ms = perfMs(rec._sent, now); }
  } catch { /* dropped */ }
}

function perfImageDone(rec, outcome) {
  if (!rec || rec._done) return;
  try {
    rec._done = true;
    rec.outcome = outcome;
    if (outcome === "shown" && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        try { rec.display_ms = perfMs(rec._decoded, perfNow()); } catch { /* dropped */ }
      });
    }
    perfKeep(rec);
  } catch { /* dropped */ }
}

function perfBegin(name, facts) {
  try {
    return { kind: "op", name: perfWord(name), op_id: ++PERF.ops, revision: S.revision ?? null,
             revision_after: null, total_ms: null, marks: {}, rids: [], outcome: null,
             facts: perfFacts(facts), _t0: perfNow() };
  } catch { return null; }
}

function perfLink(op, id) {
  try { if (op && !op._done && op.rids.length < 16) op.rids.push(id); } catch { /* dropped */ }
}

function perfMark(op, name) {
  try { if (op && !op._done && perfWord(name)) op.marks[name] = perfMs(op._t0, perfNow()); }
  catch { /* dropped */ }
}

function perfEnd(op, outcome = "ok", facts) {
  try {
    if (!op || op._done) return;
    op._done = true;
    op.total_ms = perfMs(op._t0, perfNow());
    op.outcome = perfWord(outcome) || "other";
    op.revision_after = S.revision ?? null;
    Object.assign(op.facts, perfFacts(facts));
    perfKeep(op);
  } catch { /* dropped */ }
}

// Server-Timing, as the browser reports it for each same-origin response:
// the request id the server answered under, then stage durations.
function perfServerEntries(list) {
  try {
    for (const e of list.getEntries()) {
      const st = e.serverTiming;
      if (!st || !st.length) continue;
      const stages = {};
      let rid = null;
      for (const s of st) {
        if (s.name === "rid") rid = s.description || null;
        else if (/^[a-z_]{1,16}$/.test(s.name) && Number.isFinite(s.duration)) stages[s.name] = s.duration;
      }
      const item = { rid, stages };
      if (rid) perfServerPut(`rid:${rid}`, item);
      // A resource (an image) carries no id of ours, so it is found by its
      // URL. Reads carry ours, and their URLs -- a search's query -- are
      // never kept.
      if (rid && !rid.startsWith(`${REQUEST_TAG}-`)) {
        const u = new URL(e.name, location.href);
        perfServerPut(`url:${u.pathname}${u.search}`, item);
      }
    }
  } catch { /* dropped */ }
}

function perfServerPut(key, item) {
  PERF.server.delete(key);
  PERF.server.set(key, item);
  while (PERF.server.size > PERF_SERVER_MAX) PERF.server.delete(PERF.server.keys().next().value);
}

try {
  new PerformanceObserver(perfServerEntries).observe({ type: "resource", buffered: true });
} catch { /* no resource timing here: records carry no server stages */ }

// Copies of the kept records, oldest first, server stages joined where known.
function perfRecords() {
  const out = [];
  for (const r of PERF.records) {
    try {
      if (!r.server) {
        const hit = r.kind === "request" ? PERF.server.get(`rid:${r.rid}`)
          : r.kind === "image" && r._key ? PERF.server.get(`url:${r._key}`) : null;
        if (hit) {
          r.server = { ...hit.stages };
          if (r.kind === "image") r.server_rid = hit.rid;
        }
      }
      const o = {};
      for (const k of Object.keys(r)) if (k[0] !== "_") o[k] = r[k];
      if (o.server) o.server = { ...o.server };
      if (o.marks) o.marks = { ...o.marks };
      if (o.rids) o.rids = [...o.rids];
      if (o.facts) o.facts = { ...o.facts };
      out.push(o);
    } catch { /* skipped */ }
  }
  return out;
}

globalThis.PDFPerf = {
  MAX: PERF_MAX,
  get dropped() { return PERF.dropped; },
  records: perfRecords,
  begin: perfBegin,
  mark: perfMark,
  end: perfEnd,
};

const rankOf = (priority) => {
  const k = PRIO.indexOf(priority);
  return k < 0 ? 1 : k;
};

/* Put a read in line. `job.go()` sends it and returns a promise that settles
 * once the server has answered. */
function netQueue(job) {
  job.seq = ++NET.seq;
  job.rank = rankOf(job.priority);
  job.state = "queued";
  job.queuedAt = perfNow();
  NET.queue.push(job);
  netPump();
  return job;
}

// Send the best reads there is room for.
function netPump() {
  while (NET.running < NET_READS) {
    let best = null;
    for (const j of NET.queue) {
      if (j.raster && NET.raster >= NET_RASTER) continue;
      if (j.heavy && NET.heavy >= NET_HEAVY) continue;
      if (!best || j.rank < best.rank || (j.rank === best.rank && j.seq < best.seq)) best = j;
    }
    if (!best) return;
    NET.queue.splice(NET.queue.indexOf(best), 1);
    netStart(best);
  }
}

function netStart(job) {
  job.state = "running";
  NET.running++;
  if (job.raster) NET.raster++;
  if (job.heavy) NET.heavy++;
  const st = NET.stats;
  st.sent++;
  st.peak = Math.max(st.peak, NET.running);
  st.peak_raster = Math.max(st.peak_raster, NET.raster);
  st.peak_heavy = Math.max(st.peak_heavy, NET.heavy);
  let answered;
  try { answered = Promise.resolve(job.go()); } catch (e) { answered = Promise.reject(e); }
  answered.catch(() => {}).then(() => {
    job.state = "done";
    NET.running--;
    if (job.raster) NET.raster--;
    if (job.heavy) NET.heavy--;
    netPump();
  });
}

// Take a read out of line if it has not been sent; says whether it was.
function netCancel(job) {
  if (!job || job.state !== "queued") return false;
  NET.queue.splice(NET.queue.indexOf(job), 1);
  job.state = "dropped";
  NET.stats.dropped++;
  return true;
}

// A read still in line moves with what it is for: a page scrolled onto the
// screen has its image asked for ahead of the ones beside it.
function netPriority(job, priority) {
  if (!job || job.state !== "queued") return;
  const rank = rankOf(priority);
  if (rank === job.rank) return;
  job.rank = rank;
  netPump();
}

const abortError = () =>
  Object.assign(new Error("The request was superseded."), { name: "AbortError" });

/* A JSON read. Resolves with the answer, or rejects -- with an AbortError
 * when `signal` fires first.
 *
 * Shared with an equivalent read: the same "get" with the same params. One
 * that names a version (`v`) has the same answer whenever it is sent, so it
 * can be joined until it is answered; one that does not means "what is
 * current", so it can be joined only while it is still waiting to be sent --
 * joining one already sent could hand back the document as it was before a
 * change. Questions with a body ("ask") are never shared.
 *
 * `heavy`: a preparation, held to NET_HEAVY at a time. `late(answer)`: called
 * when the caller withdrew after the read was sent and its answer still
 * arrived -- what the server made for it (a prepared edit) can then be let
 * go rather than left to wait for a commit that will never come.
 *
 * A sent read that nobody waits for any more is called back only through a
 * transport that can withdraw what it was handed (transport.withdraws), and
 * only when no `late` hook still wants its answer: its signal fires, it is
 * no longer shared, and it keeps its slot until the transport lets it go.
 * Over HTTP it is left to arrive, as above. */
function netRead(op, params, priority = "visible", signal, extra = {}) {
  const key = opKind(op) === "get" ? `${op} ${JSON.stringify(params)}` : null;
  let job = key ? NET.shared.get(key) : null;
  const joinable = job && (job.state === "queued"
                           || (job.state === "running" && "v" in params));
  if (joinable) {
    NET.stats.joined++;
    if (rankOf(priority) < job.rank) netPriority(job, priority);
  } else {
    job = { raster: false, heavy: !!extra.heavy, priority, waiters: new Set(), late: [],
            ctl: new AbortController() };
    const deliver = (how, value) => {
      if (key && NET.shared.get(key) === job) NET.shared.delete(key);
      // Sent, answered, and nobody left to take it.
      if (!job.waiters.size) NET.stats.discarded++;
      for (const w of job.waiters) w[how](value);
      job.waiters.clear();
      if (how === "ok") {
        for (const f of job.late) {
          NET.stats.late++;
          try { f(value); } catch { /* the hook's own business */ }
        }
      }
      job.late = [];
    };
    job.go = () => send(op, params, job.ctl.signal,
                        { queuedAt: job.queuedAt, priority: PRIO[job.rank] ?? null, op: extra.perf })
      .then((v) => deliver("ok", v), (e) => deliver("no", e));
    if (key) NET.shared.set(key, job);
    netQueue(job);
  }
  const waiter = {};
  const mine = new Promise((ok, no) => { waiter.ok = ok; waiter.no = no; });
  job.waiters.add(waiter);
  if (signal) {
    const abort = () => {
      if (!job.waiters.delete(waiter)) return;
      waiter.no(abortError());
      if (job.state === "running" && extra.late) job.late.push(extra.late);
      if (job.waiters.size) return;
      const unshare = () => { if (key && NET.shared.get(key) === job) NET.shared.delete(key); };
      if (netCancel(job)) unshare();
      else if (job.state === "running" && transport.withdraws && !job.late.length) {
        unshare();
        job.ctl.abort();
      }
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return mine;
}

/* A change to the document, after every change asked for before it.
 *
 * Settled at its turn: an earlier change still unanswered is reconciled
 * first (settled), and this one is not sent while that is unknown. A change
 * that itself goes unanswered is reconciled here, and the error carries the
 * outcome and says it; it is never sent again. */
function netEdit(op, params, perf) {
  NET.stats.edits++;
  const queuedAt = perfNow();       // PERF-01: its wait for the changes before it
  const run = async () => {
    await settled();
    const before = S.revision;
    try {
      return await send(op, params, undefined, { queuedAt, priority: "change", op: perf });
    } catch (e) {
      if (!e.unanswered) throw e;
      NET.stats.edits_unanswered++;
      S.unverified = { revision: before, doc: S.doc?.doc, requestId: e.requestId };
      globalThis.PDFUI?.syncSaveStatus?.();
      e.outcome = await reconcile();
      e.message = OUTCOME[e.outcome];
      throw e;
    }
  };
  const p = NET.edits.then(run, run);
  NET.edits = p.catch(() => {});
  NET.changes++;
  NET.watch?.();
  NET.edits.then(() => {
    NET.changes--;
    NET.watch?.();
  });
  return p;
}
let toastTimer;
function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = kind), kind === "err" ? 7000 : 3000);
}

// What a page's image is called, as the transport names it: the page's
// appearance version (`look`) is part of the name, so equal names are equal
// pixels and an edit renames exactly the pages it redrew.
const pageKey = (i, dpi) =>
  transport.resourceKey("render_page", { page: i, dpi, v: S.doc?.pages?.[i]?.look });
// Thumbnails are filed under their own, bounded share of the server's cache.
// 36 dpi is already twice the rail's width in pixels on a standard display and
// about its width at 2x, so the density does not change it.
const thumbKey = (i) =>
  transport.resourceKey("render_page", { page: i, dpi: 36, v: S.doc?.pages?.[i]?.look, thumb: true });
const tileKey = (i, dpi, col, row) =>
  transport.resourceKey("render_page", { page: i, dpi, tile: [col, row], v: S.doc?.pages?.[i]?.look });

// Every toolbar handler in this file is bound at the top level, so a single
// exception silently disables everything below the line that threw -- which is
// how a working zoom can look like a missing one. Say so instead.
window.addEventListener("error", (ev) => {
  toast(`Interface error: ${ev.message}`, "err");
});

/* ----------------------------- rendering ----------------------------- */

/* Take a get_document_info answer as the current document.
 *
 * Another document at the same revision number is still another document -- a
 * restarted server opens its file at revision 0 -- so nothing measured against
 * the previous one may be reused. */
function adoptDoc(info) {
  const another = !S.doc || S.doc.doc !== info.doc;
  if (another || S.doc.layout !== info.layout) {
    // Every page's tokens name the layout too, so nothing held under the old
    // one can be asked for again; let it go rather than keep it until
    // overwritten.
    S.selected.clear(); S.selectionAnchor = null; S.selectionFocus = 0;
    S.lines = {};
    S.linesPending = {};
  }
  if (another) {
    S.editorGeneration++;
    // Faces registered for the previous document name objects of IT.
    for (const style of S.fonts.values()) {
      style.remove();
      style.release?.();
    }
    S.fonts.clear();
  }
  S.doc = info;
  S.revision = info.revision;
  globalThis.PDFUI?.revisionChanged?.();
}

function showOps() {
  const n = S.doc.ops;
  $("#editinfo").textContent = n ? `${n} verified edit${n === 1 ? "" : "s"}` : "No edits";
  // The revision may have moved: Undo and Redo describe one revision only.
  syncUndo();
}

async function load() {
  const ticket = (S.loadGeneration = (S.loadGeneration || 0) + 1);
  const documentId = S.doc?.doc;
  const info = await api("get_document_info", {}, { priority: "edit" });
  // Full reloads race with each other and with mutation responses too.
  // Never rebuild the UI from an older revision or a superseded document.
  if (ticket !== S.loadGeneration || S.doc?.doc !== documentId
      || (info.doc === S.doc?.doc && info.revision < S.revision)) return;
  adoptDoc(info);
  $("#docname").textContent = S.doc.name;

  const n = S.doc.pages.length;
  const i = S.doc.info;
  $("#pageinfo").textContent =
    `${n} page${n === 1 ? "" : "s"}` + (i.signed ? ` · ${i.signed} signature(s)` : "");
  showOps();
  globalThis.PDFUI?.documentChanged();
  $("#build").textContent = `build ${BUILD}`;

  $("#warnings").innerHTML = (S.doc.warnings || [])
    .map((w) => `<div class="warn"><span>⚠</span><span>${escapeHtml(w)}</span></div>`)
    .join("");

  // Rebuilt here rather than at startup: the swatches are the document's own
  // palette, which arrives with get_document_info.
  buildMarkGroup();
  drawRail();
  if (S.viewMode !== 'custom') fitPage();
  drawPages();
}

function fitPage() {
  globalThis.PDFUI?.fit();
}

/* ----------------------------- the thumbnail rail -----------------------------
 *
 * One box per page, sized from the page's own proportions (an aspect-ratio
 * set below; see .thumb .shot in style.css), so the rail is its full length
 * from the start -- but a picture
 * only in the boxes within one rail-height of what the rail shows. The rail
 * scrolls on its own, so it keeps its own watch on what is in view rather
 * than borrowing the document's: an IntersectionObserver rooted at the rail.
 */
const RAIL = {
  thumbs: [],           // page i's .thumb element
  mounted: new Set(),   // pages whose thumbnail may hold a picture
  seen: null,           // the observer that decides which those are
};

function drawRail() {
  const rail = $("#rail");
  RAIL.seen?.disconnect();
  for (const i of RAIL.mounted) dropImage(RAIL.thumbs[i].firstChild);
  RAIL.mounted.clear();
  RAIL.thumbs = S.doc.pages.map((p) => {
    const d = document.createElement("div");
    d.className = "thumb" + (S.selected.has(p.index) ? " sel" : "");
    d.dataset.page = p.index;
    d.tabIndex = p.index === S.selectionFocus ? 0 : -1;
    d.setAttribute("role", "option");
    d.setAttribute("aria-selected", String(S.selected.has(p.index)));
    d.setAttribute("aria-label", `Page ${p.index + 1}`);
    const shot = document.createElement("div");
    shot.className = "shot";
    shot.dataset.alt = `Page ${p.index + 1}`;
    shot.style.aspectRatio = `${p.width} / ${p.height}`;
    const no = document.createElement("span");
    no.className = "no";
    no.textContent = p.index + 1;
    d.append(shot, no);
    return d;
  });
  rail.replaceChildren(fragmentOf(RAIL.thumbs));
  // "100%" of the rail's own height above and below it.
  RAIL.seen = new IntersectionObserver(railSeen, { root: rail, rootMargin: "100% 0px" });
  for (const d of RAIL.thumbs) RAIL.seen.observe(d);
}

// One fragment rather than one argument per page: a spread of tens of
// thousands of arguments is past what some engines accept.
function fragmentOf(elements) {
  const frag = document.createDocumentFragment();
  for (const el of elements) frag.appendChild(el);
  return frag;
}

function railSeen(entries) {
  for (const e of entries) {
    const i = Number(e.target.dataset.page);
    if (RAIL.thumbs[i] !== e.target) continue;       // a rail since rebuilt
    if (e.isIntersecting) RAIL.mounted.add(i);
    else if (RAIL.mounted.delete(i)) dropImage(e.target.firstChild);
  }
  railImages();
}

// Every thumbnail in reach shows its page's current version. Asking again for
// what is already shown or on its way is free (showImage), so this is also
// how a failed thumbnail is retried.
function railImages() {
  if (!S.doc) return;
  for (const i of RAIL.mounted) {
    const p = S.doc.pages[i];
    if (p) showImage(RAIL.thumbs[i].firstChild, thumbKey(i), p.look, undefined, "thumb");
  }
}

// Selecting pages changes a class on the thumbnails that changed, not the rail:
// rebuilding it threw away every thumbnail picture to move one outline.
function syncRailSelection() {
  RAIL.thumbs.forEach((d, i) => { d.classList.toggle("sel", S.selected.has(i)); d.tabIndex = i === S.selectionFocus ? 0 : -1; d.setAttribute?.("aria-selected", String(S.selected.has(i))); });
  globalThis.PDFUI?.selectionChanged();
}

// One listener for the whole rail rather than one per thumbnail.
$("#rail").addEventListener("click", (ev) => {
  const d = ev.target.closest(".thumb");
  if (!d || !S.doc) return;
  const i = Number(d.dataset.page);
  S.selectionFocus = i;
  RAIL.thumbs.forEach((t,k) => { t.tabIndex = k === i ? 0 : -1; });
  const additive = ev.metaKey || ev.ctrlKey;
  if (!additive) S.selected.clear();
  if (ev.shiftKey && Number.isInteger(S.selectionAnchor)) {
    for (let k = Math.min(i, S.selectionAnchor); k <= Math.max(i, S.selectionAnchor); k++) S.selected.add(k);
  } else {
    if (additive && S.selected.has(i)) S.selected.delete(i); else S.selected.add(i);
    S.selectionAnchor = i;
  }
  syncRailSelection();
  globalThis.PDFUI?.navigate(i);
});

/* ----------------------------- the pages -----------------------------
 *
 * Every page has a shell: an empty box of its final size, so the document is
 * its true height and scrolling, page navigation and zoom anchoring behave as
 * if everything were there. Only the pages within one screen of the visible
 * ones are MOUNTED -- carry an image and a text layer. A 300-page document
 * used to keep 300 decoded page images alive, and edit mode fetched and drew
 * the text layer of every page in the document the moment it was turned on.
 *
 * Which pages are near the screen comes from the page sizes, not from the DOM:
 * VIEW.tops is where each page's box starts, computed from the same point
 * sizes sizePage() gives the shells, so finding them is a binary search rather
 * than a layout read of every page.
 */
const VIEW = {
  doc: null,            // the S.doc and zoom the index below was built for
  zoom: 0,
  tops: [],             // page i's top edge within #pages, CSS px
  bottoms: [],
  shells: [],           // page i's .page element
  mounted: new Set(),   // pages whose image and text layer are in the DOM
  near: null,           // [first, last] of the pages on screen, as of maintain()
  dir: 0,               // PERF-02: +1 moving down, -1 up, 0 not known yet
  pos: null,            // the reading position dir was last taken from, in pages
  posZoom: 0,           // ...and the zoom it was taken at
};

function drawPages() {
  const host = $("#pages");
  for (const i of [...VIEW.mounted]) unmountPage(i);
  VIEW.shells = S.doc.pages.map((p) => {
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.id = `page-${p.index}`;
    wrap.dataset.alt = `Page ${p.index + 1}`;
    sizePage(wrap, p);
    return wrap;
  });
  host.replaceChildren(fragmentOf(VIEW.shells));
  VIEW.doc = null;
  VIEW.dir = 0;
  VIEW.pos = null;
  maintain();
}

/* The size a page occupies on screen, in CSS pixels at 96 dpi.
 *
 * Both dimensions, from the page's true point size -- so the zoom is exact
 * rather than whatever the image happens to decode to, and, more importantly,
 * so the height is NOT read off the image. A wrapper whose height comes from
 * its <img> reflows the moment a render of a different pixel size is swapped
 * in, and that one-frame reflow is what made zooming look like the page
 * reloading rather than getting sharper.
 */
const cssWidth = (p) => (p.width / 72) * 96 * S.zoom;
const cssHeight = (p) => (p.height / 72) * 96 * S.zoom;

function sizePage(wrap, p) {
  wrap.style.width = `${cssWidth(p)}px`;
  wrap.style.height = `${cssHeight(p)}px`;
}

/* Re-render at a new zoom WITHOUT taking the page off the screen.
 *
 * drawPages() rebuilds #pages from scratch, which throws away every <img> and
 * leaves a frame or two with nothing in them -- the dark well shows through and
 * the document appears to black out and come back on every zoom step. It also
 * discards the text layer, which then has to be fetched again.
 *
 * So: resize the wrappers immediately, which scales the bitmap already on
 * screen and keeps the geometry honest, then fetch the sharper renders. The
 * page is never empty, and the only visible change is a moment of softness
 * resolving into a crisp render.
 */
function zoomPages(settled = false) {
  const host = $("#pages");
  if (!host.children.length) return drawPages();
  for (const p of S.doc.pages) {
    const wrap = VIEW.shells[p.index];
    if (!wrap?.isConnected) return drawPages();   // structure changed under us
    sizePage(wrap, p);
  }
  // Which pages are near the screen is settled on the next frame, after the
  // caller has put the anchor point back where it was (setZoom).
  scheduleMaintain();
  renderVisible(settled ? 0 : 150);
  S.draft?.render();
}

/* Ask the server for sharper pixels, for the pages you can actually see.
 *
 * Every zoom step used to request a new image of every page in the document.
 * On anything longer than a chapter that is a burst of hundreds of renders to
 * show a change to the two pages on screen, and the queue behind it is why a
 * zoom felt like a reload. Only mounted pages hold an image at all now, and
 * they keep the bitmap they have, scaled, until the zoom settles.
 *
 * Debounced, so a burst of clicks or key presses issues one round of renders
 * rather than one per step. A pinch or a ctrl-wheel has already waited for
 * its gesture to stop (pinchZoom's settle), so it asks with no delay: waiting
 * a second time was 150 of the 290 fixed milliseconds between the end of a
 * gesture and a sharp page.
 */
let renderTimer = 0;
function renderVisible(delay = 150) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, delay);
}

function renderNow() {
  renderTimer = 0;
  maintain();
}

/* Where every page's box is, at the current zoom. Rebuilt when the document
 * or the zoom changes; the gap and padding are read from the stylesheet so
 * the two cannot disagree. */
function pageIndex() {
  if (VIEW.doc === S.doc && VIEW.zoom === S.zoom) return VIEW;
  const style = getComputedStyle($("#pages"));
  const gap = parseFloat(style.rowGap) || 0;
  let y = parseFloat(style.paddingTop) || 0;
  VIEW.tops = [];
  VIEW.bottoms = [];
  for (const p of S.doc.pages) {
    VIEW.tops.push(y);
    y += cssHeight(p);
    VIEW.bottoms.push(y);
    y += gap;
  }
  VIEW.doc = S.doc;
  VIEW.zoom = S.zoom;
  return VIEW;
}

// The first page whose box reaches down to `y` (in #pages), or the last page.
function pageAtOrBelow(y) {
  const { bottoms } = pageIndex();
  let lo = 0, hi = bottoms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottoms[mid] < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* How far the laid-out page i sits from where the index puts it, in px.
 *
 * The layout engine stores each box's size in its own unit -- 1/64 px in
 * Chrome, so a 739.2 px page is 739.1875 px -- and over a few hundred pages
 * that adds up to a few pixels. One page's real offset near the view says by
 * how much, which keeps the index exact where it is used. offsetTop is the
 * layout position, unaffected by the pinch preview's transform; it is taken
 * relative to page 0 so whatever the offset is measured from cancels out. */
function layoutDrift(i) {
  const shell = VIEW.shells[i], zero = VIEW.shells[0];
  if (!shell || !zero) return 0;
  const d = (shell.offsetTop - zero.offsetTop) - (VIEW.tops[i] - VIEW.tops[0]);
  return Number.isFinite(d) ? d : 0;
}

/* The pages within `margin` screens of what the stage shows, as [first, last]. */
function pagesNear(margin) {
  const n = S.doc?.pages.length || 0;
  if (!n) return [0, -1];
  const stage = $("#stage");
  const h = Math.max(1, stage.clientHeight);
  const top = stage.scrollTop - margin * h;
  const bottom = stage.scrollTop + h + margin * h;
  const { tops } = pageIndex();
  const drift = layoutDrift(pageAtOrBelow(top));
  const first = pageAtOrBelow(top - drift);
  let last = first;
  while (last + 1 < n && tops[last + 1] + drift <= bottom) last++;
  return [first, last];
}

// The page an editor is open on, if any. It stays mounted wherever the view
// goes: what has been typed into it is not saved anywhere else.
function editorPage() {
  const ed = document.getElementById("editor");
  return ed && ed.dataset.page !== undefined ? Number(ed.dataset.page) : null;
}

/* Bring the mounted pages into line with the view.
 *
 * Mounts the visible pages and one screen either side, unmounts the rest --
 * except a page with an editor open on it and a page a drag is still
 * selecting on -- and makes sure each mounted page shows its current version.
 * While a zoom is still settling, a page keeps the bitmap it has, scaled; the
 * crisp render is asked for when it settles (renderNow). */
function maintain() {
  if (!S.doc || !VIEW.shells.length) return;
  VIEW.near = pagesNear(0);
  trackDirection();
  const [first, last] = pagesNear(1);
  // Asked for in the order they are wanted (equal ranks go in arrival
  // order): the pages on screen, then ahead nearest first, then behind
  // nearest first -- or, with no direction yet, nearest first either side.
  const keep = new Set();
  const [f, l] = VIEW.near;
  for (let i = Math.max(f, first); i <= Math.min(l, last); i++) keep.add(i);
  const below = [], above = [];
  for (let i = Math.max(l + 1, first); i <= last; i++) below.push(i);
  for (let i = Math.min(f - 1, last); i >= first; i--) above.push(i);
  if (VIEW.dir) {
    for (const i of VIEW.dir > 0 ? below : above) keep.add(i);
    for (const i of VIEW.dir > 0 ? above : below) keep.add(i);
  } else {
    for (let k = 0; k < Math.max(below.length, above.length); k++) {
      if (k < below.length) keep.add(below[k]);
      if (k < above.length) keep.add(above[k]);
    }
  }
  const editing = editorPage();
  if (editing !== null) keep.add(editing);
  if (SEL.dragging && SEL.page !== null) keep.add(SEL.page);
  for (const i of [...VIEW.mounted]) if (!keep.has(i)) unmountPage(i);

  const dpi = renderDpi();
  const settling = !!renderTimer;
  for (const i of keep) {
    const wrap = VIEW.shells[i];
    const p = S.doc.pages[i];
    if (!wrap || !p) continue;
    if (!VIEW.mounted.has(i)) mountPage(i);
    paintPage(i, dpi, settling);
  }
}

/* PERF-02: which way the view is moving, from successive reading positions.
 *
 * The position is in pages (page index plus the fraction of it above the
 * middle of the stage), not pixels, so a zoom that keeps its anchor does not
 * read as movement; across a zoom change the direction is simply kept. A
 * maintain() without movement keeps it too: the last direction is the best
 * guess for where the reader goes next (as PDF.js's rendering queue does). */
function trackDirection() {
  const stage = $("#stage");
  const { tops, bottoms } = pageIndex();
  const mid = stage.scrollTop + Math.max(1, stage.clientHeight) / 2;
  const i = pageAtOrBelow(mid);
  const h = bottoms[i] - tops[i];
  const pos = i + (h > 0 ? Math.min(1, Math.max(0, (mid - tops[i]) / h)) : 0);
  if (VIEW.pos !== null && VIEW.posZoom === S.zoom && Math.abs(pos - VIEW.pos) > 1e-3)
    VIEW.dir = pos > VIEW.pos ? 1 : -1;
  VIEW.pos = pos;
  VIEW.posZoom = S.zoom;
}

/* What page i's image and text layer are asked for at (see the request
 * coordinator): a page on screen first; of the pages only within reach of
 * the screen, the side the view is moving towards before the side it is
 * leaving. A reversal re-ranks what is still waiting, because maintain()
 * asks again for every kept page (showImage moves a waiting request). */
function pagePriority(i) {
  const near = VIEW.near;
  if (!near || (i >= near[0] && i <= near[1])) return "visible";
  if (!VIEW.dir) return "adjacent";
  return (i > near[1]) === (VIEW.dir > 0) ? "ahead" : "behind";
}

/* The resolution pages are asked for, in dpi.
 *
 * Enough pixels for the screen they land on. A page is laid out at 96 CSS px
 * per inch times the zoom (cssWidth), and a CSS pixel is devicePixelRatio
 * device pixels, so a sharp page needs 96 * DPR * zoom dpi. VIEW_DPI
 * (Config_PDF.py) is what a page gets at 100% on a standard display, and a
 * floor on any other: max(VIEW_DPI, 96 * DPR). A 2x display used to get the
 * same 100 dpi, about half the pixels it shows, upscaled; a VIEW_DPI already
 * raised by hand for such a display keeps what it asked for. Held to the
 * server's ceiling, so zooming past it does not fetch the same pixels again
 * under a new URL. */
function renderDpi() {
  const r = S.doc?.render || {};
  const floor = Math.max(r.view_dpi || 100, 96 * (S.dpr || 1));
  return Math.max(1, Math.min(r.max_dpi || 600, Math.round(floor * S.zoom)));
}

// A page's render at `dpi`, in pixels, rounded up as the server rounds it.
const renderPx = (p, dpi) =>
  Math.ceil((p.width * dpi) / 72 - 1e-3) * Math.ceil((p.height * dpi) / 72 - 1e-3);

/* Show page i at `dpi`: one image, or -- when the whole page at that dpi
 * would be over the server's pixel ceiling -- a softer whole-page image with
 * sharp tiles over the part of it near the view (paintTiles). The softer one
 * is held to a quarter of the ceiling: it is only what shows until the tiles
 * arrive, and a poster's full allowance is 160 MB decoded.
 *
 * While a zoom is still settling a page keeps what it has, scaled; the sharp
 * render is asked for when it settles. */
function paintPage(i, dpi, settling) {
  const wrap = VIEW.shells[i];
  const p = S.doc.pages[i];
  const max = S.doc.render?.max_pixels;
  const big = !!max && renderPx(p, dpi) > max;
  let base = dpi;
  if (big) {
    base = Math.max(1, Math.floor(dpi * Math.sqrt(max / 4 / renderPx(p, dpi))));
    while (base > 1 && renderPx(p, base) > max / 4) base--;
  }
  const key = pageKey(i, base);
  const shown = wrap.querySelector(":scope > img");
  if (!shown || (shown.dataset.src !== key && (!settling || shown.dataset.look !== p.look))) {
    showImage(wrap, key, p.look, undefined, pagePriority(i));
  }
  if (settling) return;
  if (big) paintTiles(i, dpi);
  else if (wrap.tiles) dropTiles(wrap);
}

/* The tiles of page i at `dpi` that lie within a screen of the view.
 *
 * Tiles are the server's pdf_render.TILE_PX squares of the page's render,
 * counted from its top-left corner, each an image in its own box placed in
 * percentages of the page -- so, like the text layer, they follow any zoom
 * without being placed again, and scale with the pinch preview. They sit
 * over the page's own softer image, which shows through until each arrives.
 *
 * Tiles scrolled away from go at once. Tiles of another resolution or
 * version stay until every tile wanted now has arrived (sweepTiles): taking
 * them down sooner shows the soft image for a moment on every zoom step. */
function paintTiles(i, dpi) {
  const wrap = VIEW.shells[i];
  const p = S.doc.pages[i];
  const T = S.doc.render.tile;
  const W = Math.ceil((p.width * dpi) / 72 - 1e-3);
  const H = Math.ceil((p.height * dpi) / 72 - 1e-3);
  const stage = $("#stage");
  const s = stage.getBoundingClientRect();
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const kx = W / r.width, ky = H / r.height;       // render px per CSS px
  const x0 = Math.max(0, (s.left - r.left) * kx), x1 = Math.min(W, (s.right - r.left) * kx);
  const y0 = Math.max(0, (s.top - s.height - r.top) * ky);
  const y1 = Math.min(H, (s.bottom + s.height - r.top) * ky);
  let box = wrap.tiles;
  if (!box) {
    box = wrap.tiles = document.createElement("div");
    box.className = "tiles";
    box.held = new Map();                          // image key -> tile box
    // Under the text layer, which has to keep the pointer.
    const layer = wrap.querySelector(":scope > .tlayer");
    if (layer) wrap.insertBefore(box, layer); else wrap.append(box);
  }
  const generation = `${dpi}:${p.look}`;
  if (box.generation !== generation) {
    // Keep only the last requested resolution as a temporary backdrop.
    // Pending older generations must not accumulate during repeated zooms.
    for (const [key, cell] of box.held) {
      if (cell.generation !== box.generation || cell.look !== p.look
          || !cell.querySelector(":scope > img")) {
        dropImage(cell);
        cell.remove();
        box.held.delete(key);
      }
    }
    box.generation = generation;
  }
  const want = new Set();
  const priority = pagePriority(i);
  if (x1 > x0 && y1 > y0) {
    for (let row = Math.floor(y0 / T); row * T < y1; row++) {
      for (let col = Math.floor(x0 / T); col * T < x1; col++) {
        const key = tileKey(i, dpi, col, row);
        want.add(key);
        if (box.held.has(key)) {
          // A held cell can still be empty after a failed request.
          showImage(box.held.get(key), key, p.look, () => sweepTiles(box), priority);
          continue;
        }
        const cell = document.createElement("div");
        cell.className = "tile";
        cell.generation = generation;
        cell.look = p.look;
        cell.dataset.alt = "";
        const tw = Math.min(T, W - col * T), th = Math.min(T, H - row * T);
        cell.style.left = `${((col * T) / W) * 100}%`;
        cell.style.top = `${((row * T) / H) * 100}%`;
        cell.style.width = `${(tw / W) * 100}%`;
        cell.style.height = `${(th / H) * 100}%`;
        box.append(cell);
        box.held.set(key, cell);
        showImage(cell, key, p.look, () => sweepTiles(box), priority);
      }
    }
  }
  box.want = want;
  for (const [key, cell] of box.held) {
    // Same resolution and version, just out of reach: not needed to cover
    // anything while the others load.
    if (!want.has(key) && cell.generation === generation) {
      dropImage(cell);
      cell.remove();
      box.held.delete(key);
    }
  }
  sweepTiles(box);
}

// Once every wanted tile shows its image, the ones left over go.
function sweepTiles(box) {
  const want = box.want || new Set();
  for (const key of want) {
    if (box.held.get(key)?.querySelector(":scope > img")?.dataset.src !== key) return;
  }
  for (const [key, cell] of box.held) {
    if (want.has(key)) continue;
    dropImage(cell);
    cell.remove();
    box.held.delete(key);
  }
}

function dropTiles(wrap) {
  const box = wrap.tiles;
  if (!box) return;
  for (const cell of box.held.values()) dropImage(cell);
  box.held.clear();
  box.remove();
  wrap.tiles = null;
}

// Once per frame, however many scroll events arrive in it.
let maintainFrame = 0;
function scheduleMaintain() {
  if (maintainFrame) return;
  maintainFrame = requestAnimationFrame(() => {
    maintainFrame = 0;
    maintain();
  });
}

function mountPage(i) {
  const wrap = VIEW.shells[i];
  const layer = document.createElement("div");
  layer.className = "tlayer" + (S.editOn ? " on" : "");
  layer.dataset.page = i;
  // First, so an editor already open on this page stays on top of it; the
  // image goes in front of both (showImage).
  wrap.prepend(layer);
  VIEW.mounted.add(i);
  // Only in edit mode: the run boxes are the edit affordance. Selecting needs
  // nothing from this layer but the pointer, and gets its characters from
  // the page's lines (get_page_lines) instead.
  if (S.editOn) drawTextSoon();
  if (SEL.page === i && SEL.range) drawSelection();
  globalThis.PDFUI?.paintSearch?.(i);
}

/* The run boxes of pages mounted while scrolling, once the view has held
 * still for a moment. A jump or a fast scroll mounts and unmounts pages on
 * every frame it passes through, and a text layer, unlike an image, cannot be
 * called back once asked for -- so it is asked for the pages the view stops
 * on, not every page it went past. */
let overlayTimer = 0;
function drawTextSoon() {
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => {
    for (const i of VIEW.mounted) drawText(i);
  }, 120);
}

/* Take a page's image and text layer out of the document, and with them
 * everything they hold: the decoded bitmap, a render still on its way (which
 * is cancelled, not left to land), the run boxes, their click handlers and
 * the text-layer answer those handlers close over. An editor open on the page
 * is not touched -- maintain() never unmounts that page anyway. */
function unmountPage(i) {
  VIEW.mounted.delete(i);
  const wrap = VIEW.shells[i];
  if (!wrap) return;
  dropImage(wrap);
  dropTiles(wrap);
  wrap.querySelector(":scope > .search-layer")?.remove();
  const layer = wrap.querySelector(":scope > .tlayer");
  if (layer) {
    layer.ticket = (layer.ticket || 0) + 1;   // a drawText in flight draws nothing
    layer.abort?.abort();                     // ...and one not yet sent is not sent
    layer.remove();
  }
}

/* Put a render on screen in `host` -- a page shell or a thumbnail frame --
 * without it ever being empty or blinking. `key` is the render's name as the
 * transport gave it (pageKey); it is what dataset.src records.
 *
 * Decoded before it is placed, not merely loaded: `load` fires when the bytes
 * have arrived, which can be a frame or two before the bitmap is ready to
 * paint, and that gap is a flash of nothing where the page was.
 *
 * Only a render that actually arrived is ever recorded as shown. One that
 * failed -- most often a 410 because the page was edited while it was in
 * flight -- leaves nothing behind that would make asking again look like a
 * repeat: the viewer catches up with the document's versions (resync) and
 * asks again after a pause that doubles with every failure of the same key.
 * One that was cancelled because its page left the view is simply forgotten,
 * and asked for afresh if the page comes back.
 *
 * The image is asked for through the request coordinator, at `priority`: it
 * waits there until a raster slot is free, and only then is its name turned
 * into something loadable (transport.openResource) and given to the <img>.
 * Whatever the transport holds for it is let go with the element (letGo).
 * Asking again for what is already waiting moves it to the new priority.
 */
function showImage(host, key, look, onPlaced, priority = "visible") {
  const shown = host.querySelector(":scope > img");
  if (shown?.dataset.src === key) return;
  if (host.loading?.key === key) return netPriority(host.loading.net, priority);
  if (host.failed?.key === key && performance.now() < host.failed.until) return;
  dropLoading(host);
  const next = new Image();
  next.alt = host.dataset.alt || "";
  next.dataset.src = key;
  next.dataset.look = look || "";
  const job = (host.loading = { key, img: next, ctl: new AbortController() });
  const timing = perfImage(key, look, priority);        // PERF-01
  // An answer to a request the host has since moved on from: not shown, not
  // treated as a failure, and its bitmap let go.
  const discard = () => {
    NET.stats.discarded++;
    perfImageDone(timing, "discarded");
    letGo(next);
  };
  // A newer request may have started while this was loading; the host's
  // current request is the authority, not the order the loads finish in.
  const place = () => {
    if (host.loading !== job) return discard();
    host.loading = null;
    host.failed = null;
    const current = host.querySelector(":scope > img");
    if (current) {
      current.replaceWith(next);
      releaseSource(current);
    } else host.prepend(next);
    perfImageDone(timing, "shown");
    onPlaced?.();
  };
  const failed = () => {
    if (host.loading !== job) return discard();
    host.loading = null;
    perfImageDone(timing, "failed");
    letGo(next);
    const tries = host.failed?.key === key ? host.failed.tries + 1 : 1;
    const pause = Math.min(8000, 250 * 2 ** tries);
    host.failed = { key, tries, until: performance.now() + pause };
    resync();
    setTimeout(retryImages, pause + 20);
  };
  const decoded = (source) => {
    next.release = source.release;
    next.src = source.url;
    return next.decode ? next.decode()
      : new Promise((ok, no) => { next.onload = ok; next.onerror = no; });
  };
  // Settles once the image has arrived (or failed) -- which is when its
  // raster slot is free again. Over HTTP the source is there at once, so the
  // <img> is given its URL in the same turn the slot is taken.
  job.net = netQueue({ raster: true, priority, go: () => {
    let loaded;
    perfImageAt(timing, "sent");
    if (typeof next.addEventListener === "function")
      next.addEventListener("load", () => perfImageAt(timing, "load"), { once: true });
    try {
      const opened = transport.openResource(key, { signal: job.ctl.signal });
      loaded = typeof opened?.then === "function" ? opened.then(decoded) : decoded(opened);
    } catch (e) {
      loaded = Promise.reject(e);
    }
    return loaded.then(() => { perfImageAt(timing, "decoded"); place(); },
                       () => { if (next.naturalWidth) place(); else failed(); });
  } });
}

/* Stop wanting the render on its way to `host`. Still waiting to be sent: it
 * never will be. Already sent: the server is drawing it regardless, so it is
 * left to arrive -- holding its raster slot until then -- and is dropped
 * unseen when it does (showImage's discard); a transport that can still
 * withdraw it is told to, and the slot is free once it has. Either way no
 * resync: this is not a failure. */
function dropLoading(host) {
  const job = host.loading;
  host.loading = null;
  if (!job || netCancel(job.net)) return;
  if (job.net.state === "running" && transport.withdraws) job.ctl.abort();
}

// Cancel what is on its way and take down what is shown.
function dropImage(host) {
  dropLoading(host);
  const shown = host.querySelector(":scope > img");
  if (shown) {
    letGo(shown);
    shown.remove();
  }
}

// Whatever the transport holds for an image that is no longer shown (an
// object URL, say) goes with it. Over HTTP there is nothing.
function releaseSource(img) {
  const free = img.release;
  img.release = null;
  free?.();
}

// An image's bitmap, and what the transport holds for it, let go.
function letGo(img) {
  img.removeAttribute("src");
  releaseSource(img);
}

// After a failure has waited out its pause: every mounted page and thumbnail
// asks again for whatever it is missing.
function retryImages() {
  maintain();
  railImages();
}

/* The run boxes of one MOUNTED page. A page that is not mounted has no layer
 * to draw into and asks for nothing; it gets its boxes when it is scrolled
 * to (mountPage). */
async function drawText(pageIndex) {
  const layer = document.querySelector(`.tlayer[data-page="${pageIndex}"]`);
  // Keyed by the page's geometry version: a mark, which moves no characters,
  // leaves the overlay that is already drawn standing.
  const asked = S.doc?.pages?.[pageIndex]?.geo;
  if (!S.editOn || !layer || !asked || layer.dataset.loaded === asked) return;
  // Labelled with the version it was ASKED for, not whatever the page's token
  // says when it lands -- the same late read as E12 -- and only the newest
  // request for this layer may draw it. Edit mode turned off, or the page
  // unmounted, while it was in flight: nothing is drawn.
  const documentId = S.doc.doc;
  const ticket = (layer.ticket = (layer.ticket || 0) + 1);
  layer.abort?.abort();
  const ctl = (layer.abort = new AbortController());
  let geo;
  try {
    geo = await api("get_page_text", { page: pageIndex, v: asked },
                    { priority: pagePriority(pageIndex), signal: ctl.signal });
  } catch { return; }
  if (layer.ticket !== ticket || S.doc.pages[pageIndex]?.geo !== asked || !S.editOn
      || S.doc.doc !== documentId || geo.geo !== asked || !layer.isConnected) return;
  layer.dataset.loaded = asked;
  layer.dataset.geo = geo.geo;
  layer.innerHTML = "";
  // Percentages, so the overlay tracks the image at any zoom without redraw.
  geo.spans.forEach((sp) => {
    const [x0, y0, x1, y1] = sp.bbox;
    const el = document.createElement("div");
    el.className = "tspan";
    el.style.left = `${(x0 / geo.width) * 100}%`;
    el.style.top = `${(y0 / geo.height) * 100}%`;
    el.style.width = `${((x1 - x0) / geo.width) * 100}%`;
    el.style.height = `${((y1 - y0) / geo.height) * 100}%`;
    el.title = `${sp.text}\nfont: ${sp.font} · ${sp.size}pt`;
    // Click position matters, not just which span: the server locates the
    // exact show operator under the point, and one span can hold several.
    el.onclick = (ev) => {
      // CSS already withholds the pointer from these boxes outside edit mode,
      // but the boxes outlive the mode -- drawText caches by version -- so the
      // handler says so itself rather than relying on a stylesheet to. While
      // a formula is being boxed for replacement, a press is that box's.
      if (!S.editOn || FX.on) return;
      ev.stopPropagation();
      const r = el.getBoundingClientRect();
      // Clamp into the span. A pointer event can arrive without usable
      // coordinates -- a keyboard-triggered click, or a synthetic one, reports
      // 0,0 -- and mapping that through the rect lands far off the page, which
      // the server then correctly reports as "no text there". Falling back to
      // the middle of the thing that was clicked is always the right answer.
      const frac = (v, lo, size) =>
        size > 0 ? Math.min(1, Math.max(0, (v - lo) / size)) : 0.5;
      const fx = ev.clientX || ev.clientY ? frac(ev.clientX, r.left, r.width) : 0.5;
      const fy = ev.clientX || ev.clientY ? frac(ev.clientY, r.top, r.height) : 0.5;
      openEditor(pageIndex, x0 + fx * (x1 - x0), y0 + fy * (y1 - y0), el);
    };
    layer.appendChild(el);
  });
  // Formula blocks (8D.6): their formulas are vectors, which no text trace
  // finds, so the block's own box is what a click on them lands on. It opens
  // the whole block with its saved source.
  (geo.blocks || []).filter((b) => b.valid && b.mode === "latex" && b.box).forEach((b) => {
    const [x0, y0, x1, y1] = b.box;
    const el = document.createElement("div");
    el.className = "tblock";
    el.dataset.block = b.id;
    el.style.left = `${(x0 / geo.width) * 100}%`;
    el.style.top = `${(y0 / geo.height) * 100}%`;
    el.style.width = `${((x1 - x0) / geo.width) * 100}%`;
    el.style.height = `${((y1 - y0) / geo.height) * 100}%`;
    el.title = "Formula block: click to edit its LaTeX source";
    el.onclick = (ev) => {
      if (!S.editOn || FX.on) return;
      ev.stopPropagation();
      openEditor(pageIndex, (x0 + x1) / 2, (y0 + y1) / 2, el);
    };
    layer.appendChild(el);
  });
}

/* ----------------------------- selecting text -----------------------------
 *
 * Preview's model, and it is the right one: drag across words, then say what to
 * do with them. Not a rubber-band box -- a box across two lines of a paragraph
 * would take the right-hand half of the first and the left-hand half of the
 * second, which is never what "from here to there" means.
 *
 * The reading order comes from the server, which gets it from MuPDF's layout
 * analysis. Deriving it in the browser from the boxes alone is the one thing
 * that must not be done here: it works on this page and fails on the next one
 * with two columns, where "the line at this height" is two different lines.
 */
const SEL = {
  generation: 0,
  page: null,      // page index the drag started on
  from: null,      // {x, y} in page points
  to: null,
  dragging: false,
  dragged: false,  // suppress the click that ends a drag
  chars: null,     // the flattened characters of SEL.page
  range: null,     // [first, last] indices into SEL.chars
};

async function pageChars(index) {
  // Filed under the page's geometry version, which only edits that move its
  // characters change: after a highlight -- on this page or any other -- the
  // characters already held are still the page's characters.
  const asked = S.doc?.pages?.[index]?.geo;
  const document = S.doc?.doc;
  const held = S.lines[index];
  if (held && held.document === document && held.geo === asked) {
    keepChars(index);
    return held.chars;
  }
  // A drag, a double-click and the style probe can all ask for the same page
  // in the same moment; they share one request rather than making three.
  const inflight = S.linesPending[index];
  if (inflight && inflight.document === document && inflight.geo === asked) return inflight.promise;

  // A gesture is waiting on them: asked for ahead of any image.
  const promise = api("get_page_lines", { page: index, v: asked || "" },
                      { priority: "edit" }).then((data) => {
    if (S.doc?.doc !== document || S.doc?.pages?.[index]?.geo !== asked
        || (asked && data.geo !== asked)) {
      throw new Error("Geometry request superseded; select again.");
    }
    // Flattened once, in reading order, with the line each character belongs
    // to. A selection is a contiguous run of this list; the line number is what
    // turns that run back into one rectangle per line, which is what a mark
    // wants.
    const chars = [];
    data.lines.forEach((line, li) =>
      line.chars.forEach((c) =>
        chars.push({ c: c.c, line: li, x0: c.bbox[0], y0: c.bbox[1],
                     x1: c.bbox[2], y1: c.bbox[3] })));
    // The token a mark made from these characters sends back.
    chars.geo = data.geo;
    // Filed under the version it was requested at. Filed under whatever was
    // current on arrival, a response that landed after an edit was cached as
    // the page after the edit and trusted by the next call (E12).
    S.lines[index] = { document, geo: asked, chars };
    keepChars(index);
    return chars;
  }).finally(() => {
    if (S.linesPending[index]?.promise === promise) delete S.linesPending[index];
  });
  S.linesPending[index] = { document, geo: asked, promise };
  return promise;
}

/* Selection characters are kept for a few pages, not for every page selected
 * on. A dense page is ~14,000 characters, each an object, and a session that
 * selects its way through a long document used to keep every one of them.
 *
 * Least recently used goes first, once more than CHARS_PAGES pages or
 * CHARS_HELD characters are held, whichever comes first -- except the page
 * being used right now and the page the active selection is on, which a
 * gesture or the mark toolbar still needs. A page that is over the limit on
 * its own is therefore kept while it is in use, and let go when the selection
 * ends (clearSelection). What is let go is only ever asked for again. */
const CHARS_PAGES = 8;
const CHARS_HELD = 100000;
let charsClock = 0;

function keepChars(index) {
  const held = S.lines[index];
  if (held) held.used = ++charsClock;
  trimChars(index);
}

function trimChars(inUse) {
  const pinned = new Set([inUse, SEL.page]);
  const held = Object.entries(S.lines).sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
  let pages = held.length;
  let chars = held.reduce((n, [, e]) => n + e.chars.length, 0);
  for (const [k, e] of held) {
    if (pages <= CHARS_PAGES && chars <= CHARS_HELD) break;
    if (pinned.has(Number(k))) continue;
    delete S.lines[k];
    pages--;
    chars -= e.chars.length;
  }
}

/* The character at a point, or the nearest one on the nearest line.
 *
 * Two stages on purpose. Vertical first, because a point in the gutter between
 * two columns is unambiguous about which line it is level with and hopeless
 * about which character; then horizontal within that line, so dragging past the
 * end of a line selects to the end of it rather than jumping to whatever
 * happens to be geometrically closest on the line below. */
function charAt(chars, x, y) {
  if (!chars.length) return -1;
  let best = -1, bestGap = Infinity;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const dy = y < c.y0 ? c.y0 - y : y > c.y1 ? y - c.y1 : 0;
    const dx = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
    // Vertical distance dominates; horizontal only separates ties on a line.
    const gap = dy * 1000 + dx;
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  return best;
}

function selectionRects(chars, range) {
  if (!range) return [];
  const [a, b] = range;
  const byLine = new Map();
  for (let i = a; i <= b; i++) {
    const c = chars[i];
    const r = byLine.get(c.line);
    if (!r) byLine.set(c.line, [c.x0, c.y0, c.x1, c.y1]);
    else {
      r[0] = Math.min(r[0], c.x0); r[1] = Math.min(r[1], c.y0);
      r[2] = Math.max(r[2], c.x1); r[3] = Math.max(r[3], c.y1);
    }
  }
  return [...byLine.values()];
}

function selectionText(chars, range) {
  if (!range) return "";
  const [a, b] = range;
  let out = "", line = chars[a].line;
  for (let i = a; i <= b; i++) {
    if (chars[i].line !== line) { out += " "; line = chars[i].line; }
    out += chars[i].c;
  }
  return out;
}

function drawSelection() {
  document.querySelectorAll(".selband").forEach((el) => el.remove());
  syncMarkGroup();
  if (SEL.page === null || !SEL.range) return;
  const layer = document.querySelector(`.tlayer[data-page="${SEL.page}"]`);
  const page = S.doc.pages.find((p) => p.index === SEL.page);
  if (!layer || !page) return;
  for (const [x0, y0, x1, y1] of selectionRects(SEL.chars, SEL.range)) {
    const el = document.createElement("div");
    el.className = "selband";
    el.style.left = `${(x0 / page.width) * 100}%`;
    el.style.top = `${(y0 / page.height) * 100}%`;
    el.style.width = `${((x1 - x0) / page.width) * 100}%`;
    el.style.height = `${((y1 - y0) / page.height) * 100}%`;
    layer.appendChild(el);
  }
}

function clearSelection() {
  SEL.generation++;
  SEL.page = null; SEL.range = null; SEL.chars = null;
  document.querySelectorAll(".selband").forEach((el) => el.remove());
  syncMarkGroup();
  // The selection no longer pins its page's characters; see trimChars.
  trimChars();
}

/* Where a pointer event landed, in the page's own points.
 *
 * `onPage` keeps a drag alive once the pointer wanders off the paper -- into
 * the margin, past the last line, over the grey well. Without it the selection
 * freezes at the page edge, which is exactly where you are when you drag to the
 * end of a paragraph. The point is clamped onto the page instead, which is what
 * every text selection does. */
function pagePoint(ev, onPage) {
  const wrap = onPage === undefined
    ? ev.target.closest?.(".page")
    : document.getElementById(`page-${onPage}`);
  if (!wrap) return null;
  const index = Number(wrap.id.replace("page-", ""));
  const page = S.doc?.pages.find((p) => p.index === index);
  if (!page) return null;
  const r = wrap.getBoundingClientRect();
  if (!r.width) return null;
  const scale = page.width / r.width;
  const x = (ev.clientX - r.left) * scale;
  const y = (ev.clientY - r.top) * scale;
  if (onPage === undefined) return { index, x, y };
  return {
    index,
    x: Math.min(page.width, Math.max(0, x)),
    y: Math.min(page.height, Math.max(0, y)),
  };
}

document.addEventListener("pointerdown", (ev) => {
  // No mode test. Selecting text is not editing it, and gating this on Edit
  // Text is what made highlighting look like a feature the tool did not have.
  if (!S.doc || ev.button !== 0) return;
  if (ev.target.closest("#editor")) return;
  // A press on the chrome is not a press on the document. This matters more
  // now that the mark controls live in the toolbar: without it, pressing one
  // of them cleared the selection on pointerdown and syncMarkGroup disabled
  // the button before its own click could land, so the toolbar's mark buttons
  // could not be used at all.
  if (!ev.target.closest("#stage")) return;
  const pt = pagePoint(ev);
  clearSelection();
  if (!pt) return;
  SEL.page = pt.index; SEL.from = pt; SEL.to = pt;
  SEL.dragging = true; SEL.dragged = false;
  const gesture = SEL.generation;
  const documentId = S.doc.doc;
  pageChars(pt.index).then((chars) => {
    if (SEL.generation !== gesture || SEL.page !== pt.index || S.doc.doc !== documentId) return;
    SEL.chars = chars;
    // The first drag on a page arrives before its geometry does. Catching up
    // here is what stops that one gesture feeling like nothing is happening.
    if (SEL.dragging && SEL.dragged) updateSelection(SEL.to);
  }).catch(() => {});
});

function updateSelection(pt) {
  const a = charAt(SEL.chars, SEL.from.x, SEL.from.y);
  const b = charAt(SEL.chars, pt.x, pt.y);
  SEL.range = a < 0 || b < 0 ? null : [Math.min(a, b), Math.max(a, b)];
  drawSelection();
}

let selFrame = 0;          // the frame a drag's next redraw is waiting for
document.addEventListener("pointermove", (ev) => {
  if (!SEL.dragging) return;
  const pt = pagePoint(ev, SEL.page);
  if (!pt) return;
  // A few points of slop, so a click that wobbles is still a click and still
  // opens the editor rather than selecting one letter.
  if (!SEL.dragged &&
      Math.hypot(pt.x - SEL.from.x, pt.y - SEL.from.y) < 3) return;
  SEL.dragged = true;
  SEL.to = pt;
  ev.preventDefault();
  // Redrawn once per frame, for wherever the pointer is by then: a mouse that
  // reports faster than the display refreshes would otherwise redraw the
  // bands several times for one frame that only ever shows the last.
  if (SEL.chars && !selFrame) {
    const gesture = SEL.generation;
    selFrame = requestAnimationFrame(() => {
      selFrame = 0;
      if (SEL.generation === gesture && SEL.dragging && SEL.chars) updateSelection(SEL.to);
    });
  }
});

document.addEventListener("pointerup", () => {
  if (!SEL.dragging) return;
  SEL.dragging = false;
  // A move whose frame has not come yet still counts: the selection ends
  // where the pointer was released.
  if (selFrame) {
    cancelAnimationFrame(selFrame);
    selFrame = 0;
    if (SEL.chars) updateSelection(SEL.to);
  }
  if (SEL.dragged && SEL.range) finishSelection();
  else clearSelection();
});

/* Double-click selects a word, triple-click its line.
 *
 * Dragging was the only way to select anything, which is the right gesture for
 * a phrase and the wrong one for a word. Every other thing that shows text lets
 * you double-click it, so its absence does not read as a missing shortcut -- it
 * reads as selection being broken, which is exactly how it was reported.
 *
 * The two clicks that precede this each cleared the selection on their own
 * pointerdown, so there is nothing to preserve here and nothing to fight.
 */
document.addEventListener("dblclick", async (ev) => {
  if (!S.doc || ev.target.closest("#editor")) return;
  const pt = pagePoint(ev);
  if (!pt) return;
  ev.preventDefault();

  const gesture = SEL.generation;
  const documentId = S.doc.doc;
  let chars;
  try {
    chars = await pageChars(pt.index);
    if (SEL.generation !== gesture || S.doc.doc !== documentId) return;
  } catch {
    return;
  }
  const i = charAt(chars, pt.x, pt.y);
  if (i < 0) return;

  SEL.page = pt.index;
  SEL.chars = chars;
  SEL.from = SEL.to = pt;
  // ev.detail counts the clicks in the streak, so the third one arrives here
  // as a dblclick with detail 3 rather than as an event of its own.
  SEL.range = ev.detail >= 3 ? lineRange(chars, i) : wordRange(chars, i);
  drawSelection();
  if (SEL.range) finishSelection();
});

// Word boundaries are whitespace, and the line the character sits on -- a run
// of characters that touches the end of one line and the start of the next is
// two words that happen to be adjacent in reading order, not one.
function wordRange(chars, i) {
  if (!chars[i] || /\s/.test(chars[i].c)) return [i, i];
  const line = chars[i].line;
  let a = i, b = i;
  while (a > 0 && chars[a - 1].line === line && !/\s/.test(chars[a - 1].c)) a--;
  while (b < chars.length - 1 && chars[b + 1].line === line
         && !/\s/.test(chars[b + 1].c)) b++;
  return [a, b];
}

function lineRange(chars, i) {
  if (!chars[i]) return null;
  const line = chars[i].line;
  let a = i, b = i;
  while (a > 0 && chars[a - 1].line === line) a--;
  while (b < chars.length - 1 && chars[b + 1].line === line) b++;
  return [a, b];
}

// The click that ends a drag would otherwise land on whatever span the pointer
// finished over and open the editor on top of the selection just made.
document.addEventListener("click", (ev) => {
  if (!SEL.dragged) return;
  // Only the click that ends the drag, which lands on the document. A click on
  // the toolbar is somebody reaching for what they just selected.
  if (!ev.target.closest("#stage")) return;
  SEL.dragged = false;
  ev.stopPropagation();
  ev.preventDefault();
}, true);

/* ----------------------------- marking it up ----------------------------- */

/* The marks that get a button of their own.
 *
 * Highlight is not among them and needs no button: it is what the colour
 * swatches do. A line drawn under or through text is a different thing -- it
 * takes a colour you read AGAINST rather than through, which Config_PDF.py
 * chooses (UNDERLINE_COLOR, STRIKEOUT_COLOR), so there is nothing to pick.
 */
const MARKUP = { active: null, busy: false, doc: null };
function setActiveMarkup(kind) {
  MARKUP.active = kind ? {kind, color:null} : null;
  syncMarkGroup();
}

const MARKS = [
  ["Underline", "Underline", "M4 15.5h12V17H4zM5.5 3h1.8v6.1a2.7 2.7 0 0 0 5.4 0V3h1.8v6.1a4.5 4.5 0 0 1-9 0z"],
  ["StrikeOut", "Strikethrough", "M3 9.3h14v1.6H3zM10 3c2.6 0 4.2 1.2 4.5 3.1h-1.9C12.3 5.2 11.4 4.6 10 4.6c-1.6 0-2.6.7-2.6 1.7 0 .7.4 1.2 1.4 1.6H6.2A2.7 2.7 0 0 1 5.6 6C5.6 4.2 7.3 3 10 3zm3 9.4c0 2-1.7 3.2-4.2 3.2-2.7 0-4.4-1.3-4.6-3.4h1.9c.2 1.2 1.2 1.9 2.8 1.9 1.6 0 2.5-.6 2.5-1.6 0-.6-.3-1-1-1.4h2.1c.3.4.5.8.5 1.3z"],
];

/* Everything you can do to selected words, in the toolbar, beside Edit Text.
 *
 * Persistent controls remain discoverable before selection. The optional
 * viewerSelectionActions popup is an additional entry point to the same
 * handlers; it never replaces these toolbar controls or owns mutation state.
 *
 * Colour swatches ARE the highlight control: clicking one highlights the
 * selection in it, there and then. Arming a colour and then pressing a
 * separate button is two gestures for one intention, and the second one was
 * the one people forgot. Clicking the same colour over the same words again
 * takes the highlight off -- see annot.mark.
 *
 * Built here rather than written into index.html so the palette comes from the
 * document (Config_PDF.py's MARK_COLORS) and the icons have one definition.
 */
function buildMarkGroup() {
  const host = $("#markgroup");
  if (!host) return;
  if (MARKUP.doc !== S.doc?.doc) { MARKUP.active = null; MARKUP.doc = S.doc?.doc; }
  const palette = (S.doc && S.doc.palette) || [];
  host.innerHTML = `
    <label class="repeat-mark-label">After selection
      <select id="repeat-mark" aria-label="Repeat markup after each selection">
        <option value="">Select only</option><option value="Highlight">Highlight</option><option value="Underline">Underline</option>
      </select>
    </label>
    <select id="repeat-mark-color" aria-label="Repeated highlight color">
      ${palette.map((c,i) => `<option value="${i}">Color ${i + 1}</option>`).join('')}
    </select>
    <span id="repeat-mark-status" role="status"></span>
    ${palette.map((c, i) =>
      `<button class="tbtn mswatch" data-color="${i}" disabled
               style="background:${rgb(c)}"></button>`).join("")}
    ${MARKS.map(([kind, label, path]) =>
      `<button class="tbtn" data-kind="${kind}" disabled>
         <svg viewBox="0 0 20 20"><path d="${path}"/></svg>
       </button>`).join("")}
    <span class="tsep"></span>
    <button class="tbtn" data-act="copy" disabled>Copy</button>`;
  // Text styling changes the content, so it lives with the Edit tools (UI-01).
  const styles = `
    <button class="tbtn" data-style="bold" disabled><b>B</b></button>
    <button class="tbtn" data-style="italic" disabled><i>I</i></button>
    ${TEXT_COLORS.map(([c]) =>
      `<button class="tbtn mtswatch" data-tcolor="${c.join(",")}" disabled
               style="background:${rgb(c)}"></button>`).join("")}`;
  const styleHost = $("#stylegroup");
  if (styleHost) styleHost.innerHTML = styles; else host.insertAdjacentHTML("beforeend", styles);

  host.querySelector('#repeat-mark').onchange = async ev => {
    const kind = ev.target.value; // Other mode handlers may redraw this select.
    if (kind && editorOpen() && !(await requestEditorTransition("markup"))) { syncMarkGroup(); return; }
    if (kind) {
      if (S.editOn) document.getElementById('text-toggle').click();
      formulaMode(false);
    }
    setActiveMarkup(kind);
    if (MARKUP.active) MARKUP.active.color = MARKUP.active.kind === 'Highlight' ? palette[0] : null;
    syncMarkGroup();
  };
  host.querySelector('#repeat-mark-color').onchange = ev => {
    if (MARKUP.active?.kind === 'Highlight') MARKUP.active.color = palette[Number(ev.target.value)];
  };
  host.querySelectorAll("[data-color]").forEach((el) => {
    el.onclick = () => applyMark("Highlight", palette[Number(el.dataset.color)]);
  });
  host.querySelectorAll("[data-kind]").forEach((el) => {
    el.onclick = () => applyMark(el.dataset.kind);
  });
  markControls("[data-style]").forEach((el) => {
    el.onclick = () => applyStyle({ [el.dataset.style]: true });
  });
  markControls("[data-tcolor]").forEach((el) => {
    el.onclick = () =>
      applyStyle({ color: el.dataset.tcolor.split(",").map(Number) });
  });
  host.querySelector('[data-act="copy"]').onclick = copySelection;
  syncMarkGroup();
}

// The selection's controls: markup (Annotate) and text styling (Edit).
const markControls = (sel) => document.querySelectorAll(`#markgroup ${sel}, #stylegroup ${sel}`);

// Called wherever the selection changes, so the toolbar agrees with the page.
function syncMarkGroup() {
  globalThis.PDFSelectionActions?.sync();
  const host = $("#markgroup");
  if (!host) return;
  const live = SEL.page !== null && !!SEL.range;
  const say = (el, when, without) => { el.title = live ? when : without; };

  markControls("button").forEach((el) => { el.disabled = !live || MARKUP.busy; });
  const repeat = host.querySelector('#repeat-mark');
  if (repeat) {
    repeat.value = MARKUP.active?.kind || '';
    repeat.disabled = MARKUP.busy;
    const color = host.querySelector('#repeat-mark-color');
    color.hidden = MARKUP.active?.kind !== 'Highlight'; color.disabled = MARKUP.busy;
    const index = S.doc?.palette?.findIndex(c => c.join(',') === MARKUP.active?.color?.join(','));
    color.value = String(index >= 0 ? index : 0);
    host.querySelector('#repeat-mark-status').textContent = MARKUP.busy ? 'Applying mark…' : MARKUP.active ? `${MARKUP.active.kind} armed · Esc stops` : '';
  }
  host.querySelectorAll("[data-color]").forEach((el) =>
    say(el, "Highlight in this colour — the same colour over the same words removes it",
        "Highlight — select some text on the page first"));
  host.querySelectorAll("[data-kind]").forEach((el) => {
    const label = MARKS.find(([k]) => k === el.dataset.kind)?.[1] || "";
    say(el, `${label} the selected text — the same mark again removes it`,
        `${label} — select some text on the page first`);
  });
  // Bold and italic say more than this once the document has been asked what
  // they would mean at the selection; see annotateStyleButtons.
  markControls("[data-style]").forEach((el) =>
    say(el, `${el.dataset.style === "bold" ? "Bold" : "Italic"} the selected words`,
        `${el.dataset.style === "bold" ? "Bold" : "Italic"} — select some text first`));
  markControls("[data-tcolor]").forEach((el) => {
    const label = TEXT_COLORS.find(([c]) => c.join(",") === el.dataset.tcolor)?.[1] || "";
    say(el, `Set the selected words in ${label}`,
        `Text colour — select some text first`);
  });
  const copy = host.querySelector('[data-act="copy"]');
  if (copy) say(copy, "Copy the selected text", "Copy — select some text first");
}

/* A selection has settled -- a drag has ended, or a double-click landed.
 *
 * The probe behind annotateStyleButtons is a round trip, so it is asked here
 * and not from drawSelection(), which runs on every pointermove of a drag. */
function finishSelection() {
  syncMarkGroup();
  if (MARKUP.active && SEL.range && SEL.page !== null) {
    if (MARKUP.busy) { toast('Wait for the current mark, then select again.', 'warn'); return; }
    void applyMark(MARKUP.active.kind, MARKUP.active.color);
  } else {
    annotateStyleButtons();
    globalThis.PDFSelectionActions?.show();
  }
}

async function copySelection() {
  try {
    await navigator.clipboard.writeText(selectionText(SEL.chars, SEL.range));
    toast("Copied.", "ok");
  } catch {
    toast("The browser would not give this page the clipboard.", "err");
  }
}

/* Text colours offered for the selected words.
 *
 * Deliberately few, and deliberately not the highlight palette: those colours
 * are chosen to be read THROUGH, and text set in pale yellow cannot be read at
 * all. Black first, because the common use is putting something back. */
const TEXT_COLORS = [
  [[0, 0, 0], "black"],
  [[0.78, 0.09, 0.06], "red"],
  [[0.09, 0.35, 0.72], "blue"],
];

/* What bold and italic would actually mean at the selection -- a face the
 * document already embeds, or a simulation, or a refusal.
 *
 * Asked after the controls are already live, because the answer costs a round
 * trip and the buttons lighting up promptly matters more than their tooltips
 * being right for the first moment. The selection is re-checked afterwards:
 * the answer is about one selection, and by the time it lands there may be
 * another one, or none.
 */
let styleProbe = null;     // the AbortController of the newest style probe
async function annotateStyleButtons() {
  const host = $("#stylegroup") || $("#markgroup");
  const rects = selectionRects(SEL.chars, SEL.range);
  if (!host || !rects.length) return;
  const asked = SEL.range;
  const [x0, y0, x1, y1] = rects[0];
  // Only the newest selection's answer is wanted; an older one still
  // waiting to be sent is not sent.
  styleProbe?.abort();
  const ctl = (styleProbe = new AbortController());
  let probe;
  try {
    // style_only: the answer is these two tooltips, not an editor, so the
    // server skips the paragraph and font work the complete probe does.
    probe = await ask("probe_text",
                      { page: SEL.page, x: (x0 + x1) / 2, y: (y0 + y1) / 2,
                        geo: SEL.chars?.geo, style_only: true }, "edit", ctl.signal);
  } catch {
    return;
  }
  if (SEL.range !== asked || !probe.found || !probe.style) return;
  const s = probe.style;
  const say = (real, already, what) =>
    already ? `This text is already ${what}`
      : real ? `Set it in the ${what} face this document embeds`
      : `No ${what} face here, so it would be drawn to look ${what}`;
  const b = host.querySelector('[data-style="bold"]');
  const i = host.querySelector('[data-style="italic"]');
  if (b) b.title = say(s.real_bold, s.bold, "bold");
  if (i) {
    i.title = s.italic ? "This text is already italic"
      : !s.real_italic && !s.can_slant
        ? "Italic here would have to slant the text, and the rest of the line "
          + "is positioned from it"
        : say(s.real_italic, false, "italic");
  }
}

async function applyStyle(body) {
  // Captured before the selection is cleared: clearSelection() drops the
  // character list these rectangles are derived from.
  const rects = selectionRects(SEL.chars, SEL.range);
  const page = SEL.page;
  const geo = SEL.chars?.geo;
  clearSelection();
  await mutate("text.style", { page, rects, geo, ...body }, (r) => r.reason);
}

const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

/* Draw the mark -- or take it off, if these words already carry it.
 *
 * The server decides which of the two this is, because it is the side that can
 * see what is already on the page; the client only says what was selected and
 * in what colour. See annot.mark and pdf_annots.covering_mark.
 */
async function applyMark(kind, color) {
  if (MARKUP.busy || SEL.page === null || !SEL.range || !SEL.chars) return;
  const rects = selectionRects(SEL.chars, SEL.range);
  // null means "whatever Config_PDF.py says this kind of mark should be" --
  // which is not the highlight palette for a line drawn under or through text,
  // since those colours are chosen to be read *through* and a pale yellow
  // underline cannot be seen at all.
  const body = { page: SEL.page, kind, rects, color: color || null, geo: SEL.chars?.geo };
  if (!rects.length) return;
  MARKUP.busy = true;
  clearSelection();
  // A completed selection is consumed before any await: neither a second event
  // nor a toolbar click may toggle the just-created mark back off.
  try {
    const result = await mutate("annot.mark", body, (r) => r.reason);
    if (!result) setActiveMarkup(null); // Never repeat an uncertain/refused mutation.
    return result;
  } finally { MARKUP.busy = false; syncMarkGroup(); }
}

/* ----------------------------- text editing ----------------------------- */

// What the badge promises. Tier A is the only one that guarantees the run
// keeps its own font with every glyph present; the others say so plainly
// rather than letting you find out after typing.
const TIER = {
  A: ["ok", "Keeps its own font"],
  B: ["warn", "Font may not have every character"],
  C: ["bad", "Not editable in place"],
};

/* Type in the document's own typeface.
 *
 * The font is fetched from the file being edited and registered under a name of
 * its own, with a system stack behind it. Two things make the fallback matter
 * rather than being decoration: a PDF may embed Type1 or bare CFF, which no
 * browser can load, and an embedded subset carries only the glyphs the document
 * already uses -- so a character typed that the subset lacks falls through to
 * the system face, which is a fair picture of what the tier badge is warning
 * about.
 */
function documentFont(xref, name, fontVersion) {
  const base = String(name || "")
    .replace(/^[A-Z]{6}\+/, "")        // subset tag: ABCDEE+Cambria
    .replace(/[-,]\s*(Bold|Italic|Oblique|Regular|BoldItalic|MT|PS|PSMT).*$/i, "")
    .trim();
  const lower = base.toLowerCase();
  const generic = /times|serif|garamond|georgia|cambria|minion|book|roman/.test(lower)
    ? '"Times New Roman", Times, serif'
    : /courier|mono|consol/.test(lower)
      ? "ui-monospace, Menlo, monospace"
      : "Arial, Helvetica, sans-serif";

  const stack = [];
  if (xref) {
    // One face per version of one font of one document. An edit can extend a
    // font, and xref 12 of another document is another font entirely, so the
    // version (from the probe) is in both the font's name and the family
    // name, and the face registered for an older version is taken out --
    // with whatever the transport held for it.
    const tag = String(fontVersion || "").replace(/[^\w-]/g, "_");
    const family = `pdffont-${xref}-${tag}`;
    const held = S.fonts.get(xref);
    if (!held || held.dataset.version !== tag) {
      held?.remove();
      held?.release?.();
      const style = document.createElement("style");
      style.dataset.version = tag;
      document.head.appendChild(style);
      S.fonts.set(xref, style);
      // At once over HTTP; a transport that delivers bytes answers later, and
      // a face replaced meanwhile lets its source go unused.
      const face = (source) => {
        if (S.fonts.get(xref) !== style) return source.release?.();
        style.release = source.release;
        style.textContent = `@font-face{font-family:"${family}";src:url("${source.url}");}`;
      };
      const opened = transport.openResource(
        transport.resourceKey("get_font", { xref, v: fontVersion }));
      if (typeof opened?.then === "function") opened.then(face, () => {});
      else face(opened);
    }
    stack.push(`"${family}"`);
  }
  if (base) stack.push(`"${base}"`);
  stack.push(generic);
  return stack.join(", ");
}

/* Bold, italic and colour used to live here, in the editor panel, and applied
 * to the whole show operator under the caret. That is why pressing B bolded far
 * more than the word anyone meant: a show operator is whatever the producer
 * chose to emit, and for most documents that is an entire line.
 *
 * They now live in the toolbar and apply to exactly what is selected -- see
 * buildMarkGroup and applyStyle. The point form of text.style still
 * exists and still styles a whole run; nothing in the interface asks for it any
 * more, because "this run" is not a thing anyone selects on purpose.
 */

/* The colour of the paper beside this paragraph.
 *
 * Sampled from the rendered page rather than assumed white, because the mask
 * has to make the original text disappear and a white patch on a cream or
 * tinted page announces itself. Taken from the margin just left of the block,
 * which is paper on any page that has a margin at all.
 */
function paperColour(wrapEl, pageInfo, box) {
  try {
    const img = wrapEl.querySelector("img");
    if (!img || !img.naturalWidth) return "#fff";
    const s = img.naturalWidth / pageInfo.width;
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, Math.max(0, Math.round((box[0] - 6) * s)),
                  Math.round(((box[1] + box[3]) / 2) * s), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r},${g},${b})`;
  } catch {
    // A tainted canvas or an image still decoding. White is right far more
    // often than it is wrong, and the commit re-renders the page anyway.
    return "#fff";
  }
}

/* Type on the page.
 *
 * The page is a raster rendered by MuPDF, so "editing in place" means covering
 * the paragraph with paper-coloured mask and drawing the words again in the
 * browser -- in the document's own embedded face, at its own size, on its own
 * leading, inside its own column. That is the draft: what you type, laid out
 * by the browser's own shaper, which can break a line where the PDF will not.
 *
 * What decides is the server. A quarter of a second after typing stops, the
 * draft is PREPARED (prepare_edit): laid out with the document's own
 * metrics, widened into free space or grown into it, checked against what is
 * around it, and drawn. That rendering is laid over the page in place of the
 * draft, and Save commits exactly it (commit_edit). Until the preview
 * matches what is typed, Save is off. See the draft functions below
 * disposeEditor.
 */
async function openInPlace(pageIndex, x, y, probe) {
  const para = probe.paragraph;
  const wrapEl = document.getElementById(`page-${pageIndex}`);
  const pageInfo = S.doc.pages.find((p) => p.index === pageIndex);
  if (!wrapEl || !pageInfo || !para.box) return false;

  const rect = wrapEl.getBoundingClientRect();
  if (!rect.width) return false;
  const k = rect.width / pageInfo.width;          // CSS pixels per point
  const [bx0, by0, bx1, by1] = para.box;

  const host = document.createElement("div");
  host.id = "editor";
  host.className = "inplace";
  // Keeps this page mounted wherever the view goes (maintain, editorPage).
  host.dataset.page = pageIndex;
  host.style.left = `${(bx0 / pageInfo.width) * 100}%`;
  host.style.top = `${(by0 / pageInfo.height) * 100}%`;
  host.style.width = `${((bx1 - bx0) / pageInfo.width) * 100}%`;
  const paper = paperColour(wrapEl, pageInfo, para.box);
  host.style.background = paper;
  host.style.minHeight = `${(by1 - by0) * k}px`;

  const area = document.createElement("div");
  area.className = "iptext";
  area.contentEditable = "plaintext-only";
  area.spellcheck = false;
  area.textContent = para.text;
  area.style.fontFamily = documentFont(probe.font_xref, probe.font_name, probe.font_v);
  area.style.fontSize = `${(para.size * k).toFixed(2)}px`;
  area.style.lineHeight = `${(para.leading * k).toFixed(2)}px`;
  if (para.justified) area.style.textAlign = "justify";
  else if (para.align === "right" || para.align === "center") area.style.textAlign = para.align;
  // para.box starts 1.35 type sizes above the first baseline, which is where
  // the appearance check puts it. A line box of `leading` holding text of
  // `size` carries its baseline about (leading - size)/2 + 0.8 size below its
  // own top, so the difference is what stops the replacement text sitting
  // higher on the page than the words it replaced.
  const pad = Math.max(0, (1.35 * para.size
                           - ((para.leading - para.size) / 2 + 0.8 * para.size)) * k);
  area.style.paddingTop = `${pad.toFixed(2)}px`;

  // The server's rendering of the prepared edit, laid over the page. In a box
  // of its own: a page's direct <img> child is its page image.
  const preview = document.createElement("div");
  preview.className = "ippreview hidden";
  Object.assign(preview.style, {
    left: `${(bx0 / pageInfo.width) * 100}%`, top: `${(by0 / pageInfo.height) * 100}%`,
    width: `${((bx1 - bx0) / pageInfo.width) * 100}%`, height: `${((by1 - by0) / pageInfo.height) * 100}%`,
    background: paper,
  });
  preview.appendChild(document.createElement("img")).alt = "";
  // Drag to set the block's width; checked by the server like everything else.
  const grip = document.createElement("div");
  grip.className = "ipgrip";
  grip.title = "Drag to change the width";

  const bar = document.createElement("div");
  bar.className = "ipbar";
  bar.innerHTML = `
    <span class="ipwas">${escapeHtml(probe.font_name || "?")} · ${para.size}pt</span>
    <span class="ipsep"></span>
    ${MODE_SWITCH}
    <span class="iplines"></span>
    <span class="ipstatus"></span>
    <button class="ebtn ghost hidden" id="ipgoto" type="button">Show</button>
    <button class="ebtn ghost hidden" id="ipoffer"></button>
    <label class="ipgrow hidden"><input type="checkbox" id="ipgrowbox"> allow it to grow taller</label>
    ${probe.marker ? `<button class="ebtn ghost" id="edemark">Remove the ${escapeHtml(probe.marker.kind)}</button>` : ""}
    <span class="ipspacer"></span>
    <button class="ebtn ghost" id="ipcancel">Cancel</button>
    <button class="ebtn" id="ipsave" disabled>Apply</button>`;
  // LaTeX mode's source field, a row of its own at the top of the bar.
  const source = makeSource();
  source.wrap.classList.add("hidden");
  bar.prepend(source.wrap);

  host.appendChild(area);
  host.appendChild(grip);
  host.appendChild(bar);
  wrapEl.appendChild(preview);
  wrapEl.appendChild(host);
  syncUndo();             // no undo underneath a draft

  (para.warnings || []).forEach((w) => toast(w, "warn"));

  // A formula block reopens in LaTeX mode with its saved source (8D.6);
  // everything else opens as plain text, which never reads a dollar sign.
  const latex = para.mode === "latex" && typeof para.source === "string";
  source.ta.value = latex ? para.source : "";
  const ed = newDraft({ page: pageIndex, x, y, block: para.block_id || null,
                        mode: latex ? "latex" : "text", editor: newEditorId(),
                        text: () => (ed.mode === "latex" ? source.ta.value : area.innerText),
                        original: latex ? para.source : para.text });
  ed.originalMode = ed.mode;
  // What this block saved: "Copy formula" copies exactly that (8D.6).
  if (latex) ed.saved = { source: para.source, nodes: para.nodes || [], formulas: para.formulas || [] };
  S.draft = ed;
  globalThis.PDFDraftRecovery?.opened(ed);
  ed.render = () => showDraft(ed, { host, area, bar, preview, wrapEl, pageInfo, source,
                                    paper, fontSize:para.size, leading:para.leading, padding:pad/k });
  globalThis.PDFInspector?.attach({host,bar,ed,area,source,initialWidth:para.box[2]-para.box[0]});
  ed.render();
  // Whether formulas can be drawn here at all; until it is known, LaTeX is
  // offered, and a preparation that finds the renderer missing says so too.
  mathCaps().then(() => { if (!ed.closed) ed.render(); });

  area.addEventListener("input", () => draftChanged(ed));
  area.addEventListener("compositionstart", () => startComposition(ed));
  area.addEventListener("compositionend", () => { ed.composing = false; draftChanged(ed); });
  wireSource(ed, source, bar);
  bar.querySelector("#ipmode-text").addEventListener("click", () => setMode(ed, "text", area, source));
  bar.querySelector("#ipmode-latex").addEventListener("click", () => setMode(ed, "latex", area, source));
  bar.querySelector("#ipgrowbox").addEventListener("change", (ev) => {
    ed.grow = ev.target.checked;
    draftChanged(ed, 0);
  });
  bar.querySelector("#ipoffer").addEventListener("click", () => {
    const offer = widenOffer(ed);
    if (offer) { ed.width = offer.width; draftChanged(ed, 0); }
  });
  dragWidth(grip, host, ed, () => wrapEl.getBoundingClientRect().width / pageInfo.width);

  // What Apply commits, from the bar or from a transition (requestEditorTransition).
  ed.apply = () => sendEdit("commit_edit", { token: ed.token, ...fallbackAccept(ed) });
  const save = () => {
    if (bar.querySelector("#ipsave").disabled) return;
    if (!draftDirty(ed)) return disposeEditor("unchanged");
    if (!draftReady(ed) || fallbackPending(ed)) return;  // not this draft, or not accepted
    ed.apply();
  };
  bar.querySelector("#ipsave").onclick = save;
  bar.querySelector("#ipcancel").onclick = () => requestEditorTransition("cancel");
  bar.querySelector("#edemark")?.addEventListener("click", () =>
    sendEdit("list.remove_marker", { page: pageIndex, x, y }));

  const keys = (ev) => {
    if (ev.isComposing || ed.composing) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      save();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      requestEditorTransition("cancel");
    }
  };
  area.addEventListener("keydown", keys);
  source.ta.addEventListener("keydown", keys);

  // Clicking away does NOT commit and does not throw the typing away. An edit
  // here rewrites a real document and can be refused by the checks, so losing
  // what was typed to a stray click is not a trade worth making.
  host.addEventListener("pointerdown", (ev) => ev.stopPropagation());

  if (ed.mode === "latex") {
    area.classList.add("hidden");
    source.wrap.classList.remove("hidden");
    source.ta.focus();
    source.ta.setSelectionRange(source.ta.value.length, source.ta.value.length);
  } else {
    area.focus();
    // Caret at the end rather than selecting the paragraph: the common edit
    // is changing a word, and a full selection means the first keystroke
    // deletes everything.
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(area);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  // Prepared at once, unchanged: the bounds the width can be dragged within,
  // and a first look at what the server will draw.
  schedulePrepare(ed, 0);
  return true;
}

/* What the in-place editor shows of its draft: the server's preview over the
 * page when it is of the current text, the draft text otherwise; the line
 * count, growth and refusal the server reported; Save on only when the
 * preview is current. Placed so the bar never leaves the window (8A: a narrow
 * block at the page's right edge put Save out of reach). */
function showDraft(ed, v) {
  const { host, area, bar, preview, pageInfo } = v;
  const ready = draftReady(ed);
  const r = ed.result, lay = ed.layout;
  const k = v.wrapEl.getBoundingClientRect().width / pageInfo.width;
  area.style.fontSize = `${v.fontSize*k}px`;
  area.style.lineHeight = `${v.leading*k}px`;
  area.style.paddingTop = `${v.padding*k}px`;
  if (lay?.box) {
    // The layout the server laid out, with the margins the editor has always
    // had around a paragraph box (pdf_blocks._authorized).
    const [x0, , x1] = lay.box;
    host.style.left = `${((x0 - 2) / pageInfo.width) * 100}%`;
    host.style.width = `${((x1 - x0 + 6) / pageInfo.width) * 100}%`;
  }
  const p = ready && r?.preview;
  if (p?.png) {
    if (preview.dataset.token !== ed.token) {
      preview.firstChild.src = `data:image/png;base64,${p.png}`;
      preview.dataset.token = ed.token;
    }
    const [x0, y0, x1, y1] = p.box;
    Object.assign(preview.style, {
      left: `${(x0 / pageInfo.width) * 100}%`, top: `${(y0 / pageInfo.height) * 100}%`,
      width: `${((x1 - x0) / pageInfo.width) * 100}%`, height: `${((y1 - y0) / pageInfo.height) * 100}%`,
    });
  }
  const latex = ed.mode === "latex";
  // While typing, keep covering the original paragraph, including lines a shorter draft no longer occupies.
  preview.firstChild.style.visibility = p?.png ? "visible" : "hidden";
  preview.classList.toggle("hidden", latex && !p?.png);
  host.classList.toggle("previewing", !!p?.png);
  // LaTeX mode draws no draft of its own: until the server's preview of the
  // current source is ready, the page shows what is there now.
  host.style.background = p?.png || latex ? "transparent" : v.paper;
  host.classList.toggle("latex", latex);
  area.style.minHeight = lay ? `${Math.max(0, (lay.box[3] - lay.box[1])) * k}px` : "";
  if (v.source) showSource(ed, bar, v.source);
  drawNodes(v.wrapEl, pageInfo, p?.png && latex ? r.layout?.nodes : null);

  const lines = bar.querySelector(".iplines");
  const status = bar.querySelector(".ipstatus");
  const was = r?.was ?? lay?.was;
  const now = ready ? r.lines : lay?.lines;
  lines.textContent = now == null ? "" : now === was || was == null
    ? `${now} line${now === 1 ? "" : "s"}` : `${was} → ${now} lines`;
  lines.classList.toggle("warn", now > was);
  const offer = widenOffer(ed);
  const offerBtn = bar.querySelector("#ipoffer");
  offerBtn.classList.toggle("hidden", !offer);
  if (offer) offerBtn.textContent = `Widen to ${Math.round(offer.width)}pt`;
  const growing = ed.refusal?.code === "growth_needs_permission" || ed.grow;
  bar.querySelector(".ipgrow").classList.toggle("hidden", !growing);
  bar.querySelector("#ipgrowbox").checked = ed.grow;
  status.classList.toggle("bad", !!ed.refusal);
  status.textContent = ed.refusal ? refusalText(ed)
    : ed.pending || !ready ? "Preparing…" : (r.info || "");
  status.title = status.textContent;
  bar.querySelector("#ipsave").disabled = !ready || !!host.dataset.stale;
  if (ready && renderFallback(ed, bar, status)) bar.querySelector("#ipsave").disabled = true;
  placeBar(bar);
}

/* Keep the editor's bar inside the visible stage: shifted left when it would
 * run off the right edge, right when off the left. */
function placeBar(bar) {
  if (globalThis.PDFInspector?.owns(bar)) { globalThis.PDFInspector.sync(); return; }
  bar.style.left = "0px";
  const stage = $("#stage")?.getBoundingClientRect();
  const lo = Math.max(8, stage ? stage.left + 8 : 8);
  const hi = Math.min(window.innerWidth, stage ? stage.right : window.innerWidth) - 8;
  const r = bar.getBoundingClientRect();
  let shift = 0;
  if (r.right > hi) shift = hi - r.right;
  if (r.left + shift < lo) shift = lo - r.left;
  if (shift) bar.style.left = `${shift}px`;
}

/* The resize handle: dragging sets the width the next preparation asks for,
 * held between the longest word and the free space the server reported. */
function dragWidth(grip, host, ed, scale) {
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const k = scale();
    const start = ev.clientX;
    const from = ed.width ?? ed.layout?.width ?? host.getBoundingClientRect().width / k - 6;
    grip.setPointerCapture?.(ev.pointerId);
    const move = (e) => {
      const want = clampWidth(ed, from + (e.clientX - start) / k);
      host.style.width = `${((want + 6) * k)}px`;
      ed.dragging = want;
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      if (ed.dragging != null) {
        ed.width = Math.round(ed.dragging * 100) / 100;
        ed.dragging = null;
        draftChanged(ed, 0);
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}

async function openEditor(pageIndex, x, y, anchor) {
  // Measured before the open editor is settled: an Apply meanwhile moves the
  // page on, and the probe is then refused as stale rather than aimed anew.
  const measured = anchor?.closest(".tlayer")?.dataset.geo;
  if (!(await requestEditorTransition("open"))) return;
  const generation = S.editorGeneration;
  const documentId = S.doc.doc;
  // Closing the editor -- or clicking another run -- withdraws a probe still
  // waiting to be sent. The complete probe (probe_text; /api/text/probe over
  // HTTP): the editor is built from the paragraph and font it reads.
  const ctl = (S.editProbe = new AbortController());
  let probe;
  try {
    probe = await ask("probe_text", {
      page: pageIndex, x, y, geo: measured,
    }, "edit", ctl.signal);
  } catch (e) {
    if (S.editorGeneration !== generation || S.doc.doc !== documentId) return;
    if (e.status === 409) await staleGeometry(pageIndex);
    return toast(explain(e), "err");
  }
  if (S.editorGeneration !== generation || S.doc.doc !== documentId) return;
  if (!probe.found) return toast("No editable text there.", "err");
  // Every edit sent from this editor is positioned by this probe's reading,
  // and what it read there is how a refused save tells whether the text under
  // the editor is still the same (keepDraft).
  S.editGeo = probe.geo;
  S.editAt = { page: pageIndex, x, y, run: probe.text,
               para: probe.paragraph ? probe.paragraph.text : null };

  // On the page itself whenever there is a paragraph to type into. The panel
  // below is what is left for the cases where there is not -- a run inside a
  // table, a heading the geometry refuses to call a block -- where there is no
  // column to lay text out in and nothing to draw an in-place editor over.
  if (probe.paragraph && await openInPlace(pageIndex, x, y, probe)) return;

  const [cls, note] = TIER[probe.font_tier] || ["warn", ""];
  const para = probe.paragraph;

  const box = document.createElement("div");
  box.id = "editor";
  box.dataset.page = pageIndex;
  box.innerHTML = `
    <div class="ehead">
      <span class="badge ${cls}">${escapeHtml(probe.font_name || "?")} · ${probe.font_size}pt</span>
      <span class="enote">${escapeHtml(note)}</span>
      <button id="eclose" class="tbtn" title="Close">✕</button>
    </div>
    <div class="ebody">
      ${probe.marker ? `
        <div class="erow emarker">
          <span class="enote">This line starts with the ${probe.marker.kind}
            <strong>${escapeHtml(probe.marker.text)}</strong>.</span>
          <button id="edemark" class="ebtn ghost">Remove it</button>
        </div>` : ""}
      ${para ? `
        <label for="epara">Paragraph — ${para.lines} line${para.lines === 1 ? "" : "s"}, ${para.column_width}pt column</label>
        <textarea id="epara" rows="${Math.min(12, Math.max(4, para.lines + 1))}">${escapeHtml(para.text)}</textarea>
        ${(para.warnings || []).map((w) =>
            `<div class="enote warn">${escapeHtml(w)}</div>`).join("")}
        <div class="erow">
          <button id="ereflow" class="ebtn">Apply to paragraph</button>
          <label><input type="checkbox" id="egrow"> allow it to grow taller</label>
        </div>`
      : `<div class="ereason"><strong>This text is not part of a re-wrappable paragraph.</strong><br>
           ${escapeHtml(probe.paragraph_refused || "")}</div>`}

      <details class="erun"${para ? "" : " open"}>
        <summary>Replace just this run — no re-wrap</summary>
        ${para ? `<div class="enote">Changes these words only. The rest of the
          paragraph stays where it is, so the line will not re-break and
          justified text will not be re-spaced.</div>` : ""}
        <textarea id="espan" rows="2">${escapeHtml(probe.text)}</textarea>
        <div class="erow">
          <button id="ereplace" class="ebtn ghost">Replace run</button>
          <label><input type="checkbox" id="eshift"> allow width shift</label>
        </div>
      </details>
    </div>`;
  document.body.appendChild(box);
  globalThis.PDFDraftRecovery?.legacyOpened(box,pageIndex);
  syncUndo();

  // Show the text in the face and at roughly the size it is drawn on the page,
  // clamped to stay legible: 7pt footnotes are not readable in a panel, and a
  // 28pt heading would not fit in one.
  const family = documentFont(probe.font_xref, probe.font_name, probe.font_v);
  const size = Math.min(21, Math.max(13, (probe.font_size || 12) * 1.25));
  box.querySelectorAll("textarea").forEach((t) => {
    t.style.fontFamily = family;
    t.style.fontSize = `${size.toFixed(1)}px`;
  });

  // Anchor below the clicked text, then pull back inside the viewport.
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  const top = r.bottom + 8 + h > window.innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8;
  box.style.top = `${top}px`;
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;

  const original = probe.text;
  $("#eclose").onclick = () => requestEditorTransition("cancel");

  $("#edemark")?.addEventListener("click", () =>
    sendEdit("list.remove_marker", { page: pageIndex, x, y }));
  $("#ereplace").onclick = () =>
    sendEdit("text.replace", {
      page: pageIndex, x, y,
      new_text: $("#espan").value,
      expect_old: original,
      allow_shift: $("#eshift").checked,
    });
  if (para) {
    $("#ereflow").onclick = () =>
      sendEdit("text.reflow", {
        page: pageIndex, x, y,
        new_text: $("#epara").value,
        allow_growth: $("#egrow").checked,
      });
  }
  // Focus the paragraph when there is one: editing a paragraph is the
  // normal case, and the single run is the fallback for when it is not
  // available or not what was meant.
  (para ? $("#epara") : $("#espan")).focus();
}

/* ----------------------------- leaving an editor (SAFE-01) -----------------------------
 *
 * Two functions, one decision each. disposeEditor(reason) lets an open editor
 * go -- its probe, its preparations (cancelled with the server, so no prepared
 * token survives it), its DOM and its recovery checkpoint -- and never decides
 * whether what was typed may be thrown away. requestEditorTransition(action)
 * is that decision, and everything the user does that would end an editor
 * (another block, a page operation, Edit Text off, another workspace, markup,
 * Cancel, Escape) asks it first and goes on only when it answers true:
 *
 *   - no editor, or an unchanged draft: disposed at once, true;
 *   - a changed draft: Apply / Discard / Keep editing, in a dialog on the page.
 *     Apply is on only for the current ready preparation with any fallback
 *     font accepted, and commits exactly that preparation; a refused or failed
 *     Apply keeps the draft and cancels the transition. Keep editing puts the
 *     focus back in the source with its caret. Cancel and Escape offer Discard
 *     and Keep editing;
 *   - a commit with the server: waits for its known outcome (post reconciles
 *     a lost answer), then decides again. Leaving the dialog never cancels a
 *     commit.
 *
 * Successful commits and reconciliations call disposeEditor themselves, once
 * the outcome is known. */
const TRANSITION = { pending: null, ui: null, source: null, caret: null };

const TRANSITION_WHAT = {
  open: "editing another block", "edit-text": "turning off Edit Text", workspace: "changing the workspace",
  rotate: "rotating pages", delete: "deleting pages", reorder: "moving pages", formula: "replacing a formula",
  markup: "starting markup", zoom: "zooming",
};

// An editor is open, or one is being opened (its probe is out).
const editorOpen = () => !!(document.getElementById("editor") || S.draft || S.editProbe);

// What is typed differs from what the editor was opened on.
const editorDirty = () => !!(S.draft && !S.draft.closed && draftDirty(S.draft))
  || !!globalThis.PDFDraftRecovery?.legacyDirty();

/* Whether Apply may commit the open draft now, and if not, why. */
function transitionApply() {
  const ed = S.draft, host = document.getElementById("editor");
  if (!ed || ed.closed || !ed.apply) {
    return { ok: false, why: "Use the editor's own buttons to apply these changes." };
  }
  if (host?.dataset.stale) return { ok: false, why: "The text under the editor changed, so this draft cannot be applied." };
  if (!draftReady(ed)) {
    return { ok: false, why: ed.refusal ? refusalText(ed) : "The preview of these changes is still being prepared." };
  }
  if (fallbackPending(ed)) return { ok: false, why: "Accept the previewed font in the editor first." };
  if (document.getElementById("ipsave")?.disabled) return { ok: false, why: "Apply is off for this draft." };
  return { ok: true, why: "" };
}

/* The dialog, made once. ask() answers "apply", "discard" or "keep"; Escape
 * is Keep editing; Tab stays inside it. */
function transitionDialog() {
  if (TRANSITION.ui?.dlg.isConnected) return TRANSITION.ui;
  const dlg = document.createElement("dialog");
  dlg.id = "editor-transition";
  dlg.tabIndex = -1;
  dlg.setAttribute("aria-labelledby", "editor-transition-title");
  dlg.setAttribute("aria-describedby", "editor-transition-message");
  dlg.innerHTML = `<h2 id="editor-transition-title">Unapplied changes</h2>
    <p id="editor-transition-message"></p>
    <p id="editor-transition-status" role="status"></p>
    <div class="erow">
      <button type="button" class="ebtn" id="editor-transition-apply">Apply</button>
      <button type="button" class="ebtn ghost" id="editor-transition-discard">Discard</button>
      <button type="button" class="ebtn ghost" id="editor-transition-keep">Keep editing</button>
    </div>`;
  document.body.appendChild(dlg);
  const buttons = Object.fromEntries(["apply", "discard", "keep"].map((k) =>
    [k, dlg.querySelector(`#editor-transition-${k}`)]));
  const ui = { dlg, buttons, resolve: null, selfClosed: 0 };
  ui.choose = (choice, forced = false) => {
    const b = buttons[choice];
    if (!ui.resolve || (!forced && (b.disabled || b.hidden))) return;
    const r = ui.resolve;
    ui.resolve = null;
    r(choice);
  };
  for (const [choice, b] of Object.entries(buttons)) b.addEventListener("click", () => ui.choose(choice));
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); ui.choose("keep"); });
  // Closed some other way while a choice is open: nothing is discarded. The
  // close event is queued, so one caused by ui.close must not answer the next
  // question asked before it arrives.
  dlg.addEventListener("close", () => {
    if (ui.selfClosed) { ui.selfClosed--; return; }
    ui.choose("keep", true);
  });
  dlg.addEventListener("keydown", (ev) => {
    // The page's own shortcuts (Escape closes an editor, Cmd+Z undoes) are not
    // this dialog's.
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); ui.choose("keep"); return; }
    if (ev.key !== "Tab") return;
    const live = Object.values(buttons).filter((b) => !b.hidden && !b.disabled);
    if (!live.length) { ev.preventDefault(); return; }
    const at = live.indexOf(document.activeElement);
    const next = ev.shiftKey ? (at <= 0 ? live.length - 1 : at - 1) : (at < 0 || at === live.length - 1 ? 0 : at + 1);
    ev.preventDefault();
    live[next].focus();
  });
  ui.show = ({ message, status = "", apply = null, discard = true, keep = true }) => {
    dlg.querySelector("#editor-transition-message").textContent = message;
    dlg.querySelector("#editor-transition-status").textContent = status;
    buttons.apply.hidden = apply === null;
    buttons.apply.disabled = !apply;
    buttons.discard.disabled = !discard;
    buttons.keep.disabled = !keep;
    const opening = !dlg.open;
    if (opening) dlg.showModal();
    // Keep editing first: the choice that loses nothing.
    const first = [buttons.keep, buttons.apply, buttons.discard].find((b) => !b.hidden && !b.disabled);
    if (opening || !dlg.contains(document.activeElement) || document.activeElement.disabled) (first || dlg).focus();
  };
  ui.ask = (opts) => new Promise((resolve) => { ui.resolve = resolve; ui.show(opts); });
  ui.close = () => { ui.resolve = null; if (dlg.open) { ui.selfClosed = (ui.selfClosed || 0) + 1; dlg.close(); } };
  return (TRANSITION.ui = ui);
}

/* Where the user was typing in the open editor, and the caret there. */
function editorSource() {
  const host = document.getElementById("editor"), ed = S.draft;
  const inEditor = (el) => !!el?.isConnected && !!(host?.contains(el) || (ed && el.closest?.("#properties")));
  let el = [document.activeElement, TRANSITION.source].find((x) => inEditor(x)
    && (x.tagName === "TEXTAREA" || x.isContentEditable)) || null;
  if (!el && host) {
    el = ed && (ed.mode === "latex" || ed.kind === "formula") ? document.querySelector(".ipsource")
      : host.querySelector(".iptext, #epara, #espan");
  }
  if (!el) return null;
  if (el.tagName === "TEXTAREA") return { el, start: el.selectionStart, end: el.selectionEnd };
  const range = TRANSITION.caret?.el === el ? TRANSITION.caret.range : null;
  return { el, range };
}

function restoreSource(at) {
  if (!at?.el?.isConnected) return;
  if (at.el.closest?.("#properties.hidden")) globalThis.PDFInspector?.show?.(false);
  at.el.focus({ preventScroll: true });
  if (at.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(at.range);
  } else if (at.start != null) at.el.setSelectionRange(at.start, at.end);
}

/* Ask before ending the open editor for `action`. True once no editor is
 * open: unchanged, applied, or explicitly discarded. False when it is kept. */
async function requestEditorTransition(action = "cancel") {
  if (TRANSITION.pending) { TRANSITION.ui?.dlg.open && TRANSITION.ui.dlg.focus(); return false; }
  if (!editorOpen()) return true;
  if (!document.getElementById("editor")?.dataset.sending && !editorDirty()) {
    disposeEditor(action);
    return true;
  }
  const run = transitionSteps(action);
  TRANSITION.pending = run;
  try { return await run; } finally { TRANSITION.pending = null; }
}

/* For a gesture that cannot wait (a press starting a box, a wheel zoom): true
 * when no editor is left -- none was open, or an unchanged one was disposed.
 * Otherwise the question is asked and the gesture does not happen. */
function settleEditorNow(action) {
  if (TRANSITION.pending) return false;
  if (!editorOpen()) return true;
  if (!document.getElementById("editor")?.dataset.sending && !editorDirty()) {
    disposeEditor(action);
    return true;
  }
  void requestEditorTransition(action);
  return false;
}

async function transitionSteps(action) {
  const ed = S.draft, host = document.getElementById("editor");
  const generation = S.editorGeneration;
  const opener = document.activeElement;
  const at = editorSource();
  const ui = transitionDialog();
  const cancel = action === "cancel";
  const what = TRANSITION_WHAT[action] || "continuing";
  const message = cancel
    ? "This editor has changes that are not applied. Discard them, or keep editing?"
    : `This editor has changes that are not applied. Apply or discard them before ${what}, or keep editing.`;
  const kept = () => { ui.close(); restoreSource(at); return false; };
  // Rendering the draft (a preparation answering meanwhile) refreshes Apply.
  let refresh = null;
  const render = ed?.render;
  if (ed && render) ed.render = () => { render(); refresh?.(); };
  try {
    for (;;) {
      if (!editorOpen()) { ui.close(); return true; }
      // Another editor than the one asked about: not this transition's to end.
      if (S.draft !== ed || document.getElementById("editor") !== host) return kept();
      if (host?.dataset.sending) {
        refresh = null;
        const commit = S.editCommit || Promise.resolve();
        const asked = ui.ask({ message: "Applying and verifying this edit. The editor closes once its outcome is known.",
                               status: "Waiting for the edit result…", apply: null, discard: false });
        const outcome = await Promise.race([asked, commit.then(() => "settled", () => "settled")]);
        if (outcome === "keep") return kept();
        ui.resolve = null;
        continue;
      }
      if (!editorDirty()) { ui.close(); disposeEditor(action); return true; }
      const options = () => {
        const a = transitionApply();
        return { message, status: cancel ? "" : a.why, apply: cancel ? null : a.ok };
      };
      refresh = () => { if (ui.resolve) ui.show(options()); };
      const choice = await ui.ask(options());
      refresh = null;
      if (choice === "keep") return kept();
      if (choice === "discard") {
        ui.close();
        disposeEditor(`discard:${action}`);
        if (opener?.isConnected && !opener.closest?.("#editor, #properties")) opener.focus?.({ preventScroll: true });
        return true;
      }
      // Apply: exactly the preparation that made it available, or nothing.
      if (!transitionApply().ok || S.draft !== ed || S.editorGeneration !== generation) continue;
      ui.show({ message: "Applying and verifying…", status: "", apply: false, discard: false, keep: false });
      const applied = await ed.apply();
      if (applied && !editorOpen()) { ui.close(); return true; }
      // Refused, failed or unconfirmed: the draft stays, and so does the user.
      return kept();
    }
  } finally {
    if (ed && render) ed.render = render;
  }
}

/* Explicit Cancel of a comment draft: changed text needs Discard. */
async function confirmDiscardNote(area) {
  if (TRANSITION.pending) return false;
  const at = { el: area, start: area.selectionStart, end: area.selectionEnd };
  const ui = transitionDialog();
  const run = ui.ask({ message: "This comment has changes that are not applied. Discard them, or keep editing?",
                       apply: null });
  TRANSITION.pending = run;
  let choice;
  try { choice = await run; } finally { TRANSITION.pending = null; ui.close(); }
  if (choice !== "discard") { restoreSource(at); return false; }
  return true;
}

function disposeEditor(reason = "close") {
  globalThis.PDFDraftRecovery?.legacyClosed();
  S.editorGeneration++;
  S.editGeo = null;
  S.editAt = null;
  S.editProbe?.abort();
  S.editProbe = null;
  if (S.draft) {
    globalThis.PDFDraftRecovery?.closed(S.draft);
    dropDraft(S.draft);
    S.draft = null;
  }
  globalThis.PDFInspector?.close();
  document.getElementById("editor")?.remove();
  document.querySelector?.(".ippreview")?.remove();
  document.querySelectorAll?.(".ipnode").forEach((el) => el.remove());
  syncUndo();
  return true;
}

/* Save from the open editor. What was typed stays in the editor whatever goes
 * wrong -- a refusal, a page that moved on, a failed render, a lost connection
 * -- and is only let go once the change is known to be saved. One save at a
 * time: a second press while the first is out does nothing. Answers whether
 * the change is known to have landed (the editor is then disposed); while it
 * is out, S.editCommit is its promise, which a transition waits for. */
async function sendEdit(op, body) {
  const host = document.getElementById("editor");
  if (!host || host.dataset.sending) return false;
  if (op === "list.remove_marker" && editorDirty()) {
    toast("Apply or discard your text changes before removing the list marker.");
    return false;
  }
  const run = commitEdit(host, op, body);
  S.editCommit = run;
  try { return await run; } finally { if (S.editCommit === run) S.editCommit = null; }
}

async function commitEdit(host, op, body) {
  const at = S.editAt;
  host.dataset.sending = "1";
  globalThis.PDFInspector?.sync();
  let landed = false;
  // PERF-01: Save pressed -> verified commit answered -> its pages redrawn.
  const timing = globalThis.PDFPerf?.begin("commit", { page: at?.page });
  try {
    const r = await post(op, { geo: S.editGeo, ...body }, timing);
    globalThis.PDFPerf?.mark(timing, "answered");
    landed = true;
    // A used preparation needs no cancelling.
    if (S.draft) S.draft.token = null;
    disposeEditor("applied");
    // The pages the edit changed are redrawn, and only those. See afterEdit.
    await afterEdit(r);
    // A re-wrap moves or removes the marks on its paragraph.
    refreshNotes(r);
    refreshUndo();
    globalThis.PDFPerf?.end(timing, "ok");
    toast(r.reason, "ok");
  } catch (e) {
    globalThis.PDFPerf?.end(timing, e.outcome === "applied" ? "applied_unanswered" : "refused");
    refreshUndo();
    // A lost answer to a change that did land: it is on the page now.
    if (e.outcome === "applied") { landed = true; disposeEditor("applied"); }
    else if (e.status === 409) e.message = `${e.message} ${await keepDraft(host, at)}`;
    // A preparation is used or refused once: the draft is prepared again.
    const ed = S.draft;
    if (ed && op === "commit_edit" && e.outcome !== "applied") {
      ed.token = null;
      ed.readyGen = -1;
      if (!host.dataset.stale) schedulePrepare(ed, 0);
      ed.render();
    }
    // The refusal text explains which check declined and why. Show it whole --
    // "this font has no outline for 'ğ'" is the entire value of the feature.
    toast(explain(e), "err");
  } finally {
    delete host.dataset.sending;
    globalThis.PDFInspector?.sync();
  }
  return landed;
}

/* A 409: the page moved on after the editor was opened, and nothing was saved.
 * Catch up with the document -- which redraws what changed -- and then ask what
 * is under the editor's point now. Still the text it was opened on: the editor
 * carries on under the page's new version, and saving again applies the
 * draft. Anything else: the draft stays, but Save is switched off, because it
 * would now replace text nobody was looking at. Returns what to tell the user. */
async function keepDraft(host, at) {
  const generation = S.editorGeneration;
  await staleGeometry();
  // Closed meanwhile, or another document is open: there is nothing to keep.
  if (!at || S.editorGeneration !== generation) return "";
  if (!host.isConnected) {
    // A layout change rebuilt the pages; the editor goes back on its own.
    const wrap = document.getElementById(`page-${at.page}`);
    (host.classList.contains("inplace") && wrap ? wrap : document.body).appendChild(host);
  }
  let probe = null;
  try {
    probe = await ask("probe_text", { page: at.page, x: at.x, y: at.y,
                                           geo: S.doc.pages[at.page]?.geo });
  } catch { /* unknown counts as changed */ }
  if (S.editorGeneration !== generation) return "";
  if (probe?.found && probe.text === at.run
      && (probe.paragraph ? probe.paragraph.text : null) === at.para) {
    S.editGeo = probe.geo;
    return "The text under the editor has not changed, so saving again applies what you typed.";
  }
  host.dataset.stale = "1";
  (globalThis.PDFInspector?.controls(host) || host).querySelectorAll("#ipsave, #ereflow, #ereplace, #edemark")
    .forEach((b) => { b.disabled = true; });
  return "The text under the editor changed, so saving from it is switched off. What you "
    + "typed is still here: copy it, then close the editor and open it again.";
}

/* A 409: the page moved on after what the gesture was measured on was fetched.
 * Catch up with the document's current versions, which drops that measurement
 * and redraws whatever changed, so repeating the gesture works against the page
 * as it now is. A layout or document change reloads everything. */
async function staleGeometry() {
  await resync();
}

/* ----------------------------- prepared edits -----------------------------
 *
 * The in-place editor's draft, and the server's preparation of it. Every
 * change to the draft (typing, the width handle, the growth checkbox) bumps
 * `gen` and, PREPARE_DELAY after it settles -- never during IME composition --
 * sends prepare_edit. An answer is taken only for the draft it was asked
 * for; an older one is let go. Save is on only while the current draft has a
 * ready preparation (draftReady), and commits that preparation's token.
 *
 * Preparations are questions, not changes ("ask", see opKind). They go through the
 * request coordinator as heavy reads at "prepare" priority -- behind what is
 * on screen, one with the server at a time -- and a newer draft withdraws
 * the older one's request if it has not been sent, or lets its prepared
 * token go when its answer arrives late (netRead's `late`). Each carries the
 * editor's id and the draft's generation, so the server drops a draft that a
 * newer one from the same editor has overtaken (409 superseded) before doing
 * its work, and each new one names the token it supersedes. Closing the
 * editor tells the server so (cancelPrepared). Commits go through post() and
 * stay serialized with every other change. */
const PREPARE_DELAY = 250;
let draftSeq = 0;

function newDraft(at) {
  return { mode: "text", editor: `${REQUEST_TAG}.${++draftSeq}`, width: null, grow: false, gen: 0, readyGen: -1,
           token: null, result: null, layout: null, refusal: null, pending: false,
           composing: false, closed: false, ctrl: null, timer: 0, dragging: null,
           render: () => {}, ...at };
}

const draftReady = (ed) => !ed.closed && !ed.composing && !!ed.token && ed.readyGen === ed.gen;
const draftDirty = (ed) => ed.text() !== ed.original || ed.width != null || ed.grow
  || (ed.mode || "text") !== (ed.originalMode || ed.mode || "text");
const widenOffer = (ed) => (ed.refusal?.offers || []).find((o) => o.kind === "widen") || null;

function clampWidth(ed, w) {
  const lo = ed.layout?.min_width ?? 1;
  const hi = ed.layout?.max_width ?? Infinity;
  return Math.min(Math.max(w, lo), Math.max(lo, hi));
}

function startComposition(ed) {
  ed.composing = true;
  draftChanged(ed);  // invalidate the preview and clear any pending debounce
}

function draftChanged(ed, delay = PREPARE_DELAY) {
  ed.gen++;
  ed.render();
  schedulePrepare(ed, delay);
  globalThis.PDFDraftRecovery?.changed();
}

function schedulePrepare(ed, delay = PREPARE_DELAY) {
  clearTimeout(ed.timer);
  if (ed.closed || ed.composing) return;
  ed.timer = setTimeout(() => runPrepare(ed), delay);
}

function prepareRequest(body, signal, op = "prepare_edit", perf) {
  return api(op, body, { priority: "prepare", heavy: true, signal, perf,
                         late: (r) => r?.token && cancelPrepared(r.token) });
}

/* Let a preparation go (`token`), and/or -- `editor` -- tell the server the
 * editor closed, so work it still has waiting for that editor is dropped. */
function cancelPrepared(token, editor) {
  api("cancel_edit", { token, editor }, { priority: "edit" }).catch(() => {});
}

async function runPrepare(ed) {
  if (ed.closed || ed.composing) return;
  const gen = ed.gen;
  ed.ctrl?.abort();
  // The server lets the previous preparation go when this one names it.
  const supersedes = ed.token;
  ed.token = null;
  if (ed.empty?.()) {
    // Nothing to prepare yet (a replacement with no source typed).
    ed.ctrl = null;
    if (supersedes) cancelPrepared(supersedes);
    Object.assign(ed, { pending: false, result: null, refusal: null, answered: gen });
    return ed.render();
  }
  const ctrl = ed.ctrl = new AbortController();
  ed.pending = true;
  ed.render();
  // Every draft names its editor and generation, so a server still busy
  // with an older one drops it rather than preparing it (409 superseded).
  const common = { geo: S.editGeo, dpi: Math.round(renderDpi()), supersedes,
                   ...(ed.editor ? { editor: ed.editor, generation: gen } : {}) };
  const body = ed.body ? ed.body(common)
    : { page: ed.page, new_text: ed.text(), width: ed.width, allow_growth: ed.grow,
        mode: ed.mode || "text", ...common,
        ...(ed.block ? { block: ed.block } : { x: ed.x, y: ed.y }) };
  let r = null, err = null;
  const timing = globalThis.PDFPerf?.begin("prepare", { page: ed.page });   // PERF-01
  try { r = await prepareRequest(body, ctrl.signal, ed.op, timing); } catch (e) { err = e; }
  globalThis.PDFPerf?.end(timing, err ? (err.name === "AbortError" ? "aborted"
                                         : err.code === "superseded" ? "superseded" : "refused") : "ok");
  if (ed.ctrl !== ctrl) return;                     // a newer one is out
  ed.ctrl = null;
  ed.pending = false;
  if (ed.closed || err?.name === "AbortError") {
    if (r?.token) cancelPrepared(r.token);
    return;
  }
  if (gen !== ed.gen) {                             // typed over meanwhile
    if (r?.token) cancelPrepared(r.token);
    return ed.render();
  }
  if (err?.code === "superseded") return ed.render();  // a newer draft answers instead
  ed.answered = gen;                                // what is shown answers this draft
  if (err) {
    ed.result = null;
    ed.refusal = { message: explain(err), code: err.code, offers: err.body?.offers || [],
                   ranges: sourceRanges(err.body) };
    if (err.body?.layout) ed.layout = err.body.layout;
    if (err.code === "renderer_unavailable") mathUnavailable(err);
    if (ed.onStale && (err.code === "stale_selection" || err.code === "stale_geometry")) {
      return ed.onStale(err);
    }
    if (err.status === 409 && err.code === "stale_geometry") return draftStale(ed);
  } else {
    Object.assign(ed, { token: r.token, readyGen: gen, result: r, layout: r.layout,
                        refusal: null });
  }
  ed.render();
}

/* A preparation answered 409: the page moved on. keepDraft decides whether
 * the editor still stands on the same text; if it does, prepare again. */
async function draftStale(ed) {
  const host = document.getElementById("editor");
  const said = host ? await keepDraft(host, S.editAt) : "";
  if (ed.closed) return;
  if (said) ed.refusal = { ...ed.refusal, message: said };
  ed.render();
  if (host && !host.dataset.stale) schedulePrepare(ed, 0);
}

function dropDraft(ed) {
  ed.closed = true;
  clearTimeout(ed.timer);
  const inFlight = !!ed.ctrl;
  ed.ctrl?.abort();
  cancelPrepared(ed.token, ed.editor);
  ed.token = null;
}

/* ----------------------------- LaTeX mode (8D.7) -----------------------------
 *
 * The in-place editor has two modes. Text, the default, never reads a dollar
 * sign. LaTeX edits SOURCE: prose with $...$ or \(...\) inline formulas and
 * $$...$$ or \[...\] displays, typed into a plain text field so the offsets
 * the server reports are offsets into exactly what was typed. Nothing in the
 * browser typesets: the draft is prepared like any other (prepare_edit,
 * mode "latex"), and what shows over the page is the server's rendering of
 * the prepared candidate -- the thing Save commits.
 *
 * A refusal names its code and, when the parser knows it, its source range
 * (`range16`, UTF-16 offsets); the range is marked behind the text, without
 * moving the caret or the selection, and "Show" selects it on request. Where
 * the server gives no range, none is shown. When formulas cannot be drawn
 * here (no Node.js, an incomplete bundle) only LaTeX is switched off, with the
 * server's reason; plain editing goes on as before. */
const MATH = { caps: null, pending: null };
let editorSeq = 0;
const newEditorId = () => `${REQUEST_TAG}-e${++editorSeq}`;

const MODE_SWITCH = `
    <span class="ipmode" role="group" aria-label="Editing mode">
      <button class="ebtn ghost" id="ipmode-text" type="button">Text</button>
      <button class="ebtn ghost" id="ipmode-latex" type="button">LaTeX</button>
    </span>
    <button class="ebtn ghost hidden" id="ipinsert" type="button"
            title="Put $ delimiters around the selected source">Insert formula</button>
    <button class="ebtn ghost hidden" id="ipcopy" type="button">Copy formula</button>`;

/* get_math_capabilities, asked once. A failure to ask is not an answer: it
 * is forgotten, so the next editor asks again. */
function mathCaps() {
  if (MATH.caps) return Promise.resolve(MATH.caps);
  MATH.pending ||= api("get_math_capabilities").then((c) => (MATH.caps = c))
    .catch(() => null).finally(() => { MATH.pending = null; });
  return MATH.pending;
}

const mathOff = () => !!MATH.caps && !MATH.caps.available;
const mathReason = () => `LaTeX editing is unavailable here: ${MATH.caps?.reason
  || "the formula renderer could not be started."} Plain text editing still works.`;

// A preparation found the renderer missing: LaTeX is off from now on.
function mathUnavailable(err) {
  MATH.caps = { ...(MATH.caps || {}), available: false, code: err.code,
                reason: err.body?.detail || err.message };
}

/* The source ranges a refusal names: every parser issue's, else its own. */
function sourceRanges(body) {
  const issues = (body?.issues || []).filter((i) => i.range16);
  if (issues.length) return issues.map((i) => ({ range: i.range16, message: i.message }));
  return body?.range16 ? [{ range: body.range16, message: body.detail }] : [];
}

// "line L, column C" of a UTF-16 offset in `text`, counted from 1.
function lineCol(text, at) {
  const before = text.slice(0, at).split("\n");
  return `line ${before.length}, column ${before.at(-1).length + 1}`;
}

/* What the status says about a refusal. A LaTeX refusal with a source range
 * says where; one without says nothing about a place. */
function refusalText(ed) {
  const f = ed.refusal;
  const at = ed.mode === "latex" && f.ranges?.length ? f.ranges[0].range : null;
  return at ? `${f.message} — at ${lineCol(ed.text(), at[0])}` : f.message;
}

function makeSource() {
  const wrap = document.createElement("div");
  wrap.className = "ipsrc";
  const back = document.createElement("div");
  back.className = "ipsrcback";
  back.setAttribute("aria-hidden", "true");
  const ta = document.createElement("textarea");
  ta.className = "ipsource";
  ta.spellcheck = false;
  ta.rows = 3;
  ta.setAttribute("aria-label", "LaTeX source");
  ta.placeholder = "Text with $inline$ or $$display$$ formulas";
  wrap.append(back, ta);
  ta.addEventListener("scroll", () => { back.scrollTop = ta.scrollTop; });
  return { wrap, back, ta };
}

/* The source field's events: typing, IME composition, "Insert formula" and
 * "Show". Shared by the in-place editor and the formula replacement panel. */
function wireSource(ed, source, bar) {
  const { ta } = source;
  ta.addEventListener("input", () => draftChanged(ed));
  ta.addEventListener("compositionstart", () => startComposition(ed));
  ta.addEventListener("compositionend", () => { ed.composing = false; draftChanged(ed); });
  bar.querySelector("#ipinsert")?.addEventListener("click", () => {
    const [a, b] = [ta.selectionStart, ta.selectionEnd];
    ta.setRangeText(`$${ta.value.slice(a, b)}$`, a, b, "end");
    ta.setSelectionRange(b + 1, b + 1);
    ta.focus();
    draftChanged(ed);
  });
  bar.querySelector("#ipcopy")?.addEventListener("click", () => copyFormula(ed, ta));
  bar.querySelector("#ipgoto")?.addEventListener("click", () => {
    const at = ed.refusal?.ranges?.[0]?.range;
    if (!at) return;
    ta.focus();
    ta.setSelectionRange(at[0], Math.max(at[1], at[0]));
  });
}

/* The mode buttons, the source field, and the marks behind it. */
function showSource(ed, bar, source) {
  const latex = ed.mode === "latex";
  bar.querySelector("#ipmode-text")?.classList.toggle("on", !latex);
  const lbtn = bar.querySelector("#ipmode-latex");
  if (lbtn) {
    lbtn.classList.toggle("on", latex);
    lbtn.classList.toggle("off", mathOff());
    lbtn.disabled = mathOff();
    lbtn.title = mathOff() ? mathReason() : "Edit as LaTeX source: $...$ inline, $$...$$ display";
  }
  bar.querySelector("#ipinsert")?.classList.toggle("hidden", !latex);
  const copy = bar.querySelector("#ipcopy");
  if (copy) {
    copy.classList.toggle("hidden", !latex || !ed.saved?.formulas?.length);
    const unchanged = ed.saved && source.ta.value === ed.saved.source;
    copy.classList.toggle("off", !unchanged);
    copy.title = unchanged ? "Copy the saved LaTeX of the formula at the caret, delimiters included"
      : "The source has changed: save it first to copy a saved formula";
  }
  source.wrap.classList.toggle("hidden", !latex);
  const ranges = latex ? ed.refusal?.ranges || [] : [];
  bar.querySelector("#ipgoto")?.classList.toggle("hidden", !ranges.length);
  markSource(source, ranges.map((r) => r.range));
}

/* Mark `ranges` (UTF-16 [start, end)) behind the source text: the backdrop
 * holds the same text, transparent, with the ranges highlighted. An empty
 * range (a missing delimiter at the end) is marked one character wide. */
function markSource(source, ranges) {
  const text = source.ta.value;
  const spans = ranges.map(([a, b]) => [Math.min(a, text.length), Math.min(Math.max(b, a + 1), text.length + 1)])
    .sort((x, y) => x[0] - y[0]);
  let html = "", at = 0;
  for (const [a, b] of spans) {
    if (a < at) continue;
    html += escapeHtml(text.slice(at, a)) + `<mark>${escapeHtml(text.slice(a, b)) || " "}</mark>`;
    at = b;
  }
  source.back.innerHTML = html + escapeHtml(text.slice(at)) + "\n";
  source.back.scrollTop = source.ta.scrollTop;
}

/* "Copy formula": the exact saved LaTeX of one formula, delimiters included
 * (8D.6), as the block's record holds it -- the one the caret is in, else
 * the first. Only while the source is the saved one: the record's ranges
 * describe that, and the browser does not parse LaTeX to find others. */
async function copyFormula(ed, ta) {
  const f = ed.saved;
  if (!f?.formulas?.length) return;
  if (ta.value !== f.source) return toast("The source has changed: save it first to copy a saved formula.", "warn");
  const u16 = (cp) => Array.from(f.source).slice(0, cp).join("").length;
  const at = ta.selectionStart;
  const nodes = f.nodes.filter((n) => n.kind !== "text");
  const hit = nodes.find((n) => u16(n.start) <= at && at <= u16(n.end)) || nodes[0];
  const text = (f.formulas.find((x) => x.id === hit?.id) || f.formulas[0]).source;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard permission (an unfocused page, a policy): the copy
    // command on a selection of exactly that text.
    const tmp = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(tmp);
    tmp.select();
    const ok = document.execCommand?.("copy");
    tmp.remove();
    ta.focus();
    if (!ok) return toast("The browser did not allow copying here.", "err");
  }
  toast(`Copied ${text}`, "ok");
}

/* Where each formula of a prepared LaTeX draft was laid out (the answer's
 * layout.nodes, displayed ink boxes), outlined on the page while the preview
 * is current. */
function drawNodes(wrapEl, pageInfo, nodes) {
  wrapEl.querySelectorAll(".ipnode").forEach((el) => el.remove());
  for (const n of nodes || []) {
    const [x0, y0, x1, y1] = n.box;
    const el = document.createElement("div");
    el.className = "ipnode";
    el.title = `${n.kind === "display_math" ? "Display formula" : n.kind === "tag" ? "Tag" : "Inline formula"} ${n.id}, line ${n.line + 1}`;
    Object.assign(el.style, {
      left: `${(x0 / pageInfo.width) * 100}%`, top: `${(y0 / pageInfo.height) * 100}%`,
      width: `${((x1 - x0) / pageInfo.width) * 100}%`, height: `${((y1 - y0) / pageInfo.height) * 100}%`,
    });
    wrapEl.appendChild(el);
  }
}

/* Switch the editor between Text and LaTeX. The words carry over as they
 * are -- nothing is escaped or rewritten -- so a dollar sign typed as text
 * becomes a delimiter in LaTeX mode, and the preparation says so if it is
 * one that does not close. */
function setMode(ed, mode, area, source) {
  if (mode === ed.mode) return;
  if (mode === "latex" && mathOff()) {
    ed.refusal = { message: mathReason(), code: MATH.caps.code || "renderer_unavailable" };
    return ed.render();
  }
  if (mode === "latex") {
    source.ta.value = ed.text();
    area.classList.add("hidden");
    ed.mode = "latex";
    source.wrap.classList.remove("hidden");
    source.ta.focus();
  } else {
    area.textContent = source.ta.value;
    area.classList.remove("hidden");
    ed.mode = "text";
    area.focus();
  }
  draftChanged(ed, 0);
}

/* ----------------------------- fallback offer (8C) -----------------------------
 *
 * A prepared draft may need letters the document's font has no outline for;
 * the server then draws them in a bundled Latin Modern face and says so in
 * `fallback`. Nothing is substituted unasked: the bar names the missing
 * letters and offers "Use Latin Modern", and Save stays off until the user
 * accepts it or changes the text so it is no longer needed. The commit
 * carries the offer's id, which the server binds to that preparation. An
 * acceptance carries over to later drafts only while they need no other
 * letters and no other face. */
const fallbackKey = (f) => (f.fonts || []).map((x) => (x.face || x.lira || {}).file).join("|");

function fallbackPending(ed) {
  const f = ed.result?.fallback;
  if (!f?.needs_accept) return false;
  const a = ed.acceptedFallback;
  if (a && a.id !== f.id && a.key === fallbackKey(f)
      && [...f.missing].every((ch) => a.missing.includes(ch))) a.id = f.id;
  return !a || a.id !== f.id;
}

function fallbackAccept(ed) {
  const f = ed.result?.fallback;
  return f?.needs_accept && !fallbackPending(ed) ? { accept_fallback: f.id } : {};
}

function acceptFallback(ed) {
  const f = ed.result?.fallback;
  if (f?.needs_accept) ed.acceptedFallback = { id: f.id, key: fallbackKey(f), missing: f.missing };
}

/* The missing letters and the offer, in the bar. Returns whether Save must
 * stay off for it. */
function renderFallback(ed, bar, status) {
  const f = ed.result?.fallback;
  let btn = bar.querySelector("#ipfallback");
  if (!f?.needs_accept) {
    btn?.classList.add("hidden");
    return false;
  }
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "ebtn ghost";
    btn.id = "ipfallback";
    btn.addEventListener("click", () => { acceptFallback(ed); ed.render(); });
    status.after(btn);
  }
  const pending = fallbackPending(ed);
  const proseFont = f.kind === "prose_font";
  const letters = [...f.missing].join(" ");
  const faces = [...new Set((f.fonts || []).map((x) => (x.face || x.lira || {}).name))].join(", ");
  btn.textContent = faces ? `Use ${faces}` : "Use previewed fonts";
  btn.classList.toggle("hidden", !pending);
  btn.title = proseFont ? `Draw text in ${faces}` : `Draw ${letters} in ${faces}`;
  status.classList.toggle("bad", pending);
  status.textContent = proseFont
    ? (pending ? "This formula block has no prose font. Use the previewed font:" : `Text drawn in ${faces}.`)
    : pending
    ? `The document's font has no letters for: ${letters}. Change the text, or:`
    : `${letters} drawn in ${faces}.`;
  status.title = status.textContent;
  return pending;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ----------------------------- replacing a formula (8D.7) -----------------------------
 *
 * A formula the PDF already draws -- text glyphs, fraction rules -- is not an
 * edited block and has no source to reopen. To replace one: Replace Formula,
 * then draw a box around it. The server analyses exactly what the box selects
 * (analyze_formula) and changes nothing. A selection it cannot replace
 * safely is refused with its reason, and the content behind the refusal is
 * outlined on the page; draw the box again. A selection it can replace is
 * outlined, and a panel shows the selected original beside the replacement's
 * preview, with an empty source field: the original's LaTeX is not known and
 * is never guessed. Typed source is prepared like any draft
 * (prepare_formula) and Save commits exactly that preparation
 * (commit_edit). The result is a formula block, which reopens with the
 * source typed here. */
const FX = { on: false, drag: null, swallow: false };

const FX_LEAD = {
  unsafe_selection: "This selection cannot be replaced safely.",
  inline_drift_exceeded: "Replacing only this part would move the text after it.",
  stale_selection: "The page changed after the formula was selected.",
  stale_geometry: "The page changed after the formula was selected.",
};

function formulaMode(on) {
  if (on) setActiveMarkup(null);
  FX.on = on;
  $("#formula-toggle")?.classList.toggle("on", on);
  $("#formula-toggle")?.setAttribute("aria-pressed", String(on));
  $("#pages")?.classList.toggle("boxing", on);
  if (!on) clearFormulaMarks();
}

function clearFormulaMarks() {
  document.querySelectorAll(".fxband, .fxbad").forEach((el) => el.remove());
}

// A box on page `index`, in page points, as an overlay of class `cls`.
function pageBox(index, box, cls) {
  const wrap = document.getElementById(`page-${index}`);
  const page = S.doc?.pages[index];
  if (!wrap || !page) return null;
  const el = document.createElement("div");
  el.className = cls;
  const [x0, y0, x1, y1] = box;
  Object.assign(el.style, {
    left: `${(x0 / page.width) * 100}%`, top: `${(y0 / page.height) * 100}%`,
    width: `${((x1 - x0) / page.width) * 100}%`, height: `${((y1 - y0) / page.height) * 100}%`,
  });
  wrap.appendChild(el);
  return el;
}

const dragBox = (d) => [Math.min(d.from.x, d.to.x), Math.min(d.from.y, d.to.y),
                        Math.max(d.from.x, d.to.x), Math.max(d.from.y, d.to.y)];

// Capture phase: while boxing, a press on a page is the box's, not a text
// selection's and not a click on a run.
document.addEventListener("pointerdown", (ev) => {
  if (!FX.on || !S.doc || ev.button !== 0 || ev.target.closest("#editor")
      || !ev.target.closest("#stage")) return;
  const pt = pagePoint(ev);
  if (!pt) return;
  ev.stopPropagation();
  ev.preventDefault();
  if (!settleEditorNow("formula")) return;
  clearSelection();
  clearFormulaMarks();
  FX.drag = { page: pt.index, from: pt, to: pt, el: pageBox(pt.index, [pt.x, pt.y, pt.x, pt.y], "fxband") };
}, true);

document.addEventListener("pointermove", (ev) => {
  if (!FX.drag) return;
  const pt = pagePoint(ev, FX.drag.page);
  if (!pt) return;
  ev.stopPropagation();
  ev.preventDefault();
  FX.drag.to = pt;
  const page = S.doc.pages[FX.drag.page];
  const [x0, y0, x1, y1] = dragBox(FX.drag);
  Object.assign(FX.drag.el?.style || {}, {
    left: `${(x0 / page.width) * 100}%`, top: `${(y0 / page.height) * 100}%`,
    width: `${((x1 - x0) / page.width) * 100}%`, height: `${((y1 - y0) / page.height) * 100}%`,
  });
}, true);

document.addEventListener("pointerup", (ev) => {
  if (!FX.drag) return;
  ev.stopPropagation();
  const d = FX.drag;
  FX.drag = null;
  FX.swallow = true;                       // the click this press ends in
  const box = dragBox(d);
  if (box[2] - box[0] < 2 || box[3] - box[1] < 2) {
    d.el?.remove();
    return toast("Draw a box around the whole formula.", "warn");
  }
  analyzeFormula(d.page, box.map((v) => Math.round(v * 100) / 100), d.el);
}, true);

document.addEventListener("click", (ev) => {
  if (!FX.swallow) return;
  FX.swallow = false;
  if (!ev.target.closest("#stage") || ev.target.closest("#editor")) return;
  ev.stopPropagation();
  ev.preventDefault();
}, true);

async function analyzeFormula(index, rect, band) {
  const ticket = (FX.ticket = (FX.ticket || 0) + 1);
  const documentId = S.doc.doc;
  let a;
  try {
    a = await post("analyze_formula", { page: index, rect, geo: S.doc.pages[index]?.geo,
                                              dpi: Math.round(renderDpi()) });
  } catch (e) {
    if (FX.ticket !== ticket || S.doc.doc !== documentId) return;
    if (e.status === 409) await staleGeometry();
    band?.classList.add("bad");
    for (const box of e.body?.offending || []) pageBox(index, box, "fxbad");
    const lead = FX_LEAD[e.code];
    toast(lead ? `${lead} ${explain(e)}` : explain(e), "err");
    return;
  }
  if (FX.ticket !== ticket || S.doc.doc !== documentId) return;
  band?.remove();
  openFormulaEditor(index, a);
}

async function openFormulaEditor(index, a) {
  const documentId = S.doc.doc;
  if (!(await requestEditorTransition("formula")) || S.doc?.doc !== documentId) return;
  const wrapEl = document.getElementById(`page-${index}`);
  const page = S.doc.pages[index];
  if (!wrapEl || !page) return;
  const [bx0, by0, bx1, by1] = a.bounds;
  // The selection itself, outlined on the page; the panel hangs below it.
  const host = document.createElement("div");
  host.id = "editor";
  host.className = "inplace formula";
  host.dataset.page = index;
  Object.assign(host.style, {
    left: `${(bx0 / page.width) * 100}%`, top: `${(by0 / page.height) * 100}%`,
    width: `${((bx1 - bx0) / page.width) * 100}%`, height: `${((by1 - by0) / page.height) * 100}%`,
  });
  const bar = document.createElement("div");
  bar.className = "ipbar";
  bar.innerHTML = `
    <div class="fxpair">
      <figure><img class="fxorig" alt="The selected formula"><figcaption>Selected</figcaption></figure>
      <figure><img class="fxnew hidden" alt="Its replacement, as it will be saved"><figcaption>Replacement</figcaption></figure>
    </div>
    <span class="ipwas">${a.block ? "Edit formula" : "Replace formula"} · ${escapeHtml(String(a.size))}pt</span>
    <span class="ipsep"></span>
    <button class="ebtn ghost" id="ipinsert" type="button"
            title="Put $ delimiters around the selected source">Insert formula</button>
    <span class="ipstatus"></span>
    <button class="ebtn ghost hidden" id="ipgoto" type="button">Show</button>
    <span class="ipspacer"></span>
    <button class="ebtn ghost" id="ipcancel">Cancel</button>
    <button class="ebtn" id="ipsave" disabled>Apply</button>`;
  const source = makeSource();
  source.ta.placeholder = "The replacement, e.g. $\\frac{a}{b}$ or $$x^2$$";
  bar.prepend(source.wrap);
  const orig = bar.querySelector(".fxorig");
  if (a.original?.png) orig.src = `data:image/png;base64,${a.original.png}`;
  host.appendChild(bar);
  wrapEl.appendChild(host);
  syncUndo();

  S.editGeo = a.geo;
  S.editAt = null;
  // A box over a formula this editor saved (a formula block) selects that
  // formula: its saved source is known exactly, so it is what the field
  // starts from, and Save edits the block in place under its id.
  const saved = formulaSource(a);
  source.ta.value = saved;
  const ed = newDraft({ page: index, kind: "formula", mode: "latex", editor: newEditorId(),
                        selection: a.token, size: a.size, original: saved, origBox: a.original?.box,
                        block: a.block || null, text: () => source.ta.value });
  ed.op = "prepare_formula";
  ed.empty = () => !source.ta.value.trim();
  ed.body = (common) => ({ page: index, selection: ed.selection, source: ed.text(),
                           size: ed.size, ...common });
  // The selection is bound to the state it was analysed on: once that is
  // gone, the draft stays but cannot be saved; the formula is selected again.
  ed.onStale = (err) => {
    host.dataset.stale = "1";
    ed.refusal = { message: `${FX_LEAD.stale_selection} ${explain(err)} Draw the box again; `
                   + "your source is still here.", code: err.code };
    ed.render();
  };
  S.draft = ed;
  globalThis.PDFDraftRecovery?.opened(ed);
  ed.render = () => showFormula(ed, { host, bar, source, wrapEl, page });
  globalThis.PDFInspector?.attach({host,bar,ed,source});
  ed.render();
  wireSource(ed, source, bar);
  ed.apply = () => sendEdit("commit_edit", { token: ed.token });
  const save = () => {
    if (bar.querySelector("#ipsave").disabled) return;
    if (!draftReady(ed) || host.dataset.stale) return;
    ed.apply();
  };
  bar.querySelector("#ipsave").onclick = save;
  bar.querySelector("#ipcancel").onclick = () => requestEditorTransition("cancel");
  source.ta.addEventListener("keydown", (ev) => {
    if (ev.isComposing || ed.composing) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); save(); }
    else if (ev.key === "Escape") { ev.preventDefault(); requestEditorTransition("cancel"); }
  });
  host.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  source.ta.focus();
  mathCaps().then(() => { if (!ed.closed) ed.render(); });
}

/* The saved source an analysis answered with for a formula block's formula
 * (pdf_formula_prep.BlockSelection), or "" for an original formula, whose
 * LaTeX is not known and is never guessed. */
function formulaSource(a) {
  return a?.block && typeof a.source === "string" ? a.source : "";
}

function showFormula(ed, v) {
  const { host, bar, source, page } = v;
  const ready = draftReady(ed);
  const r = ed.result;
  const img = bar.querySelector(".fxnew");
  const p = ready && r?.preview;
  if (p?.png && img.dataset.token !== ed.token) {
    img.src = `data:image/png;base64,${p.png}`;
    img.dataset.token = ed.token;
  }
  img.classList.toggle("hidden", !p?.png);
  // Both pictures at the page's own scale, so they compare.
  const k = v.wrapEl.getBoundingClientRect().width / page.width;
  for (const [el, box] of [[bar.querySelector(".fxorig"), ed.origBox], [img, p?.box]]) {
    const b = Array.isArray(box) ? box : null;
    if (b) el.style.width = `${Math.max(24, (b[2] - b[0]) * k * 1.5)}px`;
  }
  const status = bar.querySelector(".ipstatus");
  status.classList.toggle("bad", !!ed.refusal);
  status.textContent = ed.refusal ? refusalText(ed)
    : ed.empty() ? "Type the replacement between $...$ (inline) or $$...$$ (display)."
      : ed.original && ed.text() === ed.original && !ed.pending && !ready
        ? "This formula's saved source: change it to replace the formula."
        : ed.pending || !ready ? "Preparing…" : (r.info || r.reason || "");
  status.title = status.textContent;
  if (mathOff() && !ed.refusal) {
    status.textContent = status.title = mathReason();
    status.classList.add("bad");
  }
  const ranges = ed.refusal?.ranges || [];
  bar.querySelector("#ipgoto").classList.toggle("hidden", !ranges.length);
  markSource(source, ranges.map((x) => x.range));
  bar.querySelector("#ipsave").disabled = !ready || !!host.dataset.stale;
  placeBar(bar);
}

$("#formula-toggle")?.addEventListener("click", async () => {
  if (FX.on) return formulaMode(false);
  await mathCaps();
  if (mathOff()) return toast(mathReason(), "err");
  formulaMode(true);
  toast("Draw a box around the formula to replace.", "ok");
});

/* ----------------------------- actions ----------------------------- */

// A structural response may arrive after the host adopted another document or
// layout. Its page-index mapping belongs only to the state it actually produced.
function pageReceiptCurrent(receipt, ownerDoc) {
  return !!receipt && receipt.doc === ownerDoc && receipt.doc === S.doc?.doc
    && receipt.revision === S.revision && receipt.layout === S.doc?.layout;
}

function selectedPages() {
  return [...S.selected].sort((a, b) => a - b);
}

/* Any edit but the in-place editor's: marks, comments, styling, page operations.
 *
 * What gets redrawn afterwards is what the server says changed. This used to
 * call load() for anything it could not name one page for, which re-fetches the
 * document and re-renders EVERY page in it -- seconds of work on a 700-page file
 * to show a change inside one paragraph. Rotate, delete and reorder still do
 * that, because they really do change the whole document, and the server says
 * so (layout_changed). */
async function mutate(op, body, describe) {
  try {
    const r = await post(op, body);
    await afterEdit(r);
    refreshNotes(r);
    refreshUndo();
    toast(describe(r), "ok");
    return r;
  } catch (e) {
    if (e.status === 409) await staleGeometry();
    // A refusal records nothing, but what can be undone is still asked for:
    // the server, not this file, says whether anything moved.
    refreshUndo();
    // The server rejects an edit it cannot prove safe. Surfacing the reason
    // verbatim matters more than a tidy message -- it says what it protected.
    toast(explain(e), "err");
    return null;
  }
}

/* Take in what a successful edit changed, leaving the rest of the document
 * exactly where it is on screen.
 *
 * The answer names the pages the commit reached and their new tokens, so when
 * it is the very next revision nothing needs asking again: those pages are
 * redrawn, and those whose characters moved drop their text layer and their
 * selection characters. An answer that is not the next revision means another
 * change landed in between -- two edits in flight, or one that committed and
 * then failed -- and the document's own list of tokens is asked for instead. An
 * older answer is already included in whatever was adopted after it.
 */
async function afterEdit(r) {
  if (!S.doc || r.doc !== S.doc.doc || r.layout_changed || r.layout !== S.doc.layout) {
    return load();
  }
  if (r.revision <= S.revision) return;
  if (r.revision !== S.revision + 1 || !r.tokens) return resync();
  S.revision = S.doc.revision = r.revision;
  globalThis.PDFUI?.revisionChanged?.();
  S.doc.ops = r.ops;
  showOps();
  for (const [index, t] of Object.entries(r.tokens)) {
    const p = S.doc.pages[Number(index)];
    if (!p) continue;
    const moved = p.geo !== t.geo, redrawn = p.look !== t.look;
    p.geo = t.geo;
    p.look = t.look;
    if (moved) dropGeometry(p.index);
    if (redrawn) repaint(p.index);
  }
}

/* Catch up with the document's current versions: redraw every page whose
 * appearance changed, drop the characters of every page whose geometry did.
 *
 * Shared by everyone who asks while one is in flight. A layout or document that
 * is not the one on screen reloads everything; an answer older than the
 * revision already adopted is ignored, because it could only move tokens
 * backwards. */
let resyncing = null;
function resync() {
  if (resyncing) return resyncing;
  resyncing = (async () => {
    if (!S.doc) return;
    let info;
    try { info = await api("get_document_info", {}, { priority: "edit" }); } catch { return; }
    if (info.doc !== S.doc.doc || info.layout !== S.doc.layout
        || info.pages.length !== S.doc.pages.length) {
      await load();
      await refreshUndo();
      return;
    }
    if (info.revision < S.revision) return;
    const old = S.doc.pages;
    adoptDoc(info);
    showOps();
    info.pages.forEach((p, i) => {
      if (old[i]?.geo !== p.geo) dropGeometry(i);
      if (old[i]?.look !== p.look) repaint(i);
    });
  })().finally(() => { resyncing = null; });
  return resyncing;
}

/* A change this viewer did not make, as the transport announces it: another
 * view of the same document edited it, or the host undid, redid or reverted.
 * Taken in the way a missed answer is -- the document's tokens are read again
 * (resync) and exactly the pages whose versions moved are redrawn -- so an
 * undo is never mistaken for a new edit here: nothing is sent back. One that
 * names a revision already adopted (this viewer's own edit, answered first,
 * or an older announcement arriving late) changes nothing; one for another
 * document reloads everything. Over HTTP nothing is announced. */
function documentChanged(ev) {
  if (!S.doc || !ev) return;
  // What Undo and Redo would do moved with it -- asked once caught up.
  if (ev.doc !== S.doc.doc) return load().then(refreshUndo);
  if (ev.revision > S.revision) return resync().then(refreshUndo);
}

/* A page's characters moved: the geometry a selection is measured against and
 * the text layer drawn from it are both stale. */
function dropGeometry(index) {
  delete S.lines[index];
  const layer = document.querySelector(`.tlayer[data-page="${index}"]`);
  if (layer) {
    layer.innerHTML = "";
    delete layer.dataset.loaded;
    if (S.editOn) drawText(index);
  }
}

/* A page's pixels changed: fetch its new image under its new version.
 *
 * A mounted page, or a thumbnail in reach, is swapped in decoded, so it never
 * blanks. Anything else holds no image at all and asks for the current
 * version when it is mounted, so an edit that reached many pages does not
 * become a request per page -- and nothing holds an image URL of a version
 * that no longer exists, which would come back 410. */
function repaint(index) {
  const p = S.doc.pages[index];
  if (!p) return;
  if (VIEW.mounted.has(index)) paintPage(index, renderDpi(), false);
  if (RAIL.mounted.has(index)) {
    showImage(RAIL.thumbs[index].firstChild, thumbKey(index), p.look, undefined, "thumb");
  }
}

/* SAFE-05: one structural page operation (rotate, delete, reorder) at a time.
 * From its click until its answer has been taken in, and while any other
 * change or an undo/redo is unresolved, the page-operation buttons are off and
 * a repeated click is ignored, so a rapid repeat is never submitted again.
 * Reading controls (zoom, navigation, search) are not affected.
 * PDFUI.selectionChanged (workspace.js) applies pageOpsBlocked() to the buttons. */
const PAGEOPS = { busy: false };
function pageOpsBlocked() {
  return PAGEOPS.busy || NET.changes > 0 || !!UNDO.busy;
}
async function pageOp(run) {
  if (pageOpsBlocked()) return null;
  PAGEOPS.busy = true;
  globalThis.PDFUI?.selectionChanged?.();
  try { return await run(); } finally {
    PAGEOPS.busy = false;
    globalThis.PDFUI?.selectionChanged?.();
  }
}

function rotateSelection(degrees) {
  return pageOp(async () => {
    const pages = selectedPages(), layout = S.doc.layout, doc = S.doc.doc;
    if (!pages.length || !(await requestEditorTransition("rotate"))) return;
    if (doc !== S.doc.doc || layout !== S.doc.layout) return toast('Page layout changed. Select pages again.', 'warn');
    const result = await mutate("page.rotate", { pages, degrees, layout }, () => `Rotated ${pages.length} page(s).`);
    if (pageReceiptCurrent(result, doc)) { S.selected = new Set(pages); S.selectionAnchor = pages[0]; syncRailSelection(); }
  });
}
$("#rot-l").onclick = () => rotateSelection(-90);
$("#rot-r").onclick = () => rotateSelection(90);
$("#del").onclick = () => pageOp(async () => {
  if (NOTES.drafts.size) { toast("Apply or cancel comment drafts before deleting pages.", "warn"); return; }
  const pages = selectedPages(), layout = S.doc.layout, doc = S.doc.doc;
  if (!pages.length || !(await requestEditorTransition("delete"))) return;
  if (doc !== S.doc.doc || layout !== S.doc.layout) return toast("Page layout changed. Select pages again.", "warn");
  if (!confirm(`Delete ${pages.length} selected page(s)? The source file is preserved; Undo restores this change.`)) return;
  const result = await mutate("page.delete", { pages, layout }, () => `Deleted ${pages.length} page(s).`);
  if (pageReceiptCurrent(result, doc)) { const next = Math.min(pages[0], S.doc.pages.length - 1); S.selected = new Set(next >= 0 ? [next] : []); S.selectionAnchor = next; S.selectionFocus = next; syncRailSelection(); globalThis.PDFUI?.navigate(next); }
});

/* ----------------------------- undo and redo (10.5b) -----------------------------
 *
 * Every successful edit is one verified state the server keeps on disk, and
 * Undo and Redo put the exact bytes of the one before or after it back. What
 * can be undone is the server's to say, never this file's to work out: its
 * answer (get_state) is asked for after every edit, and Undo names the change
 * it undoes and the revision it was read at -- so a press measured on a state
 * that has moved on is refused, not applied to whatever is there now.
 *
 * The buttons are off while there is nothing to undo, while the state shown
 * is not the document's current revision, while a change is still with the
 * server (one at a time: a second press cannot undo twice), and while an
 * editor is open -- its draft is the user's, and an undo underneath it would
 * leave it describing text that is no longer there. Cmd/Ctrl+Z and
 * Cmd/Ctrl+Shift+Z or Ctrl+Y press them, except in a text field: there the
 * browser's own undo of what was typed is the one meant.
 *
 * A restoration moves every version: a new revision and a new layout token,
 * so the document is read again whole -- pages, thumbnails, text layers and
 * blocks, comments, fonts -- exactly as after a page operation. */
const UNDO = {
  state: null,          // the server's last answer: get_state, or an undo's or redo's
  asked: 0,             // the newest get_state, so an older answer cannot win
  busy: null,           // "undo" or "redo" while one is with the server
};

// What the toolbar calls each kind of change (the service's ChangeRecord label).
const CHANGE_LABEL = {
  "text.replace": "Replace text", "text.style": "Style text", "text.reflow": "Edit paragraph",
  "list.remove_marker": "Remove list marker", "annot.mark": "Mark text", "annot.note": "Add note",
  "annot.update": "Edit comment", "annot.delete": "Delete mark", "page.rotate": "Rotate pages",
  "page.delete": "Delete pages", "page.reorder": "Reorder pages", "block.commit": "Edit text",
};
const changeLabel = (label) => CHANGE_LABEL[label] || "Edit";
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const UNDO_KEYS = { undo: IS_MAC ? "⌘Z" : "Ctrl+Z", redo: IS_MAC ? "⇧⌘Z" : "Ctrl+Y" };

// The step `dir` would take now, as the server described it: null if none.
function undoStep(dir) {
  const st = UNDO.state;
  if (!S.doc || !st || st.document_id !== S.doc.doc || st.revision !== S.revision) return null;
  const can = dir === "undo" ? st.can_undo : st.can_redo;
  const id = dir === "undo" ? st.undo_change_id : st.redo_change_id;
  if (!can || !id) return null;
  return { change_id: id, revision: st.revision,
           label: changeLabel(dir === "undo" ? st.undo_label : st.redo_label) };
}

// Why neither may be pressed now, or "".
function undoBlocked() {
  if (UNDO.busy) return "working";
  if (NET.changes || S.unverified) return "an edit is being saved";
  if (document.getElementById("editor")) return "save or cancel the open editor first";
  return "";
}

function syncUndo() {
  const blocked = undoBlocked();
  for (const dir of ["undo", "redo"]) {
    const btn = document.getElementById(dir);
    if (!btn) continue;
    const step = undoStep(dir);
    const name = dir === "undo" ? "Undo" : "Redo";
    btn.disabled = !step || !!blocked;
    btn.title = step ? `${name}: ${step.label} (${UNDO_KEYS[dir]})`
      + (blocked && blocked !== "working" ? ` — ${blocked}` : "")
      : `Nothing to ${dir}`;
  }
  // Page operations are off on the same transitions (SAFE-05, pageOpsBlocked).
  globalThis.PDFUI?.selectionChanged?.();
}

/* Take a state the server answered with. One for a newer revision than the
 * viewer has adopted means the document moved on without this viewer hearing
 * of it (an edit refused after its bytes were put back): caught up with, once
 * no change of this viewer's is still on its way to say so itself. */
function takeUndo(st) {
  if (!st) return;
  const held = UNDO.state;
  if (held && held.document_id === st.document_id && st.revision < held.revision) return;
  UNDO.state = st;
  globalThis.PDFUI?.savedState(st);
  if (S.doc && st.document_id === S.doc.doc && st.revision > S.revision
      && !NET.changes && !UNDO.busy) resync();
  syncUndo();
}

async function refreshUndo() {
  if (!S.doc) return;
  const ticket = ++UNDO.asked;
  let st;
  try {
    st = await api("get_state", {}, { priority: "edit" });
  } catch {
    if (ticket === UNDO.asked) { UNDO.state = null; syncUndo(); globalThis.PDFUI?.syncSaveStatus?.(); }
    return;
  }
  if (ticket === UNDO.asked) takeUndo(st);
}

async function undoRedo(dir) {
  const step = undoStep(dir);
  const blocked = undoBlocked();
  if (!step) return;
  if (blocked) {
    if (blocked !== "working") toast(`Nothing was ${dir === "undo" ? "undone" : "redone"}: ${blocked}.`, "warn");
    return;
  }
  // Off before anything is sent, so the second click of a double one finds
  // the button already off.
  UNDO.busy = dir;
  syncUndo();
  // What was measured on the state being left goes with it.
  clearSelection();
  clearFormulaMarks();
  // PERF-01: pressed -> restored state answered -> document read again.
  const timing = globalThis.PDFPerf?.begin(dir);
  try {
    const r = await post(dir, { change_id: step.change_id, revision: step.revision }, timing);
    globalThis.PDFPerf?.mark(timing, "answered");
    UNDO.state = r.state;
    await afterRestore(r);
    globalThis.PDFPerf?.end(timing, "ok");
    toast(`${dir === "undo" ? "Undone" : "Redone"}: ${step.label}.`, "ok");
  } catch (e) {
    globalThis.PDFPerf?.end(timing, "refused");
    // A lost answer is settled by reconcile (in post), which reads the
    // document back; a refusal changed nothing. Either way the state is asked
    // for again below.
    if (e.status === 409) await resync();
    toast(explain(e), "err");
  } finally {
    UNDO.busy = null;
    syncUndo();
    refreshUndo();
  }
}

/* After an undo or redo: everything is read again under the new layout. */
async function afterRestore(r) {
  const n = r.state?.page_count ?? 0;
  for (const i of [...S.selected]) if (i >= n) S.selected.delete(i);
  // Faces registered for the fonts as they were: the epoch moved, so none of
  // their names is current.
  for (const style of S.fonts.values()) {
    style.remove();
    style.release?.();
  }
  S.fonts.clear();
  await load();
  refreshNotes({ layout_changed: true, doc: S.doc?.doc, layout: S.doc?.layout, affected_pages: [] });
}

$("#undo").onclick = () => undoRedo("undo");
$("#redo").onclick = () => undoRedo("redo");
NET.watch = syncUndo;

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
  const el = e.target;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
  const key = (e.key || "").toLowerCase();
  const dir = key === "z" ? (e.shiftKey ? "redo" : "undo")
    : key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey ? "redo" : null;
  if (!dir || !S.doc) return;
  e.preventDefault();
  undoRedo(dir);
});

$("#zoom-in").onclick  = () => setZoom(S.zoom * 1.25);
$("#zoom-out").onclick = () => setZoom(S.zoom / 1.25);

/* Zoom, keeping one point of the document exactly where it is on screen.
 *
 * `anchor` is that client point -- the pointer, for a pinch or a ctrl-wheel;
 * the middle of the view for the toolbar buttons and the keyboard, which used
 * to pass nothing at all and so left the scroll offset untouched while the
 * content around it grew, walking the page away from whatever was being read.
 *
 * The point is recorded in the PAGE's own coordinates and put back after the
 * re-layout, rather than predicted from the zoom ratio. Predicting assumes the
 * scrolled content scales linearly with the zoom, and the stage's padding and
 * its centring of a page narrower than the well both make that false -- which
 * is what made zooming feel like it re-centred the document on every step.
 */
function setZoom(z, anchor, settled = false, mode = 'custom') {
  if (!Number.isFinite(z)) return;
  const stage = $("#stage");
  const next = Math.min(8, Math.max(0.1, z));
  if (Math.abs(next - S.zoom) < 1e-4) { S.viewMode = mode; globalThis.PDFUI?.zoomChanged?.(); return; }

  const sr = stage.getBoundingClientRect();
  const at = anchor || { x: sr.left + stage.clientWidth / 2,
                         y: sr.top + stage.clientHeight / 2 };
  const keep = anchorPoint(at);

  if (!S.draft && !settleEditorNow("zoom")) return;
  S.viewMode = mode;
  S.zoom = next;
  globalThis.PDFUI?.zoomChanged?.();
  $("#zoomlbl").value = `${Math.round(S.zoom * 100)}%`;
  // In-place drafts and their Properties controls survive zoom unchanged.
  clearSelection();   // and so is the mark bar
  zoomPages(settled); // widths and heights are applied synchronously

  if (!keep) return;
  const wrap = document.getElementById(`page-${keep.index}`);
  const page = S.doc.pages.find((p) => p.index === keep.index);
  if (!wrap || !page) return;
  const r = wrap.getBoundingClientRect();
  const k = r.width / page.width;
  stage.scrollLeft += r.left + keep.x * k - at.x;
  stage.scrollTop += r.top + keep.y * k - at.y;
}

/* The document point under a client point, as {index, x, y} in page points.
 *
 * The page it is over, or the nearest one when it is over the grey well
 * between two pages or beside a narrow one. Offsets outside the page are kept
 * rather than clamped: what has to stay still is the point on the screen, and
 * "18pt to the left of page 4" is as good an answer as any point on the paper.
 */
function anchorPoint(pt) {
  if (!S.doc || !VIEW.shells.length) return null;
  // Vertical distance dominates below and pages are stacked, so the nearest
  // page is the one level with the point or a neighbour of it. The index finds
  // that one; only it and the pages either side are measured.
  const stage = $("#stage");
  const level = pageAtOrBelow(pt.y - stage.getBoundingClientRect().top + stage.scrollTop);
  const last = Math.min(S.doc.pages.length - 1, level + 2);
  let best = null, bestGap = Infinity;
  for (let i = Math.max(0, level - 2); i <= last; i++) {
    const p = S.doc.pages[i];
    const wrap = VIEW.shells[i];
    if (!wrap) continue;
    const r = wrap.getBoundingClientRect();
    if (!r.width) continue;
    const dy = pt.y < r.top ? r.top - pt.y : pt.y > r.bottom ? pt.y - r.bottom : 0;
    const dx = pt.x < r.left ? r.left - pt.x : pt.x > r.right ? pt.x - r.right : 0;
    // Vertical distance dominates: pages are stacked, so the page level with
    // the point is the one being looked at even when the point is off to one
    // side of it.
    const gap = dy * 1000 + dx;
    if (gap < bestGap) { bestGap = gap; best = { p, r }; }
  }
  if (!best) return null;
  const k = best.r.width / best.p.width;
  return { index: best.p.index,
           x: (pt.x - best.r.left) / k,
           y: (pt.y - best.r.top) / k };
}

/* Trackpad and mouse zoom.
 *
 * A Mac trackpad pinch is reported two different ways and this has to handle
 * both, because the one it does not handle is the one that zooms the browser
 * instead of the document:
 *
 *   - Chrome, Edge and Firefox turn a pinch into a `wheel` event with ctrlKey
 *     set. Ctrl/Cmd plus a mouse wheel arrives identically.
 *   - Safari sends no such wheel event at all. It sends its own non-standard
 *     `gesturestart` / `gesturechange` / `gestureend` pair with a `scale`.
 *
 * Either way, preventDefault is what stops the browser zooming its own UI --
 * which scales the chrome and leaves the document exactly as it was, the
 * symptom this listener exists to prevent.
 *
 * Listeners live on `window`, but only document-stage gestures are consumed.
 * Source fields and application chrome retain browser accessibility zoom. `passive: false` must
 * stay explicit -- Chrome makes wheel listeners on window passive by default,
 * and a passive listener is not allowed to preventDefault, so dropping it puts
 * the bug straight back.
 *
 * Resize the real page boxes at most once per animation frame. Images, tiles,
 * text and editing overlays all keep the same geometry during and after the
 * gesture. Only sharper pixels wait for idle; there is no transformed stack
 * to reconcile with unscaled page gaps at the end of a pinch.
 */
(function pinchZoom() {
  let pending = null, frame = 0, settle = 0, paintedDoc = null;
  const documentTarget = target => !!target.closest?.("#stage") && !target.closest?.("#editor,input,textarea,select,[contenteditable]");
  const clamp = z => Math.min(8, Math.max(0.1, z));

  function flush() {
    cancelAnimationFrame(frame);
    frame = 0;
    const update = pending;
    pending = null;
    // A document load or another zoom command supersedes queued input.
    if (!update || update.doc !== S.doc || update.from !== S.zoom) return;
    const before = S.zoom;
    setZoom(update.zoom, update.point);
    if (S.zoom !== before) paintedDoc = S.doc;
  }

  function finish() {
    clearTimeout(settle);
    flush();
    if (paintedDoc && paintedDoc === S.doc) renderVisible(0);
    paintedDoc = null;
  }

  function preview(z, point) {
    if (!S.doc || !Number.isFinite(z)) return;
    pending = { doc: S.doc, from: S.zoom, zoom: clamp(z), point };
    if (!frame) frame = requestAnimationFrame(flush);
    clearTimeout(settle);
    settle = setTimeout(finish, 140);
  }

  window.addEventListener("wheel", ev => {
    if ((!ev.ctrlKey && !ev.metaKey) || !S.doc || !documentTarget(ev.target)) return;
    if (!Number.isFinite(ev.deltaY)) return;
    ev.preventDefault();
    const base = pending?.doc === S.doc && pending.from === S.zoom ? pending.zoom : S.zoom;
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? $("#stage").clientHeight : 1;
    preview(base * Math.exp(-ev.deltaY * unit / 180), { x: ev.clientX, y: ev.clientY });
  }, { passive: false, capture: true });

  // Safari reports a cumulative scale rather than wheel deltas.
  let gestureBase = 1, gestureActive = false;
  window.addEventListener("gesturestart", ev => {
    gestureActive = !!S.doc && documentTarget(ev.target);
    if (!gestureActive) return;
    ev.preventDefault();
    flush();
    gestureBase = S.zoom;
  }, { passive: false });
  window.addEventListener("gesturechange", ev => {
    if (!gestureActive) return;
    ev.preventDefault();
    preview(gestureBase * ev.scale, { x: ev.clientX, y: ev.clientY });
  }, { passive: false });
  window.addEventListener("gestureend", ev => {
    if (!gestureActive) return;
    gestureActive = false;
    ev.preventDefault();
    finish();
  }, { passive: false });
  window.addEventListener("blur", () => { gestureActive = false; finish(); });

  window.addEventListener("keydown", ev => {
    if (!(ev.ctrlKey || ev.metaKey) || !S.doc || !documentTarget(ev.target)) return;
    if (!["+", "=", "-", "0"].includes(ev.key)) return;
    ev.preventDefault();
    finish();
    if (ev.key === "+" || ev.key === "=") setZoom(S.zoom * 1.25);
    else if (ev.key === "-") setZoom(S.zoom / 1.25);
    else globalThis.PDFUI?.fit(true, 'fit-page');
  });
})();

/* ----------------------------- comments ----------------------------- */

/* Highlights, underlines, strikeouts and notes, listed as what they say.
 *
 * The page image already draws the marks. What it cannot show is who made one,
 * when, what they wrote, or -- for a highlight -- which words it is actually
 * over, because a PDF never records that: the annotation states four corners
 * and the text underneath has to be looked up. The server does that lookup, so
 * a row here reads as a comment about a sentence rather than as a coloured
 * rectangle somewhere on page 7.
 */
const KIND_LABEL = {
  Highlight: "Highlight", Underline: "Underline", StrikeOut: "Strikeout",
  Squiggly: "Squiggly", Text: "Note", FreeText: "Text box", Ink: "Drawing",
  Stamp: "Stamp", Line: "Line", Square: "Box", Circle: "Oval",
};

/* What the panel lists, kept between draws.
 *
 * Kept so that an edit can replace the records of the pages it reached -- the
 * server names them -- instead of the panel asking for every annotation in the
 * document after each one. Each page remembers the revision its records were
 * read at, so an answer that arrives after a newer one for the same page is
 * not allowed to put the older records back.
 *
 * The list itself is mounted in chunks, like the pages: every chunk has a box
 * of its measured (or, until measured, estimated) height, and only the chunks
 * within a panel-height of what the panel shows hold rows. A document with two
 * thousand comments used to build two thousand rows on every open.
 */
const NOTES = {
  all: [],              // every record, in the server's order: by page, then down it
  doc: null,            // the document and layout they describe
  layout: null,
  base: -1,             // revision of the last complete read
  rev: new Map(),       // page -> revision of a later partial read of it
  complete: false,      // the server listed everything (not truncated)
  filteredTop: [],       // displayed root threads; canonical records stay in all
  composing: new Set(), // defer redraws during IME composition
  top: [],              // compatibility alias for displayed root threads
  replies: new Map(),   // xref -> the records replying to it, in order
  byXref: new Map(),
  chunks: [],           // chunk k's box, holding rows k*NOTE_CHUNK onwards
  seen: null,           // the observer deciding which chunks hold rows
  heights: new Map(),   // xref -> its row's measured height, px (margin included)
  drafts: new Map(),    // xref -> text of an open, unsaved note editor
  sel: null,            // xref of the selected row
};
const NOTE_CHUNK = 40;
const NOTE_GUESS = 96;  // px: a row not yet measured

async function drawNotes() {
  let data;
  try { data = await api("list_annotations"); } catch (e) { return; }
  if (takeNotes(data, null)) renderNotes();
}

/* After an edit: bring in what it changed. A closed panel asks for everything
 * when it is next opened, so only an open one does anything here. */
async function refreshNotes(r) {
  if (!r || $("#notes").classList.contains("hidden")) return;
  const pages = r.affected_pages || [];
  if (r.layout_changed || !S.doc || r.doc !== NOTES.doc || r.layout !== NOTES.layout
      || !NOTES.complete) {
    return drawNotes();
  }
  if (!pages.length) return;
  let data;
  try { data = await api("list_annotations", { pages }); } catch (e) { return drawNotes(); }
  if (data.truncated) return drawNotes();
  if (takeNotes(data, data.pages || pages)) renderNotes();
}

/* Fold a list_annotations answer into NOTES: for `pages`, or for every page when
 * that is null. Returns whether anything was taken. A page whose records were
 * read at a later revision than this answer keeps them. */
function takeNotes(data, pages) {
  if (!data || !S.doc || data.doc !== S.doc.doc || data.layout !== S.doc.layout
      || (pages && data.truncated)) return false;
  const fresh = data.doc !== NOTES.doc || data.layout !== NOTES.layout;
  if (fresh) {
    if (pages) return false; // a new layout needs a complete baseline
    if (NOTES.doc !== data.doc) {
      NOTES.drafts.clear();
      NOTES.composing.clear();
      NOTES.pendingRender = false;
      NOTES.sel = null;
    }
    NOTES.heights.clear();
    NOTES.resetView = true;
    NOTES.doc = data.doc;
    NOTES.layout = data.layout;
    NOTES.rev.clear();
    NOTES.base = -1;
    NOTES.all = [];
  } else if (pages && !NOTES.complete) {
    return false;
  }
  const revOf = (p) => Math.max(NOTES.base, NOTES.rev.get(p) ?? -1);
  const byPage = new Map();
  for (const a of NOTES.all) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  const incoming = new Map();
  for (const a of data.annots || []) {
    if (!incoming.has(a.page)) incoming.set(a.page, []);
    incoming.get(a.page).push(a);
  }
  const covered = pages ? pages : [...new Set([...byPage.keys(), ...incoming.keys()])];
  let took = false;
  for (const p of covered) {
    if (revOf(p) > data.revision) continue;
    if (incoming.has(p)) byPage.set(p, incoming.get(p));
    else byPage.delete(p);
    if (pages) NOTES.rev.set(p, data.revision);
    took = true;
  }
  if (!pages) {
    NOTES.base = Math.max(NOTES.base, data.revision);
    for (const [p, v] of NOTES.rev) if (v <= NOTES.base) NOTES.rev.delete(p);
    NOTES.complete = !data.truncated;
    took = true;
  }
  NOTES.all = [...byPage.keys()].sort((a, b) => a - b).flatMap((p) => byPage.get(p));
  return took;
}

/* Rows and their replies, in one pass over the records. A reply sits under
 * the record it answers when that record is listed, and is a row of its own
 * when it is not. */
function groupNotes(all) {
  const byXref = new Map(all.map((a) => [a.xref, a]));
  const top = [], replies = new Map();
  for (const a of all) {
    if (a.reply_to && byXref.has(a.reply_to)) {
      if (!replies.has(a.reply_to)) replies.set(a.reply_to, []);
      replies.get(a.reply_to).push(a);
    } else {
      top.push(a);
    }
  }
  return { top, replies, byXref };
}

function noteRow(a) {
  const replies = [], seen = new Set([a.xref]);
  const pending = [...(NOTES.replies.get(a.xref) || [])].reverse();
  while(pending.length) {
    const reply=pending.pop();if(seen.has(reply.xref))continue;
    seen.add(reply.xref);replies.push(reply);
    for(const child of [...(NOTES.replies.get(reply.xref)||[])].reverse())pending.push(child);
  }
  const swatch = a.color
    ? `background:rgb(${a.color.map((c) => Math.round(c * 255)).join(",")})`
    : "background:var(--line)";
  const who = [a.author, a.created].filter(Boolean).join(" · ");
  return `<div class="note${a.xref === NOTES.sel ? " sel" : ""}" data-page="${a.page}" data-xref="${a.xref}">
      <div class="nrow">
        <span class="ndot" style="${swatch}"></span>
        <span class="nkind">${escapeHtml(KIND_LABEL[a.kind] || a.kind)}</span>
        <span class="npage">p${a.page + 1}</span>
      </div>
      ${a.quoted ? `<div class="nquote">${escapeHtml(a.quoted)}</div>` : ""}
      ${a.contents ? `<div class="nbody">${escapeHtml(a.contents)}</div>` : ""}
      ${who ? `<div class="nwho">${escapeHtml(who)}</div>` : ""}
      ${replies.map((r) => `<div class="nreply">
          <div class="nbody">${escapeHtml(r.contents)}</div>
          <div class="nwho">${escapeHtml([r.author, r.created].filter(Boolean).join(" · "))}</div>
        </div>`).join("")}
      ${NOTES.drafts.has(a.xref) ? '<div class="ndraft-label">Unapplied draft · kept visible</div>' : ""}
      <div class="nacts">
        <button class="nact" data-act="edit">${a.contents ? "Edit note" : "Add note"}</button>
        <button class="nact danger" data-act="del">Delete</button>
      </div>
    </div>`;
}

function renderNotes() {
  if (NOTES.composing.size) { NOTES.pendingRender = true; return; }
  globalThis.PDFUI?.beforeNotesRender?.();
  const panel = $("#notes");
  const rows = [...panel.querySelectorAll('.note')];
  const topEdge = panel.getBoundingClientRect?.().top + (NOTES.controls?.offsetHeight || 0);
  const anchorRow = rows.find(el => el.getBoundingClientRect().bottom > topEdge);
  const anchor = !NOTES.resetView && anchorRow ? {xref:Number(anchorRow.dataset.xref), offset:anchorRow.getBoundingClientRect().top-topEdge} : null;
  const active = document.activeElement;
  const heldEditors = new Map(rows.flatMap(el => {const editor=el.querySelector('.nedit');return editor?[[Number(el.dataset.xref),editor]]:[];}));
  NOTES.heldEditors = heldEditors;
  const style = globalThis.getComputedStyle?.(panel);
  const density = `${panel.clientWidth}:${style?.fontSize}:${style?.lineHeight}`;
  if(NOTES.heightDensity!==density){NOTES.heights.clear();NOTES.heightDensity=density;NOTES.resetView=true;}
  if(!NOTES.controls) {
    NOTES.controls=document.createElement('div');NOTES.controls.id='notes-controls';NOTES.controls.className='nhead';NOTES.controls.textContent='Comments';
    NOTES.count=document.createElement('span');NOTES.count.className='ncount';NOTES.controls.append(NOTES.count);
    NOTES.list=document.createElement('div');NOTES.list.id='notes-list';
    panel.append(NOTES.controls,NOTES.list);
    if(globalThis.ResizeObserver) {
      let width=panel.clientWidth;
      NOTES.resize=new ResizeObserver(()=>{const next=panel.clientWidth;if(next>0 && next!==width){width=next;renderNotes();}});
      NOTES.resize.observe(panel);
    }
  }
  if (!NOTES.resetView) measureNotes();
  NOTES.seen?.disconnect();
  NOTES.seen = null;
  ({ top: NOTES.top, replies: NOTES.replies, byXref: NOTES.byXref } = groupNotes(NOTES.all));
  for (const held of [NOTES.drafts, NOTES.heights]) {
    for (const x of held.keys()) if (!NOTES.byXref.has(x)) held.delete(x);
  }

  const totalNotes = NOTES.top.length;
  NOTES.filteredTop = globalThis.PDFUI?.filterNotes?.(NOTES.top) || NOTES.top;
  NOTES.top = NOTES.filteredTop;
  NOTES.count.textContent=String(NOTES.filteredTop.length);
  const keep = NOTES.resetView ? 0 : panel.scrollTop;
  NOTES.resetView = false;
  NOTES.list.replaceChildren();
  globalThis.PDFUI?.notesRendered?.(panel, totalNotes);
  if (!NOTES.filteredTop.length) {
    NOTES.chunks = [];
    NOTES.list.innerHTML = `<div class="nempty">${totalNotes ? "No comments match these filters." : "No highlights, notes or comments in this document."}</div>`;
    NOTES.heldEditors=null;
    return;
  }
  NOTES.chunks = [];
  for (let k = 0; k * NOTE_CHUNK < NOTES.top.length; k++) {
    const box = document.createElement("div");
    box.className = "nchunk";
    box.dataset.chunk = k;
    box.style.height = `${chunkHeight(k)}px`;
    NOTES.chunks.push(box);
  }
  NOTES.list.append(fragmentOf(NOTES.chunks));
  panel.scrollTop = keep;
  if(anchor) {
    const index=NOTES.filteredTop.findIndex(a=>a.xref===anchor.xref);
    if(index>=0) panel.scrollTop=NOTES.filteredTop.slice(0,index).reduce((h,a)=>h+(NOTES.heights.get(a.xref)||NOTE_GUESS),0)-anchor.offset;
  }

  // The chunks in reach now, in this frame -- the observer's first answer
  // comes a frame later, and an open panel should not flash empty boxes.
  const reach = panel.clientHeight || 800;
  let y = panel.firstElementChild.offsetHeight;
  NOTES.chunks.forEach((box, k) => {
    const h = chunkHeight(k);
    if (y + h > panel.scrollTop - reach && y < panel.scrollTop + 2 * reach) mountChunk(k);
    y += h;
  });
  // Retain the actual editor nodes and caret across sorting/filtering. Only
  // chunks containing a live editor are additionally pinned.
  for(const [xref,editor] of heldEditors) {
    if(!editor.contains(active))continue;
    const index=NOTES.filteredTop.findIndex(a=>a.xref===xref);
    if(index>=0)mountChunk(Math.floor(index/NOTE_CHUNK));
  }
  NOTES.heldEditors=null;
  if(anchor) {
    const row=panel.querySelector(`[data-xref="${anchor.xref}"]`);
    if(row)panel.scrollTop+=row.getBoundingClientRect().top-panel.getBoundingClientRect().top-NOTES.controls.offsetHeight-anchor.offset;
  }
  if(active?.isConnected && active.closest?.('.nedit')) active.focus({preventScroll:true});
  NOTES.seen = new IntersectionObserver(notesSeen, { root: panel, rootMargin: "100% 0px" });
  for (const box of NOTES.chunks) NOTES.seen.observe(box);
}

function chunkRows(k) {
  return NOTES.filteredTop.slice(k * NOTE_CHUNK, (k + 1) * NOTE_CHUNK);
}

function chunkHeight(k) {
  return chunkRows(k).reduce((h, a) => h + (NOTES.heights.get(a.xref) || NOTE_GUESS), 0);
}

function mountChunk(k) {
  const box = NOTES.chunks[k];
  if (!box || box.dataset.mounted) return;
  box.dataset.mounted = "1";
  box.innerHTML = chunkRows(k).map(noteRow).join("");
  box.style.height = "";
  for (const el of box.querySelectorAll(".note")) {
    const xref = Number(el.dataset.xref);
    if (NOTES.drafts.has(xref)) {
      const held=NOTES.heldEditors?.get(xref);
      if(held)el.querySelector('.nacts').before(held);
      else editNote(el, NOTES.byXref.get(xref), false);
    }
  }
}

function focusNoteResult(index) {
  const rows=NOTES.filteredTop;
  if(!rows.length || NOTES.doc!==S.doc?.doc || NOTES.layout!==S.doc?.layout)return;
  const rec=rows[(index%rows.length+rows.length)%rows.length];
  NOTES.sel=rec.xref;
  mountChunk(Math.floor(rows.indexOf(rec)/NOTE_CHUNK));
  const panel=$("#notes"),row=panel.querySelector(`[data-xref="${rec.xref}"]`);
  panel.querySelectorAll('.note.sel').forEach(el=>el.classList.remove('sel'));
  if(row){row.classList.add('sel');panel.scrollTop+=row.getBoundingClientRect().top-panel.getBoundingClientRect().top-NOTES.controls.offsetHeight;}
  revealAnnot(rec);
  globalThis.PDFUI?.notesRendered?.(panel,groupNotes(NOTES.all).top.length);
}

// Row heights, remembered by xref, so a chunk given back keeps its place and a
// redraw puts every box where its rows were. Only while the panel is shown: a
// hidden panel measures everything as zero.
function measureNotes(box) {
  const panel = $("#notes");
  if (panel.classList.contains("hidden") || !panel.offsetHeight) return;
  for (const el of (box || panel).querySelectorAll(".note")) {
    NOTES.heights.set(Number(el.dataset.xref), el.offsetHeight + 7);   // + .note margin
  }
}

function unmountChunk(k) {
  const box = NOTES.chunks[k];
  if (!box || !box.dataset.mounted) return;
  // Never under the person typing in it; its draft is kept regardless.
  if (box.contains(document.activeElement)) return;
  measureNotes(box);
  box.style.height = `${box.offsetHeight || chunkHeight(k)}px`;
  box.innerHTML = "";
  delete box.dataset.mounted;
}

function notesSeen(entries) {
  if ($("#notes").classList.contains("hidden")) return;
  for (const e of entries) {
    const k = Number(e.target.dataset.chunk);
    if (NOTES.chunks[k] !== e.target) continue;          // a list since redrawn
    if (e.isIntersecting) mountChunk(k);
    else unmountChunk(k);
  }
}

// One listener for every row, mounted or not yet.
$("#notes").addEventListener("click", (ev) => {
  const el = ev.target.closest(".note");
  if (NOTES.doc !== S.doc?.doc || NOTES.layout !== S.doc?.layout) return;
  if (!el || ev.target.closest(".nedit")) return;        // the editor acts for itself
  const xref = Number(el.dataset.xref);
  const rec = NOTES.byXref.get(xref);
  if (!rec) return;
  const act = ev.target.closest("[data-act]")?.dataset.act;
  if (act === "edit") return editNote(el, rec);
  if (act === "del") {
    const what = (rec.quoted || rec.contents || rec.kind).slice(0, 50);
    if (!confirm(`Delete this ${(KIND_LABEL[rec.kind] || rec.kind).toLowerCase()}?\n\n${what}`)) return;
    // A refusal -- the mark already gone, say -- asks for the whole list again.
    mutate("annot.delete", { xref, doc: S.doc.doc }, () => "Removed.")
      .then((r) => { if (!r) drawNotes(); });
    return;
  }
  if (ev.target.closest(".nacts")) return;               // buttons act for themselves
  $("#notes").querySelectorAll(".note.sel").forEach((n) => n.classList.remove("sel"));
  el.classList.add("sel");
  NOTES.sel = xref;
  revealAnnot(rec);
});

/* Bring a mark to the middle of the view.
 *
 * The mark itself, not its page: scrolling to the page leaves you looking for
 * which of nine highlights was meant. No outline is drawn over it -- the mark
 * is already a coloured band on the page, and putting a box around the thing
 * you just asked to see says nothing the position does not.
 *
 * The rectangle arrives in page points, so it is scaled by the width the page
 * is currently drawn at. That makes this correct at any zoom without knowing
 * what the zoom is. */
function revealAnnot(rec) {
  const wrap = document.getElementById(`page-${rec.page}`);
  const page = S.doc.pages.find((p) => p.index === rec.page);
  if (!wrap || !page) return;
  const stage = $("#stage");

  const wr = wrap.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const scale = wr.width / page.width;
  const [x0, y0, x1, y1] = rec.rect;

  stage.scrollTo({
    left: stage.scrollLeft + (wr.left - sr.left)
          + ((x0 + x1) / 2) * scale - stage.clientWidth / 2,
    top: stage.scrollTop + (wr.top - sr.top)
         + ((y0 + y1) / 2) * scale - stage.clientHeight / 2,
    behavior: "smooth",
  });
}

/* Edit a comment in place. The quoted text is the document's and stays put;
   what is editable is the note somebody attached to it.

   What is typed is kept in NOTES.drafts until it is saved or cancelled, so a
   row redrawn under it -- another edit's refresh, a chunk scrolled away and
   back -- comes back with the editor open and the text as it was. */
function editNote(el, rec, focus = true) {
  if (!rec || NOTES.doc !== S.doc?.doc || el.querySelector(".nedit")) return;
  const documentId = NOTES.doc;
  const draft = NOTES.drafts.has(rec.xref) ? NOTES.drafts.get(rec.xref) : (rec.contents || "");
  NOTES.drafts.set(rec.xref, draft);
  globalThis.PDFDraftRecovery?.noteOpened(rec);
  const box = document.createElement("div");
  box.className = "nedit";
  box.innerHTML = `
    <textarea rows="3" placeholder="Note on this mark">${escapeHtml(draft)}</textarea>
    <div class="erow">
      <button class="ebtn" data-act="save">Apply</button>
      <button class="ebtn ghost" data-act="cancel">Cancel</button>
    </div>`;
  el.querySelector(".nacts").before(box);
  const area = box.querySelector("textarea");
  if (focus) area.focus();
  area.oninput = () => NOTES.drafts.set(rec.xref, area.value);
  area.addEventListener('compositionstart',()=>NOTES.composing.add(rec.xref));
  area.addEventListener('compositionend',()=>{
    NOTES.drafts.set(rec.xref,area.value);NOTES.composing.delete(rec.xref);
    if(NOTES.pendingRender && !NOTES.composing.size){NOTES.pendingRender=false;renderNotes();}
  });
  box.onclick = (ev) => ev.stopPropagation();
  box.querySelector('[data-act="cancel"]').onclick = async () => {
    if (area.value !== (rec.contents || "") && !(await confirmDiscardNote(area))) return;
    globalThis.PDFDraftRecovery?.noteClosed(rec.xref);
    NOTES.drafts.delete(rec.xref);
    box.remove();
    renderNotes();
  };
  box.querySelector('[data-act="save"]').onclick = () => {
    if (documentId !== S.doc?.doc || documentId !== NOTES.doc) return;
    const text = area.value;
    NOTES.drafts.delete(rec.xref);
    // Saved: the refresh that follows redraws the row with the new note. Not
    // saved: the whole list is asked for again, with the editor and its text
    // back where they were.
    mutate("annot.update", { xref: rec.xref, contents: text, doc: documentId },
           () => "Comment saved.").then((r) => {
      if (r) { globalThis.PDFDraftRecovery?.noteClosed(rec.xref); return; }
      if (documentId !== S.doc?.doc || documentId !== NOTES.doc) return;
      NOTES.drafts.set(rec.xref, text);
      globalThis.PDFDraftRecovery?.changed();
      drawNotes();
    });
  };
}

$("#notes-toggle").onclick = (e) => panelToggle("right", "comments", e.currentTarget);
$("#rail-toggle").onclick = (e) => panelToggle("left", "pages", e.currentTarget);
$("#outline-toggle").onclick = (e) => panelToggle("left", "outline", e.currentTarget);

/* ----------------------------- panels (UI-02) -----------------------------
 *
 * The rules alone, without the page: which panel is docked, collapsed for
 * want of room, or shown as an overlay drawer, and what of it is remembered.
 * tests/browser/ui02_panels.test.cjs runs this section by itself.
 *
 * - From 1200 px both panels may be docked, but only while the document keeps
 *   560 px; otherwise the panel used less recently is collapsed.
 * - From 900 px to 1199 px one panel is docked at a time.
 * - Below 900 px a panel is an overlay drawer, min(320 px, width - 48 px), and
 *   only when it was opened there (or was the one in use when the window
 *   narrowed). A collapsed panel is still open: it comes back with the room.
 *
 * Preferences are layout only (open sidebar, its tab, the two widths), under
 * one versioned key. Nothing from the document -- titles, filters, text -- is
 * ever written there; an unknown version reads as the defaults.
 */
const PANEL_PREFS_KEY = "pdfstudio.ui";
const PANEL_PREFS_VERSION = 1;
const PANEL_LIMITS = { left: { min: 160, max: 300, initial: 192 }, right: { min: 260, max: 420, initial: 304 } };
const PANEL_BOTH_MIN = 1200, PANEL_DOCK_MIN = 900, PANEL_STAGE_MIN = 560, PANEL_SEPARATOR = 6;
const PANEL_TABS = ["pages", "outline"];

function clampPanelWidth(side, value) {
  const l = PANEL_LIMITS[side];
  if (typeof value !== "number" || !Number.isFinite(value)) return l.initial;
  return Math.round(Math.min(l.max, Math.max(l.min, value)));
}

function readPanelPrefs(raw) {
  const left = { open: true, tab: "pages", width: PANEL_LIMITS.left.initial };
  const right = { width: PANEL_LIMITS.right.initial };
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  const panels = data && typeof data === "object" && data.version === PANEL_PREFS_VERSION
    && data.panels && typeof data.panels === "object" ? data.panels : null;
  if (panels) {
    const l = panels.left && typeof panels.left === "object" ? panels.left : {};
    const r = panels.right && typeof panels.right === "object" ? panels.right : {};
    if (typeof l.open === "boolean") left.open = l.open;
    if (PANEL_TABS.includes(l.tab)) left.tab = l.tab;
    if ("width" in l) left.width = clampPanelWidth("left", l.width);
    if ("width" in r) right.width = clampPanelWidth("right", r.width);
  }
  return { left, right };
}

function panelPrefsText(state) {
  return JSON.stringify({ version: PANEL_PREFS_VERSION, panels: {
    left: { open: !!state.left.open, tab: PANEL_TABS.includes(state.left.tab) ? state.left.tab : "pages",
            width: clampPanelWidth("left", state.left.width) },
    right: { width: clampPanelWidth("right", state.right.width) } } });
}

// {width, left:{open,width}, right:{open,width}, active, drawer} ->
// {mode: 'docked'|'drawer', left/right: 'docked'|'collapsed'|'drawer'|'closed', widths}
function panelLayout(v) {
  const width = Number.isFinite(v.width) ? v.width : 0;
  const leftWidth = clampPanelWidth("left", v.left?.width), rightWidth = clampPanelWidth("right", v.right?.width);
  const open = { left: !!v.left?.open, right: !!v.right?.open };
  const active = v.active === "left" || v.active === "right" ? v.active : open.right ? "right" : "left";
  const out = { mode: "docked", left: open.left ? "docked" : "closed", right: open.right ? "docked" : "closed",
                leftWidth, rightWidth, drawerWidth: Math.max(0, Math.min(320, width - 48)) };
  if (width < PANEL_DOCK_MIN) {
    out.mode = "drawer";
    for (const side of ["left", "right"]) if (open[side]) out[side] = v.drawer === side ? "drawer" : "collapsed";
    return out;
  }
  if (open.left && open.right) {
    const room = width - leftWidth - rightWidth - 2 * PANEL_SEPARATOR;
    if (width < PANEL_BOTH_MIN || room < PANEL_STAGE_MIN) out[active === "left" ? "right" : "left"] = "collapsed";
  }
  return out;
}

// A panel change refits only a fit the reader still has: never a zoom they
// chose, and never under an open editor, whose draft a re-zoom would redraw.
function panelRefitAllowed({ zoomTouched, zoom, fitZoom, fitChoice, editing }) {
  if (editing) return false;
  if (!zoomTouched) return true;
  return fitChoice !== "actual" && Number.isFinite(fitZoom) && Math.abs(zoom - fitZoom) < 1e-6;
}

/* ----------------------------- panel controller (UI-02) -----------------------------
 *
 * One state for the left sidebar (Pages | Outline) and the right panel
 * (Comments, or Properties while an editor has it). Every geometry change is
 * bracketed by a reading anchor -- a page point near the top of the document
 * view -- so the reader stays on the same line; the zoom is refitted only for
 * an active fit (panelRefitAllowed). Panels are hidden, never torn down: a
 * closed Comments panel keeps its drafts and a closed Outline keeps its filter.
 *
 * The Outline tab is a container. When web/static/outline.js has loaded,
 * `window.PdfOutline.mount(container, ctx)` is called once, the first time
 * the tab is shown (ctx: see outlineContext); until then the tab lists the
 * document's own bookmarks, as Find does.
 */
const PROPERTIES_WIDTH = 350;   // #properties keeps its own width (style.css)
const PANELS = {
  left: { open: true, tab: "pages", width: PANEL_LIMITS.left.initial },
  right: { open: false, tab: "comments", width: PANEL_LIMITS.right.initial },
  active: "left",       // the panel used most recently: kept when room runs out
  drawer: null,         // the side shown as a drawer in a narrow window
  layout: null,         // the last applied panelLayout
  key: "",              // ... and its geometry, to tell a real change
  opener: { left: null, right: null },
  used: { left: false, right: false },   // opened by the reader in this page
  fitZoom: null,       // the zoom a chosen fit mode produced (panelRefitAllowed)
  outline: { mounted: false, doc: null, layout: null, rows: null, labels: [], page: 0, query: "",
             generation: 0, loading: false, error: "", visible: false },
};
{
  let raw = null;
  try { raw = localStorage.getItem(PANEL_PREFS_KEY); } catch {}
  const p = readPanelPrefs(raw);
  Object.assign(PANELS.left, p.left);
  PANELS.right.width = p.right.width;
}
function savePanelPrefs() {
  try { localStorage.setItem(PANEL_PREFS_KEY, panelPrefsText(PANELS)); } catch {}
}

function captureReadingAnchor() {
  const stage = $("#stage");
  if (!S.doc || !VIEW.shells.length || !stage.clientWidth || !stage.clientHeight) return null;
  const sr = stage.getBoundingClientRect();
  const dy = Math.min(48, stage.clientHeight / 4);
  const keep = anchorPoint({ x: sr.left + stage.clientWidth / 2, y: sr.top + dy });
  return keep ? { keep, dy } : null;
}
// The anchor goes back to the same height in the view and to its middle:
// a wider or narrower view keeps what was centred, centred.
function restoreReadingAnchor(a) {
  const wrap = a && VIEW.shells[a.keep.index], page = a && S.doc?.pages[a.keep.index];
  if (!wrap?.isConnected || !page) return;
  const stage = $("#stage");
  const sr = stage.getBoundingClientRect(), r = wrap.getBoundingClientRect();
  if (!r.width) return;
  const k = r.width / page.width;
  stage.scrollLeft += r.left + a.keep.x * k - (sr.left + stage.clientWidth / 2);
  stage.scrollTop += r.top + a.keep.y * k - (sr.top + a.dy);
}

function panelRefit() {
  if (!S.doc || editorOpen() || S.viewMode === 'custom' || S.viewMode === 'actual-size') return;
  globalThis.PDFUI?.fit(true);
}

function rightFromDom() {
  const props = document.getElementById("properties");
  const properties = !!props && !props.classList.contains("hidden");
  return { open: properties || !$("#notes").classList.contains("hidden"), tab: properties ? "properties" : "comments" };
}
const panelShown = (side) => ["docked", "drawer"].includes(PANELS.layout?.[side]);
const panelElement = (side) => side === "left" ? $("#sidebar")
  : PANELS.right.tab === "properties" ? document.getElementById("properties") : $("#notes");

function applyPanels({ anchor, refit = true } = {}) {
  const right = rightFromDom();
  PANELS.right.open = right.open; PANELS.right.tab = right.tab;
  for (const side of ["left", "right"]) if (!PANELS[side].open && PANELS.drawer === side) PANELS.drawer = null;
  const main = $("main");
  const width = main.getBoundingClientRect().width || window.innerWidth;
  const input = () => ({ width, active: PANELS.active, drawer: PANELS.drawer, left: PANELS.left,
    right: { open: right.open, width: right.tab === "properties" ? PROPERTIES_WIDTH : PANELS.right.width } });
  let layout = panelLayout(input());
  const before = PANELS.layout;
  if (before && before.mode !== layout.mode) {
    // Narrowing keeps a panel the reader opened, as a drawer; one that was
    // merely open by default must not cover the document. Widening docks it.
    PANELS.drawer = layout.mode === "drawer" && PANELS.used[PANELS.active]
      && ["docked", "drawer"].includes(before[PANELS.active]) ? PANELS.active : null;
    layout = panelLayout(input());
  }
  const key = JSON.stringify([layout.mode, layout.left, layout.right, right.tab, layout.leftWidth, PANELS.right.width]);
  const changed = key !== PANELS.key;
  const held = changed && S.doc ? (anchor === undefined ? captureReadingAnchor() : anchor) : null;
  PANELS.layout = layout; PANELS.key = key;

  const sidebar = $("#sidebar"), notes = $("#notes"), props = document.getElementById("properties");
  const place = (el, state, owns) => {
    if (!el) return;
    el.classList.toggle("panel-collapsed", owns && state === "collapsed");
    el.classList.toggle("panel-drawer", owns && state === "drawer");
  };
  sidebar.classList.toggle("hidden", !PANELS.left.open);
  place(sidebar, layout.left, true);
  place(notes, layout.right, right.tab === "comments");
  place(props, layout.right, right.tab === "properties");
  $("#sidebar-resize").classList.toggle("panel-collapsed", layout.left !== "docked");
  $("#notes-resize").classList.toggle("panel-collapsed", !(layout.right === "docked" && right.tab === "comments"));
  main.style.setProperty("--left-panel-w", `${layout.leftWidth}px`);
  main.style.setProperty("--right-panel-w", `${clampPanelWidth("right", PANELS.right.width)}px`);
  $("#sidebar-resize").setAttribute("aria-valuenow", String(layout.leftWidth));
  $("#notes-resize").setAttribute("aria-valuenow", String(clampPanelWidth("right", PANELS.right.width)));
  syncPanelControls();

  if (changed && S.doc) {
    if (refit) panelRefit();
    restoreReadingAnchor(held);
    scheduleMaintain();
  }
}

function syncPanelControls() {
  const left = panelShown("left"), right = panelShown("right");
  const mark = (el, on) => { if (!el) return; el.classList.toggle("on", on); el.setAttribute("aria-expanded", String(on)); };
  mark($("#rail-toggle"), left && PANELS.left.tab === "pages");
  mark($("#outline-toggle"), left && PANELS.left.tab === "outline");
  mark($("#notes-toggle"), right && PANELS.right.tab === "comments");
  const props = document.getElementById("properties-toggle");
  if (props && !props.disabled) props.setAttribute("aria-expanded", String(right && PANELS.right.tab === "properties"));
  for (const tab of PANEL_TABS) {
    const on = PANELS.left.tab === tab;
    const button = $(`#sidebar-tab-${tab}`);
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
    $(`#${tab}-panel`).hidden = !on;
  }
  const visible = left && PANELS.left.tab === "outline";
  if (visible !== PANELS.outline.visible) {
    PANELS.outline.visible = visible;
    $("#outline-panel").dispatchEvent(new CustomEvent("pdfpanels:visibility", { detail: { visible } }));
  }
  if (visible) showOutline();
}

function panelOpen(side, tab, opener) {
  if (side === "right") {
    if ($("#notes").classList.contains("hidden")) {
      if (globalThis.PDFInspector?.hide() === false) return;
      $("#notes").classList.remove("hidden");
      drawNotes();
    }
  } else {
    PANELS.left.open = true;
    if (tab) PANELS.left.tab = tab;
  }
  PANELS.active = side;
  PANELS.used[side] = true;
  PANELS.opener[side] = opener || document.activeElement;
  const narrow = PANELS.layout?.mode === "drawer";
  if (narrow) PANELS.drawer = side;
  applyPanels();
  if (side === "left") savePanelPrefs();
  // A drawer covers the document: take the keyboard into it.
  if (narrow) (side === "left" ? $(`#sidebar-tab-${PANELS.left.tab}`) : $("#notes")).focus({ preventScroll: true });
}

function panelClose(side) {
  const el = panelElement(side);
  const inside = !!el?.contains(document.activeElement);
  if (side === "right") {
    if (PANELS.right.tab === "properties") { if (globalThis.PDFInspector?.hide() === false) return; }
    else $("#notes").classList.add("hidden");
  } else PANELS.left.open = false;
  if (PANELS.drawer === side) PANELS.drawer = null;
  applyPanels();
  if (side === "left") savePanelPrefs();
  if (!inside) return;
  // Focus goes back where the panel was opened from, or to its toggle.
  const visible = (b) => b?.isConnected && !b.disabled && b.getClientRects().length > 0;
  const opener = PANELS.opener[side];
  const toggle = side === "left" ? $(PANELS.left.tab === "outline" ? "#outline-toggle" : "#rail-toggle") : $("#notes-toggle");
  (visible(opener) && !el.contains(opener) ? opener : visible(toggle) ? toggle : $("#stage")).focus({ preventScroll: true });
}

function panelToggle(side, tab, opener) {
  const current = side === "left" ? PANELS.left.tab : PANELS.right.tab;
  if (panelShown(side) && current === tab) return panelClose(side);
  panelOpen(side, tab, opener);
}

function selectSidebarTab(tab, focus = false) {
  if (!PANEL_TABS.includes(tab)) return;
  PANELS.left.tab = tab;
  applyPanels();
  savePanelPrefs();
  if (focus) $(`#sidebar-tab-${tab}`).focus({ preventScroll: true });
}

function panelNavigate(page, point) {
  const wrap = VIEW.shells[page], p = S.doc?.pages[page];
  if (!wrap || !p) return false;
  wrap.scrollIntoView({ block: "start" });
  if (point && Number.isFinite(point.y)) {
    const stage = $("#stage"), r = wrap.getBoundingClientRect();
    stage.scrollTop += r.top + point.y * (r.width / p.width) - stage.getBoundingClientRect().top - 16;
  }
  return true;
}

// What outline.js is given: the panel, the document, the engine, navigation
// and the reading anchor -- never the panel state itself.
function outlineContext() {
  return {
    version: 1,
    panel: $("#sidebar"),
    isVisible: () => PANELS.outline.visible,
    getDocument: () => S.doc,
    request: (op, params = {}, opts = {}) => api(op, params, { priority: "adjacent", ...opts }),
    navigate: (page, point) => panelNavigate(page, point),
    activateDestination: (dest) => globalThis.PDFUI?.activateDestination?.(dest),
    readingAnchor: () => captureReadingAnchor()?.keep || null,
    foldText: (s) => typeof foldNavigationText === "function" ? foldNavigationText(s) : String(s).toLowerCase(),
    close: () => panelClose("left"),
  };
}

function showOutline() {
  const container = $("#outline-panel"), o = PANELS.outline;
  if (!o.mounted && typeof globalThis.PdfOutline?.mount === "function") {
    try {
      container.replaceChildren();
      globalThis.PdfOutline.mount(container, outlineContext());
      o.mounted = true;
      return;
    } catch (e) {
      console.warn("Outline controller failed to mount; showing bookmarks.", e);
    }
  }
  if (o.mounted) return;
  if (!container.querySelector(".outline-fallback")) buildOutlineFallback(container);
  if (S.doc && (o.doc !== S.doc.doc || o.layout !== S.doc.layout || o.rows === null) && !o.loading) loadOutlineFallback();
  else paintOutlineFallback();
}

function buildOutlineFallback(container) {
  const box = document.createElement("div");
  box.className = "outline-fallback";
  box.innerHTML = `<p class="outline-status">PDF bookmarks</p>
    <label>Filter outline <input id="outline-panel-query" type="search" maxlength="256"></label>
    <p id="outline-panel-status" class="outline-status" role="status"></p>
    <div id="outline-panel-rows" class="outline-rows"></div>
    <div class="outline-paging"><button type="button" id="outline-panel-previous">Previous</button><button type="button" id="outline-panel-next">Next</button></div>`;
  container.replaceChildren(box);
  const query = box.querySelector("#outline-panel-query");
  query.value = PANELS.outline.query;
  query.oninput = () => { PANELS.outline.query = query.value; PANELS.outline.page = 0; paintOutlineFallback(); };
  box.querySelector("#outline-panel-previous").onclick = () => { PANELS.outline.page--; paintOutlineFallback(); };
  box.querySelector("#outline-panel-next").onclick = () => { PANELS.outline.page++; paintOutlineFallback(); };
}

async function loadOutlineFallback() {
  const o = PANELS.outline;
  if (!S.doc) return;
  const held = S.doc.doc, layout = S.doc.layout, generation = ++o.generation;
  if (o.doc !== held) { o.query = ""; o.page = 0; const q = document.getElementById("outline-panel-query"); if (q) q.value = ""; }
  o.loading = true; o.error = ""; o.rows = null;
  paintOutlineFallback();
  try {
    const nav = await api("get_navigation", {}, { priority: "adjacent" });
    if (generation !== o.generation || S.doc?.doc !== held || S.doc?.layout !== layout) return;
    o.doc = held; o.layout = layout;
    o.rows = Array.isArray(nav.outline) ? nav.outline : [];
    o.labels = Array.isArray(nav.labels) ? nav.labels : [];
  } catch (e) {
    if (generation === o.generation) { o.error = explain(e); o.doc = null; }
  } finally {
    if (generation === o.generation) { o.loading = false; paintOutlineFallback(); }
  }
}

function paintOutlineFallback() {
  const o = PANELS.outline, list = document.getElementById("outline-panel-rows");
  if (!list) return;
  const status = document.getElementById("outline-panel-status");
  const all = o.rows || [], limit = 200;
  const rows = typeof filterOutline === "function" ? filterOutline(all, o.query) : all;
  o.page = Math.max(0, Math.min(o.page, Math.ceil(rows.length / limit) - 1));
  const start = o.page * limit;
  list.replaceChildren();
  for (const [level, title, page] of rows.slice(start, start + limit)) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.paddingLeft = `${Math.max(1, Math.min(level, 10)) * 12}px`;
    const name = document.createElement("span"); name.className = "outline-title"; name.textContent = title;
    const where = document.createElement("span"); where.className = "outline-page";
    const label = Number.isInteger(page) ? o.labels[page - 1] : "";
    where.textContent = !Number.isInteger(page) ? "" : label && label !== String(page) ? `${label} (p. ${page})` : String(page);
    button.append(name, where);
    button.disabled = !S.doc || !Number.isInteger(page) || page < 1 || page > S.doc.pages.length;
    button.onclick = () => panelNavigate(page - 1);
    list.append(button);
  }
  status.textContent = o.loading ? "Loading bookmarks…" : o.error ? o.error : !all.length ? "This document has no bookmarks." :
    !rows.length ? "No matching bookmarks." :
    `${start + 1}–${Math.min(start + limit, rows.length)} of ${rows.length} bookmarks${o.query.trim() ? " (including parent headings)" : ""}.`;
  document.getElementById("outline-panel-previous").disabled = o.page === 0;
  document.getElementById("outline-panel-next").disabled = start + limit >= rows.length;
}

function wireSeparator(sep, side) {
  const sign = side === "left" ? 1 : -1;
  const setWidth = (value, anchor, refit) => {
    PANELS[side].width = clampPanelWidth(side, value);
    applyPanels({ anchor, refit });
  };
  sep.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 32 : 8, w = PANELS[side].width, l = PANEL_LIMITS[side];
    const next = ev.key === "ArrowRight" ? w + sign * step : ev.key === "ArrowLeft" ? w - sign * step
      : ev.key === "Home" ? l.min : ev.key === "End" ? l.max : null;
    if (next === null) return;
    ev.preventDefault();
    setWidth(next, undefined, true);
    savePanelPrefs();
  });
  let drag = null;
  sep.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    sep.setPointerCapture?.(ev.pointerId);
    sep.classList.add("dragging");
    sep.focus({ preventScroll: true });
    drag = { x: ev.clientX, width: PANELS[side].width, anchor: captureReadingAnchor(), frame: 0, next: null };
  });
  sep.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    drag.next = drag.width + sign * (ev.clientX - drag.x);
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => { if (drag) { drag.frame = 0; setWidth(drag.next, drag.anchor, false); } });
  });
  const end = (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    sep.classList.remove("dragging");
    sep.releasePointerCapture?.(ev.pointerId);
    // Refit once, at the end; the anchor holds the reader through it.
    if (d.next !== null) PANELS[side].width = clampPanelWidth(side, d.next);
    PANELS.key = "";
    applyPanels({ anchor: d.anchor, refit: true });
    savePanelPrefs();
  };
  sep.addEventListener("pointerup", end);
  sep.addEventListener("pointercancel", end);
}
wireSeparator($("#sidebar-resize"), "left");
wireSeparator($("#notes-resize"), "right");

$("#sidebar-close").onclick = () => panelClose("left");
for (const tab of PANEL_TABS) $(`#sidebar-tab-${tab}`).onclick = () => selectSidebarTab(tab);
$("#sidebar-tabs").addEventListener("keydown", (ev) => {
  const i = PANEL_TABS.indexOf(PANELS.left.tab);
  const next = ev.key === "ArrowRight" ? (i + 1) % PANEL_TABS.length : ev.key === "ArrowLeft" ? (i + PANEL_TABS.length - 1) % PANEL_TABS.length
    : ev.key === "Home" ? 0 : ev.key === "End" ? PANEL_TABS.length - 1 : -1;
  if (next < 0) return;
  ev.preventDefault();
  selectSidebarTab(PANEL_TABS[next], true);
});
// Escape closes a drawer -- not from a field, whose Escape is its own.
for (const [el, side] of [[$("#sidebar"), "left"], [$("#notes"), "right"]]) {
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented || PANELS.layout?.[side] !== "drawer") return;
    if (ev.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    ev.preventDefault(); ev.stopPropagation();
    panelClose(side);
  });
}
let panelFrame = 0;
window.addEventListener("resize", () => {
  if (panelFrame) return;
  panelFrame = requestAnimationFrame(() => { panelFrame = 0; applyPanels(); });
});
applyPanels();
// Properties, the fit menu and the revision hook belong to scripts loaded
// after this one.
document.addEventListener("DOMContentLoaded", () => {
  const props = document.getElementById("properties");
  const watch = new MutationObserver(() => {
    const now = rightFromDom();
    if (now.open === PANELS.right.open && now.tab === PANELS.right.tab) return;
    if (now.open) {
      PANELS.active = "right";
      PANELS.used.right = true;
      if (PANELS.layout?.mode === "drawer") PANELS.drawer = "right";
    }
    applyPanels();
  });
  for (const el of [$("#notes"), props]) if (el) watch.observe(el, { attributes: true, attributeFilter: ["class"] });
  // Properties' own toggle hides a panel it believes shown; a collapsed one
  // is brought back instead.
  document.getElementById("properties-toggle")?.addEventListener("click", (ev) => {
    if (!props || props.classList.contains("hidden") || panelShown("right")) return;
    ev.stopImmediatePropagation();
    PANELS.active = "right";
    if (PANELS.layout?.mode === "drawer") PANELS.drawer = "right";
    applyPanels();
  }, true);
  const fit = document.getElementById("page-fit");
  fit?.addEventListener("change", () => queueMicrotask(() => { PANELS.fitZoom = fit.value === "actual" ? null : S.zoom; }));
  const ui = globalThis.PDFUI;
  if (ui) {
    const revised = ui.revisionChanged;
    ui.revisionChanged = function () {
      revised?.call(this);
      const o = PANELS.outline;
      if (!o.mounted && o.rows !== null && (o.doc !== S.doc?.doc || o.layout !== S.doc?.layout)) {
        o.generation++; o.rows = null; o.loading = false;
        if (o.visible) queueMicrotask(showOutline);
      }
    };
  }
  applyPanels();
});
globalThis.PDFPanels = {
  open: panelOpen, close: panelClose, toggle: panelToggle, selectTab: selectSidebarTab,
  attachOutline: () => { if (PANELS.outline.visible) showOutline(); },
  state: () => JSON.parse(JSON.stringify({ left: PANELS.left, right: PANELS.right, active: PANELS.active,
                                           drawer: PANELS.drawer, layout: PANELS.layout })),
  captureReadingAnchor, restoreReadingAnchor,
};

// The run boxes double as the edit affordance: what they outline is exactly
// what the editor can address, so turning them on is how you find out what is
// editable before clicking anything. Marking is deliberately not mentioned
// here any more -- it does not live behind this button.
$("#text-toggle").onclick = async (e) => {
  const button = e.currentTarget;
  // Without an open editor this stays synchronous: other controls click it
  // and go on at once (workspace changes, arming markup).
  if (S.editOn && editorOpen() && !(await requestEditorTransition("edit-text"))) return;
  S.editOn = !S.editOn;
  if (S.editOn) setActiveMarkup(null);
  button.classList.toggle("on", S.editOn);
  button.setAttribute("aria-pressed", String(S.editOn));
  document.querySelectorAll(".tlayer").forEach((l) => l.classList.toggle("on", S.editOn));
  if (S.editOn) {
    // The mounted pages, not the document: every other page gets its boxes
    // when it is scrolled to (mountPage). Turning this on used to fetch and
    // draw the text layer of every page in the file.
    for (const i of VIEW.mounted) drawText(i);
    toast("Click any outlined run to retype it.", "ok");
  } else {
    // Any editor was settled above (requestEditorTransition); nothing typed
    // is disposed here. The boxes go with the mode, and so does everything they hold -- their
    // handlers and the text-layer answers those close over -- rather than
    // staying in the page until it is unmounted. A layer still being fetched
    // draws nothing (the ticket) and is asked for again next time.
    document.querySelectorAll(".tlayer").forEach((layer) => {
      layer.ticket = (layer.ticket || 0) + 1;
      layer.abort?.abort();
      layer.querySelectorAll(".tspan").forEach((el) => el.remove());
      delete layer.dataset.loaded;
      delete layer.dataset.geo;
    });
  }
};

/* One press, one file: edited_<the original's name>, beside the original.
 *
 * No prompt. The dialog asked a question with one sensible answer, and typing
 * a path into a browser prompt() is a worse way to name a file than any file
 * dialog -- while the answer it wanted was always "next to the one I opened".
 * The server owns the name (see export_verified) and reports the path it actually
 * wrote, which is what the toast says.
 */
$("#export").onclick = () => globalThis.PDFUI?.exportDocument();

// Where the open editor was last typed in, and its caret, so Keep editing
// (requestEditorTransition) returns exactly there after a toolbar click.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if ((el.tagName === "TEXTAREA" || el.isContentEditable) && el.closest?.("#editor, #properties")) {
    TRANSITION.source = el;
  }
});
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  const area = document.querySelector("#editor .iptext");
  if (area && sel?.rangeCount && area.contains(sel.anchorNode)) {
    TRANSITION.caret = { el: area, range: sel.getRangeAt(0).cloneRange() };
  }
});

document.addEventListener("keydown", (e) => {
  // TEXTAREA matters as much as INPUT here: the paragraph editor is a textarea,
  // and without it Cmd+A inside a paragraph you are editing selected every page
  // in the document instead of the text you were about to retype.
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
  if (e.key === "Escape") {
    if (e.target.closest?.("#page-organizer")) return;
    if (MARKUP.active) { setActiveMarkup(null); return; }
    if (document.getElementById("editor")) return void requestEditorTransition("cancel");
    if (FX.on) return formulaMode(false);
    if (SEL.range) return clearSelection();
    S.selected.clear();
    syncRailSelection();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "a" && e.target.closest?.("#rail,#organize-grid")) {
    e.preventDefault();
    S.doc.pages.forEach((p) => S.selected.add(p.index));
    syncRailSelection();
  }
});

/* Moving the window to a display of another density changes devicePixelRatio
 * and nothing else -- no resize, no zoom -- so the pages would stay at the old
 * display's resolution. A media query on the current resolution is what says
 * so. It matches that one value only, so it is armed again at every change.
 * Browser zoom (Ctrl +/-) changes the ratio too, and is caught the same way. */
function watchDensity() {
  S.dpr = window.devicePixelRatio || 1;
  const mq = window.matchMedia?.(`(resolution: ${S.dpr}dppx)`);
  mq?.addEventListener("change", () => {
    watchDensity();
    if (S.doc) renderVisible(0);
  }, { once: true });
}
watchDensity();

// Pages scrolled towards are mounted, and get their image and (in edit mode)
// their text layer, on the frame they come within a screen of the view; pages
// scrolled away from let theirs go. See maintain.
$("#stage").addEventListener("scroll", scheduleMaintain, { passive: true });

// Refit on resize until the user picks their own zoom.
window.addEventListener("resize", () => {
  if (!S.doc) return;
  scheduleMaintain();       // a taller window shows more pages
  // PDFUI's stage observer refits with point anchoring, including panel changes.
});

transport.subscribe(documentChanged);

load()
  .then(() => {
    refreshUndo();
    // One more fit after the first paint: on the initial load the stage may
    // still have been zero-height when load() ran.
    requestAnimationFrame(() => {
      scheduleMaintain();
      if (S.viewMode === 'custom') return;
      const before = S.zoom;
      fitPage();
      if (S.zoom !== before) zoomPages();
    });
  })
  .catch((e) => toast(`Could not open document: ${explain(e)}`, "err"));
