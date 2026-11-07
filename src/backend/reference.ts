import type { BackendFactory, DocumentFile } from './types';

/** Explicit reference/test backend only; native activation never loads its Node processing dependencies. */
export const referenceBackend: BackendFactory = {
  open: async (path, forceKind, options) => (await import('../viewerFile')).ViewerFile.open(path, forceKind, options),
};

/** Raw reference connection for existing oracle/host fixtures that deliberately inject it. */
export const rawReferenceBackend: BackendFactory = {
  open: async (path, forceKind, options) => (await import('../duckdbConnection')).DuckDbFile.open(path, forceKind, options),
};

/**
 * Compatibility at the reference boundary only. The host captures this per
 * document, instead of inspecting implementation classes on each reconnect.
 * Future backends supply an explicit BackendFactory to the document.
 */
export function referenceBackendFor(file: DocumentFile): BackendFactory {
  const { ViewerFile } = require('../viewerFile') as typeof import('../viewerFile');
  return file instanceof ViewerFile ? referenceBackend : rawReferenceBackend;
}
