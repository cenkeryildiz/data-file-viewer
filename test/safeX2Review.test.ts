import vscodeStub, { recorded, resetVscodeStub } from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { execFileSync, fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchCell } from '../src/xlsxWrite';
import { ViewerFile } from '../src/viewerFile';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { xlsxFile } from './stress/generators/_write';
import { fsp, injectRename, injectStageFault, readCells, sha256 } from './safeX2/faults';

/**
 * SAFE-X2 review regressions (17 October 2026 review of a050ceb).
 *
 *  1. the edited sheet's CRC is checked even where zlib.crc32 is missing;
 *  2. a lock left by a process whose id was reused (other boot / other
 *     process) is recognised as abandoned, and every busy message says how
 *     to recover;
 *  3. each save's outcome notice reaches the user when the save happens,
 *     including when the editor closes during the save;
 *  4. a failed lock update never leaves an unreadable lock behind;
 *  5. a writer never overwrites or removes a lock that is not its own;
 *
 * plus the acceptance cases the review listed as missing. Outcomes are read
 * with the independent fflate reader in faults.ts. Injected I/O failures and
 * process exits are not physical power-loss tests.
 */

type OutcomeError = Error & { outcome?: string };
interface Receipt {
  outcome?: string;
  reconciled?: boolean;
  directorySync?: string;
  publishedSha256?: string;
  recovered?: { kind: string; name: string; outcome?: string }[];
}

let dir: string;
const children: ChildProcess[] = [];
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-safe-x2-review-'));
});
after(async () => {
  for (const child of children) child.kill('SIGKILL');
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
    filePath: path, sheetPath: 'xl/worksheets/sheet1.xml', columnName: column, columnNames: ['A', 'B'],
    rowOrdinal: 2, verbatim: true, expectedCurrent, newValue, expectedSha256: sha256(bytes),
  };
}

async function leftovers(path: string): Promise<string[]> {
  const base = path.slice(dir.length + 1);
  return (await readdir(dir)).filter((n) => n.startsWith(base + '.') && n !== base);
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: OutcomeError }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: error as OutcomeError };
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

const HOST_TAG = sha256(Buffer.from(hostname())).slice(0, 8);
function currentBootId(): string | undefined {
  try {
    if (process.platform === 'darwin') return execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim();
    if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch { /* unsupported */ }
  return undefined;
}
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}
function lockRecord(fields: Record<string, unknown>) {
  return JSON.stringify({ version: 1, token: 'f'.repeat(32), host: HOST_TAG, created: new Date().toISOString(), ...fields });
}

// ---------------------------------------------------------------------------
// 1. CRC check without zlib.crc32
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zlibModule: Record<string, any> = require('node:zlib');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zipPatchModule: Record<string, any> = require('../src/zipPatch');

async function withoutNativeCrc<T>(run: () => Promise<T>): Promise<T> {
  const native = zlibModule.crc32;
  zlibModule.crc32 = undefined;
  try {
    return await run();
  } finally {
    zlibModule.crc32 = native;
  }
}

/** Overwrite the CRC of `name` in both its local header and its central record. */
function corruptCrc(bytes: Buffer, name: string): Buffer {
  const out = Buffer.from(bytes);
  const nameBytes = Buffer.from(name);
  for (let at = out.indexOf(nameBytes); at !== -1; at = out.indexOf(nameBytes, at + 1)) {
    if (at >= 30 && out.readUInt32LE(at - 30) === 0x04034b50) out.writeUInt32LE((out.readUInt32LE(at - 16) ^ 0x5a5a5a5a) >>> 0, at - 16);
    if (at >= 46 && out.readUInt32LE(at - 46) === 0x02014b50) out.writeUInt32LE((out.readUInt32LE(at - 30) ^ 0x5a5a5a5a) >>> 0, at - 30);
  }
  return out;
}

test('SAFE-X2 review 1: the CRC fallback is exported and matches the standard check value', async () => {
  assert.equal(typeof zipPatchModule.crc32, 'function', 'zipPatch must export crc32');
  await withoutNativeCrc(async () => {
    assert.equal(zipPatchModule.crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(zipPatchModule.crc32(new Uint8Array(0)), 0);
  });
});

for (const native of [false, true]) {
  test(`SAFE-X2 review 1: a candidate whose edited sheet fails its CRC is refused (${native ? 'native zlib.crc32' : 'zlib.crc32 missing, fallback forced'})`, async () => {
    const { path, bytes } = await workbook(`crc-${native ? 'native' : 'fallback'}.xlsx`);
    const real = zipPatchModule.rewriteZip;
    zipPatchModule.rewriteZip = (index: unknown, replacements: Map<string, Uint8Array>) =>
      corruptCrc(real(index, replacements), 'xl/worksheets/sheet1.xml');
    let result;
    try {
      const run = () => settle(patchCell(request(path, bytes)));
      result = native ? await run() : await withoutNativeCrc(run);
    } finally {
      zipPatchModule.rewriteZip = real;
    }
    assert.ok(result.error, 'a candidate with a wrong CRC for the edited sheet was published');
    assert.equal(result.error.outcome, 'not-published');
    assert.match(result.error.message, /CRC/);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await leftovers(path), []);
  });
}

test('SAFE-X2 review 1: with zlib.crc32 missing a good edit still publishes', async () => {
  const { path, bytes } = await workbook('crc-fallback-good.xlsx');
  const receipt = await withoutNativeCrc(() => patchCell(request(path, bytes)));
  assert.equal(receipt.outcome, 'published');
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
});

// ---------------------------------------------------------------------------
// 2. Reused process ids
// ---------------------------------------------------------------------------

test('SAFE-X2 review 2: a lock from an earlier boot is abandoned even though its pid is alive now', async () => {
  const { path, bytes } = await workbook('lock-other-boot.xlsx');
  // After a reboot the same pid can belong to anything -- here, this very process.
  await writeFile(path + '.dfv-lock', lockRecord({ pid: process.pid, boot: 'an-earlier-boot', start: 'whenever' }));
  const started = Date.now();
  const { value, error } = await settle(patchCell(request(path, bytes)));
  assert.equal(error, undefined, `the save was blocked by a lock from another boot: ${error?.message}`);
  assert.ok(Date.now() - started < 4_000);
  assert.ok(value!.recovered.some((r) => r.kind === 'lock' && r.outcome === 'not-published'));
  assert.deepEqual(readCells(path, ['A2']), ['edited']);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 review 2: a lock whose pid now belongs to a different process is abandoned', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const { path, bytes } = await workbook('lock-reused-pid.xlsx');
  const stranger = liveProcess();
  await writeFile(path + '.dfv-lock', lockRecord({ pid: stranger.pid, boot: currentBootId(), start: 'not this process' }));
  const { value, error } = await settle(patchCell(request(path, bytes)));
  assert.equal(error, undefined, `the save was blocked by a lock whose pid was reused: ${error?.message}`);
  assert.ok(value!.recovered.some((r) => r.kind === 'lock'));
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 review 2: a lock that cannot be judged abandoned is respected, and the message says how to recover', async () => {
  const { path, bytes } = await workbook('lock-legacy-live.xlsx');
  const holder = liveProcess();
  const lockPath = path + '.dfv-lock';
  const foreign = lockRecord({ pid: holder.pid }); // the earlier format: no boot or start marks
  await writeFile(lockPath, foreign);
  const { error } = await settle(patchCell(request(path, bytes)));
  assert.ok(error, 'a live lock was ignored');
  assert.equal(error.outcome, 'not-published');
  assert.ok(error.message.includes(lockPath), `the message must name the lock file: ${error.message}`);
  assert.match(error.message, /delete/i, 'the message must say how to recover');
  assert.equal(await readFile(lockPath, 'utf8'), foreign);
  assert.deepEqual(await readFile(path), bytes);
  await unlink(lockPath);
});

test('SAFE-X2 review 2: an unreadable lock is respected while fresh, and the message says how to recover', async () => {
  const { path, bytes } = await workbook('lock-unreadable.xlsx');
  const lockPath = path + '.dfv-lock';
  await writeFile(lockPath, '');
  const { error } = await settle(patchCell(request(path, bytes)));
  assert.ok(error);
  assert.ok(error.message.includes(lockPath), error.message);
  assert.match(error.message, /delete/i);
  await unlink(lockPath);
});

// ---------------------------------------------------------------------------
// 4. Disk full on the lock
// ---------------------------------------------------------------------------

/** Fail the `nth` write (1-based) that lands in any lock-related file with ENOSPC. */
function failLockWrite(nth: number): () => void {
  const realOpen = fsp.open;
  const realWriteFile = fsp.writeFile;
  let writes = 0;
  const isLock = (path: unknown) => String(path).includes('.dfv-lock');
  const nextFails = () => ++writes === nth;
  const enospc = () => Object.assign(new Error('injected disk full on the lock'), { code: 'ENOSPC' });
  fsp.writeFile = async (path: unknown, ...rest: unknown[]) => {
    if (isLock(path) && nextFails()) throw enospc();
    return realWriteFile(path, ...rest);
  };
  fsp.open = async (path: unknown, ...rest: unknown[]) => {
    const handle = await realOpen(path, ...rest);
    if (!isLock(path)) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'writeFile' || key === 'write') {
          return async (...args: unknown[]) => {
            if (nextFails()) throw enospc();
            return (target as any)[key](...args);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return () => {
    fsp.open = realOpen;
    fsp.writeFile = realWriteFile;
  };
}

for (const [nth, what] of [[1, 'lock creation'], [2, 'the lock update before the rename']] as const) {
  test(`SAFE-X2 review 4: disk full on ${what} leaves no lock behind and the next save is not blocked`, async () => {
    const { path, bytes } = await workbook(`lock-enospc-${nth}.xlsx`);
    const restore = failLockWrite(nth);
    let result;
    try {
      result = await settle(patchCell(request(path, bytes)));
    } finally {
      restore();
    }
    assert.ok(result.error, 'a save whose lock could not be written must not succeed');
    assert.equal(result.error.outcome, 'not-published');
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await leftovers(path), [], 'the failed save left its lock (or debris) behind');
    const started = Date.now();
    const next = await settle(patchCell(request(path, bytes)));
    assert.equal(next.error, undefined, `the next save was blocked: ${next.error?.message}`);
    assert.ok(Date.now() - started < 2_000, 'the next save waited on a broken lock');
    assert.deepEqual(readCells(path, ['A2']), ['edited']);
  });
}

// ---------------------------------------------------------------------------
// 5. Never write over another writer's lock
// ---------------------------------------------------------------------------

test('SAFE-X2 review 5: a lock replaced after the final source check is neither overwritten nor removed', async () => {
  // The state two waiters racing over an abandoned lock can leave behind (the
  // restore of a wrongly moved lock fails with EEXIST): this writer's lock is
  // gone and another writer's live lock is in its place.
  const { path, bytes } = await workbook('lock-replaced.xlsx');
  const lockPath = path + '.dfv-lock';
  const holder = liveProcess();
  const foreign = lockRecord({ pid: holder.pid, token: 'e'.repeat(32) });
  const realReadFile = fsp.readFile;
  let sourceReads = 0;
  fsp.readFile = async (file: unknown, ...rest: unknown[]) => {
    const out = await realReadFile(file, ...rest);
    if (String(file) === path && ++sourceReads === 2) {
      await unlink(lockPath);
      await writeFile(lockPath, foreign);
    }
    return out;
  };
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    fsp.readFile = realReadFile;
  }
  assert.ok(sourceReads >= 2, 'the final source check did not run');
  assert.ok(result.error, 'a writer that lost its lock published anyway');
  assert.equal(result.error.outcome, 'not-published');
  assert.equal(await readFile(lockPath, 'utf8').catch(() => '(removed)'), foreign, 'another writer\'s live lock was overwritten or removed');
  assert.deepEqual(await readFile(path), bytes);
  await unlink(lockPath);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 review 5 (stress): many writers racing over one abandoned lock -- one wins, nothing is lost or left', async () => {
  for (let round = 0; round < 5; round++) {
    const { path, bytes } = await workbook(`takeover-race-${round}.xlsx`);
    await writeFile(path + '.dfv-lock', lockRecord({ pid: deadPid(), boot: currentBootId() }));
    const values = Array.from({ length: 8 }, (_, i) => `w${round}-${i}`);
    const results = await Promise.all(values.map((v) => settle(patchCell(request(path, bytes, 'A', v)))));
    const won = results.filter((r) => r.value);
    assert.equal(won.length, 1, `round ${round}: ${won.length} writers published from the same source`);
    for (const r of results) if (r.error) assert.equal(r.error.outcome, 'not-published', r.error.message);
    const winner = values[results.findIndex((r) => r.value)];
    assert.deepEqual(readCells(path, ['A2', 'B2']), [winner, '1']);
    assert.equal(won[0].value!.publishedSha256, sha256(await readFile(path)));
    assert.deepEqual(await leftovers(path), [], `round ${round}`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance: directory sync, external atomic replace, exit before rename
// ---------------------------------------------------------------------------

/** Make the directory flush after the rename fail with EIO. */
function failDirectorySync(folder: string): () => void {
  const realOpen = fsp.open;
  fsp.open = async (path: unknown, ...rest: unknown[]) => {
    const handle = await realOpen(path, ...rest);
    if (String(path) !== folder) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'sync') return async () => { throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return () => { fsp.open = realOpen; };
}

test('SAFE-X2 acceptance: an injected directory-sync failure gives an accurate receipt', async () => {
  const { path, bytes } = await workbook('dirsync.xlsx');
  const restore = failDirectorySync(dir);
  let receipt;
  try {
    receipt = await patchCell(request(path, bytes));
  } finally {
    restore();
  }
  assert.equal(receipt.outcome, 'published');
  assert.equal(receipt.directorySync, 'failed');
  assert.equal(receipt.reconciled, false);
  assert.equal(receipt.publishedSha256, sha256(await readFile(path)));
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 acceptance: an external atomic replace (rename over the source) before the final check is refused', async () => {
  const { path, bytes } = await workbook('atomic-replace.xlsx');
  const other = join(dir, 'atomic-replace-source.xlsx');
  await xlsxFile(other, [{ name: 'A', rows: [['Name', 'Value'], ['external', 7]] }]);
  const external = await readFile(other);
  const restore = injectStageFault(async (_stage, data) => {
    // Another program saves the way careful programs do: temp file, rename over.
    const temp = join(dir, 'atomic-replace.tmp');
    await writeFile(temp, external);
    await rename(temp, path);
    return { write: data };
  });
  let result;
  try {
    result = await settle(patchCell(request(path, bytes)));
  } finally {
    restore();
  }
  assert.ok(result.error);
  assert.equal(result.error.outcome, 'not-published');
  assert.deepEqual(await readFile(path), external, 'the externally saved workbook was overwritten');
  assert.deepEqual(await leftovers(path), []);
});

const WRITER = join(__dirname, 'safeX2', 'writerChild.js');
const VIEWER = join(__dirname, 'safeX2', 'viewerChild.js');

function child(script: string, args: string[]) {
  const proc = fork(script, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(proc);
  const messages: { state: string; message?: string; outcome?: string }[] = [];
  const waiters: (() => void)[] = [];
  let exited = false;
  proc.on('message', (m) => { messages.push(m as never); for (const w of waiters.splice(0)) w(); });
  const exit = new Promise<number | null>((resolve) => proc.on('exit', (code) => {
    exited = true;
    for (const w of waiters.splice(0)) w();
    resolve(code);
  }));
  const next = (state: string, timeoutMs = 30_000) => new Promise<boolean>((resolve) => {
    const check = () => {
      if (messages.some((m) => m.state === state)) return resolve(true);
      if (exited) return resolve(false);
      waiters.push(check);
    };
    setTimeout(() => resolve(messages.some((m) => m.state === state)), timeoutMs);
    check();
  });
  return { proc, messages, exit, next };
}

test('SAFE-X2 acceptance: exit before the rename -- the next save recovers both the stage and the lock', async () => {
  const { path, bytes } = await workbook('exit-before-both.xlsx');
  const writer = child(WRITER, ['exit-before', path, 'A', 'old', 'edited', sha256(bytes)]);
  assert.equal(await writer.exit, 77);
  const debris = await leftovers(path);
  assert.ok(debris.some((n) => n.includes('.dfv-tmp-')), `no stage was left to recover: ${debris}`);
  assert.ok(debris.some((n) => n.endsWith('.dfv-lock')), `no lock was left to recover: ${debris}`);
  assert.deepEqual(await readFile(path), bytes);
  const receipt = await patchCell(request(path, bytes, 'B', 5, '1'));
  assert.ok(receipt.recovered.some((r) => r.kind === 'stage'), 'the stage was not recovered');
  assert.ok(receipt.recovered.some((r) => r.kind === 'lock' && r.outcome === 'not-published'), 'the lock was not recovered as not-published');
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['old', '5'], 'the orphaned stage must never be published');
  assert.deepEqual(await leftovers(path), []);
});

// ---------------------------------------------------------------------------
// Acceptance: two document instances on one workbook
// ---------------------------------------------------------------------------

test('SAFE-X2 acceptance: two document instances in one process editing the same workbook', async () => {
  const { path } = await workbook('two-docs-same-process.xlsx');
  const first = await ViewerFile.open(path);
  const second = await ViewerFile.open(path);
  try {
    await first.runQuery('select * from "A"');
    await second.runQuery('select * from "A"');
    const results = await Promise.all([
      settle(first.updateCell('A', 'A', 'from-first', { A: 'old', B: '1' })),
      settle(second.updateCell('A', 'B', 2, { A: 'old', B: '1' })),
    ]);
    const won = results.filter((r) => r.value === 1);
    assert.equal(won.length, 1, 'both instances published from the same bytes, or neither did');
    const lost = results.find((r) => r.error)!;
    assert.equal(lost.error!.outcome, 'not-published');
    const final = readCells(path, ['A2', 'B2']);
    assert.ok(
      JSON.stringify(final) === JSON.stringify(['from-first', '1']) || JSON.stringify(final) === JSON.stringify(['old', '2']),
      `final row ${JSON.stringify(final)} mixes or loses edits`);
    // The loser, now stale, is refused again rather than overwriting the winner.
    const loser = results[0].error ? first : second;
    const retry = await settle(loser.updateCell('A', 'A', 'stale', { A: 'old', B: '1' }));
    assert.ok(retry.error || retry.value === 0, 'a stale instance overwrote the published edit');
    assert.deepEqual(readCells(path, ['A2', 'B2']), final);
  } finally {
    first.dispose();
    second.dispose();
  }
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 acceptance: two document instances in separate processes editing the same workbook', async () => {
  const { path } = await workbook('two-docs-two-processes.xlsx');
  const other = child(VIEWER, [path, 'A', 'from-child', 'old', '1']);
  assert.ok(await other.next('ready'), `child viewer did not open: ${JSON.stringify(other.messages)}`);
  const local = await ViewerFile.open(path);
  try {
    await local.runQuery('select * from "A"');
    other.proc.send('go');
    assert.ok(await other.next('staged'), `child did not stage: ${JSON.stringify(other.messages)}`);
    // The child holds the workbook's save lock while it is about to publish.
    const mine = await settle(local.updateCell('A', 'B', 2, { A: 'old', B: '1' }));
    other.proc.send('publish');
    await other.exit;
    const theirs = other.messages.find((m) => m.state === 'success' || m.state === 'error');
    assert.equal(theirs?.state, 'success', theirs?.message);
    assert.ok(mine.error, 'this instance published from bytes the other process was replacing');
    assert.equal(mine.error.outcome, 'not-published');
    assert.deepEqual(readCells(path, ['A2', 'B2']), ['from-child', '1']);
  } finally {
    local.dispose();
  }
  assert.deepEqual(await leftovers(path), []);
});

// ---------------------------------------------------------------------------
// 3. The receipt reaches the user
// ---------------------------------------------------------------------------

type Posted = Record<string, unknown>;

async function openHost(path: string) {
  const file = await ViewerFile.open(path);
  const document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, file);
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
  const posted: Posted[] = [];
  let handler!: (message: unknown) => Promise<void>;
  let panelClosed = false;
  const closeListeners: (() => void)[] = [];
  const webview = {
    cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => { handler = callback; return { dispose() {} }; },
    // As in VS Code: a disposed webview refuses messages.
    postMessage: async (message: Posted) => {
      if (panelClosed) throw new Error('Webview is disposed');
      posted.push(message);
      return true;
    },
  };
  const panel = { webview, onDidDispose: (listener: () => void) => { closeListeners.push(listener); return { dispose() {} }; } };
  await provider.resolveCustomEditor(document, panel as any);
  let requestId = 0;
  const send = (message: Posted) => handler({ ...message, requestId: ++requestId });
  const close = () => {
    panelClosed = true;
    for (const listener of closeListeners) listener();
    document.dispose();
  };
  return { document, posted, send, close };
}

async function editableHost(path: string) {
  const host = await openHost(path);
  await host.send({ command: 'runQuery', sql: 'select * from "A"' });
  const result = host.posted.filter((m) => m.command === 'queryResult').at(-1) as Posted | undefined;
  assert.equal(result?.editable, true, `the grid is not editable: ${JSON.stringify(host.posted.at(-1))}`);
  await host.send({ command: 'toggleSafeMode', safeMode: false, backupBeforeWrite: false, checkForChanges: false });
  return host;
}

const lostAck = () => injectRename(async (real, from, to) => {
  await real(from, to);
  throw new Error('injected after publication');
});

test('SAFE-X2 review 3: a reconciled save is reported to the user when it happens, not after the next query', async () => {
  resetVscodeStub();
  const { path } = await workbook('notice-reconciled.xlsx');
  const host = await editableHost(path);
  try {
    const restore = lostAck();
    try {
      await host.send({ command: 'updateCell', column: 'A', newValue: 'edited', rowValues: { A: 'old', B: '1' } });
    } finally {
      restore();
    }
    assert.ok(host.posted.some((m) => m.command === 'cellUpdated'), JSON.stringify(host.posted.at(-1)));
    const shown = recorded.messages.filter((m) => /checked afterwards and holds the edit/.test(m.text));
    assert.equal(shown.length, 1, `the reconciliation notice was not shown at save time: ${JSON.stringify(recorded.messages)}`);
    assert.match(shown[0].text, /notice-reconciled\.xlsx/);
    // Not repeated by the next query either.
    await host.send({ command: 'runQuery', sql: 'select * from "A"' });
    assert.equal(recorded.messages.filter((m) => /checked afterwards/.test(m.text)).length, 1);
  } finally {
    host.close();
  }
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
});

test('SAFE-X2 review 3: a directory-sync failure is reported to the user when the save happens', async () => {
  resetVscodeStub();
  const { path } = await workbook('notice-dirsync.xlsx');
  const host = await editableHost(path);
  try {
    // ViewerFile works on the workbook's real path (tmpdir is a symlink on macOS).
    const restore = failDirectorySync(await realpath(dir));
    try {
      await host.send({ command: 'updateCell', column: 'B', newValue: 5, rowValues: { A: 'old', B: '1' } });
    } finally {
      restore();
    }
    assert.ok(host.posted.some((m) => m.command === 'cellUpdated'), JSON.stringify(host.posted.at(-1)));
    assert.ok(
      recorded.messages.some((m) => m.level === 'warning' && /folder could not be flushed/.test(m.text)),
      `the directory-sync failure was not shown: ${JSON.stringify(recorded.messages)}`);
  } finally {
    host.close();
  }
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['old', '5']);
});

test('SAFE-X2 acceptance / review 3: closing the document while updateCell is in flight loses neither the save nor its notice', async () => {
  resetVscodeStub();
  const { path } = await workbook('close-in-flight.xlsx');
  const host = await editableHost(path);
  const staged = gate();
  const proceed = gate();
  const restore = injectRename(async (real, from, to) => {
    staged.open();
    await proceed.opened;
    await real(from, to);
    throw new Error('injected after publication');
  });
  try {
    const edit = host.send({ command: 'updateCell', column: 'A', newValue: 'edited', rowValues: { A: 'old', B: '1' } });
    await staged.opened;
    host.close(); // the user closes the editor while the save is publishing
    proceed.open();
    await edit;
  } finally {
    restore();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
  assert.ok(
    recorded.messages.some((m) => /checked afterwards and holds the edit/.test(m.text)),
    `the receipt notice was lost when the editor closed: ${JSON.stringify(recorded.messages)}`);
  assert.ok(
    recorded.messages.some((m) => /close-in-flight\.xlsx/.test(m.text) && /saved/i.test(m.text)),
    `the user was not told the save completed after the editor closed: ${JSON.stringify(recorded.messages)}`);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 review 3: a save refused after the editor closed is still reported', async () => {
  resetVscodeStub();
  const { path, bytes } = await workbook('close-refused.xlsx');
  const host = await editableHost(path);
  const staged = gate();
  const proceed = gate();
  const restore = injectRename(async () => {
    staged.open();
    await proceed.opened;
    throw Object.assign(new Error('injected refusal'), { code: 'EACCES' });
  });
  try {
    const edit = host.send({ command: 'updateCell', column: 'A', newValue: 'edited', rowValues: { A: 'old', B: '1' } });
    await staged.opened;
    host.close();
    proceed.open();
    await edit;
  } finally {
    restore();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await readFile(path), bytes);
  assert.ok(
    recorded.messages.some((m) => m.level === 'error' && /close-refused\.xlsx/.test(m.text) && /not changed/.test(m.text)),
    `the refusal was lost when the editor closed: ${JSON.stringify(recorded.messages)}`);
  assert.deepEqual(await leftovers(path), []);
});

test('SAFE-X2 review 3: ViewerFile delivers save notices to its sink even when disposed during the save', async () => {
  const { path } = await workbook('viewer-dispose-in-flight.xlsx');
  const file = await ViewerFile.open(path);
  const notices: string[] = [];
  (file as unknown as { onSaveNotice?: (notice: string) => void }).onSaveNotice = (notice) => notices.push(notice);
  await file.runQuery('select * from "A"');
  const staged = gate();
  const proceed = gate();
  const restore = injectRename(async (real, from, to) => {
    staged.open();
    await proceed.opened;
    await real(from, to);
    throw new Error('injected after publication');
  });
  let result;
  try {
    const edit = settle(file.updateCell('A', 'A', 'edited', { A: 'old', B: '1' }));
    await staged.opened;
    file.dispose();
    proceed.open();
    result = await edit;
  } finally {
    restore();
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.value, 1);
  assert.ok(notices.some((n) => /checked afterwards and holds the edit/.test(n)), `notices: ${JSON.stringify(notices)}`);
  assert.deepEqual(readCells(path, ['A2', 'B2']), ['edited', '1']);
  assert.deepEqual(await leftovers(path), []);
});
