import assert from 'node:assert/strict';
import test from 'node:test';
import { DatasetSession, type SessionHooks } from '../src/backend/session';
import type { BackendFactory, DocumentFile } from '../src/backend/types';
import { QUERY_LIMITS, QueryPolicyError } from '../src/queryPolicy';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function file(extra: Partial<DocumentFile> = {}): DocumentFile {
  return { interruptCurrentQuery() {}, dispose() {}, refreshInPlace: async () => false, ...extra } as DocumentFile;
}
function session(openFile = file(), hooks: Partial<SessionHooks> = {}, backend: BackendFactory = { open: async () => file() }) {
  return new DatasetSession(openFile, backend, { authorize() {}, ...hooks });
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

test('live queue limit counts distinct jobs with reused guards and recovers after failure', async () => {
  const held = latch();
  const owner = session();
  const guard = () => false;
  const outcomes = Array.from({ length: QUERY_LIMITS.queuedRequests + 1 }, () => owner.runExclusive(() => held.promise, guard).then(() => 'ran', errorText));
  assert.equal(owner.isBusy(), true);
  held.release();
  assert.deepEqual(await Promise.all(outcomes), [...Array(8).fill('ran'), 'Too many queued operations. Wait or cancel the current query.']);
  const cause = new QueryPolicyError('original operation failure');
  await assert.rejects(owner.runExclusive(async () => { throw cause; }), error => error === cause);
  assert.deepEqual(await owner.tryRunExclusive(async () => 42), { ran: true, value: 42 });
  await owner.close();
});

test('superseded read flood is depth-bounded and never suppresses an unguarded save', async () => {
  const held = latch(), entered = latch();
  const owner = session();
  const events: string[] = [];
  const active = owner.runExclusive(async () => { entered.release(); await held.promise; });
  await entered.promise;
  const reads = Array.from({ length: QUERY_LIMITS.queuedRequests * 8 - 2 }, () => owner.runExclusive(async () => { events.push('stale read'); }, () => true).then(() => 'ran', errorText));
  const save = owner.runExclusive(async () => { events.push('save'); });
  await assert.rejects(owner.runExclusive(async () => events.push('overflow')), /Too many queued operations/);
  let tickRan = false;
  assert.deepEqual(await owner.tryRunExclusive(async () => { tickRan = true; }), { ran: false });
  assert.equal(tickRan, false);
  held.release();
  await Promise.all([active, save]);
  assert.ok((await Promise.all(reads)).every(text => text === 'Superseded by a newer query.'));
  assert.deepEqual(events, ['save']);
  assert.equal(owner.isBusy(), false);
  assert.equal(await owner.runExclusive(async () => 'next user run'), 'next user run');
  await owner.close();
});

test('authorization is checked at execution, preserves error identity and leaves the chain usable', async () => {
  const held = latch(), entered = latch();
  const denial = new QueryPolicyError('Trust this workspace before opening datasets or running queries.');
  let trusted = true;
  const owner = session(file(), { authorize: () => { if (!trusted) throw denial; } });
  const first = owner.runExclusive(async () => { entered.release(); await held.promise; });
  await entered.promise;
  let accessed = false;
  const queued = assert.rejects(owner.runExclusive(async () => { accessed = true; }), error => error === denial);
  trusted = false;
  held.release();
  await Promise.all([first, queued]);
  assert.equal(accessed, false);
  trusted = true;
  assert.equal(await owner.runExclusive(async () => 'trusted again'), 'trusted again');
  await owner.close();
});

test('close is immediate and idempotent, but save drain precedes summary, disposal and lock release', async () => {
  const held = latch(), entered = latch();
  const events: string[] = [];
  let owner!: DatasetSession;
  owner = session(file({ interruptCurrentQuery: () => events.push('interrupt'), dispose: () => events.push('dispose') }), {
    onClosing: () => { assert.equal(owner.closed, true); events.push('closing'); },
    beforeDispose: async () => { events.push('summary'); },
    onDisposed: () => events.push('release lock'),
  });
  const save = owner.runExclusive(async () => { entered.release(); await held.promise; events.push('save complete'); });
  await entered.promise;
  const queued = assert.rejects(owner.runExclusive(async () => events.push('queued access')), /This document is closed/);
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  assert.deepEqual(events, ['closing', 'interrupt']);
  const postclose = assert.rejects(owner.runExclusive(async () => events.push('postclose access')), /This document is closed/);
  held.release();
  await Promise.all([save, queued, postclose, closing]);
  assert.deepEqual(events, ['closing', 'interrupt', 'save complete', 'summary', 'dispose', 'release lock']);
});

test('idle close remains synchronous and failing host callbacks cannot block drain/disposal/release', async () => {
  const events: string[] = [];
  const owner = session(file({ interruptCurrentQuery: () => events.push('interrupt'), dispose: () => events.push('dispose') }), {
    onClosing: () => { events.push('closing'); throw new Error('closing callback'); },
    beforeDispose: () => { events.push('summary'); throw new Error('summary callback'); },
    onDisposed: () => { events.push('release lock'); throw new Error('disposed callback'); },
  });
  const closing = owner.close();
  assert.deepEqual(events, ['closing', 'interrupt', 'summary', 'dispose', 'release lock']);
  await closing;
  await owner.close();
  assert.equal(events.length, 5);
});

test('even interruption or file-disposal failure cannot skip final host lock release', async () => {
  let released = 0;
  const cause = new Error('dispose failure');
  const owner = session(file({ interruptCurrentQuery() { throw new Error('interrupt failure'); }, dispose() { throw cause; } }), { onDisposed() { released++; } });
  await assert.rejects(owner.close(), error => error === cause);
  assert.equal(released, 1);
});

test('supported save sinks remain bound after close and replacement; two sessions keep separate sinks', async () => {
  const a: string[] = [], b: string[] = [];
  const first = file({ onSaveNotice: undefined }), second = file({ onSaveNotice: undefined });
  const left = session(first, { onSaveNotice: text => a.push(text) });
  const right = session(second, { onSaveNotice: text => b.push(text) });
  const replacement = file({ onSaveNotice: undefined });
  left.file = replacement;
  await left.close();
  first.onSaveNotice?.('old save'); replacement.onSaveNotice?.('new save'); second.onSaveNotice?.('other document');
  assert.deepEqual(a, ['old save', 'new save']); assert.deepEqual(b, ['other document']);
  assert.equal(right.closed, false);
  await right.close();
});

test('reopen preserves lazy in-place refresh, fresh settings, identity, invalidation and old-handle order', async () => {
  const events: string[] = [];
  const old = file({ refreshInPlace: async () => { events.push('in place'); return true; }, dispose: () => events.push('old disposed') });
  const next = file({ dispose: () => events.push('next disposed') });
  let optionsReads = 0;
  const calls: Parameters<BackendFactory['open']>[] = [];
  const owner = session(old, {}, { open: async (...args) => { calls.push(args); return next; } });
  const options = () => { optionsReads++; return { numberLocale: 'eu' as const }; };
  await owner.runExclusive(() => owner.reopen('/source', 'kdb', true, options, () => events.push('in-place invalidated')));
  assert.equal(optionsReads, 0); assert.equal(calls.length, 0); assert.equal(owner.file, old);
  await owner.runExclusive(() => owner.reopen('/source', 'kdb', false, options, () => { assert.equal(owner.file, next); events.push('new invalidated'); }));
  assert.equal(optionsReads, 1);
  assert.deepEqual(calls, [['/source', 'kdb', { numberLocale: 'eu', forceReadOnly: false }]]);
  assert.deepEqual(events, ['in place', 'in-place invalidated', 'new invalidated', 'old disposed']);
  await owner.close();
});

test('open failure keeps the prior handle and exact error, while a late successful open is disposed after close', async () => {
  const entered = latch(), proceed = latch();
  const original = file();
  const cause = new QueryPolicyError('refused refresh');
  let opens = 0, newDisposed = 0, invalidations = 0;
  const late = file({ dispose: () => { newDisposed++; } });
  const owner = session(original, {}, { open: async () => { if (++opens === 1) throw cause; entered.release(); await proceed.promise; return late; } });
  await assert.rejects(owner.runExclusive(() => owner.reopen('/source', undefined, false, () => ({}), () => invalidations++)), error => error === cause);
  assert.equal(owner.file, original); assert.equal(opens, 1);
  const pending = owner.runExclusive(() => owner.reopen('/source', undefined, false, () => ({}), () => invalidations++));
  await entered.promise;
  const closing = owner.close();
  proceed.release();
  await Promise.all([pending, closing]);
  assert.equal(opens, 2); assert.equal(newDisposed, 1); assert.equal(invalidations, 0); assert.equal(owner.file, original);
});

test('repeated reopens and alternating two documents serialize independently without shared handles or cache callbacks', async () => {
  const ids = [0, 0], invalidations = [0, 0], disposals = [0, 0];
  const owners = [0, 1].map(index => session(file({ dispose: () => disposals[index]++ }), {}, {
    open: async (_path, _kind, options) => { assert.equal(options?.forceReadOnly, false); ids[index]++; return file({ dispose: () => disposals[index]++ }); },
  }));
  const work: Promise<void>[] = [];
  for (let round = 0; round < 20; round++) for (const index of [0, 1]) work.push(owners[index].runExclusive(() => owners[index].reopen(`/${index}`, undefined, false, () => ({}), () => invalidations[index]++)));
  // The existing eight-job limit rejects the excess independently per document.
  const outcomes = await Promise.allSettled(work);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 16);
  assert.deepEqual(ids, [8, 8]); assert.deepEqual(invalidations, [8, 8]); assert.deepEqual(disposals, [8, 8]);
  await owners[0].close();
  assert.equal(owners[1].closed, false);
  await owners[1].runExclusive(() => owners[1].reopen('/1', undefined, false, () => ({}), () => invalidations[1]++));
  await owners[1].close();
  assert.deepEqual(disposals, [9, 10]);
});


test('reentrant host closing observes the same completion promise until an active save drains', async () => {
  const held = latch(), entered = latch();
  let nested: Promise<void> | undefined, nestedDone = false;
  let owner!: DatasetSession;
  owner = session(file(), { onClosing: () => { nested = owner.close(); void nested.then(() => { nestedDone = true; }); } });
  const active = owner.runExclusive(async () => { entered.release(); await held.promise; });
  await entered.promise;
  const closing = owner.close();
  assert.equal(nested, closing);
  await Promise.resolve();
  assert.equal(nestedDone, false);
  held.release();
  await Promise.all([active, closing]);
  assert.equal(nestedDone, true);
});

test('a failing invalidation callback still releases the replaced file without retrying the open', async () => {
  let disposed = 0, opened = 0;
  const old = file({ dispose: () => { disposed++; } }), next = file();
  const cause = new Error('host invalidation failure');
  const owner = session(old, {}, { open: async () => { opened++; return next; } });
  await assert.rejects(owner.runExclusive(() => owner.reopen('/source', undefined, false, () => ({}), () => { throw cause; })), error => error === cause);
  assert.equal(opened, 1); assert.equal(disposed, 1); assert.equal(owner.file, next);
  await owner.close();
});
