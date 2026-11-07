#!/bin/bash
# D7.1 packaging recipe: stage a clean copy OUTSIDE the session/UUID path, add the native workers,
# generate the licence inventory, run vsce, then inspect the archive with test/package.cjs.
# Installs nothing, publishes nothing. V23 is the first permitted real run.
#
#   scripts/stage-vsix.sh build-workers          # once, under the heavy lock (cold DuckDB release build)
#   scripts/stage-vsix.sh package OUT.vsix       # stage + vsce + inspect
#
# Environment (defaults are this machine's verified paths):
#   DFV_NATIVE_DIR   native Cargo workspace   (default this checkout's native/)
#   DFV_WORKER_DIR   directory holding dfv-table and dfv-mat (default $DFV_RELEASE_TARGET/release)
#   DFV_RELEASE_TARGET release target dir     (default /Users/macc/dfv-release-target)
#   DFV_PYTHON       python for the licence inventory (default myproject env)
set -euo pipefail

U="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="${DFV_NATIVE_DIR:-$U/native}"
TARGET="${DFV_RELEASE_TARGET:-/Users/macc/dfv-release-target}"
WORKERS="${DFV_WORKER_DIR:-$TARGET/release}"
PY="${DFV_PYTHON:-/Users/macc/miniforge3/envs/myproject/bin/python}"
RUST_BIN=/Users/macc/.rustup/toolchains/1.99.1-aarch64-apple-darwin/bin

build_workers() {
  # Default features only: the test-doc and test-mutations switches must not exist in a deliverable.
  # Path remaps keep /Users/... out of panic locations and the bundled DuckDB C++ __FILE__ strings.
  cd "$NATIVE"
  PATH="$RUST_BIN:$PATH" RUSTUP_AUTO_INSTALL=0 CARGO_TARGET_DIR="$TARGET" \
  DYLD_LIBRARY_PATH="$RUST_BIN/../lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
  CARGO_PROFILE_RELEASE_STRIP=symbols \
  RUSTFLAGS="--remap-path-prefix=$HOME=/build --remap-path-prefix=$NATIVE=/src --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}/registry=/cargo-registry" \
  CFLAGS="-ffile-prefix-map=$HOME=/build -ffile-prefix-map=${CARGO_HOME:-$HOME/.cargo}/registry=/cargo-registry" \
  CXXFLAGS="-ffile-prefix-map=$HOME=/build -ffile-prefix-map=${CARGO_HOME:-$HOME/.cargo}/registry=/cargo-registry" \
    cargo build --release --offline --locked -j2 -p dfv-table -p dfv-mat
  for worker in dfv-table dfv-mat; do
    /usr/bin/strip "$WORKERS/$worker"
    /usr/bin/codesign --force --sign - "$WORKERS/$worker"
  done
  ls -l "$WORKERS/dfv-table" "$WORKERS/dfv-mat"
}

package() {
  local out="$1"
  case "$out" in /*) ;; *) echo "OUT must be an absolute path" >&2; exit 2;; esac
  for w in dfv-table dfv-mat; do [ -x "$WORKERS/$w" ] || { echo "missing worker $WORKERS/$w (run build-workers)" >&2; exit 1; }; done
  # vsce packages 0 files from a session-UUID path, so stage under $HOME, never under the scratchpad.
  stage="$(mktemp -d "$HOME/dfv-vsix-stage.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  # Patterns are anchored to the repo root: an unanchored 'native' or 'bin' would also drop src/native and media/pdf/bin.
  rsync -a --exclude /node_modules --exclude /out-test --exclude /test --exclude /dist --exclude '/*.vsix' \
    --exclude /.git --exclude /.serena --exclude /.tmp --exclude /docs --exclude /bin \
    --include '/native/' --include '/native/pdf-mvp-assets.json' --exclude '/native/*' "$U/" "$stage/"
  mkdir "$stage/bin"
  cp "$WORKERS/dfv-table" "$WORKERS/dfv-mat" "$stage/bin/"
  chmod 755 "$stage/bin/dfv-table" "$stage/bin/dfv-mat"
  (cd "$stage/bin" && /usr/bin/python3 - <<'EOF'
import hashlib, json, os, platform
w = {n: {"bytes": os.path.getsize(n), "sha256": hashlib.sha256(open(n, "rb").read()).hexdigest()} for n in ("dfv-table", "dfv-mat")}
json.dump({"platform": "darwin-arm64", "features": "default (no test-doc, no test-mutations)", "workers": w}, open("workers.json", "w"), indent=1)
EOF
  )
  cd "$stage"
  npm ci --ignore-scripts --offline --no-audit --no-fund >/dev/null  # dev tools to build; vsce ships production deps only
  "$PY" -I "$U/scripts/third_party_licenses.py" "$NATIVE" "$stage" "$stage/THIRD_PARTY_LICENSES.txt"
  cat "$U/native/pdf-third-party-licenses.txt" "$U/native/duckdb-third-party-licenses.txt" >> "$stage/THIRD_PARTY_LICENSES.txt"
  npx --no-install vsce package --target darwin-arm64 --allow-missing-repository --out "$out"   # vscode:prepublish runs esbuild --require-pdf
  shasum -a 256 "$out"
  DFV_WORKER_DIR="$WORKERS" node "$U/test/package.cjs" "$out"
}

case "${1:-}" in
  build-workers) build_workers ;;
  package) package "${2:?usage: package /absolute/OUT.vsix}" ;;
  *) sed -n 2,13p "$0"; exit 2 ;;
esac
