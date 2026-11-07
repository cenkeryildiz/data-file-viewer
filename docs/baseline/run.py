#!/usr/bin/env python3
"""Local B0 evidence runner. Run with Conda myproject; requires psutil.

This file is intentionally self-contained in each owning repository. It never
imports a sibling project or evaluates user configuration. Logs remain local.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import signal
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone

import psutil

ROOT = Path(__file__).resolve().parents[2]
POLICY = Path(__file__).with_name("workloads.json")


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n")
    temporary.replace(path)


def fingerprint(path):
    if path.is_symlink():
        return {"kind": "symlink", "sha256": hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()}
    if not path.is_file():
        return {"kind": "missing"}
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"kind": "file", "bytes": path.stat().st_size, "sha256": digest}


def sources():
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT
    ).decode().split("\0")
    return {name: fingerprint(ROOT / name) for name in sorted(set(names)) if name}


def inventory(patterns):
    return {str(p.relative_to(ROOT)): fingerprint(p)
            for pattern in patterns for p in sorted(ROOT.glob(pattern))
            if p.is_file() or p.is_symlink()}


def tool_versions(env):
    result = {}
    for name in ('git', 'node', 'npm'):
        executable = shutil.which(name, path=env.get('PATH'))
        if not executable:
            result[name] = {"status": "unavailable"}
            continue
        try:
            version = subprocess.check_output([executable, '--version'], env=env,
                                              stderr=subprocess.STDOUT, timeout=5).decode().strip()
            result[name] = {"executable": executable, "version": version}
        except (OSError, subprocess.SubprocessError) as error:
            result[name] = {"executable": executable, "error": str(error)}
    return result


def stop(child, observed):
    # Children may start their own sessions (VS Code does). Retain identities,
    # not bare PIDs, so PID reuse cannot terminate an unrelated process.
    try:
        observed.update({p.pid: p for p in psutil.Process(child.pid).children(recursive=True)})
    except psutil.Error:
        pass
    for proc in reversed(list(observed.values())):
        try:
            proc.kill()
        except psutil.Error:
            pass
    if os.name == "posix":
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif child.poll() is None:
        child.kill()
    child.wait(timeout=10)
    psutil.wait_procs(list(observed.values()), timeout=5)


def measure(spec, directory, index, env):
    argv = [sys.executable if arg == "{python}" else arg for arg in spec["argv"]]
    cwd = ROOT / spec.get("cwd", ".")
    env = {**env, **spec.get("env", {})}
    result = {"argv": argv, "cwd": str(cwd.relative_to(ROOT)), "timeout_seconds": spec["timeout_seconds"]}
    started = time.monotonic()
    observed = {}
    rss = cpu = 0
    samples = 0
    per_process_cpu = {}
    child = None
    try:
        with (directory / f"{index:02d}.log").open("wb") as log:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name == "posix")
            parent = psutil.Process(child.pid)
            while True:
                try:
                    processes = [parent, *parent.children(recursive=True)]
                except psutil.Error:
                    processes = []
                current_rss = 0
                for proc in processes:
                    try:
                        observed[proc.pid] = proc
                        current_rss += proc.memory_info().rss
                        t = proc.cpu_times()
                        per_process_cpu[(proc.pid, proc.create_time())] = t.user + t.system
                    except psutil.Error:
                        pass
                rss = max(rss, current_rss)
                cpu = sum(per_process_cpu.values())
                samples += 1
                if child.poll() is not None:
                    result.update(status="command_passed" if child.returncode == 0 else "failed", exit_code=child.returncode)
                    break
                if time.monotonic() - started >= spec["timeout_seconds"]:
                    result.update(status="timeout", exit_code=None)
                    break
                time.sleep(0.05)
    except OSError as error:
        result.update(status="unavailable", error=str(error), exit_code=None)
    finally:
        if child is not None:
            stop(child, observed)
    result.update(wall_seconds=time.monotonic() - started, sampled_tree_peak_rss_bytes=rss,
                  sampled_tree_cpu_seconds=cpu, samples=samples)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--workload", action="append", default=[])
    parser.add_argument("--benchmark", action="store_true", help="2 warmups and 7 measured runs; all must succeed")
    args = parser.parse_args()
    policy = json.loads(POLICY.read_text())
    if args.list:
        print("\n".join(policy["workloads"]))
        return 0
    if not args.workload or any(name not in policy["workloads"] for name in args.workload):
        parser.error("choose registered workloads with --workload (use --list)")
    evidence = ROOT / policy["evidence_directory"]
    evidence.mkdir(parents=True, exist_ok=True)
    # Exclusive lock prevents two suites from clobbering shared synthetic fixtures.
    lock = evidence / "runner.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        parser.error(f"another run owns {lock}; inspect its PID before removing a stale lock")
    os.write(descriptor, str(os.getpid()).encode())
    os.close(descriptor)
    try:
        run = evidence / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-{os.getpid()}")
        run.mkdir()
        before = sources()
        packages = {}
        for name in policy.get("python_packages", []):
            try:
                packages[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                packages[name] = None
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if policy.get("prepend_path"):
            env["PATH"] = str(ROOT / policy["prepend_path"]) + os.pathsep + env.get("PATH", "")
        write_json(run / "manifest.json", {
            "schema_version": 1, "phase": "B0", "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
            "source_files": before, "policy": policy, "python": sys.version,
            "python_executable": sys.executable, "python_packages": packages,
            "tool_versions": tool_versions(env),
            "platform": platform.platform(), "machine": platform.machine(),
            "logical_cpus": os.cpu_count(), "physical_cpus": psutil.cpu_count(logical=False),
            "memory_bytes": psutil.virtual_memory().total, "disk": psutil.disk_usage(ROOT)._asdict(),
            "limits": ["50ms sampled RSS/CPU can miss short-lived children and peaks; RSS sums shared pages.",
                       "Command success is not phase acceptance; inspect skips, expected failures and independent consumers.",
                       "No cache flush or power-profile control; runs are sequential warm-cache candidates.",
                       "Stage timings, disk IO and first-visible UI latency require separate instrumentation."]})
        rows = []
        for name in args.workload:
            directory = run / name
            directory.mkdir()
            count = 9 if args.benchmark else 1
            for index in range(count):
                row = measure(policy["workloads"][name], directory, index, env)
                row.update(workload=name, iteration=index, warmup=args.benchmark and index < 2)
                rows.append(row)
                write_json(run / "results.json", rows)
                print(f"{name}[{index}]: {row['status']} ({row['wall_seconds']:.2f}s)", flush=True)
                if row["status"] != "command_passed":
                    break
        after = sources()
        changed = [name for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)]
        write_json(run / "source-after.json", {"source_files": after, "changed": changed})
        write_json(run / "artifacts.json", inventory(policy.get("artifact_globs", [])))
        metrics = {}
        for name in args.workload:
            selected = [r for r in rows if r["workload"] == name and not r["warmup"]]
            valid = not changed and len(selected) == (7 if args.benchmark else 1) and all(r["status"] == "command_passed" for r in rows if r["workload"] == name)
            times = sorted(r["wall_seconds"] for r in selected)
            metrics[name] = {"valid_command_sample": valid, "measured_runs": len(times),
                             "p50_seconds": statistics.median(times) if valid else None,
                             "p95_seconds": times[math.ceil(len(times) * .95) - 1] if valid else None}
        write_json(run / "metrics.json", metrics)
        print(f"Evidence: {run}", flush=True)
        if changed:
            print("Source changed during run: " + ", ".join(changed), file=sys.stderr)
        return int(bool(changed) or any(r["status"] != "command_passed" for r in rows))
    finally:
        lock.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
