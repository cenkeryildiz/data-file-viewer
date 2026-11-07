// Writes tests/fixtures/csv_differential.json: a corpus of CSV edge cases and what the REFERENCE
// (src/duckdbConnection.ts, bundled with esbuild, run headless on @duckdb/node-api) makes of each one.
// tests/csv_differential.rs replays every case through the native engine and compares; tools/csv_independent.py
// re-reads the same files with DuckDB-python/Polars/PyArrow and checks the exact values independently.
//
//   node tools/make_csv_differential.cjs <repo-root> [<out.json>]
//
// <repo-root> is the data-file-viewer checkout (it supplies src/). node_modules/ comes from <repo-root>, or from
// $DFV_NODE_MODULES when the checkout is a worktree without one. Nothing is written outside <out.json> and
// a temp directory.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(process.argv[2] || '.');
const out = path.resolve(process.argv[3] || path.join(__dirname, '../tests/fixtures/csv_differential.json'));
const modules = path.resolve(process.env.DFV_NODE_MODULES || path.join(root, 'node_modules'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-csvdiff-'));
const bundle = path.join(tmp, 'dbconn.cjs');
execFileSync(path.join(modules, '.bin/esbuild'), [
  path.join(root, 'src/duckdbConnection.ts'), '--bundle', '--platform=node', '--format=cjs',
  `--outfile=${bundle}`, '--packages=external', '--external:vscode', '--log-level=error',
]);
process.env.NODE_PATH = modules;
require('node:module').Module._initPaths();
const { DuckDbFile } = require(bundle);

const cases = [];
const add = (name, content, options = {}) =>
  cases.push({ name, bytes: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), options });

// ---- empty / degenerate -------------------------------------------------------------------------
add('empty_file', '');
add('header_only', 'a,b\n');
add('header_only_no_newline', 'a,b');
add('newline_only', '\n');
add('whitespace_only', '   \n');
add('single_column', 'a\n1\n2\n');
add('blank_lines', 'a,b\n1,2\n\n3,4\n\n');
add('only_delimiters', ',,\n,,\n');
add('empty_header_name', ',b\n1,2\n');
add('duplicate_headers', 'a,a,a\n1,2,3\n');
add('duplicate_headers_case', 'A,a\n1,2\n');
add('trailing_delimiter', 'a,b,\n1,2,\n');
add('quoted_header_names', '"a b","c""d"\n1,2\n');
add('unicode_text', 'İstanbul,σ\n1,😀\n2,ş\n');
// ---- encodings / line endings / delimiters ----------------------------------------------------------
add('bom_utf8', '﻿a,b\n1,2\n');
add('bom_turkish', '﻿a;b\n1.234,5;2\n3,25;4\n');
add('crlf', 'a,b\r\n1,2\r\n3,4\r\n');
add('cr_only', 'a,b\r1,2\r3,4\r');
add('mixed_line_endings', 'a,b\r\n1,2\n3,4\r5,6\n');
add('semicolon', 'a;b\n1;x\n2;y\n');
add('tab', 'a\tb\n1\tx\n2\ty\n');
add('pipe', 'a|b\n1|x\n2|y\n');
add('latin1_bytes', Buffer.from([0x61, 0x0a, 0xe7, 0x0a]));
add('invalid_utf8', Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]));
add('nul_byte', Buffer.from('a,b\n1,\u00002\n3,4\n', 'latin1'));
// ---- quoting -------------------------------------------------------------------------------------
add('quoted_embedded', 'a,b\n"x,y",1\n"he said ""hi""",2\n"multi\nline",3\n');
add('quoted_numbers', 'a,b\n"1","2"\n"3","4"\n');
add('quoted_turkish', 'a;b\n"1.234,56";1\n"2.000,00";2\n');
add('quoted_english_thousands', 'a,b\n"1,234.56",1\n"2,000.00",2\n');
add('quoted_empty', 'a,b\n"",1\n,2\n');
add('quote_in_unquoted', 'a,b\nx"y,1\n');
// ---- malformed -----------------------------------------------------------------------------------
add('ragged_short', 'a,b,c\n1,2,3\n4,5\n6,7,8\n');
add('ragged_long', 'a,b\n1,2\n3,4,5\n');
add('unterminated_quote', 'a,b\n1,"oops\n2,3\n');
add('stray_quote_mid_file', 'a,b\n1,2\n3,"4\n5,6\n');
// ---- mixed text / numbers ---------------------------------------------------------------------------
add('text_among_numbers', 'v\n1\ntwo\n3\n');
add('markers_in_numbers', 'v\n1.5\n#N/A\n2.5\nNA\n');
add('markers_only', 'v\n#N/A\nNA\n');
add('markers_only_blank_and_null', 'v\n#N/A\n\nNA\n');
add('markers_case_and_padding', 'v\nna\n n/a \n1\n');
add('markers_with_word', 'v\n1\nNA\nfoo\n');
add('markers_every_token', 'v\n1\n#VALUE!\n#REF!\n#DIV/0!\n#NAME?\n#NUM!\n#NULL!\n#N/A\nN/A\nNA\n');
add('leading_zero_ids', 'id\n007\n010\n123\n');
add('leading_zero_with_marker', 'id\n007\nNA\n123\n');
add('wide_bigint_clean', 'id\n9007199254740993\n9007199254740995\n42\n');
add('wide_bigint_with_zero_pad', 'id\n9007199254740993\n9007199254740995\n007\n');
add('wide_bigint_with_marker', 'id\n9007199254740993\nNA\n42\n');
add('wide_negative', 'id\n-9007199254740993\n-9007199254740995\n');
add('wide_hugeint', 'id\n12345678901234567890123\n12345678901234567890124\n');
add('wide_hugeint_with_marker', 'id\n12345678901234567890123\n#N/A\n12345678901234567890124\n');
add('wide_astronomical', 'id\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567891\n');
add('int_boundaries', 'v\n9223372036854775807\n-9223372036854775808\n');
add('past_bigint', 'v\n9223372036854775808\n1\n');
add('exactly_2_53', 'v\n9007199254740992\n9007199254740991\n');
add('mixed_int_dec_wide', 'v\n1.5\n9007199254740993\n2.25\n');
add('mixed_int_dec_wide_marker', 'v\n1.5\n9007199254740993\nNA\n');
add('decimals_with_marker', 'rate\n1.50\n2.25\n#N/A\n1e3\n');
add('exponents', 'v\n1e3\n1E-3\n2.5e10\n');
add('exponent_overflow', 'v\n1e400\n1\n');
add('exponent_underflow', 'v\n1e-400\n1\n');
add('nan_inf', 'v\nnan\ninf\n1\n');
add('percent_and_currency', 'p,c\n5%,$1.50\n6%,$2.25\n');
add('parenthesised_negatives', 'v\n"(1.234,56)"\n"1.234,56"\n');
add('plus_signs', 'v\n+1\n+2\n');
add('padded_numbers', 'v\n 1 \n 2 \n');
add('booleans', 'b\ntrue\nfalse\n');
add('dates', 'd\n2024-01-31\n2024-02-29\n');
add('dates_mixed_formats', 'd\n2024-01-31\n31/01/2024\n');
add('timestamps', 'ts\n2026-01-02 09:30:00\n2026-01-05 16:00:00\n');
add('ids_and_dates_decision_fixture',
  'id,trade_date,stamp,price,mixed,code\n12345678901234567890123,2026-01-02,2026-01-02 09:30:00,1.5,1.5,007\n12345678901234567890124,2026-01-05,2026-01-05 16:00:00,2.25,9007199254740993,010\n');
add('sniffer_controls',
  'd1,d3,b,t,n,ts\n2026-01-02,20260102,true,09:30,42,2026-01-02T09:30:00\n2026-01-15,20260115,false,16:00,-7,2026-01-15T16:00:00\n');
add('doubles_controls',
  'price,avogadro,long\n1.50,6.022e23,0.1234567890123456789\n1e3,1.5E-10,-123456.78901234567\n-0.5,3.0e8,1.25\n12.25,2e0,0.30000000000000004\n');
add('beyond_double_precision',
  'a,b,id\n966.41641389214044,-218.89959204133902,12345678901234567890123\n278.74005196960428,0.000123456789012345678,12345678901234567890124\n');
add('sixteen_digits', 'v\n1234567890123456\n0.5\n');
add('several_columns_mixed',
  'a,b,c,d\n1.5,x,007,#N/A\n2.5,y,010,3\nNA,z,123,4\n');
// ---- decimal convention ----------------------------------------------------------------------------
add('turkish_plain', 'Tarih;Deger;Oran\n2024-01-31;1.794.446,52;12,5\n2024-02-29;2.145.900,00;13,7\n');
add('turkish_with_markers', 'tutar\n1.794.446,52\n12,5\nNA\n');
add('turkish_markers_semicolon', 'tutar;n\n1.794.446,52;1\n#N/A;2\n12,5;3\n');
add('turkish_integers_with_thousands', 'v\n1.234.567\n2.345.678\n');
add('turkish_ids_wide', 'tutar;kimlik\n1.234,56;12345678901234567890123\n2.345,67;12345678901234567890124\n98,10;12345678901234567890125\n');
add('turkish_comma_only', 'v\n1,5\n2,5\nNA\n');
add('english_plain', 'Date,Value,Rate\n2024-01-31,"1,234.56",12.5\n');
add('english_thousands_markers', 'v\n"1,234.56"\n#N/A\n12.5\n');
add('ambiguous_column', 'a\n1.234\n2.345\n3.456\n');
add('ambiguous_with_markers', 'a\n1.234\nNA\n2.345\n');
add('ambiguous_forced_eu', 'a\n1.234\n2.345\n', { numberLocale: 'eu' });
add('ambiguous_forced_en', 'a\n1.234\n2.345\n', { numberLocale: 'en' });
add('forced_eu_on_english', 'a\n1,234.56\n12.5\n', { numberLocale: 'eu' });
add('forced_en_on_turkish', 'a;b\n1.234,56;1\n12,5;2\n', { numberLocale: 'en' });
add('forced_eu_on_turkish', 'a;b\n1.234,56;1\n12,5;2\n', { numberLocale: 'eu' });
add('columns_disagree', 'a;b\n1.794.446,52;"1,234.56"\n2.000,00;"2,000.00"\n');
add('strong_column_resolves_weak', 'strong;maybe\n1.794.446,52;1.234\n2.000,00;2.345\n');
add('integer_column_carries_no_convention', 'a;b\n1.794.446,52;1\n2.000,00;2\n');
// ---- nullText option ----------------------------------------------------------------------------
add('null_text_off', 'v\n1.5\n#N/A\n2.5\n', { nullText: [] });
add('null_text_custom', 'v\n1\n-\nmissing\n2\n', { nullText: ['-', 'missing'] });
add('null_text_custom_default_markers_now_words', 'v\n1\n-\nNA\n2\n', { nullText: ['-'] });
add('null_text_default_on_custom_data', 'v\n1\n-\nmissing\n2\n');
// ---- bigger inputs -------------------------------------------------------------------------------
{
  const rows = ['v'];
  for (let i = 0; i < 5000; i += 1) rows.push(`${i}.25`);
  rows.push('9007199254740993');
  add('deep_wide_value', rows.join('\n') + '\n');
}
{
  const rows = ['v'];
  for (let i = 0; i < 6000; i += 1) rows.push(`${i}.5`);
  rows.push('a written note');
  add('late_note_in_numbers', rows.join('\n') + '\n');
}
{
  const rows = ['v,w'];
  for (let i = 0; i < 3000; i += 1) rows.push(i % 7 === 0 ? 'NA,1' : `${i}.5,${i}`);
  add('markers_scattered', rows.join('\n') + '\n');
}
{
  const rows = ['v'];
  for (let i = 0; i < 3300; i += 1) rows.push('NA');
  for (let i = 0; i < 700; i += 1) rows.push(`${i}.5`);
  add('markers_head_numbers_tail', rows.join('\n') + '\n');
}
{
  const header = [];
  const row = [];
  for (let i = 0; i < 300; i += 1) {
    header.push(`c${i}`);
    row.push(i % 3 === 0 ? '1.5' : i % 3 === 1 ? 'NA' : `t${i}`);
  }
  add('wide_300_columns', header.join(',') + '\n' + row.join(',') + '\n' + row.join(',') + '\n');
}
// Expanded from `gen` on both sides rather than stored: { prefix, fill, count, suffix }.
const gen = (name, g, options = {}) =>
  cases.push({ name, gen: g, bytes: Buffer.from(g.prefix + g.fill.repeat(g.count) + g.suffix, 'utf8'), options });
gen('long_field', { prefix: 'a\n', fill: 'x', count: 200000, suffix: '\n' });
gen('line_over_default_limit', { prefix: 'a\n', fill: 'x', count: 3000000, suffix: '\n' });

// ---- run the reference ------------------------------------------------------------------------------
const cell = (v) => (v === null || v === undefined ? null : String(v));
const q = (n) => `"${n.replace(/"/g, '""')}"`;
const ROWS_INLINE = 1000;

(async () => {
  const results = [];
  for (const c of cases) {
    const file = path.join(tmp, `${c.name}.csv`);
    fs.writeFileSync(file, c.bytes);
    const entry = { name: c.name, options: c.options, ...(c.gen ? { gen: c.gen } : { hex: c.bytes.toString('hex') }) };
    let f;
    try {
      f = await DuckDbFile.open(file, undefined, { ...c.options, restrictedReads: true, forceReadOnly: true });
    } catch (e) {
      entry.ref = { error: String(e && e.message ? e.message : e).split('\n')[0] };
      results.push(entry);
      continue;
    }
    const report = f.numberLocale;
    entry.ref = {
      warnings: [...f.openWarnings],
      locale: report && { locale: report.locale, forced: report.forced, conflicting: report.conflicting, undecidable: report.undecidable },
    };
    try {
      const desc = await f.runQuery(`describe select * from ${q(c.name)}`);
      const [ni, ti] = [desc.columns.indexOf('column_name'), desc.columns.indexOf('column_type')];
      entry.ref.columns = desc.rows.map((r) => ({ name: cell(r[ni]), type: cell(r[ti]) }));
      const count = await f.runQuery(`select count(*) as n from ${q(c.name)}`);
      entry.ref.count = Number(count.rows[0][0]);
      const list = entry.ref.columns.map((x) => `cast(${q(x.name)} as varchar) as ${q(x.name)}`);
      if (entry.ref.columns.length === 0) {
        entry.ref.rows = [];
      } else if (entry.ref.count <= ROWS_INLINE) {
        const rows = await f.runQuery(`select ${list.join(', ')} from ${q(c.name)}`);
        entry.ref.rows = rows.rows.map((r) => r.map(cell));
      } else {
        const sums = entry.ref.columns.map((x) => `md5(string_agg(coalesce(cast(${q(x.name)} as varchar), '<null>'), '|')) as ${q(x.name)}`);
        const rows = await f.runQuery(`select ${sums.join(', ')} from ${q(c.name)}`);
        entry.ref.digests = rows.rows[0].map(cell);
      }
    } catch (e) {
      // Opened, but reading it fails: the failure is part of the behaviour being compared.
      entry.ref.readError = String(e && e.message ? e.message : e).split('\n')[0];
    } finally {
      f.dispose();
    }
    results.push(entry);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const inputs = ['src/duckdbConnection.ts', 'src/queryPolicy.ts', 'src/numericLocale.ts', 'src/textColumns.ts', 'src/backend/sql.ts', 'src/chartSpec.ts', 'package-lock.json'];
  const reference = { source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source_sha256: Object.fromEntries(inputs.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    bundle_sha256: createHash('sha256').update(fs.readFileSync(bundle)).digest('hex') };
  fs.writeFileSync(out, JSON.stringify({ generatedBy: 'tools/make_csv_differential.cjs', reference, cases: results }, null, 1) + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => r.ref.error || r.ref.readError).map((r) => r.name);
  console.log(`${results.length} cases -> ${out}; reference errors: ${failed.join(', ') || 'none'}`);
})();
