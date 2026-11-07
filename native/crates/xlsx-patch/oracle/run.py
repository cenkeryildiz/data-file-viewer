"""Differential gate: TS patchCell vs the Rust crate on the same workbooks/edits.
usage: python run.py <work-dir>   (work-dir is created; needs node, esbuild, the myproject python with openpyxl, cargo)"""
import json, os, subprocess, sys
from pathlib import Path
H = Path(__file__).resolve().parent; W = Path(sys.argv[1]).resolve(); W.mkdir(parents=True, exist_ok=True)
NATIVE = H.parents[2]; NM = NATIVE.parent / 'node_modules'
PY = os.environ.get('DFV_REF_PYTHON', sys.executable)
corpus, ts_out, rust_out = W / 'corpus', W / 'ts-out', W / 'rust-out'
def run(cmd, **kw): print('>', ' '.join(map(str, cmd))[:160], flush=True); subprocess.run(cmd, check=True, **kw)
run([PY, H / 'make_workbooks.py', corpus])
run([NM / '.bin/esbuild', H / 'oracle.ts', '--bundle', '--platform=node', '--format=esm', f'--outfile={W}/oracle.mjs', '--log-level=warning', "--banner:js=import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);"], env=dict(os.environ, NODE_PATH=str(NM)))
run(['node', W / 'oracle.mjs', corpus, ts_out])
tc = os.path.expanduser('~/.rustup/toolchains/1.99.1-aarch64-apple-darwin/bin')
env = dict(os.environ, PATH=tc + os.pathsep + os.environ['PATH'], RUSTUP_TOOLCHAIN='1.99.1-aarch64-apple-darwin', RUSTUP_AUTO_INSTALL='0',
           CARGO_TARGET_DIR=os.environ.get('CARGO_TARGET_DIR', str(NATIVE / 'target')), DFV_XLSX_ORACLE=str(W))
run(['cargo', 'test', '--offline', '-p', 'dfv-table-xlsx-patch', '--test', 'differential', '-j2', '--', '--nocapture'], cwd=NATIVE, env=env)
run([PY, '-B', H / 'verify_openpyxl.py', W])
