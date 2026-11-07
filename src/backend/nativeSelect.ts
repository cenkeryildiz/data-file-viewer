// Native is the installed default; the reference backend requires an explicit development/test override.
import { join } from 'node:path';
import { referenceBackend } from './reference';
import { nativeBackend } from './nativeDocument';
import type { BackendFactory } from './types';

/** Packaged worker location; DFV_TABLE_WORKER overrides it for a worker built in place. */
export const nativeWorkerPath = (extensionPath: string, env: NodeJS.ProcessEnv = process.env) =>
  env.DFV_TABLE_WORKER || join(extensionPath, 'bin', process.platform === 'win32' ? 'dfv-table.exe' : 'dfv-table');

export function selectBackend(extensionPath: string, env: NodeJS.ProcessEnv = process.env): BackendFactory {
  if (env.DFV_BACKEND === 'reference') return referenceBackend;
  if (env.DFV_BACKEND !== undefined && env.DFV_BACKEND !== 'native') throw new Error('Unknown DFV_BACKEND. Use native or the explicit reference test backend.');
  return nativeBackend({ executable: nativeWorkerPath(extensionPath, env), env });
}
