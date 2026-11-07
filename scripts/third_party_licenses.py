#!/usr/bin/env python3
"""Write THIRD_PARTY_LICENSES.txt for the shipped binaries and npm runtime packages.

usage: third_party_licenses.py <native-workspace-dir> <extension-dir> <out.txt>

Rust: normal (non-dev, non-build) dependency closure of dfv-table and dfv-mat from
`cargo metadata --offline --locked`, each with its SPDX expression and the licence
files found in the crate source. npm: production packages in package-lock.json.
Fails (exit 1) when a shipped package has no licence expression or no licence text,
so the inventory cannot silently be incomplete. Reads only; installs/downloads nothing.
"""
import json, os, subprocess, sys

WORKERS = ("dfv-table", "dfv-mat")
TEXT_PREFIXES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE")


def rust_closure(native):
    meta = json.loads(subprocess.run(
        ["cargo", "metadata", "--offline", "--locked", "--format-version", "1",
         "--filter-platform", "aarch64-apple-darwin"],
        cwd=native, check=True, capture_output=True, text=True).stdout)
    pkgs = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    roots = [p["id"] for p in meta["packages"] if p["name"] in WORKERS and p["id"] in meta["workspace_members"]]
    if len(roots) != len(WORKERS):
        sys.exit(f"worker packages not found in workspace: {roots}")
    seen, stack = set(), list(roots)
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        for dep in nodes[i]["deps"]:
            # kind None = normal dependency; dev/build kinds put no code in the binary
            if any(k.get("kind") is None for k in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    return [pkgs[i] for i in sorted(seen, key=lambda i: (pkgs[i]["name"], pkgs[i]["version"]))]


def licence_files(directory):
    out = []
    for dirpath, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in ("target", ".git", "tests", "benches", "examples")]
        for f in sorted(files):
            if f.upper().startswith(TEXT_PREFIXES):
                out.append(os.path.join(dirpath, f))
        if dirpath.count(os.sep) - directory.count(os.sep) >= 2:
            dirs[:] = []
    return out


def main(native, ext, out):
    problems, lines = [], []
    rust = [p for p in rust_closure(native) if p["name"] not in WORKERS and p["source"] is not None]
    own = [p for p in rust_closure(native) if p["source"] is None]
    lines.append("THIRD-PARTY LICENCES\n")
    lines.append("Binaries bin/dfv-table and bin/dfv-mat (Rust, project licence MIT OR Apache-2.0) link:\n")
    for p in rust:
        lic = p.get("license") or ("see " + p["license_file"] if p.get("license_file") else None)
        if not lic:
            problems.append(f"rust {p['name']} {p['version']}: no licence expression")
        lines.append(f"  {p['name']} {p['version']}  {lic}")
    lines.append(f"\n({len(own)} first-party workspace crates omitted; {len(rust)} third-party Rust packages)\n")
    lock = json.load(open(os.path.join(ext, "package-lock.json")))
    npm = sorted((k, v) for k, v in lock["packages"].items() if k and not v.get("dev"))
    lines.append("npm runtime packages bundled or shipped in the extension:\n")
    for key, v in npm:
        lines.append(f"  {key.split('node_modules/')[-1]} {v.get('version')}  {v.get('license')}")
        if not v.get("license"):
            problems.append(f"npm {key}: no licence field in package-lock.json")
    lines.append("\n" + "=" * 78 + "\nLICENCE TEXTS (as found in each package's source)\n" + "=" * 78)
    unpublished = []
    for p in rust:
        files = licence_files(os.path.dirname(p["manifest_path"]))
        if not files:
            unpublished.append(p)
        for f in files:
            lines.append(f"\n--- {p['name']} {p['version']}: {os.path.basename(f)} ---\n" + open(f, errors="replace").read().strip())
    # Some crates publish no licence file. The standard text of their declared SPDX id must then be
    # reproduced above by another shipped package; otherwise the inventory is incomplete.
    marker = {"MIT": "Permission is hereby granted", "Apache-2.0": "Apache License"}
    body = "\n".join(lines)
    for p in unpublished:
        lic = p.get("license") or ""
        if lic not in marker or marker[lic] not in body:
            problems.append(f"rust {p['name']} {p['version']}: no licence text and no standard {lic!r} text to refer to")
            continue
        lines.append(f"\n--- {p['name']} {p['version']}: licence file not published in the crate ---\n"
                     f"Declared licence {lic}; authors: {'; '.join(p.get('authors') or ['(none declared)'])}.\n"
                     f"The standard {lic} text reproduced elsewhere in this file applies.")
    for key, v in npm:
        files = licence_files(os.path.join(ext, key)) if os.path.isdir(os.path.join(ext, key)) else []
        if not files:
            problems.append(f"npm {key}: no licence text found under {key}")
        for f in files:
            lines.append(f"\n--- {key.split('node_modules/')[-1]} {v.get('version')}: {os.path.basename(f)} ---\n" + open(f, errors="replace").read().strip())
    open(out, "w").write("\n".join(lines) + "\n")
    print(f"{out}: {len(rust)} rust + {len(npm)} npm packages, {os.path.getsize(out)} bytes")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
