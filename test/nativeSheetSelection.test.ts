import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeDocument } from '../src/backend/nativeDocument';
import { xlsxFile } from './stress/generators/_write';
import { SchemaSet } from './migration/schemaSubset';

test('actual native selection discovers only its worksheet and atomically refreshes metadata', async () => {
  const worker = process.env.DFV_TABLE_WORKER;
  assert.ok(worker && fs.existsSync(worker), 'DFV_TABLE_WORKER must name the actual worker');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-sheet-selection-'));
  const source = path.join(dir, 'book.xlsx');
  await xlsxFile(source, ['A', 'B'].map(name => ({name, rows: [['id','value'],[1,2],[3,4]]})));
  const original = fs.readFileSync(source);
  const doc = await NativeDocument.open({executable: worker}, source);
  const schemas = new SchemaSet(path.join(process.cwd(), 'test/migration/schema'));
  const checkTables = () => {
    for (const table of doc.getDetectedSheetTables('A')) {
      const wire = Object.fromEntries(Object.entries(table).map(([key, value]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), key === 'rowCount' ? String(value) : value]));
      assert.deepEqual(schemas.validate(wire, 'read-metadata.v1.schema.json', '/$defs/detectedTable'), []);
    }
  };
  try {
    assert.deepEqual(doc.listSheetPreparation().map(s => s.state), ['pending','pending']);
    assert.deepEqual(doc.getDetectedSheetTables('A'), []);
    await doc.runQuery('select count(*) from A cross join B');
    await doc.getQueryCatalog();
    assert.deepEqual(doc.listSheetPreparation().map(s => s.state), ['pending','pending']);
    await doc.runQuery('select * from A', 0, 'A');
    assert.equal(doc.getSheetPreparation('A')?.state, 'ready');
    assert.equal(doc.getSheetPreparation('B')?.state, 'pending');
    assert.equal(doc.getDetectedSheetTables('A').length, 1);
    checkTables();
    await doc.runQuery('select * from B', 0, 'B');
    assert.equal(doc.getSheetPreparation('B')?.state, 'ready');
    assert.equal(doc.hasPendingSheets(), false);
    const cached = doc.getDetectedSheetTables('A');
    await doc.runQuery('select * from A', 0, 'A');
    assert.deepEqual(doc.getDetectedSheetTables('A'), cached);
    await assert.rejects(doc.runQuery('select 1', 0, 'missing'));
    const corrected = await doc.retrySheetPreparation('A', [{top:0,bottom:3,left:0,right:1,headerRow:null}]);
    assert.equal(corrected?.generation, 1);
    const manual = doc.getDetectedSheetTables('A').find(t => t.provenance === 'manual');
    assert.ok(manual);
    assert.equal(manual.headerRow, null);
    assert.equal(manual.rowCount, 3);
    checkTables();
    const saved = doc.getDetectedSheetTables('A');
    await assert.rejects(doc.retrySheetPreparation('A', [{top:0,bottom:999,left:0,right:1,headerRow:null}]));
    assert.deepEqual(doc.getDetectedSheetTables('A'), saved);
    assert.equal(doc.getSheetPreparation('B')?.generation, 0);
    const reopened = await NativeDocument.open({executable:worker},source,'xlsx',{sheetTableCorrections:{A:{manualTables:[{top:0,bottom:3,left:0,right:1,headerRow:null}]}}});
    try {
      await reopened.runQuery('select * from A',0,'A');
      assert.equal(reopened.getDetectedSheetTables('A').find(t => t.provenance==='manual')?.rowCount,3);
      assert.equal(reopened.getSheetPreparation('B')?.state,'pending');
    } finally { await reopened.close(); }
    assert.deepEqual(fs.readFileSync(source), original);
  } finally { await doc.close(); fs.rmSync(dir, {recursive:true,force:true}); }
});
