/* Document search: query generations, cancellation, result paging and
 * ephemeral match overlays over the search-resource protocol
 * (SEARCH_PROTOCOL.md v1: start_search, read_search, cancel_search).
 *
 * The controller holds no DOM and talks to the engine only through
 * `deps.request(op, params, opts)`, so the same logic runs in the browser,
 * in Node tests with a fake engine, and later against the Rust worker.
 * Overlays are drawn from engine coordinates (displayed page space, the
 * same space selection uses); they are never PDF annotations.
 */
const PDFSearch = (() => {
  const DEBOUNCE_MS = 150;          // after the last query edit
  const POLL_MS = 60;               // between reads while nothing new arrived
  const READ_LIMIT = 100;           // matches per read (protocol maximum 200)
  const RESULT_ROWS = 100;          // result rows mounted at once
  const MAX_QUERY = 256;
  const SCOPES = ["text", "formula_source", "comments"];
  const SCOPE_LABEL = {text: "Text", formula_source: "Formula source", comments: "Comments"};

  /* What a search request says, or the reason it cannot be sent. */
  function searchParams(query, options = {}, revision) {
    const q = String(query ?? "");
    if (!q.trim()) return {error: "Enter text to search."};
    if (q.length > MAX_QUERY) return {error: `Search text is limited to ${MAX_QUERY} characters.`};
    const scope = SCOPES.includes(options.scope) ? options.scope : "text";
    return {params: {query: q, expected_revision: revision, case_sensitive: !!options.caseSensitive,
                     whole_word: !!options.wholeWord, scope}};
  }

  /* Which options this engine says it supports (get_capabilities().search).
   * Unknown or absent capabilities support only the plain text search. */
  function supportedOptions(caps) {
    const s = caps && caps.search;
    return {
      caseSensitive: !!(s && s.case_sensitive),
      wholeWord: !!(s && s.whole_word),
      scopes: s && Array.isArray(s.scopes) ? SCOPES.filter((x) => s.scopes.includes(x)) : ["text"],
      maxMatches: (s && s.max_matches) || 5000,
    };
  }

  function statusText(st) {
    const n = st.matches.length;
    const word = n === 1 ? "match" : "matches";
    const progress = st.pagesTotal ? ` · searched ${st.pagesScanned} of ${st.pagesTotal} pages` : "";
    switch (st.status) {
      case "idle": return st.message || "";
      case "waiting": return "Searching after you stop typing…";
      case "starting": return "Starting search…";
      case "running": return `${n} ${word}${progress}`;
      case "complete": return n ? `${n} ${word}${progress}` : "No matching text found. Scanned pages require OCR.";
      case "truncated": return `${st.maxMatches}+ matches; narrow the query${progress}`;
      case "cancelled": return `Search stopped; ${n} partial ${word} shown${progress}.`;
      default: return st.message || "";
    }
  }

  function createController(deps) {
    // Called unbound: window.setTimeout throws "Illegal invocation" as a method of another object.
    const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout || ((id) => clearTimeout(id));
    const timers = {set: (fn, ms) => setT(fn, ms), clear: (id) => clearT(id)};
    let generation = 0, debounce = 0, capsAsked = null;
    const st = {status: "idle", message: "", query: "", options: {caseSensitive: false, wholeWord: false, scope: "text"},
                searchId: null, doc: null, revision: null, matches: [], current: -1,
                pagesScanned: 0, pagesTotal: 0, maxMatches: 5000, supported: supportedOptions(null)};
    const changed = () => deps.onChange?.(st);
    const sleep = (ms) => new Promise((resolve) => timers.set(resolve, ms));

    async function capabilities() {
      if (!capsAsked) capsAsked = Promise.resolve(deps.request("get_capabilities", {}))
        .then((caps) => { st.supported = supportedOptions(caps); st.maxMatches = st.supported.maxMatches; changed(); return st.supported; })
        .catch(() => st.supported);
      return capsAsked;
    }

    /* Stop the engine's search (if any); the answer is not waited for. */
    function release() {
      const id = st.searchId;
      st.searchId = null;
      if (id) Promise.resolve(deps.request("cancel_search", {search_id: id})).catch(() => {});
    }

    function reset(status, message) {
      generation++;
      timers.clear(debounce); debounce = 0;
      release();
      Object.assign(st, {status, message, matches: [], current: -1, pagesScanned: 0, pagesTotal: 0});
      changed();
    }

    function setQuery(query, options) {
      reset("idle", "");
      st.query = String(query ?? "");
      if (options) st.options = {...st.options, ...options};
      if (!st.query.trim()) { st.message = ""; changed(); return; }
      st.status = "waiting"; changed();
      const mine = generation;
      debounce = timers.set(() => { if (mine === generation) start(); }, DEBOUNCE_MS);
    }

    function setOptions(options) { setQuery(st.query, options); }

    async function start(query, options) {
      if (query !== undefined) st.query = String(query);
      if (options) st.options = {...st.options, ...options};
      reset("starting", "");
      const mine = generation;
      const doc = deps.doc();
      if (!doc) { st.status = "idle"; st.message = "Open a document to search."; changed(); return; }
      const built = searchParams(st.query, st.options, doc.revision);
      if (built.error) { st.status = "idle"; st.message = built.error; changed(); return; }
      await capabilities();
      if (mine !== generation) return;
      st.doc = doc.doc; st.revision = doc.revision;
      const timing = deps.perf?.begin("search", {pages: doc.pages});
      let answer;
      try {
        answer = await deps.request("start_search", built.params, {priority: "search"});
      } catch (e) {
        deps.perf?.end(timing, "refused");
        if (mine !== generation) return;
        st.status = "error";
        st.message = e?.body?.code === "search_option_unsupported"
          ? "This engine does not support that search option yet."
          : deps.explain ? deps.explain(e) : String(e?.message || e);
        changed(); return;
      }
      if (mine !== generation) {
        Promise.resolve(deps.request("cancel_search", {search_id: answer.search_id})).catch(() => {});
        deps.perf?.end(timing, "superseded"); return;
      }
      if (answer.doc !== st.doc || answer.revision !== st.revision) {
        Promise.resolve(deps.request("cancel_search", {search_id: answer.search_id})).catch(() => {});
        reset("stale", "Document changed. Search again for current results.");
        deps.perf?.end(timing, "superseded"); return;
      }
      st.searchId = answer.search_id; st.pagesTotal = answer.pages_total; st.status = "running";
      if (answer.limits?.max_matches) st.maxMatches = answer.limits.max_matches;
      changed();
      let cursor = 0, first = true;
      try {
        for (;;) {
          const r = await deps.request("read_search", {search_id: answer.search_id, cursor, limit: READ_LIMIT},
                                       {priority: "search"});
          if (mine !== generation) { deps.perf?.end(timing, "superseded"); return; }
          if (!valid()) { invalidate(); deps.perf?.end(timing, "superseded"); return; }
          for (const m of r.matches) st.matches.push(m);
          if (r.matches.length && first) { first = false; if (st.current < 0) st.current = 0; deps.perf?.mark(timing, "first_result"); }
          st.pagesScanned = r.pages_scanned; st.pagesTotal = r.pages_total;
          cursor = r.next_cursor ?? cursor + r.matches.length;
          if (r.next_cursor === null || r.next_cursor === undefined) {
            st.status = r.truncated ? "truncated" : "complete";
            st.searchId = null;
            changed();
            deps.perf?.end(timing, r.truncated ? "capped" : "ok", {scanned: r.pages_scanned, matches: st.matches.length});
            return;
          }
          changed();
          if (!r.matches.length) await sleep(POLL_MS);
          if (mine !== generation) { deps.perf?.end(timing, "superseded"); return; }
        }
      } catch (e) {
        deps.perf?.end(timing, "refused");
        if (mine !== generation) return;
        const reason = e?.body?.code;
        if (reason === "search_stale" || e?.status === 409) { reset("stale", "Document changed. Search again for current results."); return; }
        st.searchId = null; st.status = "error";
        st.message = reason === "search_expired" ? "Search expired. Search again."
          : deps.explain ? deps.explain(e) : String(e?.message || e);
        changed();
      }
    }

    function stop() {
      if (!["running", "starting", "waiting"].includes(st.status)) return;
      generation++;
      timers.clear(debounce); debounce = 0;
      release();
      st.status = st.matches.length || st.pagesScanned ? "cancelled" : "idle";
      st.message = st.status === "idle" ? "Search stopped." : "";
      changed();
    }

    function valid() {
      const doc = deps.doc();
      return !!doc && doc.doc === st.doc && doc.revision === st.revision;
    }

    function invalidate(message = "Document changed. Search again for current results.") {
      if (st.status === "idle" && !st.matches.length && !st.searchId) return;
      reset("stale", message);
    }

    /* A result is shown only while its page still has the geometry it was
     * found on: anything else could highlight moved content. */
    function matchValid(m) {
      const doc = deps.doc();
      return !!m && valid() && doc.pageGeo(m.page) === m.geo;
    }

    function go(index) {
      if (!st.matches.length) return null;
      const n = st.matches.length;
      const i = ((index % n) + n) % n;
      const m = st.matches[i];
      if (!matchValid(m)) { invalidate("This result is out of date: the document changed. Search again."); return null; }
      st.current = i; changed();
      return m;
    }

    function close() {
      generation++;
      timers.clear(debounce); debounce = 0;
      release();
      if (["running", "starting", "waiting"].includes(st.status)) st.status = st.matches.length ? "cancelled" : "idle";
      changed();
    }

    return {state: st, setQuery, setOptions, start, stop, invalidate, go, next: () => go(st.current + 1),
            previous: () => go(st.current - 1), close, capabilities, matchValid,
            status: () => statusText(st)};
  }

  /* The panel: options, status, Previous/Next, a bounded result list and the
   * overlays on mounted pages. `host` provides doc(), request(), navigate(),
   * ensureVisible(), perf, explain and the finder dialog. */
  function mountPanel(host) {
    const {finder} = host;
    const queryField = finder.querySelector("#find-query");
    const message = finder.querySelector("#find-status");
    const options = document.createElement("div");
    options.className = "find-options";
    options.innerHTML = `<label><input id="find-case" type="checkbox"> Match case</label>
      <label><input id="find-word" type="checkbox"> Whole words</label>
      <label>In <select id="find-scope" aria-label="Search in">${SCOPES.map((s) => `<option value="${s}">${SCOPE_LABEL[s]}</option>`).join("")}</select></label>
      <span id="find-options-note" class="find-note"></span>`;
    queryField.closest("label").after(options);
    const nav = document.createElement("div");
    nav.className = "find-navigation";
    nav.innerHTML = '<button id="find-previous" type="button" disabled>Previous</button><button id="find-next" type="button" disabled>Next</button><span id="find-position" role="status"></span>';
    message.before(nav);
    message.setAttribute("aria-live", "polite");
    const old = finder.querySelector("#find-results");
    const list = document.createElement("div");
    list.id = "search-results"; list.setAttribute("role", "list"); list.setAttribute("aria-label", "Search results");
    if (old) old.replaceWith(list); else message.after(list);
    const pager = document.createElement("div");
    pager.className = "search-pager";
    pager.innerHTML = '<button id="search-rows-previous" type="button">Earlier results</button><button id="search-rows-next" type="button">Later results</button>';
    list.after(pager);
    const caseBox = options.querySelector("#find-case"), wordBox = options.querySelector("#find-word");
    const scopeSel = options.querySelector("#find-scope");
    let rowStart = 0, painted = null, shownCurrent = null;

    const ctl = createController({
      request: host.request, doc: host.doc, perf: host.perf, explain: host.explain,
      onChange: () => render(),
    });

    function chosen() { return {caseSensitive: caseBox.checked, wholeWord: wordBox.checked, scope: scopeSel.value}; }

    function applySupport() {
      const s = ctl.state.supported;
      const off = "Not supported by this engine yet";
      caseBox.disabled = !s.caseSensitive; caseBox.title = caseBox.disabled ? off : "";
      wordBox.disabled = !s.wholeWord; wordBox.title = wordBox.disabled ? off : "";
      for (const o of scopeSel.options) { o.disabled = !s.scopes.includes(o.value); o.title = o.disabled ? off : ""; }
      if (caseBox.disabled) caseBox.checked = false;
      if (wordBox.disabled) wordBox.checked = false;
      if (scopeSel.selectedOptions[0]?.disabled) scopeSel.value = "text";
      const missing = [caseBox.disabled && "match case", wordBox.disabled && "whole words",
                       s.scopes.length < SCOPES.length && "formula source and comment scopes"].filter(Boolean);
      options.querySelector("#find-options-note").textContent = missing.length ? `Not yet supported by this engine: ${missing.join(", ")}.` : "";
    }

    function row(m, i) {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "listitem"); b.dataset.match = String(i);
      const where = document.createElement("span"); where.className = "search-where";
      where.textContent = `Page ${m.page + 1}${m.scope && m.scope !== "text" ? ` · ${SCOPE_LABEL[m.scope] || m.scope}` : ""}`;
      b.append(where, " ");
      const sn = m.snippet;
      if (sn && typeof sn.text === "string") {
        const text = document.createElement("span"); text.className = "search-snippet";
        if (Number.isInteger(sn.start) && Number.isInteger(sn.end) && sn.end > sn.start) {
          const mark = document.createElement("mark");
          mark.textContent = sn.text.slice(sn.start, sn.end);
          text.append(sn.text.slice(0, sn.start), mark, sn.text.slice(sn.end));
        } else text.textContent = sn.text;
        b.append(text);
      }
      if (i === ctl.state.current) { b.classList.add("current"); b.setAttribute("aria-current", "true"); }
      b.onclick = () => goTo(i);
      return b;
    }

    function render() {
      const st = ctl.state;
      applySupport();
      message.textContent = statusText(st);
      finder.querySelector("#find-previous").disabled = finder.querySelector("#find-next").disabled = !st.matches.length;
      finder.querySelector("#find-position").textContent = st.matches.length && st.current >= 0
        ? `${st.current + 1} / ${st.matches.length}${st.status === "truncated" ? "+" : ""} matches` : "";
      // Browsing another result page must not move the selected match. Follow
      // selection only when it changes, including the first match of a new search.
      const current = st.matches[st.current] ?? null;
      if (current !== shownCurrent) {
        shownCurrent = current;
        if (st.current >= 0 && (st.current < rowStart || st.current >= rowStart + RESULT_ROWS)) rowStart = Math.floor(st.current / RESULT_ROWS) * RESULT_ROWS;
      }
      rowStart = Math.max(0, Math.min(rowStart, Math.max(0, st.matches.length - 1)));
      const end = Math.min(st.matches.length, rowStart + RESULT_ROWS);
      const key = `${st.matches.length}:${rowStart}:${st.current}:${st.status}`;
      if (key !== painted) {
        painted = key;
        const rows = [];
        for (let i = rowStart; i < end; i++) rows.push(row(st.matches[i], i));
        list.replaceChildren(...rows);
        pager.hidden = st.matches.length <= RESULT_ROWS;
        pager.querySelector("#search-rows-previous").disabled = rowStart === 0;
        pager.querySelector("#search-rows-next").disabled = end >= st.matches.length;
        paintAll();
      }
    }

    function paint(index) {
      const wrap = host.shell(index), page = host.page(index);
      if (!wrap || !page) return;
      wrap.querySelector(":scope > .search-layer")?.remove();
      const st = ctl.state;
      if (!finder.open || !st.matches.length || !host.mounted(index)) return;
      const doc = host.doc();
      if (!doc || doc.doc !== st.doc || doc.revision !== st.revision) return;
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg"); svg.classList.add("search-layer");
      svg.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
      svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
      st.matches.forEach((m, n) => {
        // Only results found on the geometry the page has now.
        if (m.page !== index || m.geo !== page.geo) return;
        for (const quad of m.quads || []) {
          const polygon = document.createElementNS(ns, "polygon");
          polygon.setAttribute("points", [0, 1, 3, 2].map((i) => quad[i].join(",")).join(" "));
          if (n === st.current) { polygon.classList.add("current"); if (!svg.querySelector("#current-search-match")) polygon.id = "current-search-match"; }
          svg.append(polygon);
        }
      });
      if (svg.childElementCount) wrap.append(svg);
    }

    function paintAll() { for (const index of host.mountedPages()) paint(index); }

    function goTo(i) {
      const m = ctl.go(i);
      if (!m) return;
      host.navigate(m.page);
      host.ensureVisible?.();
      paintAll(); render();
      finder.querySelector("#current-search-match")?.scrollIntoView({block: "center", inline: "nearest"});
    }

    finder.querySelector("#find-start").onclick = () => ctl.start(queryField.value, chosen());
    finder.querySelector("#find-stop").onclick = () => ctl.stop();
    finder.querySelector("#find-previous").onclick = () => goTo(ctl.state.current - 1);
    finder.querySelector("#find-next").onclick = () => goTo(ctl.state.current + 1);
    pager.querySelector("#search-rows-previous").onclick = () => { rowStart = Math.max(0, rowStart - RESULT_ROWS); painted = null; render(); };
    pager.querySelector("#search-rows-next").onclick = () => { rowStart += RESULT_ROWS; painted = null; render(); };
    queryField.addEventListener("input", () => ctl.setQuery(queryField.value, chosen()));
    for (const el of [caseBox, wordBox, scopeSel]) el.addEventListener("change", () => ctl.setOptions(chosen()));
    queryField.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const st = ctl.state;
      if (st.query === queryField.value && st.matches.length) goTo(st.current + (ev.shiftKey ? -1 : 1));
      else ctl.start(queryField.value, chosen());
    });
    finder.addEventListener("close", () => { ctl.close(); for (const el of document.querySelectorAll(".search-layer")) el.remove(); painted = null; render(); });
    render();

    return {
      controller: ctl, paint, paintAll,
      opened() { ctl.capabilities(); paintAll(); },
      revisionChanged() { if (!(ctl.state.doc === host.doc()?.doc && ctl.state.revision === host.doc()?.revision)) ctl.invalidate(); },
      next() { goTo(ctl.state.current + 1); }, previous() { goTo(ctl.state.current - 1); },
      hasMatches: () => ctl.state.matches.length > 0,
    };
  }

  return Object.freeze({createController, mountPanel, searchParams, supportedOptions, statusText,
                        DEBOUNCE_MS, READ_LIMIT, RESULT_ROWS});
})();

if (typeof module === "object" && module && module.exports) module.exports = PDFSearch;
