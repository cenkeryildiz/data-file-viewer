import type { QueryColumn, QueryTarget } from '../../queryCatalog';
import { groupQueryTargets, type QueryTargetGroup } from '../../queryTargetList';

/** At most this many SQL drafts wait behind "Restore draft". */
export const MAX_PICKER_DRAFTS = 8;

/**
 * The Query table picker's data for one document's view (EX-03), without DOM.
 *
 * Owns the catalog page cache, the chosen target, its columns for completion,
 * the catalog generation every reply is checked against, and the user's SQL
 * drafts displaced by "Use in SQL". The view renders from it; nothing here is
 * shared between documents.
 */
export class QueryPicker {
  readonly targets = new Map<string, QueryTarget>();
  readonly columns = new Map<string, QueryColumn[]>();
  private readonly drafts: string[] = [];
  selected: QueryTarget | undefined;
  nextCursor: number | undefined;
  /** The query catalog generation this picker currently describes. */
  generation = 0;
  private catalogRequestId = 0;
  private targetRequestId: number | undefined;
  /** A→B→A is a new choice even when the target's worksheet name matches again. */
  private targetSelectionSeq: number | undefined;

  /** Remember which outgoing request a reply must answer to be accepted. */
  noteRequest(command: unknown, requestId: number, selectionSeq: number): void {
    if (['queryTarget', 'queryTargetSql', 'sheetTableSql'].includes(String(command))) {
      this.targetRequestId = requestId;
      this.targetSelectionSeq = selectionSeq;
    }
    if (command === 'queryCatalog') this.catalogRequestId = requestId;
  }

  /**
   * Apply a catalog page. `ignored` for a reply to an older request or an older
   * generation; `reset` when the source changed and the old choice was dropped.
   */
  acceptCatalog(message: { targets: QueryTarget[]; generation: number; cursor: number; nextCursor?: number; requestId?: number }): 'ignored' | 'applied' | 'reset' {
    if (message.requestId !== this.catalogRequestId) return 'ignored';
    if (message.generation < this.generation) return 'ignored';
    let outcome: 'applied' | 'reset' = 'applied';
    if (message.generation !== this.generation) {
      this.targets.clear(); this.columns.clear(); this.selected = undefined;
      outcome = 'reset';
    }
    this.generation = message.generation;
    if (message.cursor === 0) this.targets.clear();
    for (const target of message.targets) this.targets.set(target.id, target);
    // The fresh copy, not the one selected earlier: a raw worksheet only gains
    // its used-range bounds once the sheet has been prepared.
    if (this.selected) this.selected = this.targets.get(this.selected.id);
    this.nextCursor = message.nextCursor;
    return outcome;
  }

  /** Columns for one target, as the reply to its own request. */
  acceptDetails(message: { target: QueryTarget; columns: QueryColumn[]; requestId?: number }, selectionSeq: number): boolean {
    if (message.requestId === undefined || message.requestId !== this.targetRequestId || selectionSeq !== this.targetSelectionSeq) return false;
    if (message.target.generation !== this.generation) return false;
    this.targets.set(message.target.id, message.target);
    this.columns.set(message.target.id, message.columns);
    if (!this.selected || this.selected.id === message.target.id) this.selected = message.target;
    return true;
  }

  /**
   * A generated SQL draft for a target replaces the editor text; the text it
   * replaces is kept to restore. `full` when too many drafts are waiting.
   */
  acceptSqlDraft(message: { target: QueryTarget; requestId?: number }, editorText: string, selectionSeq: number): 'ignored' | 'full' | 'accepted' {
    if (message.requestId === undefined || message.requestId !== this.targetRequestId || selectionSeq !== this.targetSelectionSeq) return 'ignored';
    if (message.target.generation !== this.generation) return 'ignored';
    if (this.drafts.length >= MAX_PICKER_DRAFTS) return 'full';
    this.drafts.push(editorText);
    this.selected = message.target; this.targets.set(message.target.id, message.target);
    return 'accepted';
  }

  /** The most recently displaced draft, if any. */
  restoreDraft(): string | undefined { return this.drafts.pop(); }
  get hasDrafts(): boolean { return this.drafts.length > 0; }

  select(id: string): QueryTarget | undefined {
    this.selected = this.targets.get(id);
    return this.selected;
  }

  /** A worksheet-bound target never stays chosen once another sheet is selected. */
  dropForeignSelection(sheet: string | undefined): void {
    if (this.selected?.worksheet !== undefined && this.selected.worksheet !== sheet) this.selected = undefined;
  }

  groups(openSheet: string | undefined): QueryTargetGroup[] {
    return groupQueryTargets(this.targets.values(), openSheet);
  }

  /** SQL completion schema: catalog → schema → table → columns. */
  completionSchema(): Record<string, Record<string, Record<string, { label: string; type: string; detail: string }[]>>> {
    const schema: Record<string, any> = Object.create(null);
    for (const target of this.targets.values()) {
      const catalog = schema[target.catalog] ??= Object.create(null);
      const namespace = catalog[target.schema] ??= Object.create(null);
      namespace[target.name] = (this.columns.get(target.id) ?? []).map(column => ({ label: column.name, type: 'property', detail: column.type }));
    }
    return schema;
  }
}
