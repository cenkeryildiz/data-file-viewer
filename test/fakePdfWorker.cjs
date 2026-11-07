// Scripted PDF transport faults only; real feature/fidelity checks use the pinned Rust worker.
const fs = require('node:fs');
const reply = (id, result) => process.stdout.write(JSON.stringify({ protocol_version: 1, request_id: id, result }) + '\n');
const state = { session_id: 'test-session', revision: 0, dirty: false, layout: 'test-layout', page_count: 1, pid: process.pid };
let buffer = '';
let resourceFault, heldMutation;
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf('\n')) >= 0;) {
    const m = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
    fs.appendFileSync(process.env.DFV_FAKE_PDF_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\n');
    const fault = m.params?.fault ?? m.params?.command?.fault;
    if (fault === 'hold-mutation') { heldMutation = m.request_id; continue; }
    if (m.method === 'cancel_search' && m.params?.resume && heldMutation !== undefined) { reply(heldMutation, { ...state }); heldMutation = undefined; }
    if (fault === 'hang') continue;
    if (fault === 'oversized-partial') { process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120)); continue; }
    if (fault === 'oversized-line') { reply(m.request_id, 'x'.repeat(8 * 1024 * 1024)); continue; }
    if (fault === 'malformed-frame') { process.stdout.write('invalid JSON\n'); continue; }
    if (fault === 'resource' || fault === 'resource-base64') { resourceFault = fault; reply(m.request_id, { resource: { handle: 'bad-resource', mime: 'image/png', length: 1 } }); continue; }
    if (m.method === 'read_resource') { reply(m.request_id, { handle: 'bad-resource', mime: 'image/png', offset: 0, length: resourceFault === 'resource-base64' ? 1 : 0, total: 1, eof: resourceFault === 'resource-base64', data: resourceFault === 'resource-base64' ? '/x==' : '' }); continue; }
    reply(m.request_id, m.method === 'open_document' ? { ...state } : m.method.startsWith('cancel_') ? { cancelled: true } : { ...state });
  }
});
process.stdin.on('end', () => process.exit(0));
