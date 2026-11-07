import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DuckDbFile } from '../src/duckdbConnection';
import {
  MANIFEST,
  TRUTH,
  fixturePath,
  normalise,
  parseRef,
  rawGrid,
  regionRef,
  sameValue,
  sha256File,
} from './xlsxCorpus';
import { spanRowCount } from '../src/sheetRowMap';

/**
 * EX-01 regression corpus against the real workbook reader.
 *
 * Every fixture is a committed, byte-deterministic XLSX (build_corpus.py) whose
 * ground truth is written from the same spec as its cells. Tests that capture
 * CURRENTLY WRONG behaviour assert the correct result and are marked `todo`
 * with the defect reference, so `npm test` stays green while the defect stays
 * visible in the TODO count. When a fix lands, its todo test starts passing;
 * remove the `todo` entry below in that fix's commit.
 */

const KNOWN_FAILURES: Record<string, string> = {
  'tables:explicit-single':
    'EX-06 explicit-single-column-missed: declared one-column Excel table A1:A3 is not offered',
  'tables:explicit-adjacent':
    'EX-06 adjacent-explicit-tables-fused: LeftData A1:B3 + RightData C1:D3 become one 4-column table',
  'tables:explicit-stacked':
    'EX-06 adjacent-explicit-tables-fused (vertical): Top A1:B3 + Bottom A4:B6 fuse; header "Amount" becomes null data',
  'tables:multilevel-header':
    'EX-06 multilevel-header: only the second header row is used; Item/Q1/Q2 levels and A1:E5 range are lost',
  'columns-agree:multilevel-header':
    'EX-01-OBS-1 detector metadata names the blank-header column "_col0" while the derived query names it "C0"',
};

const names = Object.keys(TRUTH.fixtures);

test('every known-failure entry names a real corpus fixture', () => {
  for (const key of Object.keys(KNOWN_FAILURES)) {
    assert.ok(names.includes(key.split(':')[1]), `stale KNOWN_FAILURES key ${key}`);
  }
});

async function withFile<T>(name: string, fn: (file: DuckDbFile) => Promise<T>): Promise<T> {
  const file = await DuckDbFile.open(fixturePath(name), undefined, { forceReadOnly: true });
  try {
    return await fn(file);
  } finally {
    await file.dispose();
  }
}

/* ---------------------------------------------------------- source identity */

for (const name of names) {
  test(`corpus ${name}: file hash matches manifest and is unchanged by open/query/dispose`, async () => {
    const path = fixturePath(name);
    const before = sha256File(path);
    assert.equal(before, MANIFEST.sha256[TRUTH.fixtures[name].file], 'fixture differs from manifest.json');
    await withFile(name, async (file) => {
      for (const sheet of TRUTH.fixtures[name].sheets) {
        await file.runQuery(`select * from "${sheet.name}"`);
        for (const t of file.getDetectedSheetTables(sheet.name)) await file.runQuery(`select * from "${t.name}"`);
      }
    });
    assert.equal(sha256File(path), before, 'reading the workbook changed its bytes');
  });
}

/* ------------------------------------------------------------- raw sheet */

for (const name of names) {
  test(`corpus ${name}: the raw sheet shows every stored value exactly`, async () => {
    await withFile(name, async (file) => {
      for (const sheet of TRUTH.fixtures[name].sheets) {
        const expected = rawGrid(sheet);
        const r = await file.runQuery(`select * from "${sheet.name}"`);
        assert.equal(r.rows.length, expected.length, `${sheet.name}: raw row count`);
        assert.equal(r.columns.length, expected[0].length, `${sheet.name}: raw column count`);
        for (let i = 0; i < expected.length; i++) {
          for (let j = 0; j < expected[i].length; j++) {
            const got = normalise(r.rows[i][j]);
            assert.equal(got ?? null, expected[i][j], `${sheet.name} row ${i + 1} col ${j + 1}`);
          }
        }
      }
    });
  });
}

/* ---------------------------------------------------------- derived tables */

for (const name of names) {
  const key = `tables:${name}`;
  test(
    `corpus ${name}: offered tables match ground-truth ranges, columns and logical rows`,
    { todo: KNOWN_FAILURES[key] },
    async () => {
      const fx = TRUTH.fixtures[name];
      await withFile(name, async (file) => {
        for (const sheet of fx.sheets) await file.runQuery(`select * from "${sheet.name}" limit 1`);
        const detected = fx.sheets.flatMap((s) => file.getDetectedSheetTables(s.name));
        assert.deepEqual(
          detected.map((t) => `${t.sheet}!${regionRef(t)}`),
          fx.tables.map((t) => `${t.sheet}!${t.range}`),
          'table ranges'
        );
        for (let k = 0; k < fx.tables.length; k++) {
          const want = fx.tables[k];
          const got = detected[k];
          if (want.headerRows.length === 1) assert.equal(got.headerRow, want.headerRows[0] - 1, 'header row');
          const r = await file.runQuery(`select * from "${got.name}"`);
          if (want.columns) assert.deepEqual(r.columns, want.columns, 'columns');
          if (want.columnLevels) {
            assert.equal(new Set(r.columns).size, r.columns.length, 'column names are unique');
            r.columns.forEach((c, i) => {
              for (const level of want.columnLevels!) {
                assert.ok(c.includes(level[i]), `column ${i} "${c}" does not carry header level "${level[i]}"`);
              }
            });
          }
          assert.equal(r.rows.length, want.rows.length, `${got.name}: logical row count`);
          assert.equal(got.rowCount, want.rows.length, `${got.name}: detector rowCount`);
          assert.equal(spanRowCount(got.dataRows), want.rows.length, `${got.name}: source-row map size`);
          if (want.excludedRows) {
            assert.deepEqual(got.excludedRows.map((e) => e.row + 1), want.excludedRows, `${got.name}: excluded rows`);
          }
          want.rows.forEach((row, i) =>
            row.forEach((v, j) =>
              assert.ok(sameValue(normalise(r.rows[i][j]), v), `${got.name} row ${i} col ${j}: ${String(r.rows[i][j])} != ${String(v)}`)
            )
          );
        }
      });
    }
  );
}

for (const name of names) {
  test(
    `corpus ${name}: detector column metadata agrees with the derived query's columns`,
    { todo: KNOWN_FAILURES[`columns-agree:${name}`] },
    async () => {
      await withFile(name, async (file) => {
        for (const sheet of TRUTH.fixtures[name].sheets) {
          await file.runQuery(`select * from "${sheet.name}" limit 1`);
          for (const t of file.getDetectedSheetTables(sheet.name)) {
            const r = await file.runQuery(`select * from "${t.name}" limit 0`);
            assert.deepEqual(r.columns, t.columns, t.name);
          }
        }
      });
    }
  );
}

for (const name of names) {
  test(
    `corpus ${name}: numeric ground-truth columns are reported numeric, others not`,
    { todo: KNOWN_FAILURES[`stats-kind:${name}`] },
    async () => {
      const fx = TRUTH.fixtures[name];
      await withFile(name, async (file) => {
        for (const sheet of fx.sheets) await file.runQuery(`select * from "${sheet.name}" limit 1`);
        const detected = fx.sheets.flatMap((s) => file.getDetectedSheetTables(s.name));
        for (const want of fx.tables) {
          const got = detected.find((t) => t.sheet === want.sheet && regionRef(t) === want.range);
          if (!got) continue; // range mismatches are owned by the tables test above
          want.rows[0].forEach((_, j) => {
            const values = want.rows.map((row) => row[j]).filter((v) => v !== null);
            const numeric = values.length > 0 && values.every((v) => typeof v === 'number');
            assert.equal(got.columnStatsKind[j] === 'numeric', numeric, `${got.name} column ${j}`);
          });
        }
      });
    }
  );
}

/* ------------------------------------------------------------ specific cases */

test('corpus multilevel-header: every data row is read exactly even though the header levels are not', async () => {
  const want = TRUTH.fixtures['multilevel-header'].tables[0].rows;
  await withFile('multilevel-header', async (file) => {
    await file.runQuery('select * from "Sheet" limit 1');
    const [t] = file.getDetectedSheetTables('Sheet');
    const r = await file.runQuery(`select * from "${t.name}"`);
    assert.equal(r.rows.length, want.length);
    want.forEach((row, i) => row.forEach((v, j) => assert.ok(sameValue(normalise(r.rows[i][j]), v), `row ${i} col ${j}`)));
  });
});

test('corpus formula-errors: cached formula results are used, error cells become null AND are disclosed', async () => {
  const fx = TRUTH.fixtures['formula-errors'];
  await withFile('formula-errors', async (file) => {
    const raw = await file.runQuery('select * from "Sheet"');
    for (const [ref, marker] of Object.entries(fx.tables[0].errorCells!)) {
      const [r, c] = parseRef(ref);
      assert.equal(raw.rows[r][c], marker, `raw ${ref} must show the marker verbatim`);
    }
    const warnings = file.takeLateWarnings();
    assert.ok(
      warnings.some((w) => w.includes('#DIV/0!')),
      'an error cell turned into an empty table value without any notice'
    );
  });
});

test('corpus mixed-value: a non-numeric text value is kept exactly and the column reading is disclosed', async () => {
  await withFile('mixed-value', async (file) => {
    await file.runQuery('select * from "Sheet" limit 1');
    file.takeLateWarnings();
    const [t] = file.getDetectedSheetTables('Sheet');
    const r = await file.runQuery(`select * from "${t.name}"`);
    // Exact text, not a null that happens to come with some warning.
    assert.deepEqual(r.rows.map((row) => row[1]), ['1', 'not numeric', '3']);
    const warnings = file.takeLateWarnings();
    const notice = warnings.find((w) => w.includes(t.name) && w.includes('"Value"'));
    assert.ok(notice, `no notice names the table and column: ${JSON.stringify(warnings)}`);
    assert.match(notice!, /B3 "not numeric"/, 'the notice names the cell and its exact text');
    assert.match(notice!, /shown as text/);
  });
});

test('corpus single-column: an undeclared one-column block is still not offered as a table', async () => {
  await withFile('single-column', async (file) => {
    await file.runQuery('select * from "Sheet" limit 1');
    assert.deepEqual(file.getDetectedSheetTables('Sheet'), []);
  });
});

test('corpus sparse: the distant note is on the raw sheet but is not a table', async () => {
  await withFile('sparse', async (file) => {
    const raw = await file.runQuery('select "AZ" from "Sheet"');
    assert.equal(raw.rows.length, 1000);
    assert.equal(raw.rows[999][0], 'far note');
    assert.deepEqual(file.getDetectedSheetTables('Sheet').map(regionRef), ['A1:B3']);
  });
});

test('corpus two-sheet: using Raw_Data detects only Raw_Data, never the other sheet', async () => {
  await withFile('two-sheet', async (file) => {
    await file.runQuery('select * from "Raw_Data" limit 1');
    assert.deepEqual(file.getDetectedSheetTables('Raw_Data').map((t) => t.sheet), ['Raw_Data']);
    assert.deepEqual(file.getDetectedSheetTables('ZOther'), [], 'ZOther was discovered without being used');
    assert.ok(!(await file.listTables()).some((t) => t.startsWith('ZOther · ')));
  });
});
