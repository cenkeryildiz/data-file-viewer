import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type NativeFeature = 'table' | 'pdf' | 'mat';
export const MAX_NATIVE_WORKERS = 8;
const workers = new Set<{ feature: NativeFeature; pid?: number }>();

export class WorkerCapacityError extends Error {
  constructor() {
    super(`All ${MAX_NATIVE_WORKERS} native worker slots are in use. Close a data or PDF tab before opening another.`);
    this.name = 'WorkerCapacityError';
  }
}

/** Includes children still starting or stopping; neither state frees their slot. */
export function nativeWorkerUsage() {
  return { limit: MAX_NATIVE_WORKERS, workers: [...workers].map(worker => ({ ...worker })) };
}

export function spawnWorker(feature: NativeFeature, executable: string, args: string[], options: SpawnOptions): ChildProcess {
  if (workers.size >= MAX_NATIVE_WORKERS) throw new WorkerCapacityError();
  const worker: { feature: NativeFeature; pid?: number } = { feature };
  workers.add(worker);
  try {
    const child = spawn(executable, args, options);
    let started = false;
    child.once('spawn', () => { started = true; worker.pid = child.pid; });
    child.once('error', () => { if (!started) workers.delete(worker); });
    child.once('exit', () => workers.delete(worker));
    return child;
  } catch (error) {
    workers.delete(worker);
    throw error;
  }
}
