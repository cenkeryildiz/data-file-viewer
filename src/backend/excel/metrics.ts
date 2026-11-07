import type { PreparationMetrics, PreparationPhase } from '../types';

/**
 * PERF-X1: per-document timing of each workbook preparation phase, plus the
 * counters that show whether work scales with the sheets actually used.
 * Host-free and cheap (one clock read per phase); never shared between
 * documents.
 */
export class PreparationRecorder {
  private readonly phases = new Map<PreparationPhase, { count: number; totalMs: number; maxMs: number; lastMs: number }>();
  detectorCalls = 0;
  gridCells = 0;
  gridDecodedBytes = 0;
  cacheEvictions = 0;
  cacheRestores = 0;

  record(phase: PreparationPhase, ms: number): void {
    const entry = this.phases.get(phase) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    entry.count++;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    entry.lastMs = ms;
    this.phases.set(phase, entry);
  }

  async time<T>(phase: PreparationPhase, work: () => Promise<T> | T): Promise<T> {
    const started = performance.now();
    try { return await work(); } finally { this.record(phase, performance.now() - started); }
  }

  snapshot(cache: { cells: number; objects: number; maxCells: number }): PreparationMetrics {
    const phases: PreparationMetrics['phases'] = {};
    for (const [phase, entry] of this.phases) phases[phase] = { ...entry };
    return {
      phases,
      detectorCalls: this.detectorCalls,
      gridCells: this.gridCells,
      gridDecodedBytes: this.gridDecodedBytes,
      cachedCells: cache.cells,
      cachedObjects: cache.objects,
      cacheMaxCells: cache.maxCells,
      cacheEstimatedBytes: cache.cells * ESTIMATED_BYTES_PER_CACHED_CELL,
      cacheEvictions: this.cacheEvictions,
      cacheRestores: this.cacheRestores,
    };
  }
}

/**
 * The estimate the cache budget is stated in. MAX_CACHED_CELLS' own note sizes
 * 10 M cells at ~80 MB; verbatim text cells are usually wider, so this is a
 * floor, reported beside DuckDB's measured memory in the PERF-X1 evidence.
 */
export const ESTIMATED_BYTES_PER_CACHED_CELL = 8;

/** JS heap bytes a decoded grid costs at least: UTF-16 text plus one slot per cell. */
export function decodedGridBytes(grid: readonly (readonly unknown[])[]): { cells: number; bytes: number } {
  let cells = 0;
  let bytes = 0;
  for (const row of grid) {
    cells += row.length;
    bytes += 8 * row.length;
    for (const cell of row) if (typeof cell === 'string') bytes += 2 * cell.length;
  }
  return { cells, bytes };
}
