// Writes tests/fixtures/edit_select_differential.json: SQL strings and the table the REFERENCE's
// baseTableOfSelect (src/duckdbConnection.ts, the gate behind checkEditableSelect) names for each, or null.
// tests/edit_differential.rs replays them through the native edit::base_table_of_select.
//   node tools/make_edit_differential.cjs <repo-root> [<out.json>]    ($DFV_NODE_MODULES as in make_csv_differential.cjs)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(process.argv[2] || '.');
const out = path.resolve(process.argv[3] || path.join(__dirname, '../tests/fixtures/edit_select_differential.json'));
const modules = path.resolve(process.env.DFV_NODE_MODULES || path.join(root, 'node_modules'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dfv-editdiff-'));
const bundle = path.join(tmp, 'dbconn.cjs');
execFileSync(path.join(modules, '.bin/esbuild'), [
  path.join(root, 'src/duckdbConnection.ts'), '--bundle', '--platform=node', '--format=cjs',
  `--outfile=${bundle}`, '--packages=external', '--external:vscode', '--log-level=error',
]);
process.env.NODE_PATH = modules;
require('node:module').Module._initPaths();
const { baseTableOfSelect } = require(bundle);

const sqls = [
  'select * from t', 'SELECT * FROM T', '  select  *  from  t  ', 'select * from t;', 'select * from t ;  ',
  'select * from "My Table"', 'select * from "a""b"', 'select * from ""', 'select * from "', 'select * from "abc',
  'select * from "a"b"', 'select * from "a" "b"', 'select * from main.t', 'select * from "main"."t"', 'select * from t1', 'select * from _t',
  'select * from 1t', 'select * from é', 'select * from "é"', 'select*from t', 'select *from t', 'select* from t', 'select * from t where a=1',
  'select * from t where', 'select * from t where ', 'select * from t where  ', 'select * from t where x', 'select * from t  where  x',
  'select * from t wherex', 'select * from t where a = 1 order by a', 'select * from t order by a', 'select * from t order by',
  'select * from t order  by  a desc', 'select * from t order by a limit 5', 'select * from t limit 5', 'select * from t limit 5 offset 2',
  'select * from t limit 5 offset', 'select * from t limit x', 'select * from t limit -1', 'select * from t limit 1.5', 'select * from t offset 3',
  'select * from t limit 5;', 'select * from t limit 5 ; ', 'select * from t limit 5; select 1', 'select * from t; select 1',
  'select * from t limit 5 where a = 1', 'select * from t where a = 1 limit 5 offset 2;',
  'select a from t', 'select *, 1 from t', 'select * from t, u', 'select * from t as x', 'select * from t x',
  'select * from t join u on 1=1', 'select * from t JOIN u', 'select * from t group by a', 'select * from t GROUP   BY a',
  'select * from t group\tby a', 'select * from t where a group by', 'select * from t where grouped = 1', 'select * from t where group_by = 1',
  'select * from t where a = \'group by\'', 'select distinct * from t', 'select * from t where a = \'distinct\'', 'select * from t where redistinct = 1',
  'select * from t union select * from u', 'select * from t where a in (select 1 union select 2)', 'select * from t where unions = 1',
  'select * from t intersect select * from t', 'select * from t except select * from t', 'select * from t where a = 1 using sample 10',
  'select * from t window w as (partition by a)', 'select * from t where x = my_window', 'select * from t where window_ = 1', 'select * from t where a = rejoin',
  'select * from t where joiner = 1', 'select * from t where é = 1 and join = 2', 'select * from t where a_join = 1', 'select * from t where éjoin = 1',
  'select * from t where a = 1 -- comment', '/* c */ select * from t', 'select /* c */ * from t', 'select * from t /* c */',
  'select * from t where a = (select max(b) from u)', 'select * from t where a = 1\nlimit 5', 'select * from t\n where a = 1',
  'select\n*\nfrom\nt', 'select * from t', 'select * from t', 'select\u0085*\u0085from\u0085t', '﻿select * from t',
  'select * from t ', ' select * from t', 'select * from t\u0085', 'select * from t where a = 1', 'select * from t where a = 1 limit 3',
  'SeLeCt * FrOm t WhErE a OrDeR bY a LiMiT 5 OfFsEt 1', 'select * from t where a = 1 order by a limit 5 offset 1 ;',
  'select * from t limit 5 offset 1 limit 2', 'select * from t order by a order by b', 'select * from t where a where b',
  '', ' ', ';', 'select', 'select *', 'select * from', 'select * from ', 'select * from;', 'insert into t values (1)', 'delete from t', 'drop table t',
  'with x as (select 1) select * from x', 'select * from read_csv(\'x\')', 'select * from t where a = \'x\'\'y\'', 'select * from "t" where "a" = 1',
  'select * from "T" order by "A"', 'describe select * from t', 'explain select * from t', 'from t', 'select * from t tablesample 10',
  'select * from t qualify row_number() over () = 1', 'select * from t where a = 1 having b', 'select * from t for update',
  'select * from t where a like \'%using%\'', 'select * from t where a = \'it\'\'s using\'',
  'select * from "a b" where "c d" = 1 order by "e f" limit 1', 'select * from "line\nbreak"', 'select * from "tab\tname"',
  'select * from "' + 'x'.repeat(5000) + '"', 'select * from t where ' + 'a = 1 and '.repeat(2000) + 'b = 2',
];
const results = sqls.map((sql) => ({ sql, table: baseTableOfSelect(sql) ?? null }));
fs.mkdirSync(path.dirname(out), { recursive: true });
const reference = { source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source_sha256: { 'src/duckdbConnection.ts': createHash('sha256').update(fs.readFileSync(path.join(root, 'src/duckdbConnection.ts'))).digest('hex') },
  bundle_sha256: createHash('sha256').update(fs.readFileSync(bundle)).digest('hex') };
fs.writeFileSync(out, JSON.stringify({ generatedBy: 'tools/make_edit_differential.cjs', reference, cases: results }, null, 1) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${results.length} cases (${results.filter((r) => r.table !== null).length} editable) -> ${out}`);
