import { QUERY_LIMITS, QueryPolicyError } from '../queryPolicy';
import type { BackendFactory, DocumentFile, DuckDbFileOpenOptions, FileKind } from './types';

export interface SessionHooks {
  /** Called when queued work starts, so the host can check current workspace trust. */
  authorize: () => void;
  onSaveNotice?: (notice: string) => void;
  /** Runs immediately after closing is marked, before interruption or draining. */
  onClosing?: () => void;
  /** Optional final comparison/summary; failure never prevents disposal. */
  beforeDispose?: (file: DocumentFile) => void | Promise<void>;
  /** Runs only after the file is disposed, including after an active save drains. */
  onDisposed?: () => void;
}

/**
 * Per-dataset ownership and serialization, independent of VS Code and the UI.
 * Metadata access remains synchronous. Operations, including reopen, run inside
 * runExclusive/tryRunExclusive; a reopen never recursively queues itself.
 */
export class DatasetSession {
  private currentFile!: DocumentFile;
  private lockChain: Promise<void> = Promise.resolve();
  private lockDepth = 0;
  private readonly queuedChecks = new Set<() => boolean>();
  private isClosed = false;
  private closePromise?: Promise<void>;

  constructor(file: DocumentFile, readonly backend: BackendFactory, private readonly hooks: SessionHooks) {
    this.file = file;
  }

  get file(): DocumentFile { return this.currentFile; }
  set file(next: DocumentFile) {
    this.currentFile = next;
    if ('onSaveNotice' in next && this.hooks.onSaveNotice) next.onSaveNotice = this.hooks.onSaveNotice;
  }
  get closed(): boolean { return this.isClosed; }
  isBusy(): boolean { return this.lockDepth > 0; }

  /** Supersession applies only when the caller supplies a read guard; saves never supply one. */
  runExclusive<T>(fn: () => Promise<T>, isSuperseded?: () => boolean): Promise<T> {
    const live = [...this.queuedChecks].filter(superseded => !superseded()).length;
    if (live >= QUERY_LIMITS.queuedRequests || this.lockDepth >= QUERY_LIMITS.queuedRequests * 8) {
      return Promise.reject(new QueryPolicyError('Too many queued operations. Wait or cancel the current query.'));
    }
    // Each job has its own identity, even if callers reuse a guard.
    const check = () => isSuperseded?.() ?? false;
    this.queuedChecks.add(check);
    this.lockDepth++;
    const run = this.lockChain.then(() => {
      if (this.closed) throw new QueryPolicyError('This document is closed.');
      this.hooks.authorize();
      if (check()) throw new QueryPolicyError('Superseded by a newer query.');
      return fn();
    });
    const settle = () => {
      this.lockDepth--;
      this.queuedChecks.delete(check);
    };
    this.lockChain = run.then(settle, settle);
    return run;
  }

  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.isBusy()) return { ran: false };
    return { ran: true, value: await this.runExclusive(fn) };
  }

  /** Called within the owning serialized operation. Host settings remain lazy. */
  async reopen(path: string, forceKind: FileKind | undefined, forceReadOnly: boolean,
    options: () => DuckDbFileOpenOptions, invalidated: () => void): Promise<void> {
    if (forceReadOnly && await this.file.refreshInPlace()) {
      invalidated();
      return;
    }
    const next = await this.backend.open(path, forceKind, { ...options(), forceReadOnly });
    if (this.closed) {
      next.dispose();
      return;
    }
    const old = this.file;
    this.file = next;
    try { invalidated(); }
    finally { old.dispose(); }
  }

  /** Marks closed synchronously; the returned promise completes after drain and disposal. */
  close(): Promise<void> {
    if (this.closed) return this.closePromise!;
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    this.closePromise = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    this.isClosed = true;
    try { this.hooks.onClosing?.(); } catch { /* Host cleanup cannot prevent draining the file. */ }
    try { this.file.interruptCurrentQuery(); } catch { /* Still drain/dispose if interruption itself fails. */ }
    const finish = async () => {
      try {
        const pending = this.hooks.beforeDispose?.(this.file);
        // Avoid inserting an await into the old synchronous idle-cleanup path.
        if (pending) await pending;
      } catch { /* Closing never publishes raw errors or prevents cleanup. */ }
      finally {
        try { this.file.dispose(); }
        finally {
          try { this.hooks.onDisposed?.(); } catch { /* Host cleanup is once-only and cannot reject a completed disposal. */ }
        }
      }
    };
    const draining = this.lockDepth > 0 ? this.lockChain.then(finish) : finish();
    void draining.then(complete, fail);
    return this.closePromise;
  }
}
