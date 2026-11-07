import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile, copyFile, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfHost } from '../src/pdfHost';

// Real worker: DFV_PDF_BINARY=<abs path to dfv-pdf>, DFV_PDF_SAMPLE=<abs path to a small PDF>.
const binary = process.env.DFV_PDF_BINARY, sample = process.env.DFV_PDF_SAMPLE;
const fake = (dir: string) => ({ extensionPath: join(dir, 'ext'), globalStorageUri: { fsPath: join(dir, 'store') } }) as any;
const uri = (fsPath: string) => ({ scheme: 'file', fsPath }) as any;

async function setup(bin?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-pdfhost-'));
  await mkdir(join(dir, 'ext/media/pdf/bin'), { recursive: true });
  const dest = join(dir, 'ext/media/pdf/bin/dfv-pdf');
  if (bin) await symlink(bin, dest);
  return { dir, dest };
}

test('pdfHost: open, edit, export to a verified copy that reopens; original untouched', { skip: !binary || !sample }, async () => {
  const { dir } = await setup(binary);
  const hosts: Array<{ dispose(): void }> = []; // an assertion failure must still stop every worker, or the run never exits
  try {
    const source = join(dir, 'in.pdf');
    await copyFile(sample!, source);
    const before = await readFile(source);
    const host = await createPdfHost(fake(dir), uri(source)); hosts.push(host);
    const state: any = await host.request('get_state', {});
    assert.ok(state.page_count > 0 && !state.dirty);
    await host.request('page.rotate', { pages: [0], degrees: 90, layout: state.layout });
    assert.equal(((await host.request('get_state', {})) as any).dirty, true);
    await assert.rejects(host.exportTo(uri(source)), /never overwritten/);
    const out = join(dir, 'out.pdf');
    await host.exportTo(uri(out));
    assert.equal(((await host.request('get_state', {})) as any).dirty, false, 'exportTo acknowledges its receipt: Save leaves the tab clean');
    host.dispose();
    assert.deepEqual(await readFile(source), before);
    assert.ok((await stat(out)).size > 0);
    const reopened = await createPdfHost(fake(dir), uri(out)); hosts.push(reopened);
    const info: any = await reopened.request('get_state', {});
    assert.equal(info.page_count, state.page_count);
    reopened.dispose();
    // Nothing the host stored sits beside the original.
    await assert.rejects(stat(join(dir, 'in.pdf.bak')));
  } finally { for (const h of hosts) h.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('pdfHost: a worker that dies at start is reported, not hidden', async () => {
  const { dir, dest } = await setup();
  try {
    await writeFile(dest, '#!/bin/sh\nexit 3\n');
    await chmod(dest, 0o755);
    const source = join(dir, 'in.pdf');
    await writeFile(source, '%PDF-1.4\n');
    await assert.rejects(createPdfHost(fake(dir), uri(source)), /worker/i);
    await assert.rejects(createPdfHost(fake(dir), uri(join(dir, 'missing.pdf'))), /Cannot read/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
