/* How the viewer reaches the engine.
 *
 * viewer.js names no route, URL or port. Everything it asks of the engine
 * goes through one EditorTransport, by operation name, and this file holds
 * the only implementation the browser uses: HTTP, against the routes
 * web/app.py serves. Another host (a test, or a future editor whose engine
 * runs as a worker process) hands the viewer another object with the same
 * five members. The viewer's own rules -- the request coordinator, token
 * checks, decode-before-swap, reconcile after a lost answer -- stay in
 * viewer.js and are the same whichever transport carries the requests.
 *
 *   request(op, params, { requestId, signal }) -> Promise<answer>
 *     One JSON question or change. Resolves with the engine's answer.
 *     Rejects with
 *       - an AbortError, when `signal` fired before the request went out, or
 *         (`withdraws` below) while the engine still had it waiting;
 *       - a refusal, { refused: true, status, code, body, requestId }: the
 *         engine answered and declined. `status` keeps the meanings the
 *         viewer acts on -- 409 the page moved on, 410 a version is gone --
 *         and `body` is the engine's whole answer (an overlap's offers);
 *       - anything else: no answer. For a change that is ambiguous -- it may
 *         have landed -- and the viewer finds out (reconcile) rather than
 *         sending it again.
 *
 *   withdraws: boolean
 *     Whether a request already handed over can still be called back by its
 *     `signal`. Over HTTP it cannot: the server finishes what it was sent,
 *     so the viewer leaves the answer to arrive, holding the request's slot
 *     until it does, and a later asker for the same version may still share
 *     it. A transport that queues work on the engine's side may say true;
 *     the viewer then fires the signal when nobody wants the answer any more,
 *     and the promise settles (AbortError) once the engine has let it go.
 *
 *   resourceKey(op, params) -> string
 *     The name of one version of an image (render_page) or an embedded font
 *     (get_font). Equal names are equal bytes, so the viewer compares names
 *     and never takes one apart.
 *
 *   openResource(key, { signal }) -> source | Promise<source>
 *     Something an <img> or @font-face can load, { url, release() }. The
 *     viewer calls release() once the element showing it is gone. Over HTTP
 *     the name IS the URL and there is nothing to release; a transport that
 *     delivers bytes would answer with an object URL and revoke it there. An
 *     answer given at once is used in the same turn, so an image starts
 *     loading exactly when the request coordinator lets it.
 *
 *   subscribe(listener) -> unsubscribe()
 *     Changes the viewer did not make itself -- another view of the same
 *     document, an undo or a revert from the host -- as listener({ cause, doc,
 *     revision, pages }). The viewer's own edits are answered, not announced.
 *     A server cannot push over plain HTTP, so here nothing is announced.
 *
 * EditorTransport.kind(op) says what an operation is: "get" (a read with no
 * body, which the viewer may share between askers), "ask" (a question with a
 * body that changes nothing), "change" (a change to the document: sent one at
 * a time, in order, never twice) or "resource". An unknown name throws, here
 * and in every transport, rather than going out as something else. */

const EditorTransport = (() => {
  const enc = encodeURIComponent;
  // The version a resource or read is asked for under, as a query.
  const version = (token) => (token ? `v=${enc(token)}` : "");
  const fixed = (path) => () => path;
  const asIs = (p) => p;
  const without = (name, extra = {}) => (p) => {
    const { [name]: _, ...rest } = p;
    return { ...rest, ...extra };
  };

  /* Every operation the viewer uses, and the route that serves it. A POST's
   * body is the params as given unless the entry says otherwise; what goes in
   * the path does not go in the body. The names are the engine's own (the
   * service and worker contract): reads by what they read, changes by the
   * apply_edit kind they are. */
  const OPS = {
    get_capabilities: { kind: "get", path: fixed("/api/capabilities") },
    list_recoveries: { kind: "get", path: fixed("/api/recoveries") },
    restore_recovery: { kind: "change", path: fixed("/api/recover") },
    // Host metadata, not PDF mutations; Rust/VS Code hosts provide their own store.
    list_drafts: { kind: "get", path: fixed("/api/drafts") },
    checkpoint_draft: { kind: "ask", path: fixed("/api/drafts/checkpoint") },
    discard_draft: { kind: "ask", path: fixed("/api/drafts/discard") },
    // Reads.
    search_page: { kind: "get", path: (p) => `/api/page/${p.page}/search?q=${enc(p.query)}&v=${enc(p.v || "")}` },
    // Document search (SEARCH_PROTOCOL.md): start, read progress/results by
    // cursor, cancel. Starting and cancelling change nothing in the document.
    start_search: { kind: "ask", path: fixed("/api/search") },
    read_search: { kind: "get",
                   path: (p) => `/api/search/${enc(p.search_id)}?cursor=${enc(p.cursor ?? 0)}&limit=${enc(p.limit ?? 100)}` },
    cancel_search: { kind: "ask", path: (p) => `/api/search/${enc(p.search_id)}/cancel`, body: () => ({}) },
    get_navigation: { kind: "get", path: fixed("/api/navigation") },
    start_outline_analysis: { kind: "ask", path: fixed("/api/outline/start") },
    read_outline_analysis: { kind: "get", path: (p) => `/api/outline/${enc(p.analysis_id)}?cursor=${enc(p.cursor ?? 0)}&limit=${enc(p.limit ?? 200)}`
      + (p.generation == null ? "" : `&generation=${enc(p.generation)}`) },
    cancel_outline_analysis: { kind: "ask", path: (p) => `/api/outline/${enc(p.analysis_id)}/cancel`, body: () => ({}) },
    get_page_links: { kind: "get", path: (p) => `/api/page/${p.page}/links?v=${enc(p.v || "")}` },
    get_document_info: { kind: "get", path: fixed("/api/doc") },
    get_page_text: { kind: "get", path: (p) => `/api/page/${p.page}/text?${version(p.v)}` },
    get_page_lines: { kind: "get", path: (p) => `/api/page/${p.page}/lines?v=${enc(p.v || "")}` },
    get_block: { kind: "get", path: (p) => `/api/page/${p.page}/block/${enc(p.block)}` },
    list_annotations: { kind: "get",
                        path: (p) => (p.pages ? `/api/annots?pages=${p.pages.join(",")}` : "/api/annots") },
    get_math_capabilities: { kind: "get", path: fixed("/api/math/capabilities") },
    // Where the document is in its history: what Undo and Redo would do.
    get_state: { kind: "get", path: fixed("/api/state") },
    // Questions with a body. A preparation is one: nothing changes until
    // its token is committed.
    probe_text: { kind: "ask", path: fixed("/api/text/probe") },
    prepare_edit: { kind: "ask", path: fixed("/api/edit/prepare") },
    cancel_edit: { kind: "ask", path: fixed("/api/edit/cancel") },
    analyze_formula: { kind: "ask", path: fixed("/api/formula/analyze") },
    prepare_formula: { kind: "ask", path: fixed("/api/formula/prepare") },
    // Changes.
    commit_edit: { kind: "change", path: fixed("/api/edit/commit") },
    "text.replace": { kind: "change", path: fixed("/api/text/replace") },
    "text.style": { kind: "change", path: fixed("/api/text/style") },
    "text.reflow": { kind: "change", path: fixed("/api/text/reflow") },
    "list.remove_marker": { kind: "change", path: fixed("/api/list/marker") },
    "annot.note": { kind: "change", path: fixed("/api/note") },
    "annot.mark": { kind: "change", path: fixed("/api/mark") },
    "annot.update": { kind: "change", path: (p) => `/api/annot/${p.xref}`, body: without("xref") },
    "annot.delete": { kind: "change", path: (p) => `/api/annot/${p.xref}`,
                      body: without("xref", { delete: true }) },
    "page.rotate": { kind: "change", path: fixed("/api/rotate") },
    "page.delete": { kind: "change", path: fixed("/api/delete") },
    "page.reorder": { kind: "change", path: fixed("/api/reorder") },
    // Back to the verified state before a change, or forward to the one after
    // it: { change_id, revision }. Changes like any other, in the same line.
    undo: { kind: "change", path: fixed("/api/undo") },
    redo: { kind: "change", path: fixed("/api/redo") },
    // Not a change to the document, but ordered with them: it writes the
    // state every change asked for before it produced.
    export_verified: { kind: "change", path: fixed("/api/export"),
                       body: p => ({...p, defer_saved: !p.compact}) },
    mark_saved: { kind: "change", path: fixed("/api/mark-saved") },
    // Resources. A page, a thumbnail (thumb) or one tile of a page's render
    // ([col, row]), under the page's appearance version; a font under its
    // own. Same order of query fields as the viewer always asked for them.
    render_page: { kind: "resource",
                   path: (p) => `/api/page/${p.page}?dpi=${p.dpi}`
                     + (p.tile ? `&tile=${p.tile[0]},${p.tile[1]}` : "")
                     + `&${version(p.v)}` + (p.thumb ? "&thumb=1" : "") },
    get_font: { kind: "resource", path: (p) => `/api/font/${p.xref}?${version(p.v)}` },
  };

  function entry(op) {
    const e = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
    if (!e) throw new Error(`Unknown engine operation: ${op}`);
    return e;
  }

  const kind = (op) => entry(op).kind;

  const abortError = () =>
    Object.assign(new Error("The request was withdrawn before it was sent."), { name: "AbortError" });

  /* A server answer that is not 2xx, as a refusal. The body is read ONCE, as
   * text, and then parsed: reading it as JSON first and as text after a parse
   * failure throws "body already read", which is how a 500 used to reach the
   * screen as a message about the browser rather than the server. */
  async function refused(res, requestId) {
    let raw = "";
    try { raw = await res.text(); } catch { /* the connection dropped mid-body */ }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* not JSON: a proxy, or a crash page */ }
    return Object.assign(new Error(`HTTP ${res.status}`), {
      refused: true,
      status: res.status,
      body,
      code: (body && body.code) || res.headers.get("X-Error-Code") || null,
      requestId: res.headers.get("X-Request-ID") || (body && body.request_id) || requestId,
    });
  }

  /* The production transport: the routes web/app.py serves, on the page's own
   * origin. `fetch` is looked up at every request, not captured here, so
   * whatever the page's fetch is when a request goes out is what sends it. */
  function http() {
    return {
      name: "http",
      withdraws: false,

      async request(op, params = {}, { requestId, signal } = {}) {
        const e = entry(op);
        if (e.kind === "resource") throw new Error(`${op} is a resource; open it with openResource`);
        if (signal?.aborted) throw abortError();
        const headers = {};
        const init = { headers };
        if (e.kind !== "get") {
          init.method = "POST";
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify((e.body || asIs)(params) || {});
        }
        if (requestId) headers["X-Request-ID"] = requestId;
        // Not given the signal: a request that has gone out is left to finish
        // (withdraws: false). A failure to connect rejects as it is: no answer.
        const res = await fetch(e.path(params), init);
        if (!res.ok) throw await refused(res, requestId);
        // Answered, and then cut off, rejects here too: no answer.
        return res.json();
      },

      resourceKey(op, params = {}) {
        const e = entry(op);
        if (e.kind !== "resource") throw new Error(`${op} is not a resource`);
        return e.path(params);
      },

      openResource(key) {
        return { url: key, release() {} };
      },

      subscribe() {
        return () => {};
      },
    };
  }

  return Object.freeze({ kind, http, abortError, OPERATIONS: Object.freeze(Object.keys(OPS)) });
})();

// For Node (the transport tests); in the browser this file is a plain script.
if (typeof module === "object" && module && module.exports) module.exports = EditorTransport;
