/* Presentation only; retain the inspector's original nodes and event handlers. */
(() => {
  if (!document.body.className.includes('vscode-')) return;
  const panel = document.getElementById('properties');
  if (!panel || document.getElementById('editing-help')) return;
  panel.querySelector('#properties-title').textContent = 'Edit selection';
  document.getElementById('properties-toggle').textContent = 'Edit selection';
  panel.querySelector('#properties-hide').setAttribute('aria-label', 'Hide editing panel');
  const kicker = document.createElement('p');
  kicker.id = 'editing-kicker';
  kicker.textContent = 'EDITOR';
  panel.prepend(kicker);
  const help = document.createElement('p');
  help.id = 'editing-help';
  help.textContent = 'Review your change on the page. Apply keeps the change; Export saves a PDF copy.';
  panel.querySelector('#properties-object').after(help);
  panel.setAttribute('aria-describedby', help.id);
})();
