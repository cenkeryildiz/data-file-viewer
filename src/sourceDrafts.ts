// Host-owned unapplied source drafts (ported from the bundle's sourceDrafts.mjs).
// Never a PDF history state or a prepared edit; stored under extension-owned storage only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_BYTES = 1024 * 1024, MAX_RECORDS = 64, MAX_TOTAL = 16 * MAX_BYTES;
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const encode = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(id);
const uint = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const fields = (v: any, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();

export function validateDraft(d: any): any {
  const text = (k: string) => typeof d[k] === 'string' && Array.from(d[k] as string).length <= 200000;
  const ok = fields(d, ['id', 'generation', 'kind', 'page', 'source', 'original', 'mode', 'options', 'caret', 'base_revision', 'object_id'])
    && validId(d.id) && ['generation', 'page', 'base_revision'].every(k => uint(d[k]))
    && ['paragraph', 'formula', 'comment'].includes(d.kind) && ['text', 'latex'].includes(d.mode)
    && text('source') && text('original') && fields(d.options, ['width', 'grow']) && typeof d.options.grow === 'boolean'
    && (d.options.width === null || (typeof d.options.width === 'number' && Number.isFinite(d.options.width) && d.options.width > 0))
    && (d.caret === null || (Array.isArray(d.caret) && d.caret.length === 2 && d.caret.every((n: unknown) => uint(n) && (n as number) <= 400000) && d.caret[0] <= d.caret[1]))
    && (d.object_id === null || (typeof d.object_id === 'string' && Array.from(d.object_id as string).length <= 256))
    && Buffer.byteLength(encode(d)) <= MAX_BYTES - 4096;
  if (!ok) throw Error('Invalid source checkpoint.');
  return d;
}

function privateDirectory(directory: string, container = false) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  const s = fs.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & (container ? 0o022 : 0o077)) || (process.getuid && s.uid !== process.getuid()))
    throw Error('Checkpoint storage must be an owner-private directory.');
}
function sync(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class SourceDrafts {
  private root: string;
  private directory = '';
  constructor(root: string, private source: string) { this.root = path.resolve(root); }

  // Synchronous bounded operations also serialize calls from this host; O_EXCL refuses other hosts.
  private locked<T>(body: (namespace: string) => T): T {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    privateDirectory(this.root, true);
    const namespace = path.join(this.root, 'native_source_drafts');
    privateDirectory(namespace);
    this.directory = path.join(namespace, hash(fs.realpathSync(this.source)));
    privateDirectory(this.directory);
    const lock = path.join(this.directory, '.lock');
    const deadOwner = () => {
      const lfd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let pid: number;
      try { pid = Number(fs.readFileSync(lfd, 'utf8')); } finally { fs.closeSync(lfd); }
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; } catch (e: any) { if (e.code === 'ESRCH') return true; throw e; }
    };
    try {
      if (deadOwner()) {
        const reclaim = lock + '.reclaim', claim = fs.openSync(reclaim, 'wx', 0o600);
        try { if (deadOwner()) fs.unlinkSync(lock); } finally { fs.closeSync(claim); fs.unlinkSync(reclaim); }
      }
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); return body(namespace); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }

  private read(file: string): any {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let raw: Buffer;
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size > MAX_BYTES || s.nlink !== 1) throw Error('Invalid checkpoint file.');
      raw = Buffer.alloc(s.size);
      let offset = 0;
      while (offset < raw.length) {
        const n = fs.readSync(fd, raw, offset, raw.length - offset, null);
        if (!n) throw Error('Truncated checkpoint.');
        offset += n;
      }
    } finally { fs.closeSync(fd); }
    const e = JSON.parse(raw.toString('utf8')), r = e.record;
    if (e.format !== 'native-source-checkpoint-1' || e.sha256 !== hash(encode(r)) || r.version !== 1 || !Number.isFinite(r.updated) || !r.base
      || typeof r.base.source_digest !== 'string' || !uint(r.base.verified_length) || !uint(r.base.revision)
      || typeof r.base.verified_digest !== 'string' || typeof r.base.doc !== 'string') throw Error('Invalid checkpoint checksum or identity.');
    validateDraft(r.draft);
    if (path.basename(file) !== r.draft.id + '.json') throw Error('Checkpoint identity differs.');
    return r;
  }

  list(digest: string) {
    return this.locked(() => {
      const names = fs.readdirSync(this.directory).sort(), files = names.filter(n => n.endsWith('.json'));
      let unreadable = names.filter(n => n.startsWith('.draft-')).length;
      const records: any[] = [];
      for (const n of files.slice(0, MAX_RECORDS)) {
        try { const r = this.read(path.join(this.directory, n)); records.push({ ...r, source_matches: r.base.source_digest === digest }); } catch { unreadable++; }
      }
      return { records: records.sort((a, b) => b.updated - a.updated), unreadable, truncated: files.length > MAX_RECORDS };
    });
  }

  put(draft: any, base: unknown) {
    validateDraft(draft);
    return this.locked(namespace => {
      const file = path.join(this.directory, draft.id + '.json');
      let old: any;
      try { fs.lstatSync(file); old = this.read(file); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (old && (old.draft.generation > draft.generation || (old.draft.generation === draft.generation && !isDeepStrictEqual(old.draft, draft))))
        throw Error('A newer or different checkpoint exists.');
      const same = !!old && isDeepStrictEqual(old.draft, draft);
      const record = same ? old : { version: 1, draft, base, updated: Date.now() / 1000 };
      const data = encode({ format: 'native-source-checkpoint-1', record, sha256: hash(encode(record)) });
      const files = fs.readdirSync(this.directory).filter(n => n.endsWith('.json') || n.startsWith('.draft-'));
      const total = files.filter(n => n !== draft.id + '.json').reduce((sum, n) => sum + fs.lstatSync(path.join(this.directory, n)).size, 0) + Buffer.byteLength(data);
      if (Buffer.byteLength(data) > MAX_BYTES || (!old && files.filter(n => n.endsWith('.json')).length >= MAX_RECORDS)
        || files.filter(n => n.startsWith('.draft-')).length >= MAX_RECORDS || total > MAX_TOTAL)
        throw Error('Checkpoint storage is full; existing records were retained.');
      if (!same) {
        const temp = path.join(this.directory, '.draft-' + crypto.randomUUID());
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
      } else {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      sync(this.directory); sync(namespace); sync(this.root); sync(path.dirname(this.root));
      return { id: draft.id, generation: draft.generation, updated: record.updated };
    });
  }

  discard(id: string, generation: number) {
    if (!validId(id) || !uint(generation)) throw Error('Invalid checkpoint identity.');
    return this.locked(() => {
      const file = path.join(this.directory, id + '.json');
      try {
        const r = this.read(file);
        if (r.draft.generation !== generation) throw Error('Checkpoint changed; refresh before discarding.');
        fs.unlinkSync(file);
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      sync(this.directory);
      return { id, deleted: true };
    });
  }
}
