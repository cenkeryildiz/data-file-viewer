# PDF UI work for Claude integration

Owner: Codex. Branch: `codex/pdf-ui-20261030`, separate worktree at
`/Users/macc/Desktop/Kod/.codex-work/dfv-ui-20261030`.

Scope: `media/pdf-vscode/{theme.css,interface.css,surfaces.css,interface.js}`,
`test/{pdfTheme.cjs,pdfInterface.cjs,pdfSurfaces.cjs}`, this handoff and UI previews.
These UI commits do not edit Claude's extension checkout, generated bundle, host/provider, worker,
table engine, package manifest or shared plan. No heavy PDF/VS Code gates or packaging.
The current host has automatic `media/pdf-vscode/*.css` and `*.js` loaders; the committed
baseline used by this branch predates that loader. Apply the UI files to the
current host when ready, rather than replacing the host with this branch's baseline.

## First implemented slice

The viewer chrome follows VS Code's live light, dark and high-contrast theme tokens,
including focus, buttons, panel surfaces, warning/error surfaces and fonts. The
standalone theme selector is hidden inside VS Code, where the host owns the theme.
PDF paper, PDF text and page-overlay tokens keep their existing values. The CSS is
scoped to VS Code body classes and leaves standalone theme selection available.

## Editing interface

The editing surface now uses an Apple-inspired visual direction: a quiet document
surround, neutral segmented workspace tabs and a full-height inset inspector with
rounded corners, soft depth, consistent spacing and stronger type hierarchy. The
panel groups editing mode, paragraph width, selection metadata and preview feedback,
with Apply/Cancel at the bottom. The on-page editor has a softer focus edge and a
larger width-handle target; real PDF text geometry and engine previews are preserved.
No external UI framework, shader, font download or animation library was added.

The inset docked inspector occupies exactly the controller's existing 350px
reservation (326px panel plus 12px margins on each side). The native drawer policy
still decides when it overlays the page; the drawer has a wider, viewport-bounded
380px surface with 12px exterior margins. The whole inspector scrolls when content exceeds its height; its action row
remains sticky where space permits. This keeps controls reachable even when an
enlarged header would otherwise leave no room for the old inner scroller. High-contrast themes
use solid explicit edges and no decorative inspector/menu shadows; reduced-motion
users get no toolbar transitions.

The layer reuses the original control nodes and handlers. It changes no engine
capability, readiness rule, draft guard, panel visibility policy or PDF coordinates.
The helper text explains Apply versus Export; the original unsupported controls
remain disabled. No new font or formatting capability is advertised. Smooth zoom has a source implementation described below; packaged acceptance
remains pending. D7.0 still needs its full acceptance before release.

## Design references

- [VS Code webview theming](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content): use host CSS variables and all four theme classes.
- [VS Code webview UX](https://code.visualstudio.com/api/ux-guidelines/webviews): match the editor's conventions and preserve keyboard access.
- [Mozilla PDF.js viewer CSS](https://github.com/mozilla/pdf.js/blob/master/web/viewer.css): reference for compact grouped controls, neutral document surround and sidebar separation. No source/assets copied.
- [Emil Kowalski's Apple design reference](https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md): reviewed for restrained hierarchy, soft depth, typography and responsive feedback. Used as design research, not installed as a dependency or skill.
- [Mira](https://github.com/Dtheme/Mira) and [apple-design](https://github.com/bowen31337/apple-design): reviewed as Apple-inspired design-system references. No code/assets copied.

## Reading interface

The same style now covers normal viewing: segmented Pages/Outline tabs, softly
selected thumbnails, rounded outline rows and search field, calmer comment cards,
page shadows and quiet panel dividers. An unavailable editing panel toggle is hidden;
an empty workspace tool row takes no vertical space. Existing sidebar widths,
resizers, tool overflow, annotation data and PDF page coordinates are retained.
The PDF page and thumbnails keep a light colour scheme even in dark chrome.

Reading previews in `docs/pdf-ui-previews/reading-*.png` use a clearly labelled
sample page rasterized from an HTML fixture, repeated in three illustrative
thumbnails; sample comments/outline are supplied by the harness. They demonstrate
the styled viewer DOM, not worker rendering, actual PDF navigation or annotation
readback. Browser checks cover editor-closed state, reachable controls at
1440/1024/640px, outline input reachability and light/dark/comments layouts.

## Focused validation

30 October 2026: both browser scripts exited 0. All four theme checks,
standalone-isolation, inspector behaviour, four viewport sizes and enlarged-text
checks passed, including the 350px inspector reservation, editing inspector in dark
and both high-contrast themes, and reduced-motion behaviour. JavaScript syntax checks
passed. Wide/narrow editing previews and theme screenshots were visually inspected. Screenshots
use synthetic host theme variables, not an actual VS Code theme export.

Capture limitation: hardware-accelerated headless capture sometimes omitted sample
page text/images after a theme switch, despite visible DOM, correct decoded images
and correct hit-testing. The interface harness now uses installed Chrome locally
(bundled Chromium in CI) with GPU disabled; complete captures were visually verified.
Direct stage captures are retained as extra evidence. These software-rendered
screenshots do not qualify GPU performance or packaged-host theme-switch fidelity;
verify both in real VS Code during integration.

Inputs read from the current packaged bundle (SHA-256):

- `index.html`: `9e2efa6778c72b7d01c1ac12e10e63c96cc246b6884f3e6b9cfe947fe8abf735`
- `style.css`: `a069d8cfc236cb456e9643d9b17bd68017a16be9ae4acea66bf5494f397c241d`
- `viewerInspector.js`: `67bf55b28205a1abe480d3d5d317a683ac6190332e7df99c96dfda04061ef529`
- `workspace.js`: `88799979eb5f6f3333de1b2e86cd990a7f9208848d943b0f546c49d5cc5ec207`

Use the existing Playwright installation; no dependency install is required:

```sh
NODE_PATH=/Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/node_modules \
  node test/pdfTheme.cjs \
  /Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/media/pdf/web/static \
  /tmp/dfv-ui-20261030
```

Run `test/pdfInterface.cjs` with the same arguments to exercise the actual inspector
and workspace controllers against stubbed engine dependencies. It checks Apply
readiness/handler identity, unsupported tools, refused workspace transitions, draft
retention on hide/reopen, IME hide protection, keyboard focus, and reachable controls
at 1440/1024/800/640/480/320px, plus enlarged text and long refusal messages.
At 320px with 200% text and a 700px viewport, keyboard focus can reach both the
heading controls and Apply/Cancel by scrolling the inspector. The test supplies
the panel controller's drawer class at narrow widths; it does not qualify that
controller's engine-driven layout decisions. `editing-*.png` show an explicitly
labeled HTML sample document, not rendered PDF output.

The test reads the current bundle HTML/CSS and strips scripts. It verifies live theme
changes, priority over the opposite standalone theme, visible focus, high-contrast
control borders and invariant PDF/overlay tokens. Screenshots are chrome-only:
they do not demonstrate a loaded PDF or an end-to-end edit/save workflow. The real
packaged webview, custom themes and render/edit/save/recovery regressions remain
integration checks for Claude after applying the layer.

## Smooth zoom source handoff — 30 October 2026

Root Kod commit `4450b88` on `codex/pdf-smooth-zoom-20261030` changes
`Projects/Python/pdf_creator/web/static/viewer.js` and adds
`Projects/Python/pdf_creator/tests/browser/smooth_zoom.cjs`. Both are applied
to the active canonical source checkout; its original viewer hash was checked
before writing. This is a root-repository commit, separate from these nested
extension UI commits. Claude's generated extension bundle and host are untouched.
Rebuild the native UI bundle from the updated canonical viewer before packaging
the extension; the existing bundle copy remains stale until then.

Pinch zoom now resizes the existing page boxes once per animation frame, keeps
the point under the current pointer anchored, and reuses current images and
overlays until sharper pixels are due. Gesture completion changes no geometry.
Queued events are rejected if the document or zoom changes; keyboard zoom flushes
pending input. Safari cumulative gestures, wheel delta units, draft refusal,
10–800% limits and browser accessibility zoom outside the document are retained.
Pages narrower than the viewport remain centered; anchoring is constrained by
the available scroll range at document edges.

Run from the canonical PDF project with existing Playwright available:

```sh
NODE_PATH=/Users/macc/Desktop/Kod/Projects/Rust/data-file-viewer/node_modules node tests/browser/smooth_zoom.cjs
```

Focused Chrome checks pass for event coalescing, less than one pixel anchor
error, a moving pointer, identical geometry before/after idle, image and overlay
node retention, draft refusal, superseded document/zoom input, keyboard
interruption, cumulative synthetic Safari events, bounds, centered small pages
and 1,000 page shells. The original implementation fails the per-frame-update
regression assertion. All 88 existing viewport, direction, scheduling, transport
and transition tests pass against the changed source.

The focused browser harness uses real DOM/CSS and original zoom functions,
with scheduling/engine collaborators stubbed and software rendering. It does
not qualify native request counts, rendered PDF fidelity, actual in-place edit
preparation, hardware GPU frame times, physical Mac trackpad or Safari input,
or the packaged VS Code webview. D7.0 smooth-zoom acceptance remains open.

## Inspector accessibility and host fields — 30 October 2026

The helper is linked as the inspector's accessible description and describes
both text and formula changes. Source fields now use the host input background
and foreground, including when its theme opposes the standalone viewer theme.
Warning/error surfaces fall back to host chrome and text if the host omits
semantic colors, rather than assuming a dark theme. The focused theme check
covers these tokens in all four host theme classes and preserves PDF colors.

## Search and secondary editing surfaces — 30 October 2026

`media/pdf-vscode/surfaces.css` styles existing Find, unapplied-change
confirmation, page selection, recovery, reading text, note composition and
external-link surfaces. The fallback run editor gets a wider bounded surface,
readable spacing and a scrollable body. It retains its source field, original
font choice and engine handlers. No new capability or action is introduced.
The existing host loads this CSS automatically alongside the other layers.

Optional host hover/pressed/title colors fall back to the current host surface
and text, avoiding dark fallback buttons with dark text in a light theme.
The theme check measures fallback secondary-button text at a ratio of at least
4.5 against its background in the two supplied light/dark test profiles.

`test/pdfSurfaces.cjs` accepts the same static-directory/evidence arguments as
the other focused checks. It uses the original search and transition controllers
with fixture engine replies, plus the original fallback editor's HTML constructor.
Checks cover retained search query, disabled unsupported options, selected result
navigation, controls at 320px, Keep editing as initial focus, Escape returning Keep,
disabled Apply, Tab containment and a long confirmation at 200% text size. The
fallback source remains identical through resizing and its action stays reachable;
high-contrast edges stay visible without a decorative shadow. Its edit submission
handler is not loaded, so this is no native edit acceptance.

`docs/pdf-ui-previews/search-*.png`, `confirmation-light.png` and
`editing-fallback-light.png` show labelled sample content. Captures wait for two
paint frames after resizing to avoid stale compositor tiles. Full packaged
webview, hardware input and native read/edit/save behavior remain unqualified.

## Focus, recovery and note retention — 30 October 2026

Selected-text actions now share the rounded surface and controls. Disabled note
Apply buttons use disabled colors; the original primary-button selector otherwise
kept them blue while submission was blocked. The paragraph-width handle gets a
black/white keyboard focus edge that remains visible over page pixels.

The inspector harness exercises the original keyboard width handler, including
1pt/10pt steps, its ARIA value and busy/IME guards. The surface harness also loads
the original recovery and reading-text modules: readonly source retains Unicode
and whitespace, Select source selects its exact text, and reading text follows
the fixture engine's line order. Recovery selection makes no engine write.

The original selection-action/note controller is checked with fixture mutation
and checkpoint collaborators: arrow/Home/End navigation, empty note prevention,
source retention and disabled Apply after refusal, no automatic replay, and a
failed Keep draft leaving the composer open. Note controls remain reachable at
320px. These are UI/controller checks, not native checkpoint durability or PDF
annotation acceptance. Updated editing captures and new recovery, reading-text,
selection and retained-note captures are in `docs/pdf-ui-previews/`.

## Live outline and long comments — 30 October 2026

Outline source selection and controls use the same rounded fields. The surface
harness mounts the original `outline.js` module with fixture PDF bookmarks; it
checks arrow-key expansion/navigation, Enter activation and a Unicode heading
filter. Sidebar widths are measured at 160/192/300px and the controls do not
overflow. Only `get_navigation` is requested; no heading-analysis work is started.

Long comment bodies, quotes and author names wrap without altering their text;
action rows wrap too. The harness checks 260/304/420px comments widths with long
unbroken references and names, and confirms an action remains reachable.
`outline-live-light.png` shows the real outline UI with fixture bookmarks,
complementing the earlier illustrative outline capture.
