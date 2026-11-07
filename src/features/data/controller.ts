import { chooseWorksheet, initialState, previewDispatched, reduce, type Effect, type ExtensionMessage, type WebviewState } from './state';
import { QueryPicker } from './queryPicker';

/** The one thing the data view needs from its host: a way to post a message. */
export interface HostChannel { postMessage(message: unknown): void }

/**
 * One document's data-view controller (MOD-02).
 *
 * Owns the transport sequence, the reducer state, the worksheet selection
 * inside it and the query picker. Every outgoing message gets a transport id
 * and the picker's catalog generation; the host echoes both, which is how
 * stale replies are recognised. The DOM layer holds exactly one controller and
 * passes it nothing global, so two views can never share selection or cache
 * state.
 */
export class DataController {
  state: WebviewState = initialState();
  readonly picker = new QueryPicker();
  private transportSequence = 0;

  constructor(private readonly host: HostChannel) {}

  /** Post to the host; returns the transport id the host echoes on its replies. */
  post(message: Record<string, unknown>): number {
    const requestId = ++this.transportSequence;
    this.picker.noteRequest(message.command, requestId, this.state.selection.seq);
    this.host.postMessage({ ...message, requestId, generation: this.picker.generation });
    return requestId;
  }

  /** Choose a sidebar entry now; returns the effects the view must apply. */
  choose(sheet: string): Effect[] {
    const chosen = chooseWorksheet(this.state, sheet, this.picker.generation, this.transportSequence);
    this.state = chosen.state;
    return chosen.effects;
  }

  /** Record that the preview for choice `seq` went out as `requestId`. */
  previewSent(seq: number, requestId: number): void {
    this.state = previewDispatched(this.state, seq, requestId);
  }

  /** Apply a host message to the reducer state; returns the effects to apply. */
  receive(message: ExtensionMessage): Effect[] {
    const { state, effects } = reduce(this.state, message);
    this.state = state;
    return effects;
  }
}

export function createDataController(host: HostChannel): DataController {
  return new DataController(host);
}
