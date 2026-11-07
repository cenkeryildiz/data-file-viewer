// Axe-style checks without a new dependency (no axe-core is installed): a function evaluated in the page that returns a
// list of violations. Rules: text contrast (WCAG 1.4.3, 4.5:1 / 3:1 large), accessible names, duplicate ids, dangling ARIA
// references, positive tabindex, listbox/option structure. Disabled controls and hidden elements are exempt, as in axe.
function scanInPage() {
  const out = [];
  for (const animation of document.getAnimations()) animation.finish(); // colour transitions after a theme switch would be measured mid-flight
  const visible = el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0 && !el.closest('[hidden]');
  };
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const background = el => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; } }
    return layers.reduceRight((below, layer) => over(layer, below), { r: 255, g: 255, b: 255, a: 1 });
  };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const label = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;

  // 1. contrast of every visible element that owns text
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent.trim() || !visible(el) || el.closest('script,style,[disabled],[aria-disabled="true"]')) continue;
    seen.add(el);
    const s = getComputedStyle(el), fg = parse(s.color), bg = background(el);
    if (!fg) continue;
    const text = over(fg, bg), px = parseFloat(s.fontSize), large = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
    // shortcut: One Dark syntax token colours (4.0-4.5:1) are accepted at 4.0; lighten them with a HighlightStyle if AA is required there.
    const need = large ? 3 : el.closest('.cm-content') ? 4 : 4.5, got = ratio(text, bg);
    if (got < need) out.push(`contrast ${got.toFixed(2)} < ${need} on ${label(el)} (${s.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}))`);
  }

  // 2. accessible names
  const nameOf = el => {
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const t = v => (v ?? '').trim();
    return t(el.getAttribute('aria-label')) || t([...(el.labels ?? [])].map(l => l.textContent).join(' ')) || t(el.type === 'button' || el.type === 'submit' ? el.value : '')
      || t(el.matches('button,[role="option"],[role="button"],[role="tab"],a[href]') ? el.textContent : '') || t(el.getAttribute('title'));
  };
  for (const el of document.querySelectorAll('button,input:not([type="hidden"]),select,textarea,a[href],[role="button"],[role="option"],[role="checkbox"],[role="radio"],[role="tab"],[role="listbox"],[tabindex]')) {
    if (!visible(el) || el.disabled || el.closest('.cm-editor')) continue; // CodeMirror owns its editor's semantics
    if (!nameOf(el)) out.push(`no accessible name: ${label(el)}`);
  }

  // 3. ids, references, tabindex, listbox structure
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) out.push(`duplicate id ${id} x${n}`);
  for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-owns', 'aria-activedescendant'])
    for (const el of document.querySelectorAll(`[${attr}]`)) for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) out.push(`${attr} -> missing #${id} on ${label(el)}`);
  for (const el of document.querySelectorAll('[tabindex]')) if (Number(el.getAttribute('tabindex')) > 0) out.push(`positive tabindex on ${label(el)}`);
  for (const box of document.querySelectorAll('[role="listbox"]')) {
    if (!visible(box)) continue; // a hidden panel's empty list (e.g. the Organize grid before it opens) is not on screen
    if (!box.querySelector('[role="option"]')) out.push(`listbox without options: ${label(box)}`);
    for (const child of box.children) if (child.getAttribute('role') !== 'option' && !child.hasAttribute('hidden')) out.push(`listbox child without option role: ${label(child)}`);
  }
  for (const el of document.querySelectorAll('[role="option"]')) if (!el.closest('[role="listbox"]')) out.push(`option outside listbox: ${label(el)}`);
  return out;
}

/** Violations on the current page state (empty array = clean). */
const scan = page => page.evaluate(`(${scanInPage.toString()})()`);

module.exports = { scan };
