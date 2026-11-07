import vscodeStub from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfHost } from '../src/pdfHost';

// Annotation and page edits sent exactly as the viewer's bundle sends them (media/pdf/web/static/*.js),
// through the extension-side host into the REAL dfv-pdf worker, then read back with PyMuPDF from the export.
// Needs DFV_PDF_BIN (the worker) and a Python with PyMuPDF (DFV_PDF_PYTHON, default the myproject env).

const BIN = process.env.DFV_PDF_BIN;
const PY = process.env.DFV_PDF_PYTHON || '/Users/macc/miniforge3/envs/myproject/bin/python3';
const skip = !BIN || !existsSync(BIN) ? 'set DFV_PDF_BIN to the dfv-pdf binary' : !existsSync(PY) ? 'set DFV_PDF_PYTHON to a Python with PyMuPDF' : false;
const uri = (p: string) => vscodeStub.Uri.file(p) as any;

/** Two pages, each with "Annotate me" in 18pt Helvetica at (20, 100). */
function twoPagePdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 100 Td (Annotate me) Tj ET';
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', page,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', page];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, 'latin1');
}

/** [{page, type, contents}] for every annotation in the PDF, via PyMuPDF. */
const annotations = (pdf: string): { page: number; type: string; contents: string }[] => JSON.parse(execFileSync(PY, ['-I', '-c',
  'import sys,json,pymupdf\nd=pymupdf.open(sys.argv[1])\nprint(json.dumps([{"page":p.number,"type":a.type[1],"contents":a.info.get("content","")} for p in d for a in p.annots()]))', pdf], { encoding: 'utf8' }));
const pageCount = (pdf: string): number => +execFileSync(PY, ['-I', '-c', 'import sys,pymupdf\nprint(len(pymupdf.open(sys.argv[1])))', pdf], { encoding: 'utf8' });

async function withHost(fn: (h: Awaited<ReturnType<typeof createPdfHost>>, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'dfv-pdf-annot-'));
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, 'media', 'pdf', 'bin'), { recursive: true });
  symlinkSync(BIN!, join(ext, 'media', 'pdf', 'bin', 'dfv-pdf'));
  const source = join(dir, 'in.pdf');
  writeFileSync(source, twoPagePdf());
  const context = { extensionPath: ext, extensionUri: uri(ext), globalStorageUri: uri(join(dir, 'store')), subscriptions: [] } as any;
  const host = await createPdfHost(context, uri(source));
  try { await fn(host, dir); } finally { host.dispose(); rmSync(dir, { recursive: true, force: true }); }
}

const RECT = [[20, 84, 110, 104]];

test('pdfHost annotations: highlight, underline, strikeout and a note reach the exported PDF', { skip }, () => withHost(async (host, dir) => {
  const geo = async (page = 0) => ((await host.request('get_document_info', {})) as any).pages[page].geo as string;
  // annot.mark as applyMark sends it: the mark type travels in `kind`.
  for (const kind of ['Highlight', 'Underline', 'StrikeOut'])
    await host.request('annot.mark', { page: 0, kind, rects: RECT, color: null, geo: await geo() });
  // annot.note as the note dialog sends it, including its expected_revision.
  const info: any = await host.request('get_document_info', {});
  const noted: any = await host.request('annot.note', { page: 0, doc: info.doc, geo: await geo(), selection_kind: 'text', rects: RECT, contents: 'a real comment', expected_revision: info.revision });
  assert.equal(noted.annotation.kind, 'Text');
  const out = join(dir, 'out.pdf');
  await host.exportTo(uri(out));
  const got = annotations(out);
  assert.deepEqual(got.map(a => a.type).sort(), ['Highlight', 'StrikeOut', 'Text', 'Underline']);
  assert.equal(got.find(a => a.type === 'Text')!.contents, 'a real comment');
  // annot.update / annot.delete as the comment list sends them ({xref, doc, contents}).
  const xref = noted.annotation.xref;
  await host.request('annot.update', { xref, contents: 'edited', doc: info.doc });
  await host.exportTo(uri(join(dir, 'out2.pdf')));
  assert.equal(annotations(join(dir, 'out2.pdf')).find(a => a.type === 'Text')!.contents, 'edited');
  await host.request('annot.delete', { xref, doc: info.doc });
  await host.exportTo(uri(join(dir, 'out3.pdf')));
  assert.deepEqual(annotations(join(dir, 'out3.pdf')).map(a => a.type).sort(), ['Highlight', 'StrikeOut', 'Underline']);
}));

test('pdfHost annotations: page edits in the viewer shape change the exported page list', { skip }, () => withHost(async (host, dir) => {
  const layout = async () => ((await host.request('get_state', {})) as any).layout;
  await host.request('page.rotate', { pages: [0], degrees: 90, layout: await layout() });
  await host.request('page.reorder', { order: [1, 0], layout: await layout() });
  await host.request('page.delete', { pages: [0], layout: await layout() });
  await host.exportTo(uri(join(dir, 'out.pdf')));
  assert.equal(pageCount(join(dir, 'out.pdf')), 1);
}));

test('pdfHost annotations: text edits in the viewer shape are understood by the engine', { skip }, () => withHost(async host => {
  const geo = async () => ((await host.request('get_document_info', {})) as any).pages[0].geo as string;
  // Whatever the engine decides about this content, it must not reject the field names.
  const shapes: [string, any][] = [
    ['text.replace', { page: 0, x: 30, y: 90, new_text: 'x', expect_old: 'Annotate me', allow_shift: false }],
    ['text.reflow', { page: 0, x: 30, y: 90, new_text: 'x', allow_growth: false }],
    ['text.style', { page: 0, rects: RECT, bold: true }],
    ['text.style', { page: 0, rects: RECT, color: [1, 0, 0] }],
  ];
  for (const [op, body] of shapes) {
    const r = await host.request(op, { geo: await geo(), ...body }).then(() => null, e => e);
    if (r) assert.notEqual(r.reason, 'invalid_request', `${op}: ${r.message}`);
  }
}));

test('pdfHost annotations: engine refusals keep their message and are not reported as a lost connection', { skip }, () => withHost(async host => {
  // A command missing a required field: the engine's own words, a 4xx status, flagged as an answered refusal.
  const bad: any = await host.request('annot.mark', { kind: 'Highlight', rects: RECT }).then(() => null, e => e);
  assert.ok(bad, 'must reject');
  assert.equal(bad.refused, true);
  assert.equal(bad.status, 400);
  assert.equal(bad.code, 'invalid_request');
  assert.match(bad.message, /needs 'page'/);
  assert.equal(bad.body.detail, bad.message);
  // A stale expected_revision on a note is a 409 refusal, not a transport loss.
  const info: any = await host.request('get_document_info', {});
  const stale: any = await host.request('annot.note', { page: 0, doc: info.doc, geo: info.pages[0].geo, selection_kind: 'text', rects: RECT, contents: 'n', expected_revision: info.revision + 5 }).then(() => null, e => e);
  assert.ok(stale, 'must reject');
  assert.equal(stale.refused, true);
  assert.equal(stale.status, 409);
  assert.match(stale.message, /revision/i);
  // Host-side refusals (export onto nothing writable is covered elsewhere; closed host here).
  host.dispose();
  const closed: any = await host.request('get_state', {}).then(() => null, e => e);
  assert.equal(closed.refused, true);
  assert.equal(closed.status, 409);
}));
