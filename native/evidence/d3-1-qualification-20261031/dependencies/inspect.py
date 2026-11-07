"""Record the local production dependency closure without compiling or downloading."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tomllib

args = argparse.ArgumentParser()
args.add_argument('--cargo', type=Path, required=True)
args.add_argument('--binary', type=Path, required=True)
opts = args.parse_args()
out = Path(__file__).resolve().parent
native = out.parents[2]
repo = native.parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


commands = []


def run(argv, cwd=native):
    result = subprocess.run([str(a) for a in argv], cwd=cwd, capture_output=True, text=True, check=True)
    commands.append({'argv': [str(a) for a in argv], 'cwd': str(cwd), 'exit_code': result.returncode})
    return result.stdout


target = 'aarch64-apple-darwin'
cargo = opts.cargo.resolve()
metadata = json.loads(run([cargo, 'metadata', '--offline', '--locked', '--filter-platform', target, '--format-version', '1']))
tree = run([cargo, 'tree', '-p', 'dfv-table', '--offline', '--locked', '--target', target,
            '--edges', 'normal,build', '--prefix', 'depth', '--format', '{p}|{f}'])
(out / 'cargo-tree.txt').write_text(tree)
normal_tree = run([cargo, 'tree', '-p', 'dfv-table', '--offline', '--locked', '--target', target,
                   '--edges', 'normal', '--prefix', 'depth', '--format', '{p}|{f}'])
normal_keys = set(re.findall(r'^\d+([^ ]+) v([^ |]+)', normal_tree, re.MULTILINE))
features = {}
for line in tree.splitlines():
    match = re.match(r'^\d+([^ ]+) v([^ |]+).*?\|([^ ]*)', line)
    if match:
        features.setdefault((match[1], match[2]), set()).update(filter(None, match[3].split(',')))
locked = {(p['name'], p['version'], p.get('source')): p for p in tomllib.loads((native / 'Cargo.lock').read_text())['package']}
packages = []
issues = []
for package in sorted(metadata['packages'], key=lambda p: (p['name'], p['version'])):
    key = (package['name'], package['version'])
    if key not in features:
        continue
    root = Path(package['manifest_path']).parent
    item = {k: package[k] for k in ('name', 'version', 'source', 'license', 'license_file', 'repository', 'rust_version')}
    item.update(features=sorted(features[key]), manifest=str(root / 'Cargo.toml'), manifest_sha256=sha(root / 'Cargo.toml'))
    item['dependency_role'] = 'normal' if key in normal_keys else 'build-only'
    lock = locked[(package['name'], package['version'], package['source'])]
    item['lock_checksum'] = lock.get('checksum')
    if package['source']:
        archive = root.parents[2] / 'cache' / root.parent.name / f'{package["name"]}-{package["version"]}.crate'
        item['cached_archive'] = str(archive)
        item['archive_sha256'] = sha(archive) if archive.is_file() else None
        item['archive_checksum_matches_lock'] = item['archive_sha256'] == lock.get('checksum')
        mismatches = []
        expected_files = {}
        if archive.is_file():
            with tarfile.open(archive) as contents:
                for member in contents:
                    if member.isfile():
                        relative = str(Path(member.name).relative_to(root.name))
                        expected_files[relative] = hashlib.sha256(contents.extractfile(member).read()).hexdigest()
        for relative, expected in expected_files.items():
            file = root / relative
            if not file.resolve().is_relative_to(root.resolve()) or not file.is_file() or sha(file) != expected:
                mismatches.append(relative)
        item['verified_source_files'] = len(expected_files)
        item['source_mismatches'] = mismatches
        license_paths = [root / p for p in expected_files if re.match(r'(?i)^(license|licence|notice|copying|copyright)(\.|-|$)', Path(p).name)]
        item['license_texts'] = [{'path': str(p.relative_to(root)), 'sha256': sha(p)} for p in sorted(license_paths) if p.is_file()]
        vcs = root / '.cargo_vcs_info.json'
        item['vcs'] = json.loads(vcs.read_text()) if vcs.is_file() else None
        supplement = out / 'upstream-license' / 'provenance.json'
        if key == ('duckdb', '1.10505.0') and supplement.is_file():
            provenance = json.loads(supplement.read_text())
            text = out / 'upstream-license' / provenance['local_file']
            data = text.read_bytes()
            blob_sha = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            assert provenance['commit'] == item['vcs']['git']['sha1'] and blob_sha == provenance['github_blob_sha']
            item['license_texts'].append({'path': str(text.relative_to(out)), 'sha256': sha(text), 'origin': provenance})
        if not item['license_texts']:
            issues.append({'package': '@'.join(key), 'issue': 'No licence/notice text in cached crate; SPDX metadata is not retained licence text.'})
        if mismatches or not item['archive_checksum_matches_lock']:
            issues.append({'package': '@'.join(key), 'issue': 'Source/archive checksum verification incomplete; inspect package record.'})
    else:
        item['local_sources'] = {str(p.relative_to(repo)): sha(p) for p in sorted(root.rglob('*')) if p.is_file() and (p.name == 'Cargo.toml' or 'src' in p.relative_to(root).parts)}
    if package['name'] == 'libduckdb-sys':
        bundle = root / 'duckdb.tar.gz'
        vendor_manifest = json.loads((out / 'upstream-license' / 'duckdb-vendors.json').read_text())
        source_blobs = {entry['path']: entry['sha'] for entry in vendor_manifest['source_git_blobs']}
        data = bundle.read_bytes()
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == vendor_manifest['packaged_archive_git_blob']['sha']
        retained_licenses = []
        for licence in vendor_manifest['licenses']:
            file = out / 'upstream-license' / licence['file']
            data = file.read_bytes()
            assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == licence['git_blob_sha']
            retained_licenses.append({**licence, 'sha256': sha(file)})
        with tarfile.open(bundle) as contents:
            names = contents.getnames()
            manifest = json.load(contents.extractfile('duckdb/manifest.json'))
            vendor_sources_verified = 0
            for member in contents:
                if member.isfile() and member.name.startswith('duckdb/third_party/'):
                    relative = member.name.removeprefix('duckdb/third_party/')
                    data = contents.extractfile(member).read()
                    assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == source_blobs[relative]
                    vendor_sources_verified += 1
            headers = {}
            for name in ('duckdb/third_party/utf8proc/utf8proc.cpp', 'duckdb/third_party/re2/re2/re2.h', 'duckdb/third_party/snappy/snappy.h'):
                data = contents.extractfile(name).read()
                headers[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'opening_notice': data[:2000].decode(errors='replace')}
        item['bundled_sources'] = {
            'archive_sha256': sha(bundle),
            'available_extensions': sorted(manifest['extensions']),
            'icu_source_members': sum('/icu/' in name for name in names),
            'standalone_licence_notice_members': [name for name in names if re.match(r'(?i)^(license|licence|notice|copying)(\.|-|$)', Path(name).name)],
            'third_party_directories': sorted({name.split('/')[2] for name in names if name.startswith('duckdb/third_party/') and len(name.split('/')) > 3}),
            'notice_examples': headers,
            'upstream_commit': vendor_manifest['commit'],
            'upstream_manifest_sha256': sha(out / 'upstream-license' / 'duckdb-vendors.json'),
            'vendor_source_files_matched_to_upstream_git_blobs': vendor_sources_verified,
            'retained_licenses': retained_licenses,
            'disposition': 'The Cargo source archive matches the exact duckdb-rs Git blob; all 442 bundled vendor source files match its pinned DuckDB submodule revision. Root and all 26 vendor licences omitted by the archive are retained from that revision and verified by Git blob SHA. Coverage includes the entire bundled vendor superset for core_functions/json/parquet. This dependency provenance review does not accept final binary-package notice inclusion or certify legal compliance.',
        }
    packages.append(item)

binary = opts.binary.resolve()
linked = run(['otool', '-L', binary])
(out / 'loaded-libraries.txt').write_text(linked)
result = {
    'scope': 'Local macOS arm64 production dfv-table normal/build closure; no dev-only dependency or full-workspace acceptance implied.',
    'head': run(['git', 'rev-parse', 'HEAD'], repo).strip(),
    'target': target,
    'rustc': run([cargo.parent / 'rustc', '-Vv']),
    'cargo': run([cargo, '-V']),
    'clang_observation': run(['xcrun', 'clang', '--version']),
    'python': sys.version,
    'generator_sha256': sha(Path(__file__)),
    'inputs': {str(p.relative_to(repo)): sha(p) for p in (native / 'Cargo.toml', native / 'Cargo.lock', native / 'rust-toolchain.toml')},
    'binary_observation': {'path': str(binary), 'sha256': sha(binary), 'note': 'Observed binary only; final qualification must bind its actual build profile and SHA separately.', 'loaded_libraries_sha256': sha(out / 'loaded-libraries.txt')},
    'packages': packages,
    'issues': issues,
    'commands': commands,
    'legal_review': 'Licence expressions, available licence-file hashes and source provenance only; no legal compliance certification or redistribution clearance.',
}
(out / 'proof.json').write_text(json.dumps(result, indent=2) + '\n')
assert len(packages) == len(features), 'Every package in the selected tree must have metadata.'
assert all(not p.get('source_mismatches') and p.get('archive_checksum_matches_lock', True) for p in packages), 'Source provenance verification failed.'
print(json.dumps({'packages': len(packages), 'issues': len(issues)}))
