#!/bin/zsh
# EX-05 counting attempt: zsh test/_evidence/ex-05/run_attempt.sh <attempt-NN>
# Holds the shared heavy-test lock for the whole run (this process's pid is in
# `owner`), records every step in <attemptDir>/runs.json, and releases the lock
# on exit only if the owner file is still ours.
set -eu
REPO=/Users/macc/Desktop/Kod/Projects/Rust/.dfv-worktrees/ex-05
LOCK=/Users/macc/Desktop/Kod/.codex-work/pdf-resume-20261016/heavy-test.lock
NAME=${1:?attempt name, e.g. attempt-01}
DIR=$REPO/test/_evidence/ex-05/$NAME
[[ -e $DIR ]] && { echo "$DIR exists; use a new attempt"; exit 2; }
TOKEN="EX-05 $NAME pid=$$ $(date -u +%FT%TZ)"
until mkdir "$LOCK" 2>/dev/null; do echo "lock held: $(head -1 $LOCK/owner 2>/dev/null)"; sleep 15; done
printf 'owner=EX-05 %s (worktree ex-05)\npid=%s\ntoken=%s\n' "$NAME" $$ "$TOKEN" > "$LOCK/owner"
release() { grep -qF "token=$TOKEN" "$LOCK/owner" 2>/dev/null && rm -rf "$LOCK"; }
trap release EXIT INT TERM
cd $REPO
mkdir -p $DIR
git rev-parse HEAD > $DIR/source-head.txt
git status --short > $DIR/source-status.txt
step() { node test/_evidence/ex-05/run_step.cjs $DIR "$@"; }
step compile -- npx tsc -p tsconfig.test.json
step unit-ex05 -- node --test --test-reporter=spec out-test/test/ex05LogicalRows.test.js out-test/test/xlsxCorpus.test.js out-test/test/sheetTables.test.js out-test/test/xlsxSheetCache.test.js
step unit-full -- node --test '"out-test/test/*.test.js"'
step security -- npm run test:security
step browser-ex05 -- node test/browser/ex05LogicalRows.cjs
step browser-sql -- node test/browser/sqlWorkflow.cjs
step browser-chart -- node test/browser/chartDetail.cjs
step package -- npm run package
step host-ex05 -- node test/host/ex05LogicalRows.cjs
step host-sql -- node test/host/sqlWorkflow.cjs
git status --short > $DIR/source-status-after.txt
echo "attempt finished: $DIR"
