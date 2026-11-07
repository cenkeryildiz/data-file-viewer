// The native adapter's operation inventory (D3.17/D3.18): every read the viewer can ask for plus the two writes.
// An operation the worker does not advertise fails with NativeUnsupportedError, never a silent default,
// and nativeCoverage() lets a gate list exactly which ones those are.
import { READ_METHODS } from '../queryProtocol';
import { NativeError } from './nativeWorker';

export const NATIVE_WRITE_METHODS = ['createBackup', 'updateCell'] as const;
/** 22 reads + 2 writes: the TS-level surface the adapter answers for. */
export const NATIVE_OPERATIONS: readonly string[] = [...READ_METHODS, ...NATIVE_WRITE_METHODS];

/** The worker (or this build of it) does not route `operation`. Distinct from a failure of an operation it does route. */
export class NativeUnsupportedError extends NativeError {
  constructor(readonly operation: string, reason = 'the native table worker does not route it yet') {
    super('unsupported', `${operation} is unavailable: ${reason}.`, { category: 'unsupported' });
    this.name = 'NativeUnsupportedError';
  }
}
export const isUnsupported = (e: unknown): e is NativeUnsupportedError => e instanceof NativeUnsupportedError;

/** Split the inventory by what a worker advertises (capabilities.methods). */
export function nativeCoverage(advertised: readonly string[]) {
  const have = new Set(advertised);
  return {
    routed: NATIVE_OPERATIONS.filter(op => have.has(op)),
    unsupported: NATIVE_OPERATIONS.filter(op => !have.has(op)),
  };
}
