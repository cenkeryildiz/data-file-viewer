import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DuckDBConnection } from '@duckdb/node-api';

import { DuckDbFile } from '../src/duckdbConnection';
import { detectTables, type Cell } from '../src/sheetTables';
import {
  gridRowOfSlot,
  slotOfGridRow,
  slotsBefore,
  spanRowCount,
  tableDataRows,
  validSpans,
  type RowSpan,
} from '../src/sheetRowMap';
import { ViewerFile } from '../src/viewerFile';
import { xlsxFile } from './stress/generators/_write';
import { TRUTH, fixturePath, normalise, sha256File } from './xlsxCorpus';

/**
 * EX-05 exact logical rows: one source-row map for detection, the derived
 * query, stats/plot inputs, the inline grid and edits; failed numeric coercion
 * keeps its text and is disclosed.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dfv-ex05-'));
}

async function rawCell(path: string, sheet: string, ref: string): Promise<unknown> {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    const r = await file.runQuery(`select "${m[1]}" from "${sheet}"`);
    return r.rows[Number(m[2]) - 1]?.[0] ?? null;
  } finally {
    await file.dispose();
  }
}

function rowValuesOf(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((c, i) => (out[c] = row[i]));
  return out;
}

/* ------------------------------------------------------------ row-map helpers */

test('row-map helpers agree with a brute-force expansion over random maps', () => {
  let seed = 538030117;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let trial = 0; trial < 500; trial++) {
    const spans: RowSpan[] = [];
    let row = rand(5);
    for (let k = rand(8); k > 0; k--) {
      const len = 1 + rand(6);
      spans.push({ start: row, end: row + len });
      row += len + 1 + rand(4);
    }
    assert.ok(validSpans(spans));
    const rows = spans.flatMap((s) => Array.from({ length: s.end - s.start }, (_, i) => s.start + i));
    assert.equal(spanRowCount(spans), rows.length);
    rows.forEach((r, slot) => {
      assert.equal(gridRowOfSlot(spans, slot), r);
      assert.equal(slotOfGridRow(spans, r), slot);
    });
    assert.equal(gridRowOfSlot(spans, rows.length), undefined);
    assert.equal(gridRowOfSlot(spans, -1), undefined);
    for (let r = 0; r <= row + 2; r++) {
      if (!rows.includes(r)) assert.equal(slotOfGridRow(spans, r), -1);
      assert.equal(slotsBefore(spans, r), rows.filter((x) => x < r).length);
    }
  }
});

test('row-map validation rejects overlapping, unordered, empty and non-integer spans', () => {
  assert.equal(validSpans([{ start: 2, end: 4 }, { start: 3, end: 5 }]), false);
  assert.equal(validSpans([{ start: 4, end: 5 }, { start: 1, end: 2 }]), false);
  assert.equal(validSpans([{ start: 1, end: 1 }]), false);
  assert.equal(validSpans([{ start: 0.5, end: 2 }]), false);
  assert.equal(validSpans('nope'), false);
  assert.equal(validSpans([]), true);
  // A description restored from older state falls back to the rectangle.
  assert.deepEqual(tableDataRows({ top: 0, bottom: 4, headerRow: 0 }), [{ start: 1, end: 4 }]);
  assert.deepEqual(tableDataRows({ top: 0, bottom: 1, headerRow: 0 }), []);
});

/* ------------------------------------------------- conservative merging */

test('a repeated header in other columns is NOT merged into the table above', () => {
  const grid: Cell[][] = [
    ['Name', 'Value', null, null],
    ['Alice', '1', null, null],
    [null, null, null, null],
    [null, null, 'Name', 'Value'],
    [null, null, 'Bob', '2'],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 2, 'blocks in different columns were fused into one rectangle');
  assert.deepEqual(tables.map((t) => [t.region.left, t.dataRows]), [
    [0, [{ start: 1, end: 2 }]],
    [2, [{ start: 4, end: 5 }]],
  ]);
});

test('a block with a caption above its repeated header is not merged (the caption is not data)', () => {
  const grid: Cell[][] = [
    ['Name', 'Value'],
    ['Alice', '1'],
    [],
    ['Second half'],
    ['Name', 'Value'],
    ['Bob', '2'],
  ];
  for (const t of detectTables(grid)) {
    for (const s of t.dataRows) for (let r = s.start; r < s.end; r++) assert.notEqual(grid[r][0], 'Second half');
  }
});

test('a footnote between two same-header blocks keeps them apart', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
    [],
    ['Source: TCMB'],
    [],
    ['Date', 'v'],
    ['2021', 2],
  ];
  const tables = detectTables(grid);
  assert.ok(tables.every((t) => !t.dataRows.some((s) => s.start <= 3 && 3 < s.end)), 'the footnote row became data');
  assert.ok(tables.every((t) => !(t.region.top <= 3 && 3 < t.region.bottom)), 'the footnote was swept into a table');
});

test('explicit split keeps a repeated-header block separate; explicit merge joins a differently-labelled one', () => {
  const repeated: Cell[][] = [['Name', 'Value'], ['Alice', '1'], [], ['Name', 'Value'], ['Bob', '2']];
  const split = detectTables(repeated, { corrections: { split: [3] } });
  assert.deepEqual(split.map((t) => t.dataRows), [[{ start: 1, end: 2 }], [{ start: 4, end: 5 }]]);

  const relabelled: Cell[][] = [['Name', 'Value'], ['Alice', '1'], [], ['Name', 'Value (cont.)'], ['Bob', '2']];
  assert.equal(detectTables(relabelled).length, 2, 'different headers merged without a correction');
  const merged = detectTables(relabelled, { corrections: { merge: [3] } });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].dataRows, [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
  assert.deepEqual(merged[0].excludedRows, [{ row: 2, reason: 'blank' }, { row: 3, reason: 'header' }]);
  assert.equal(merged[0].rowCount, 2);

  // A merge that would need a wider rectangle is ignored, not half-applied.
  const shifted: Cell[][] = [['Name', 'Value', null], ['Alice', '1', null], [], [null, 'Name', 'Value'], [null, 'Bob', '2']];
  assert.equal(detectTables(shifted, { corrections: { merge: [3] } }).length, 2);
});

test('stress: many repeated-header blocks give an exact map in one pass', () => {
  const grid: Cell[][] = [['Name', 'Value']];
  const want: [string, string][] = [];
  for (let b = 0; b < 400; b++) {
    for (let i = 0; i < 1 + (b % 5); i++) {
      const row: [string, string] = [`n${b}-${i}`, String(b * 10 + i)];
      grid.push(row);
      want.push(row);
    }
    for (let g = 0; g < 1 + (b % 3); g++) grid.push([]);
    grid.push(['Name', 'Value']);
  }
  grid.push(['last', '9']);
  want.push(['last', '9']);
  const started = performance.now();
  const [t, ...rest] = detectTables(grid);
  const ms = performance.now() - started;
  assert.equal(rest.length, 0);
  assert.equal(t.rowCount, want.length);
  const got = t.dataRows.flatMap((s) => grid.slice(s.start, s.end));
  assert.deepEqual(got, want);
  assert.equal(t.rowCount + t.excludedRows.length, t.region.bottom - t.region.top - 1);
  assert.ok(ms < 2000, `detector took ${ms} ms`);
});

/* ---------------------------------------------- the reproduced real fixture */

test('repeated.xlsx: exactly A/1, B/2 and count 2 in metadata, SQL, count, stats and plot inputs', async () => {
  const path = fixturePath('repeated');
  const before = sha256File(path);
  const want = TRUTH.fixtures.repeated.tables[0].rows;
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    await file.runQuery('select * from "Sheet" limit 1');
    const [t] = file.getDetectedSheetTables('Sheet');
    assert.equal(t.rowCount, 2);
    assert.deepEqual(t.dataRows, [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
    assert.deepEqual(t.excludedRows.map((e) => [e.row + 1, e.reason]), [[3, 'blank'], [4, 'header']]);
    assert.deepEqual(t.columnStatsKind, ['other', 'numeric']);

    const all = await file.runQuery(`select * from "${t.name}"`);
    assert.deepEqual(all.rows.map((r) => r.map(normalise)), want);
    assert.deepEqual(all.columnStatsKind, ['other', 'numeric']);
    const count = await file.runQuery(`select count(*) from "${t.name}"`);
    assert.equal(Number(count.rows[0][0]), 2);

    const inline = await file.runDetectedTableQuery(t.name, [], { column: 'Value', direction: 'desc' });
    assert.equal(inline.totalRows, 2);
    assert.deepEqual(inline.rows.map((r) => r.map(normalise)), [['Bob', 2], ['Alice', 1]]);

    const stats = await file.getColumnDescriptiveStats(inline.sql, 'Value', 'numeric');
    assert.deepEqual([stats.totalRows, stats.nonNullRows, stats.nullCount], [2, 2, 0]);
    assert.equal(Number(stats.min), 1);
    assert.equal(Number(stats.max), 2);

    const chart = await file.runChartQuery(`select * from "${t.name}"`, 'Name', ['Value'], true, 0, true);
    assert.deepEqual(chart.rows.map((r) => [r[0], Number(r[1])]).sort(), [['Alice', 1], ['Bob', 2]]);
  } finally {
    await file.dispose();
  }
  assert.equal(sha256File(path), before);
});

/* ------------------------------------------------------------------- edits */

test('sort then edit through the derived table updates the intended original cell (in-process)', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'repeated.xlsx');
    copyFileSync(fixturePath('repeated'), path);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      const sorted = await file.runDetectedTableQuery(t.name, [], { column: 'Value', direction: 'desc' });
      assert.equal(sorted.rows[0][0], 'Bob');
      // Row 0 of the SORTED result is Bob, which lives on sheet row 5.
      assert.equal(await file.updateCell(t.name, 'Value', 7, rowValuesOf(sorted.columns, sorted.rows[0])), 1);
      const filtered = await file.runDetectedTableQuery(t.name, [{ column: 'Name', operator: 'equals', value: 'Alice' }]);
      assert.equal(await file.updateCell(t.name, 'Name', 'Alicia', rowValuesOf(filtered.columns, filtered.rows[0])), 1);
    } finally {
      await file.dispose();
    }
    assert.equal(await rawCell(path, 'Sheet', 'B5'), '7');
    assert.equal(await rawCell(path, 'Sheet', 'A2'), 'Alicia');
    // Structure rows and the other cells are untouched.
    assert.equal(await rawCell(path, 'Sheet', 'B2'), '1');
    assert.equal(await rawCell(path, 'Sheet', 'A3'), null);
    assert.equal(await rawCell(path, 'Sheet', 'A4'), 'Name');
    assert.equal(await rawCell(path, 'Sheet', 'B4'), 'Value');
    assert.equal(await rawCell(path, 'Sheet', 'A5'), 'Bob');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sort then edit through the read worker and host writer (ViewerFile) lands on the original cell', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'repeated.xlsx');
    copyFileSync(fixturePath('repeated'), path);
    const file = await ViewerFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      assert.deepEqual(t.dataRows, [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
      const sorted = await file.runQuery(`select * from "${t.name}" order by "Value" desc`);
      assert.equal(await file.updateCell(t.name, 'Value', 8, rowValuesOf(sorted.columns, sorted.rows[0])), 1);
      const after = await file.runQuery(`select * from "${t.name}"`);
      assert.deepEqual(after.rows.map((r) => r.map(normalise)), [['Alice', 1], ['Bob', 8]]);
    } finally {
      file.dispose();
    }
    assert.equal(await rawCell(path, 'Sheet', 'B5'), '8');
    assert.equal(await rawCell(path, 'Sheet', 'B4'), 'Value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edit whose row has no mapped sheet row is refused and the workbook is unchanged', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'repeated.xlsx');
    copyFileSync(fixturePath('repeated'), path);
    const before = sha256File(path);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      const rows = await file.runQuery(`select * from "${t.name}"`);
      // White-box: the map loses its second span, so Bob's row has no source row.
      (file as unknown as { viewSources: Map<string, { tableOrigin: { dataRows: RowSpan[] } }> })
        .viewSources.get(t.name)!.tableOrigin.dataRows = [{ start: 1, end: 2 }];
      await assert.rejects(
        file.updateCell(t.name, 'Value', 9, rowValuesOf(rows.columns, rows.rows[1])),
        /no exact cell/
      );
    } finally {
      await file.dispose();
    }
    assert.equal(sha256File(path), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('identical logical rows across a repeated header are ambiguous: the edit is refused', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'dupes.xlsx');
    await xlsxFile(path, [{ name: 'Sheet', rows: [['Name', 'Value'], ['Same', 1], [], ['Name', 'Value'], ['Same', 1]] }]);
    const before = sha256File(path);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      assert.equal(t.rowCount, 2);
      const rows = await file.runQuery(`select * from "${t.name}"`);
      assert.equal(rows.rows.length, 2);
      await assert.rejects(file.updateCell(t.name, 'Value', 5, rowValuesOf(rows.columns, rows.rows[0])), /identical/);
    } finally {
      await file.dispose();
    }
    assert.equal(sha256File(path), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- failed numeric coercion */

test('failed text recovery refuses repeated queries and edits; retry preserves text and the source', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'mixed.xlsx');
    copyFileSync(fixturePath('mixed-value'), path);
    const before = sha256File(path);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      // Inject the I/O failure at the actual text replacement boundary.
      const connection = (file as unknown as { connection: DuckDBConnection }).connection;
      const run = connection.run.bind(connection);
      connection.run = async (sql, ...args) => {
        if (sql.includes('positional join')) throw new Error('injected text reread failure');
        return run(sql, ...args);
      };
      try {
        for (let i = 0; i < 2; i++) {
          await assert.rejects(file.runQuery(`select * from "${t.name}"`), /could not be kept as text/);
        }
        await assert.rejects(file.updateCell(t.name, 'Value', 'x', { Name: 'Bob', Value: null }), /Refusing to overwrite a cell/);
        assert.equal(sha256File(path), before);
        const raw = await file.runQuery('select * from "Sheet"');
        assert.equal(raw.rows[2][1], 'not numeric');
      } finally {
        connection.run = run;
      }
      const recovered = await file.runQuery(`select * from "${t.name}"`);
      assert.deepEqual(recovered.rows, [['Alice', '1'], ['Bob', 'not numeric'], ['Clara', '3']]);
      assert.equal(sha256File(path), before);
    } finally {
      await file.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source-row internal name does not collide with a case-variant workbook header', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'collision.xlsx');
    await xlsxFile(path, [{ name: 'Sheet', rows: [
      ['__DFV_SOURCE_ROW', 'Value'], ['Alice', 1], [], ['__DFV_SOURCE_ROW', 'Value'], ['Bob', 2],
    ] }]);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      const result = await file.runQuery(`select * from "${t.name}"`);
      assert.deepEqual(result.columns, ['__DFV_SOURCE_ROW', 'Value']);
      assert.deepEqual(result.rows.map((r) => [r[0], Number(r[1])]), [['Alice', 1], ['Bob', 2]]);
    } finally {
      await file.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-value.xlsx: SQL, filters, stats and plot inputs keep "not numeric"; its exact edit lands on B3', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'mixed.xlsx');
    copyFileSync(fixturePath('mixed-value'), path);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      assert.deepEqual(t.columnStatsKind, ['other', 'other'], 'a column holding text was offered numeric controls');
      const all = await file.runQuery(`select * from "${t.name}"`);
      assert.deepEqual(all.rows, [['Alice', '1'], ['Bob', 'not numeric'], ['Clara', '3']]);
      assert.equal(all.columnStatsKind[1], 'other');
      const warnings = file.takeLateWarnings();
      assert.equal(warnings.filter((w) => w.includes('"Value"') && w.includes('B3 "not numeric"')).length, 1, JSON.stringify(warnings));

      const bob = await file.runDetectedTableQuery(t.name, [{ column: 'Value', operator: 'contains', value: 'not' }]);
      assert.deepEqual(bob.rows, [['Bob', 'not numeric']]);
      const nulls = await file.runQuery(`select count(*) from "${t.name}" where "Value" is null`);
      assert.equal(Number(nulls.rows[0][0]), 0, 'a value became NULL');
      // Plot input: the chart reads the same derived rows, so Bob's text is in
      // its input rather than a silently dropped NULL point.
      const chart = await file.runChartQuery(`select * from "${t.name}"`, 'Name', ['Value'], true, 0, true);
      assert.deepEqual(chart.rows.map((r) => r[0]).sort(), ['Alice', 'Bob', 'Clara']);
      assert.deepEqual(chart.rows.find((r) => r[0] === 'Bob')?.[1], 'not numeric');

      // The NULL the old reading showed matches no row, so nothing is written;
      // the exact text is what identifies the cell.
      const unchanged = sha256File(path);
      assert.equal(await file.updateCell(t.name, 'Value', 'x', { Name: 'Bob', Value: null }), 0);
      assert.equal(sha256File(path), unchanged);
      assert.equal(await file.updateCell(t.name, 'Value', '2', { Name: 'Bob', Value: 'not numeric' }), 1);
    } finally {
      await file.dispose();
    }
    assert.equal(await rawCell(path, 'Sheet', 'B3'), '2');
    assert.equal(await rawCell(path, 'Sheet', 'B2'), '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a numeric column without text stays numeric and warns nothing (no false alarms)', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'clean.xlsx');
    await xlsxFile(path, [{ name: 'Sheet', rows: [['Name', 'Value'], ['a', 1], ['b', '#N/A'], ['c', 3]] }]);
    const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      file.takeLateWarnings();
      const [t] = file.getDetectedSheetTables('Sheet');
      const r = await file.runQuery(`select * from "${t.name}"`);
      assert.equal(r.columnStatsKind[1], 'numeric');
      assert.deepEqual(r.rows.map((x) => (x[1] === null ? null : Number(x[1]))), [1, null, 3]);
      assert.ok(!file.takeLateWarnings().some((w) => w.includes('shown as text')));
    } finally {
      await file.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stress: a 3,000-row table with repeated headers and scattered text keeps every value and every row', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'big.xlsx');
    const rows: unknown[][] = [['Name', 'Value', 'When']];
    const want: [string, string | number][] = [];
    for (let i = 0; i < 3000; i++) {
      const value: string | number = i % 997 === 5 ? `note ${i}` : i;
      rows.push([`n${i}`, value, `2024-01-${String((i % 28) + 1).padStart(2, '0')}`]);
      want.push([`n${i}`, value]);
      if (i % 250 === 249 && i < 2999) rows.push([], ['Name', 'Value', 'When']);
    }
    await xlsxFile(path, [{ name: 'Sheet', rows }]);
    const file = await DuckDbFile.open(path);
    try {
      await file.runQuery('select * from "Sheet" limit 1');
      const [t] = file.getDetectedSheetTables('Sheet');
      assert.equal(t.rowCount, 3000);
      assert.equal(t.excludedRows.length, 2 * 11);
      const r = await file.runQuery(`select "Name", "Value" from "${t.name}"`);
      assert.equal(r.rows.length, 3000);
      r.rows.forEach((row, i) => {
        assert.equal(row[0], want[i][0]);
        assert.equal(String(row[1]), String(want[i][1]), `row ${i}`);
      });
      const warnings = file.takeLateWarnings();
      assert.ok(warnings.some((w) => w.includes('"Value"') && /holds 4 values/.test(w)), JSON.stringify(warnings));

      // Sorted edits on rows from different blocks each land on their own cell.
      for (const target of [0, 249, 250, 1999, 2999]) {
        const sorted = await file.runQuery(`select * from "${t.name}" order by "Name" desc`);
        const index = sorted.rows.findIndex((x) => x[0] === `n${target}`);
        assert.equal(await file.updateCell(t.name, 'When', `edited-${target}`, rowValuesOf(sorted.columns, sorted.rows[index])), 1);
      }
      const check = await file.runQuery(`select "Name", "When" from "${t.name}" where "When" like 'edited-%'`);
      assert.deepEqual(check.rows.map((x) => x[0]).sort(), ['n0', 'n1999', 'n249', 'n250', 'n2999']);
      for (const row of check.rows) assert.equal(row[1], `edited-${String(row[0]).slice(1)}`);
    } finally {
      await file.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
