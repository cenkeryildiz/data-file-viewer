/**
 * A separate writer PROCESS for the SAFE-X2 regressions (forked with IPC).
 *
 *   writerChild <mode> <file> <column> <expectedCurrent> <newValue> <expectedSha256>
 *
 * mode:
 *   pause        -- publication pauses at `rename` (the staged candidate is
 *                   complete) until the parent sends 'publish'.
 *   exit-before  -- the process exits (77) immediately before `rename`.
 *   exit-after   -- the process exits (78) immediately after `rename`.
 *
 * Reports {state:'staged'|'success'|'error'} to the parent. Not a test file.
 */
import { injectRename } from './faults';
import { patchCell } from '../../src/xlsxWrite';

const [mode, file, column, expectedCurrent, newValue, expectedSha256] = process.argv.slice(2);
const send = (message: object) => process.send?.(message);

injectRename(async (real, from, to) => {
  if (mode === 'exit-before') process.exit(77);
  if (mode === 'pause') {
    send({ state: 'staged' });
    await new Promise((resolve) => process.once('message', resolve));
  }
  await real(from, to);
  if (mode === 'exit-after') process.exit(78);
});

patchCell({
  filePath: file,
  sheetPath: 'xl/worksheets/sheet1.xml',
  columnName: column,
  columnNames: ['A', 'B'],
  rowOrdinal: 2,
  verbatim: true,
  expectedCurrent,
  newValue: /^\d+$/.test(newValue) ? Number(newValue) : newValue,
  expectedSha256,
}).then(
  (receipt) => {
    send({ state: 'success', receipt });
    process.disconnect?.();
  },
  (error: Error & { outcome?: string }) => {
    send({ state: 'error', message: error.message, outcome: error.outcome });
    process.disconnect?.();
  }
);
