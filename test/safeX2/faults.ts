/**
 * SAFE-X2 fault injection for the .xlsx cell writer.
 *
 * Converted from the audit probes in
 * Projects/Python/pdf_creator/tests/_evidence/viewer_plan_validation_20261016/
 * (probe_backend.cjs, probe_concurrent.cjs). Faults are injected by replacing
 * functions on the live `node:fs/promises` module object, exactly as the probes
 * did, so the same test drives both the writer as audited and the writer as
 * fixed. A staging file is recognised by its `.dfv-tmp-` sibling marker; the
 * writer may stage through `writeFile(path)` or through `open(path)` and the
 * handle's `writeFile`/`write`, so both routes are intercepted.
 *
 * Simulated I/O failures and process exits are not physical power-loss tests.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const fsp: Record<string, any> = require('node:fs/promises');

export const STAGE_MARK = '.dfv-tmp-';
export const isStage = (path: unknown) => String(path).includes(STAGE_MARK);
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type StageFault = (stage: string, bytes: Uint8Array) => Promise<{ write: Uint8Array; error?: Error }>;

/**
 * Install `fault` on every write that lands in a staging file. It decides
 * which bytes really get written and whether the write then reports an error.
 * Returns the function that restores the real module.
 */
export function injectStageFault(fault: StageFault): () => void {
  const realWriteFile = fsp.writeFile;
  const realOpen = fsp.open;
  fsp.writeFile = async (path: unknown, data: Uint8Array, ...rest: unknown[]) => {
    if (!isStage(path)) return realWriteFile(path, data, ...rest);
    const { write, error } = await fault(String(path), data);
    await realWriteFile(path, write, ...rest);
    if (error) throw error;
  };
  fsp.open = async (path: unknown, ...rest: unknown[]) => {
    const handle = await realOpen(path, ...rest);
    if (!isStage(path)) return handle;
    const stage = String(path);
    const intercept = async (data: Uint8Array) => {
      const { write, error } = await fault(stage, data);
      await handle.writeFile(write);
      if (error) throw error;
    };
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'writeFile') return (data: Uint8Array) => intercept(data);
        if (key === 'write') {
          return async (data: Uint8Array) => {
            await intercept(data);
            return { bytesWritten: data.length, buffer: data };
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return () => {
    fsp.writeFile = realWriteFile;
    fsp.open = realOpen;
  };
}

/** Replace `rename` while it is the publication step. Returns the restorer. */
export function injectRename(
  replacement: (real: (from: string, to: string) => Promise<void>, from: string, to: string) => Promise<void>
): () => void {
  const real = fsp.rename;
  // Only the publication rename (a staging file moved over the workbook);
  // any other rename the writer makes passes through untouched.
  fsp.rename = (from: string, to: string) => (isStage(from) ? replacement(real, from, to) : real(from, to));
  return () => {
    fsp.rename = real;
  };
}

/**
 * The independent reader: fflate's own unzip (not the writer's zipPatch) and a
 * direct read of the cell's XML. Returns undefined when the package does not
 * open at all.
 */
export function readCells(path: string, refs: string[], sheet = 'xl/worksheets/sheet1.xml'): (string | undefined)[] | undefined {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(readFileSync(path)));
  } catch {
    return undefined;
  }
  const part = files[sheet];
  if (!part) return undefined;
  const xml = strFromU8(part);
  return refs.map((ref) => {
    const cell = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(xml);
    if (!cell) return undefined;
    const body = cell[1] ?? '';
    return /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
  });
}
