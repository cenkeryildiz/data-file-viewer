// Runs the TypeScript reference (src/xlsxWrite.ts patchCell) over hand-built and openpyxl workbooks.
// usage (bundled by run.py): node oracle.js <corpus-dir> <out-dir>
// Writes <corpus-dir>/*.xlsx + cases-ts.json, then <out-dir>/<id>.xlsx and <out-dir>/results.json.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough, zipSync, strToU8 } from 'fflate';
import { patchCell } from '../../../../src/xlsxWrite';

const [corpus, outDir] = process.argv.slice(2);
type Tag = { t: string; v?: unknown };
const V = {
  null: { t: 'null' } as Tag,
  bool: (v: boolean): Tag => ({ t: 'bool', v }),
  num: (v: number | string): Tag => ({ t: 'num', v: String(v) }),
  big: (v: string): Tag => ({ t: 'big', v }),
  str: (v: string): Tag => ({ t: 'str', v }),
};
const fromTag = (t: Tag): unknown => {
  switch (t.t) {
    case 'null': return null;
    case 'bool': return t.v;
    case 'num': return Number(t.v);
    case 'big': return BigInt(t.v as string);
    default: return t.v;
  }
};

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const wbXml = (extra = '', pr = '') => `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pr}<sheets><sheet name="data" sheetId="1" r:id="rId1"/><sheet name="notes" sheetId="2" r:id="rId2"/></sheets>${extra}</workbook>`;
const WB_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
const SST = `<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="7" uniqueCount="7"><si><t>name</t></si><si><t>qty</t></si><si><t>total</t></si><si><t>widget &amp; co</t></si><si><r><t>bo</t></r><r><rPr><b/></rPr><t>lt</t></r></si><si><t xml:space="preserve"> a&#x41;&#66;&lt;b </t></si><si><t>when</t></si></sst>`;
const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr/><dimension ref="B1:D5"/><sheetData>
<row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
<row r="2"><c r="B2" t="s"><v>3</v></c><c r="C2" s="4"><v>2</v></c><c r="D2" s="7"><v>5.5</v></c></row>
<row r="3"><c r="B3" t="s"><v>4</v></c><c r="C3" s="4"><v>10</v></c><c r="D3" s="7"><f t="shared" ref="D3:D4" si="0">C3*2</f><v>20</v></c></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>nut &amp; &lt;bolt&gt;</t></is></c><c r="C4" s="4"><v>7</v></c></row>
<row r="5"><c r="B5" t="s"><v>5</v></c><c r="C5"><v>9007199254740993</v></c><c r="E5" t="b"><v>1</v></c></row>
<row r="6" spans="1:1"/>
<row r="8"><c r="B8" t="str"><f>B2&amp;"x"</f><v>widget &amp; cox</v></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells><hyperlinks><hyperlink ref="B2" r:id="rId9"/></hyperlinks><pageMargins left="0.7"/></worksheet>`;
const SHEET2 = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>keep me</t></is></c></row></sheetData></worksheet>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="[h]:mm:ss"/><numFmt numFmtId="166" formatCode="&quot;d&quot;0"/></numFmts><cellXfs count="8"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="4"/><xf numFmtId="1"/><xf numFmtId="2"/></cellXfs></styleSheet>`;
const DATES = (s = 1) => `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>when</t></is></c><c r="C1" t="inlineStr"><is><t>dt</t></is></c><c r="D1" t="inlineStr"><is><t>dur</t></is></c><c r="E1" t="inlineStr"><is><t>dd</t></is></c><c r="F1" t="inlineStr"><is><t>num</t></is></c></row>
<row r="2"><c r="A2"><v>1</v></c><c r="B2" s="${s}"><v>46085</v></c><c r="C2" s="2"><v>46085.5</v></c><c r="D2" s="3"><v>0.25</v></c><c r="E2" s="4"><v>5</v></c><c r="F2" s="5"><v>3.5</v></c></row>
</sheetData></worksheet>`;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function parts(sheet1: string, over: Record<string, string | Uint8Array> = {}): Record<string, Uint8Array | [Uint8Array, { level: 0 }]> {
  const text: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': CT, '_rels/.rels': ROOT_RELS,
    'xl/workbook.xml': wbXml('<definedNames><definedName name="Qty">data!$C$2:$C$4</definedName></definedNames>'),
    'xl/_rels/workbook.xml.rels': WB_RELS, 'xl/sharedStrings.xml': SST, 'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': SHEET2,
    'xl/worksheets/_rels/sheet1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`,
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="x"><x>ü</x></cp:coreProperties>',
    ...over,
  };
  const out: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  for (const [k, v] of Object.entries(text)) out[k] = typeof v === 'string' ? strToU8(v) : v;
  out['xl/media/image1.png'] = [PNG, { level: 0 }]; // stored member
  out['xl/ünï.xml'] = strToU8('<u>é</u>'); // non-ASCII name
  return out;
}
const withComment = (zip: Uint8Array, comment: string): Uint8Array => {
  const c = strToU8(comment), out = new Uint8Array(zip.length + c.length);
  out.set(zip); out.set(c, zip.length);
  new DataView(out.buffer).setUint16(zip.length - 22 + 20, c.length, true);
  return out;
};
function streamed(files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => { if (err) throw err; chunks.push(data); });
  for (const [name, v] of Object.entries(files)) {
    const [data, stored] = Array.isArray(v) ? [v[0], true] : [v, false];
    const f = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(f); f.push(data, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

const books: Record<string, Uint8Array> = {
  'ts_main.xlsx': zipSync(parts(SHEET1)),
  'ts_comment.xlsx': withComment(zipSync(parts(SHEET1)), 'archive comment ü'),
  'ts_streamed.xlsx': streamed(parts(SHEET1)),
  'ts_dates.xlsx': zipSync(parts(DATES(1), { 'xl/workbook.xml': wbXml('', '<workbookPr defaultThemeVersion="1"/>') })),
  'ts_dates1904.xlsx': zipSync(parts(DATES(1), { 'xl/workbook.xml': wbXml('', '<workbookPr date1904="1"/>') })),
  'ts_nostyles.xlsx': (() => { const p = parts(DATES(1)); delete p['xl/styles.xml']; return zipSync(p); })(),
  'ts_junk_sheet.xlsx': zipSync(parts(SHEET1.replace('<sheetData>', '<sheetData>\n<row r="1"><c r="A1" t="inlineStr"><is><t>title row</t></is></c></row>'))),
};
const S1 = 'xl/worksheets/sheet1.xml';
const cases: unknown[] = [];
const hdr = ['name', 'qty', 'total'];
// header-mode request (rowOrdinal counts from below the header); column letters come from the header text
const h = (book: string, id: string, column: string, row: number, cur: Tag, nv: Tag, extra: Record<string, unknown> = {}, names: string[] = hdr) =>
  cases.push({ id, workbook: book, request: { sheetPath: S1, columnName: column, columnNames: names, rowOrdinal: row, verbatim: false, expectedCurrent: cur, newValue: nv, ...extra } });
const vb = (book: string, id: string, column: string, row: number, cur: Tag, nv: Tag, extra: Record<string, unknown> = {}) =>
  cases.push({ id, workbook: book, request: { sheetPath: S1, columnName: column, columnNames: [], rowOrdinal: row, verbatim: true, expectedCurrent: cur, newValue: nv, ...extra } });

const M = 'ts_main.xlsx';
h(M, 'main-number-by-header', 'qty', 1, V.num(2), V.num(99));
h(M, 'main-style-survives', 'total', 1, V.num(5.5), V.num(6.25));
h(M, 'main-integer-stays-integer', 'qty', 2, V.num(10), V.num(11));
h(M, 'main-integer-as-text-number', 'qty', 2, V.str('10'), V.str('12'));
h(M, 'main-string-escaped', 'name', 1, V.str('widget & co'), V.str('a<b & "c" > d'));
h(M, 'main-string-dollar-divergence', 'name', 1, V.str('widget & co'), V.str('price $& $1 $$'));
h(M, 'main-text-numeric-stays-text', 'name', 1, V.str('widget & co'), V.str('0009'));
h(M, 'main-numeric-text-into-number', 'qty', 1, V.num(2), V.str('12.50'));
h(M, 'main-numeric-expo', 'qty', 1, V.num(2), V.str('1e3'));
h(M, 'main-insert-missing-cell', 'total', 3, V.null, V.num(3));
h(M, 'main-insert-before', 'name', 3, V.str('nut & <bolt>'), V.str('nuts'));
h(M, 'main-rich-text-cell', 'name', 2, V.str('bolt'), V.str('screw'));
h(M, 'main-entities-cell', 'name', 4, V.str(' aA' + 'B<b '), V.str('plain'));
h(M, 'main-big-integer-exact', 'qty', 4, V.big('9007199254740993'), V.big('9007199254740995'));
h(M, 'main-big-integer-as-number-refused', 'qty', 4, V.num(9007199254740992), V.num(1));
h(M, 'main-disagree', 'qty', 1, V.num(3), V.num(1));
h(M, 'main-disagree-null', 'qty', 1, V.null, V.num(1));
h(M, 'main-past-end', 'qty', 9, V.null, V.num(1));
h(M, 'main-row-zero', 'qty', 0, V.num(2), V.num(1));
h(M, 'main-no-header', 'qty', 1, V.num(2), V.num(1), {}, ['name', 'nope']);
h(M, 'main-no-such-column', 'zzz', 1, V.num(2), V.num(1), {}, ['name']);
h(M, 'main-formula-refused', 'total', 2, V.num(20), V.num(1));
vb(M, 'main-vb-formula-str-refused', 'B', 8, V.str('widget & cox'), V.str('x'));
vb(M, 'main-vb-number', 'C', 2, V.num(2), V.num(-0.5));
vb(M, 'main-vb-bool', 'E', 5, V.bool(true), V.bool(false));
vb(M, 'main-vb-bool-text', 'E', 5, V.str('true'), V.str('yes'));
vb(M, 'main-vb-null-clears', 'C', 2, V.num(2), V.null);
vb(M, 'main-vb-empty-string-clears', 'C', 2, V.num(2), V.str(''));
vb(M, 'main-vb-number-1e21', 'C', 2, V.num(2), V.num(1e21));
vb(M, 'main-vb-number-tiny', 'C', 2, V.num(2), V.num(1e-7));
vb(M, 'main-vb-number-sum', 'C', 2, V.num(2), V.num(0.1 + 0.2));
vb(M, 'main-vb-number-neg-exp', 'C', 2, V.num(2), V.num(-1.5e-10));
vb(M, 'main-vb-nan-text', 'C', 2, V.num(2), V.num('NaN'));
vb(M, 'main-vb-inf-text', 'C', 2, V.num(2), V.num('Infinity'));
vb(M, 'main-vb-bigint', 'C', 2, V.num(2), V.big('123456789012345678901234567890'));
vb(M, 'main-vb-lowercase-column', 'c', 2, V.num(2), V.num(1));
vb(M, 'main-vb-empty-row-self-closing', 'A', 6, V.null, V.num(1));
vb(M, 'main-vb-row-missing', 'A', 7, V.null, V.num(1));
vb(M, 'main-vb-new-far-column', 'ZZ', 2, V.null, V.str('far'));
vb(M, 'main-vb-sha-wrong', 'C', 2, V.num(2), V.num(1), { expectedSha256: 'f'.repeat(64) });
vb(M, 'main-other-sheet-path-missing', 'C', 2, V.num(2), V.num(1));
(cases[cases.length - 1] as { request: { sheetPath: string } }).request.sheetPath = 'xl/worksheets/sheet9.xml';
vb('ts_comment.xlsx', 'comment-archive', 'C', 2, V.num(2), V.num(77));
vb('ts_streamed.xlsx', 'streamed-archive', 'C', 2, V.num(2), V.num(77));
vb('ts_junk_sheet.xlsx', 'junk-row-verbatim', 'B', 3, V.str('widget & co'), V.str('w'));
h('ts_junk_sheet.xlsx', 'junk-row-header-found', 'qty', 1, V.num(2), V.num(5));
const D = 'ts_dates.xlsx', dnames = ['id', 'when', 'dt', 'dur', 'dd', 'num'];
for (const [book, tag] of [[D, 'd1900'], ['ts_dates1904.xlsx', 'd1904']] as const) {
  const expectWhen = book === D ? '2026-03-04' : '2026-03-04';
  h(book, `${tag}-date-matches-iso`, 'when', 1, V.str(expectWhen), V.str('2026-05-06'), {}, dnames);
  h(book, `${tag}-date-matches-serial`, 'when', 1, V.num(46085), V.str('2026-05-06'), {}, dnames);
  h(book, `${tag}-date-wrong-expected`, 'when', 1, V.str('2026-03-05'), V.str('2026-05-06'), {}, dnames);
  h(book, `${tag}-datetime`, 'dt', 1, V.str('2026-03-04 12:00:00'), V.str('2026-03-04T13:30:15'), {}, dnames);
  h(book, `${tag}-datetime-fraction`, 'dt', 1, V.str('2026-03-04 12:00:00'), V.str('2026-03-04 13:30:15.5'), {}, dnames);
  h(book, `${tag}-time`, 'dur', 1, V.str('06:00:00'), V.str('07:30'), {}, dnames);
  h(book, `${tag}-date-nonexistent`, 'when', 1, V.str('2026-03-04'), V.str('2026-02-30'), {}, dnames);
  h(book, `${tag}-date-garbage`, 'when', 1, V.str('2026-03-04'), V.str('garbage'), {}, dnames);
  h(book, `${tag}-date-serial-text`, 'when', 1, V.str('2026-03-04'), V.str('46100'), {}, dnames);
  h(book, `${tag}-date-1900-leap-bug`, 'when', 1, V.str('2026-03-04'), V.str('1900-02-28'), {}, dnames);
  h(book, `${tag}-date-1900-mar1`, 'when', 1, V.str('2026-03-04'), V.str('1900-03-01'), {}, dnames);
  h(book, `${tag}-date-leap-day`, 'when', 1, V.str('2026-03-04'), V.str('2024-02-29'), {}, dnames);
  h(book, `${tag}-date-not-leap`, 'when', 1, V.str('2026-03-04'), V.str('2023-02-29'), {}, dnames);
  h(book, `${tag}-quoted-format-not-date`, 'dd', 1, V.num(5), V.str('2026-05-06'), {}, dnames);
  h(book, `${tag}-builtin-number-not-date`, 'num', 1, V.num(3.5), V.str('2026-05-06'), {}, dnames);
  h(book, `${tag}-builtin-number-text`, 'num', 1, V.num(3.5), V.str('4.25'), {}, dnames);
}
h('ts_nostyles.xlsx', 'nostyles-number', 'qty', 1, V.num(1), V.num(2), {}, ['id', 'when']);
vb('ts_nostyles.xlsx', 'nostyles-vb', 'B', 2, V.num(46085), V.str('2026-05-06'));

const pyCases: unknown[] = JSON.parse(await readFile(join(corpus, 'cases-openpyxl.json'), 'utf8'));
await mkdir(corpus, { recursive: true });
for (const [n, b] of Object.entries(books)) await writeFile(join(corpus, n), b);
await writeFile(join(corpus, 'cases-ts.json'), JSON.stringify(cases, null, 1));
await mkdir(outDir, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'xlsx-oracle-'));
const results: Record<string, unknown> = {};
for (const cs of [...cases, ...pyCases] as { id: string; workbook: string; request: Record<string, unknown> }[]) {
  const file = join(work, cs.id + '.xlsx');
  await copyFile(join(corpus, cs.workbook), file);
  const r = cs.request;
  try {
    await patchCell({
      filePath: file, sheetPath: r.sheetPath as string, columnName: r.columnName as string, columnNames: r.columnNames as string[],
      rowOrdinal: r.rowOrdinal as number, verbatim: r.verbatim as boolean, expectedSha256: r.expectedSha256 as string | undefined,
      expectedCurrent: fromTag(r.expectedCurrent as Tag), newValue: fromTag(r.newValue as Tag),
    });
    await copyFile(file, join(outDir, cs.id + '.xlsx'));
    results[cs.id] = { ok: true };
  } catch (e) {
    results[cs.id] = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
await writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
await rm(work, { recursive: true, force: true });
console.log(JSON.stringify({ cases: Object.keys(results).length, ok: Object.values(results).filter((x) => (x as { ok: boolean }).ok).length }));
