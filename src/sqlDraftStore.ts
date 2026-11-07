/**
 * The user's SQL editor draft, per document, kept exactly as typed.
 *
 * The webview's editor is destroyed when its tab closes, so a draft that only
 * lived there was lost on close/reopen. The host keeps the latest one per
 * document URI in memory and, when VS Code provides one, in workspace state.
 * Bounded by count; each draft is already bounded by the SQL size limit.
 * Nothing here interprets the text: what is stored is what is restored.
 */
export interface DraftMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const STATE_KEY = 'dataFileViewer.sqlDrafts.v1';
export const MAX_STORED_DRAFTS = 20;
const PERSIST_DELAY_MS = 250;

export class SqlDraftStore {
  /** Most recently written last. */
  private readonly drafts = new Map<string, string>();
  private persisting: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly memento?: DraftMemento) {
    const stored = memento?.get<unknown>(STATE_KEY);
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1] !== '') {
          this.drafts.set(entry[0], entry[1]);
        }
      }
    }
  }

  get(documentKey: string): string | undefined {
    return this.drafts.get(documentKey);
  }

  /**
   * An empty draft removes the entry. The in-memory copy, which is what a
   * reopen in this session reads, changes at once. The webview sends every
   * keystroke, so workspace state is written once typing pauses, or at once
   * through flush() (an editor closing).
   */
  set(documentKey: string, sql: string): void {
    this.drafts.delete(documentKey);
    if (sql !== '') this.drafts.set(documentKey, sql);
    while (this.drafts.size > MAX_STORED_DRAFTS) this.drafts.delete(this.drafts.keys().next().value as string);
    if (!this.memento || this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => { void this.flush(); }, PERSIST_DELAY_MS);
  }

  /** Write any pending change to workspace state now. */
  flush(): Promise<void> {
    if (this.persistTimer !== undefined) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    if (!this.memento) return Promise.resolve();
    // Serialized so a slower earlier write can never land after a later one.
    const snapshot = [...this.drafts];
    const memento = this.memento;
    this.persisting = this.persisting.then(() => memento.update(STATE_KEY, snapshot)).then(undefined, () => undefined);
    return this.persisting;
  }
}
