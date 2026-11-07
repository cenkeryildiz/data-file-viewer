/**
 * Worksheet selection for one document's data view (EX-02), as plain values.
 *
 * Choosing a sidebar entry takes effect immediately; its preview arrives later,
 * and anything that arrives for an older choice is discarded. SQL the user runs
 * never changes this selection, and its rows are never attributed to the
 * selected sheet. Owned per document: every function takes and returns the
 * selection it works on, so two views cannot share one.
 */
export interface WorksheetSelection {
  sheet: string | undefined;
  /** Increments on every choice, including choosing the same sheet again. */
  seq: number;
  /** The query catalog generation the choice was made against. */
  generation: number;
  /** The last transport id sent before the choice: replies to it, or to anything earlier, are stale. */
  since: number;
  /** The one preview request on the wire. A newer choice waits for it, then goes out. */
  inFlight: { seq: number; requestId: number } | undefined;
}

export function initialSelection(): WorksheetSelection {
  return { sheet: undefined, seq: 0, generation: 0, since: 0, inFlight: undefined };
}

/** A preview to send now for the latest choice. */
export interface PreviewDispatch { sheet: string; seq: number }

/** Choose a sheet. One preview at a time: a burst of clicks must not queue a burst of queries. */
export function chooseSheet(
  selection: WorksheetSelection,
  sheet: string,
  generation: number,
  transportSeq: number
): { selection: WorksheetSelection; dispatch: PreviewDispatch | undefined } {
  const next: WorksheetSelection = { ...selection, sheet, seq: selection.seq + 1, generation, since: transportSeq };
  return { selection: next, dispatch: next.inFlight ? undefined : { sheet, seq: next.seq } };
}

/** Record the transport id of the preview just sent for choice `seq`. */
export function markDispatched(selection: WorksheetSelection, seq: number, requestId: number): WorksheetSelection {
  return { ...selection, inFlight: { seq, requestId } };
}

/**
 * Settle the in-flight preview if `reply` answers it, and decide whether the
 * reply is stale -- an answer to a request made before the current choice, or
 * a preview for an older choice. When the settled preview was for an older
 * choice, the latest one is dispatched now.
 */
export function settleReply(
  selection: WorksheetSelection,
  reply: { requestId?: number; selectionSeq?: number }
): { selection: WorksheetSelection; stale: boolean; dispatch: PreviewDispatch | undefined } {
  let next = selection;
  let dispatch: PreviewDispatch | undefined;
  if (selection.inFlight && reply.requestId === selection.inFlight.requestId) {
    next = { ...selection, inFlight: undefined };
    if (selection.inFlight.seq !== selection.seq && selection.sheet !== undefined) {
      dispatch = { sheet: selection.sheet, seq: selection.seq };
    }
  }
  const older = reply.requestId !== undefined && reply.requestId <= selection.since;
  const otherChoice = reply.selectionSeq !== undefined && reply.selectionSeq !== selection.seq;
  return { selection: next, stale: dispatch !== undefined || older || otherChoice, dispatch };
}

/** Whether the host attests that a result's worksheet coordinates belong to the current choice. */
export function attestsCurrentChoice(
  selection: WorksheetSelection,
  result: { sheetPreview?: string; selectionSeq?: number }
): boolean {
  return result.sheetPreview !== undefined && result.sheetPreview === selection.sheet &&
    result.selectionSeq !== undefined && result.selectionSeq === selection.seq;
}
