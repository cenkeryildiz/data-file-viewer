/**
 * Public entrypoint of the data-view feature (MOD-02). Code outside
 * src/features/data imports from here only; test/mod02Boundaries.test.ts
 * enforces it.
 */
export { DataController, createDataController, type HostChannel } from './controller';
export { QueryPicker, MAX_PICKER_DRAFTS } from './queryPicker';
export {
  attestsCurrentChoice,
  chooseSheet,
  initialSelection,
  markDispatched,
  settleReply,
  type PreviewDispatch,
  type WorksheetSelection,
} from './worksheetSelection';
export * from './state';
