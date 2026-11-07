/* One properties surface for the existing draft. Controls are moved, never cloned. */
(() => {
  const panel = document.createElement('aside');
  panel.id = 'properties'; panel.className = 'hidden';
  panel.setAttribute('aria-labelledby', 'properties-title');
  panel.innerHTML = `<header><h2 id="properties-title">Properties</h2><button type="button" id="properties-hide" aria-label="Hide Properties">Hide</button></header>
    <p id="properties-object"></p><fieldset id="properties-fields"><legend class="sr-only">Edit properties</legend></fieldset>`;
  document.querySelector('main').append(panel);
  const fields = panel.querySelector('fieldset');
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'properties-toggle'; toggle.className = 'tbtn wide';
  toggle.textContent = 'Properties'; toggle.disabled = true;
  toggle.setAttribute('aria-controls', 'properties'); toggle.setAttribute('aria-expanded', 'false');
  document.getElementById('notes-toggle').after(toggle);
  let current = null, lastFocus = null;

  function show(focus = true) {
    if (!current || current.ed.closed) return;
    document.getElementById('notes').classList.add('hidden');
    const notesToggle = document.getElementById('notes-toggle');
    notesToggle.classList.remove('on'); notesToggle.setAttribute('aria-expanded','false');
    panel.classList.remove('hidden'); toggle.setAttribute('aria-expanded','true');
    scheduleMaintain();
    if (focus && !current.ed.composing) {
      const target = lastFocus?.isConnected && panel.contains(lastFocus) && !lastFocus.closest('.hidden')
        ? lastFocus : current.ed.mode === 'latex' ? current.source.ta : current.area;
      target?.focus({preventScroll:true});
    }
  }
  function hide() {
    // Hiding a live IME source would interrupt its composition session.
    if (current?.ed.composing) { toast('Finish composing text before hiding Properties.', 'warn'); return false; }
    if (panel.contains(document.activeElement) && document.activeElement.id !== 'properties-hide') lastFocus = document.activeElement;
    panel.classList.add('hidden'); toggle.setAttribute('aria-expanded','false');
    if (panel.contains(document.activeElement)) toggle.focus();
    scheduleMaintain();
    return true;
  }
  toggle.onclick = () => panel.classList.contains('hidden') ? show() : hide();
  panel.querySelector('#properties-hide').onclick = hide;
  panel.addEventListener('focusin', ev => { if (ev.target.id !== 'properties-hide') lastFocus = ev.target; });

  function sync() {
    if (!current) return;
    const {ed,host,width,area,editText,grip} = current;
    fields.disabled = !!host.dataset.sending;
    if (area) area.contentEditable = fields.disabled ? 'false' : 'plaintext-only';
    if (width) {
      const value = ed.width ?? ed.layout?.width ?? current.initialWidth;
      if (document.activeElement !== width && Number.isFinite(value)) width.value = String(Math.round(value*100)/100);
      width.min = String(ed.layout?.min_width ?? 1);
      if (Number.isFinite(ed.layout?.max_width)) width.max = String(ed.layout.max_width);
      else width.removeAttribute('max');
      width.disabled = ed.composing || !!host.dataset.stale;
      if (grip) {
        grip.setAttribute('aria-valuenow',width.value); grip.setAttribute('aria-valuemin',width.min);
        if (width.max) grip.setAttribute('aria-valuemax',width.max); else grip.removeAttribute('aria-valuemax');
        grip.setAttribute('aria-disabled',String(width.disabled || fields.disabled));
      }
    }
    if (current.widthPending) current.bar.querySelector('#ipsave').disabled = true;
    if (editText) editText.classList.toggle('hidden', ed.mode !== 'text');
  }
  globalThis.PDFInspector = {
    attach({host,bar,ed,area,source,initialWidth}) {
      this.close();
      current = {host,bar,ed,area,source,initialWidth};
      document.getElementById('properties-object').textContent = `${ed.kind === 'formula' ? 'Formula replacement' : 'Paragraph'} · page ${ed.page + 1}`;
      bar.style.left = ''; fields.append(bar);
      const mode = bar.querySelector('.ipmode');
      if (mode) bar.prepend(mode);
      if (area) {
        const label = document.createElement('label'); label.className = 'properties-width';
        label.innerHTML = 'Paragraph width (pt) <input id="properties-width" type="number" min="1" step="0.1" inputmode="decimal">';
        const input = label.querySelector('input'); current.width = input;
        if (mode) mode.after(label); else bar.prepend(label);
        input.onchange = () => {
          const value = input.valueAsNumber;
          if (fields.disabled || ed.composing || host.dataset.stale) return;
          if (!Number.isFinite(value) || value <= 0) {
            current.widthPending = true; sync();
            input.setCustomValidity('Enter a positive width in PDF points.'); input.reportValidity(); return;
          }
          input.setCustomValidity(''); current.widthPending = false;
          const next = Math.round(clampWidth(ed,value)*100)/100;
          input.value = String(next);
          if (next !== (ed.width ?? ed.layout?.width ?? initialWidth)) { ed.width = next; draftChanged(ed,0); }
          else ed.render();
        };
        const grip = host.querySelector('.ipgrip'); current.grip=grip;
        if (grip) {
          grip.tabIndex=0; grip.setAttribute('role','separator'); grip.setAttribute('aria-orientation','vertical');
          grip.setAttribute('aria-label','Paragraph width in PDF points');
          grip.onkeydown = ev => {
            if (!['ArrowLeft','ArrowRight'].includes(ev.key)) return;
            ev.preventDefault();
            if (fields.disabled || widthDisabled()) return;
            const value=ed.width ?? ed.layout?.width ?? initialWidth;
            input.value=String(value+(ev.key==='ArrowRight'?1:-1)*(ev.shiftKey?10:1));
            input.dispatchEvent(new Event('change'));
          };
        }
        function widthDisabled() { return ed.composing || !!host.dataset.stale; }
        input.oninput = () => { input.setCustomValidity(''); current.widthPending=true; sync(); };
        input.onkeydown = ev => { if (ev.key === 'Enter') {ev.preventDefault();input.dispatchEvent(new Event('change'));} };
        const editText = document.createElement('button'); editText.type='button'; editText.className='ebtn ghost';
        editText.id='properties-edit-text'; editText.textContent='Edit text on page';
        editText.onclick = () => {host.scrollIntoView({block:'center',inline:'nearest'});area.focus({preventScroll:true});};
        label.after(editText); current.editText=editText;
      }
      const actions = document.createElement('div'); actions.className='properties-actions';
      actions.append(bar.querySelector('#ipcancel'),bar.querySelector('#ipsave')); bar.append(actions);
      const status = bar.querySelector('.ipstatus');
      status.tabIndex=0; status.setAttribute('aria-label','Preview status');
      source.ta.setAttribute('aria-label','LaTeX source');
      toggle.disabled=false; sync(); show(false);
    },
    sync,
    owns: bar => current?.bar === bar,
    controls: host => current?.host === host ? current.bar : host,
    show, hide,
    close() {
      if (!current) return;
      const focused = panel.contains(document.activeElement);
      current.bar.remove(); current=null; lastFocus=null; fields.disabled=false;
      panel.classList.add('hidden'); toggle.disabled=true; toggle.setAttribute('aria-expanded','false');
      if (focused) document.getElementById('stage').focus({preventScroll:true});
      scheduleMaintain();
    },
  };
})();
