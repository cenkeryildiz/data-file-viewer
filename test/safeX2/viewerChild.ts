/**
 * A second DOCUMENT INSTANCE in a separate process for the SAFE-X2 review
 * regressions: a real ViewerFile (its own query worker) editing one workbook.
 *
 *   viewerChild <file> <column> <newValue> <rowA> <rowB>
 *
 * Opens the workbook, runs the grid query, then edits. Publication pauses at
 * `rename` (the candidate is staged and verified) until the parent sends
 * 'publish'. Reports {state:'ready'|'staged'|'success'|'error'}. Not a test file.
 */
import { injectRename } from './faults';
import { ViewerFile } from '../../src/viewerFile';

const [file, column, newValue, rowA, rowB] = process.argv.slice(2);
const send = (message: object) => process.send?.(message);

injectRename(async (real, from, to) => {
  send({ state: 'staged' });
  await new Promise((resolve) => process.once('message', resolve));
  await real(from, to);
});

(async () => {
  const viewer = await ViewerFile.open(file);
  try {
    await viewer.runQuery('select * from "A"');
    send({ state: 'ready' });
    await new Promise((resolve) => process.once('message', resolve));
    const value = /^\d+$/.test(newValue) ? Number(newValue) : newValue;
    const rows = await viewer.updateCell('A', column, value, { A: rowA, B: rowB });
    send({ state: 'success', rows });
  } catch (error) {
    send({ state: 'error', message: (error as Error).message, outcome: (error as { outcome?: string }).outcome });
  } finally {
    viewer.dispose();
    process.disconnect?.();
  }
})();
