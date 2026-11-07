import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchCell } from '../src/xlsxWrite';
import { ViewerFile } from '../src/viewerFile';
import { xlsxFile } from './stress/generators/_write';
import { injectRename, injectStageFault, readCells, sha256, STAGE_MARK } from './safeX2/faults';

/**
 * SAFE-X2: publication safety of the one-cell .xlsx writer.
 *
 * Each test is one of the audit probes (viewer_plan_validation_20261016,
 * probe_backend.cjs / probe_concurrent.cjs) turned into a product regression.
 * The outcome is always checked with an independent reader (fflate unzip plus
 * a direct read of the cell XML), never with the writer's own zipPatch.
 *
 * The rule under test: after any save attempt, the file holds either the old
 * good workbook or the verified new one, and the caller is told which.
 * Process exits and injected I/O errors are not physical power-loss tests.
 */

interface Receipt {
  outcome?: string;
  reconciled?: boolean;
  sourceSha256?: string;
  publishedSha256?: string;
  directorySync?: string;
  recovered?: { kind: string; name: string; outcome?: string }[];
}
type OutcomeError = Error & { outcome?: string };

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-safe-x2-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function workbook(name: string): Promise<{ path: string; bytes: Buffer }> {
  const path = join(dir, name);
  await xlsxFile(path, [
    { name: 'A', rows: [['Name', 'Value'], ['old', 1]] },
    { name: 'B', rows: [['Name', 'Value'], ['untouched', 9]] },
  ]);
  return { path, bytes: await readFile(path) };
}

function request(path: string, bytes: Uint8Array, column = 'A', newValue: unknown = 'edited', expectedCurrent: unknown = 'old') {
  return {
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: column,
    columnNames: ['A', 'B'],
    rowOrdinal: 2,
    verbatim: true,
    expectedCurrent,
    newValue,
    expectedSha256: sha256(bytes),
  };
}

/** Writer debris beside `path`: staging files and coordination locks. */
async function leftovers(path: string): Promise<string[]> {
  const base = path.slice(dir.length + 1);
  return (await readdir(dir)).filter((n) => n.startsWith(base + '.') && n !== base);
}

async function settle(promise: Promise<unknown>): Promise<{ receipt?: Receipt; error?: OutcomeError }> {
  try {
    return { receipt: (await promise) as Receipt };
  } catch (error) {
    return { error: error as OutcomeError };
  }
}

test('SAFE-X2 probe disk-full: partial stage is refused, old file kept, staging removed', async () => {
  const { path, bytes } = await workbook('disk-full.xlsx');
  const restore = injectStageFault(async (_stage, data) => ({
    write: data.subarray(0, 20),
    error: Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }),
  }));
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.ok(result.error, 'a failed stage write must not report success');
  assert.match(result.error.message, /injected disk full|not changed|not published/i);
  assert.deepEqual(await readFile(path), bytes, 'the original workbook must survive');
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 probe pre-rename refusal: old file kept, staging removed, outcome not-published', async () => {
  const { path, bytes } = await workbook('rename-refused.xlsx');
  const restore = injectRename(async () => {
    throw Object.assign(new Error('injected refusal'), { code: 'EACCES' });
  });
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.ok(result.error);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await leftovers(path), []);
  assert.equal(result.error.outcome, 'not-published', 'the caller must be told the workbook was not changed');
});

test('SAFE-X2 probe corrupt stage: an unreadable candidate is never published', async () => {
  // Audit: rename succeeded, no error, independent openpyxl could not open the file.
  const { path, bytes } = await workbook('corrupt-stage.xlsx');
  const restore = injectStageFault(async (_stage, data) => ({ write: data.subarray(0, 20) }));
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.ok(result.error, 'a corrupt staged archive must be refused, not published');
  assert.equal(result.error.outcome, 'not-published');
  assert.deepEqual(await readFile(path), bytes, 'the original workbook must survive');
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['old', '1']);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 probe corrupt stage (bit flip in the edited member) is refused', async () => {
  // A stage of the right length whose edited member no longer decodes to the
  // intended XML: the structural ZIP check alone would not notice.
  const { path, bytes } = await workbook('bitflip-stage.xlsx');
  const restore = injectStageFault(async (_stage, data) => {
    const copy = Buffer.from(data);
    const at = copy.indexOf(Buffer.from('xl/worksheets/sheet1.xml')) + 'xl/worksheets/sheet1.xml'.length + 4;
    copy[at] ^= 0xff;
    return { write: copy };
  });
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.ok(result.error, 'a damaged staged archive must be refused');
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 probe external replacement after staging begins: the external workbook survives', async () => {
  const { path, bytes } = await workbook('external-replacement.xlsx');
  const other = join(dir, 'external-source.xlsx');
  await xlsxFile(other, [{ name: 'A', rows: [['Name', 'Value'], ['external', 7]] }]);
  const external = await readFile(other);
  const restore = injectStageFault(async (_stage, data) => {
    await writeFile(path, external); // another program saves the workbook mid-edit
    return { write: data };
  });
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.ok(result.error, 'an edit staged from bytes that are no longer on disk must be refused');
  assert.equal(result.error.outcome, 'not-published');
  assert.deepEqual(await readFile(path), external, 'the externally saved workbook was overwritten');
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 probe rename-success-then-error: the caller is told the truth (published)', async () => {
  const { path, bytes } = await workbook('rename-then-error.xlsx');
  const restore = injectRename(async (real, from, to) => {
    await real(from, to);
    throw new Error('injected after publication');
  });
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1'], 'the edit is on disk');
  assert.equal(result.error, undefined, `the edit was published but the caller was told it failed: ${result.error?.message}`);
  assert.equal(result.receipt?.outcome, 'published');
  assert.equal(result.receipt?.reconciled, true, 'the receipt must record that the outcome was reconciled');
  assert.equal(result.receipt?.publishedSha256, sha256(await readFile(path)));
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 successful save returns a verified receipt and changes nothing else', async () => {
  const { path, bytes } = await workbook('receipt.xlsx');
  const receipt = (await patchCell(request(path, bytes))) as unknown as Receipt | undefined;
  const now = await readFile(path);
  assert.equal(receipt?.outcome, 'published');
  assert.equal(receipt?.reconciled, false);
  assert.equal(receipt?.sourceSha256, sha256(bytes));
  assert.equal(receipt?.publishedSha256, sha256(now));
  assert.match(String(receipt?.directorySync), /^(synced|unsupported|failed)$/);
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
  assert.deepEqual(readCells(path, ['A2', 'B2'], 'xl/worksheets/sheet2.xml'), ['untouched', '9']);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 staging is exclusive: an existing file at a predictable staging name is never overwritten', async () => {
  // The audited writer named its stage `${file}.dfv-tmp-${pid}-${Date.now()}`
  // and opened it with truncation: any file already there (a backup, another
  // writer's stage) was overwritten and then renamed over the workbook.
  const { path, bytes } = await workbook('alias.xlsx');
  const realNow = Date.now;
  const fixed = realNow();
  const squatter = `${path}${STAGE_MARK}${process.pid}-${fixed}`;
  await writeFile(squatter, 'precious bytes that are not this edit');
  Date.now = () => fixed;
  try {
    await patchCell(request(path, bytes));
  } finally {
    Date.now = realNow;
  }
  assert.equal(await readFile(squatter, 'utf8'), 'precious bytes that are not this edit');
  assert.deepEqual(readCells(path, ['A2']), ['edited']);
  await rm(squatter);
});

test('SAFE-X2 formula refusal is preserved and leaves no debris', async () => {
  const path = join(dir, 'formula.xlsx');
  await xlsxFile(path, [{ name: 'A', rows: [['Name', 'Value'], ['old', 1]], formulas: { '1-1': '=SUM(1,0)' } }]);
  const bytes = await readFile(path);
  const { error } = await settle(patchCell(request(path, bytes, 'B', 5, '1')));
  assert.ok(error);
  assert.match(error.message, /formula/);
  assert.equal(error.outcome ?? 'not-published', 'not-published');
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await leftovers(path), []);
});

// ---------------------------------------------------------------------------
// Separate processes
// ---------------------------------------------------------------------------

const CHILD = join(__dirname, 'safeX2', 'writerChild.js');

interface Child {
  process: ChildProcess;
  messages: { state: string; message?: string; outcome?: string; receipt?: Receipt }[];
  exit: Promise<number | null>;
  next(state: string, timeoutMs?: number): Promise<boolean>;
}

function spawnWriter(mode: string, path: string, column: string, expected: string, value: string, sha: string): Child {
  const child = fork(CHILD, [mode, path, column, expected, value, sha], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages: Child['messages'] = [];
  const waiters: (() => void)[] = [];
  child.on('message', (m) => {
    messages.push(m as Child['messages'][number]);
    for (const w of waiters.splice(0)) w();
  });
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => {
    for (const w of waiters.splice(0)) w();
    resolve(code);
  }));
  let exited = false;
  void exit.then(() => { exited = true; });
  return {
    process: child,
    messages,
    exit,
    next(state, timeoutMs = 20_000) {
      return new Promise((resolve) => {
        const check = () => {
          if (messages.some((m) => m.state === state)) return resolve(true);
          if (exited) return resolve(false);
          waiters.push(check);
        };
        setTimeout(() => resolve(messages.some((m) => m.state === state)), timeoutMs);
        check();
      });
    },
  };
}

test('SAFE-X2 probe two writer processes on one source: no edit is silently lost', async () => {
  // Audit: both processes staged from the same bytes, both reported success,
  // and the final row was [old, 99] -- writer A's "new-A" was gone.
  const { path, bytes } = await workbook('concurrent.xlsx');
  const sha = sha256(bytes);
  const a = spawnWriter('pause', path, 'A', 'old', 'new-A', sha);
  assert.ok(await a.next('staged'), 'writer A did not reach publication');
  const b = spawnWriter('pause', path, 'B', '1', '99', sha);
  // B either stages too (the audited writer) or is held/refused by the
  // cross-process coordination. Give it a moment either way.
  await b.next('staged', 1_500);
  a.process.send('publish');
  await a.exit;
  if (b.messages.some((m) => m.state === 'staged')) b.process.send('publish');
  await b.exit;

  const outcomeA = a.messages.find((m) => m.state === 'success' || m.state === 'error');
  const outcomeB = b.messages.find((m) => m.state === 'success' || m.state === 'error');
  const final = readCells(path, ['A2', 'B2']);
  assert.equal(outcomeA?.state, 'success', `writer A: ${outcomeA?.message}`);
  assert.deepEqual(final, ['new-A', '1'], 'writer A\'s published edit was overwritten by a writer staged from older bytes');
  assert.equal(outcomeB?.state, 'error', 'writer B staged from superseded bytes and must be refused');
  assert.equal(outcomeB?.outcome, 'not-published');
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 probe process exit before rename: old file kept and the orphaned stage is recovered', async () => {
  const { path, bytes } = await workbook('crash-before.xlsx');
  const child = spawnWriter('exit-before', path, 'A', 'old', 'edited', sha256(bytes));
  assert.equal(await child.exit, 77);
  assert.deepEqual(await readFile(path), bytes, 'the original workbook must survive');
  // The next save on this workbook cleans up the identified orphan, without
  // publishing it, and reports what it removed.
  const receipt = (await patchCell(request(path, bytes, 'B', 5, '1'))) as unknown as Receipt | undefined;
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['old', '5'], 'the orphaned stage must never be published');
  assert.deepEqual(await leftovers(path), [], 'the orphaned staging file was left behind');
  assert.ok(receipt?.recovered?.some((r) => r.kind === 'stage'), 'the recovery was not reported');
});

test('SAFE-X2 probe process exit after rename: edit readable, the lost acknowledgement is reconciled', async () => {
  const { path, bytes } = await workbook('crash-after.xlsx');
  const child = spawnWriter('exit-after', path, 'A', 'old', 'edited', sha256(bytes));
  assert.equal(await child.exit, 78);
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
  const now = await readFile(path);
  const receipt = (await patchCell(request(path, now, 'B', 5, '1'))) as unknown as Receipt | undefined;
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '5']);
  assert.deepEqual(await leftovers(path), []);
  assert.ok(
    receipt?.recovered?.some((r) => r.kind === 'lock' && r.outcome === 'published'),
    'the earlier writer\'s unacknowledged save was not reconciled as published'
  );
});

test('SAFE-X2 a dead writer\'s lock does not block, but a live writer\'s lock is respected', async () => {
  const { path, bytes } = await workbook('live-lock.xlsx');
  const a = spawnWriter('pause', path, 'A', 'old', 'new-A', sha256(bytes));
  assert.ok(await a.next('staged'));
  const { error } = await settle(patchCell(request(path, bytes, 'B', 5, '1')));
  a.process.send('publish');
  await a.exit;
  assert.ok(error, 'a save started while another process was publishing must not succeed from stale bytes');
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['new-A', '1']);
  assert.deepEqual(await leftovers(path), []);
});

// ---------------------------------------------------------------------------
// Through the document layer
// ---------------------------------------------------------------------------

test('SAFE-X2 ViewerFile reports a reconciled post-rename error as the save it was', async () => {
  const { path } = await workbook('viewer-lost-ack.xlsx');
  const file = await ViewerFile.open(path);
  try {
    await file.runQuery('select * from "A"');
    const restore = injectRename(async (real, from, to) => {
      await real(from, to);
      throw new Error('injected after publication');
    });
    let result;
    try {
      result = await settle(file.updateCell('A', 'A', 'edited', { A: 'old', B: '1' }));
    } finally {
      restore();
    }
    assert.equal(result.error, undefined, `published edit reported as failure: ${result.error?.message}`);
    assert.equal(result.receipt as unknown, 1);
    assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
    const reread = await file.runQuery('select * from "A"');
    assert.ok(JSON.stringify(reread.rows).includes('edited'));
  } finally {
    file.dispose();
  }
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 ViewerFile refuses when the workbook is replaced during the save', async () => {
  const { path } = await workbook('viewer-external.xlsx');
  const other = join(dir, 'viewer-external-source.xlsx');
  await xlsxFile(other, [{ name: 'A', rows: [['Name', 'Value'], ['external', 7]] }]);
  const external = await readFile(other);
  const file = await ViewerFile.open(path);
  try {
    await file.runQuery('select * from "A"');
    const restore = injectStageFault(async (_stage, data) => {
      await writeFile(path, external);
      return { write: data };
    });
    let result;
    try {
      result = await settle(file.updateCell('A', 'A', 'edited', { A: 'old', B: '1' }));
    } finally {
      restore();
    }
    assert.ok(result.error, 'the save must be refused');
    assert.match(result.error.message, /not changed|not published|changed/i);
    assert.deepEqual(await readFile(path), external);
  } finally {
    file.dispose();
  }
  assert.deepEqual(await leftovers(path), []);
});

// ---------------------------------------------------------------------------
// Verification on its own terms (added with the fix): a candidate that was
// written faithfully but BUILT wrong must still never be published.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zipPatchModule: Record<string, any> = require('../src/zipPatch');

async function withBuilder(
  alter: (real: (index: unknown, replacements: Map<string, Uint8Array>) => Buffer, index: unknown, replacements: Map<string, Uint8Array>) => Buffer,
  run: () => Promise<unknown>
) {
  const real = zipPatchModule.rewriteZip;
  zipPatchModule.rewriteZip = (index: unknown, replacements: Map<string, Uint8Array>) => alter(real, index, replacements);
  try {
    return await settle(run());
  } finally {
    zipPatchModule.rewriteZip = real;
  }
}

test('SAFE-X2 verification refuses a candidate that changed an unrelated part', async () => {
  const { path, bytes } = await workbook('unrelated-part.xlsx');
  const { strToU8 } = await import('fflate');
  const { error } = await withBuilder(
    (real, index, replacements) => real(index, new Map([...replacements, ['xl/worksheets/sheet2.xml', strToU8('<worksheet/>')]])),
    () => patchCell(request(path, bytes))
  );
  assert.ok(error, 'a candidate that rewrote another sheet was published');
  assert.equal(error.outcome, 'not-published');
  assert.match(error.message, /sheet2\.xml changed/);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 verification refuses a candidate whose edited sheet is not the intended XML', async () => {
  const { path, bytes } = await workbook('wrong-cell.xlsx');
  const { strFromU8, strToU8 } = await import('fflate');
  const { error } = await withBuilder(
    (real, index, replacements) => {
      const sheet = strFromU8(replacements.get('xl/worksheets/sheet1.xml')!).replace('<v>1</v>', '<v>2</v>');
      return real(index, new Map([['xl/worksheets/sheet1.xml', strToU8(sheet)]]));
    },
    () => patchCell(request(path, bytes))
  );
  assert.ok(error, 'a candidate that also changed B2 was published');
  assert.equal(error.outcome, 'not-published');
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 ViewerFile keeps the writer\'s outcome message for the user and reports reconciliation', async () => {
  const { queryDiagnostic } = await import('../src/queryDiagnostics');
  const { path } = await workbook('viewer-messages.xlsx');
  const other = join(dir, 'viewer-messages-source.xlsx');
  await xlsxFile(other, [{ name: 'A', rows: [['Name', 'Value'], ['external', 7]] }]);
  const file = await ViewerFile.open(path);
  try {
    await file.runQuery('select * from "A"');
    const restoreStage = injectStageFault(async (_stage, data) => {
      await writeFile(path, await readFile(other));
      return { write: data };
    });
    let refused;
    try {
      refused = await settle(file.updateCell('A', 'A', 'edited', { A: 'old', B: '1' }));
    } finally {
      restoreStage();
    }
    assert.ok(refused.error);
    assert.equal(refused.error.outcome, 'not-published');
    assert.match(queryDiagnostic(refused.error).message, /was not changed/);

    await file.refreshInPlace();
    await file.runQuery('select * from "A"');
    file.takeLateWarnings();
    const restoreRename = injectRename(async (real, from, to) => {
      await real(from, to);
      throw new Error('injected after publication');
    });
    try {
      assert.equal(await file.updateCell('A', 'A', 'edited', { A: 'external', B: '7' }), 1);
    } finally {
      restoreRename();
    }
    assert.ok(file.takeLateWarnings().some((w) => /checked afterwards and holds the edit/.test(w)));
  } finally {
    file.dispose();
  }
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '7']);
  assert.deepEqual(await leftovers(path), []);
});
