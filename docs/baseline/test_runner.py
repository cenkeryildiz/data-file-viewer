"""Behavioral checks for deadline cleanup, failed benchmarks and provenance."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import psutil

spec = importlib.util.spec_from_file_location('baseline_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def test_timeout_terminates_descendant_and_records_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pidfile = root/'child.pid'
            code = "import subprocess,sys,time,pathlib; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
            with patch.object(runner, 'ROOT', root):
                result = runner.measure({'argv':[sys.executable,'-c',code,str(pidfile)],'timeout_seconds':1},root,0,os.environ.copy())
            self.assertEqual(result['status'], 'timeout')
            pid = int(pidfile.read_text())
            self.assertTrue(not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE)

    def test_failed_benchmark_has_no_passing_percentiles_and_keeps_logs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(['git','init','-q',str(root)],check=True)
            subprocess.run(['git','-C',str(root),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','test'],check=True)
            (root/'.gitignore').write_text('_work/\n')
            policy = root/'policy.json'
            policy.write_text(json.dumps({'evidence_directory':'_work','workloads':{'failure':{'argv':[sys.executable,'-c',"print('failure retained'); raise SystemExit(7)"],'timeout_seconds':5}}}))
            with patch.object(runner,'ROOT',root), patch.object(runner,'POLICY',policy), patch.object(sys,'argv',['run.py','--workload','failure','--benchmark']):
                self.assertEqual(runner.main(),1)
            report = next((root/'_work').glob('*/metrics.json'))
            metrics = json.loads(report.read_text())['failure']
            self.assertFalse(metrics['valid_command_sample'])
            self.assertIsNone(metrics['p50_seconds'])
            self.assertIn('failure retained',(report.parent/'failure/00.log').read_text())
            self.assertEqual(json.loads((report.parent/'source-after.json').read_text())['changed'],[])
            self.assertFalse((root/'_work/runner.lock').exists())

    def test_missing_executable_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(runner,'ROOT',root):
                result=runner.measure({'argv':[str(root/'absent')],'timeout_seconds':1},root,0,os.environ.copy())
            self.assertEqual(result['status'],'unavailable')

    def test_fingerprint_does_not_follow_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            link=Path(temp)/'alias'
            link.symlink_to('missing-target')
            self.assertEqual(runner.fingerprint(link)['kind'],'symlink')

    def test_source_mutation_invalidates_successful_command(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(['git','init','-q',str(root)],check=True)
            subprocess.run(['git','-C',str(root),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','test'],check=True)
            (root/'.gitignore').write_text('_work/\n')
            (root/'source.txt').write_text('before')
            policy = root/'policy.json'
            policy.write_text(json.dumps({'evidence_directory':'_work','workloads':{'mutation':{'argv':[sys.executable,'-c',"from pathlib import Path; Path('source.txt').write_text('after')"],'timeout_seconds':5}}}))
            with patch.object(runner,'ROOT',root), patch.object(runner,'POLICY',policy), patch.object(sys,'argv',['run.py','--workload','mutation']):
                self.assertEqual(runner.main(),1)
            report = next((root/'_work').glob('*/metrics.json'))
            self.assertFalse(json.loads(report.read_text())['mutation']['valid_command_sample'])
            self.assertEqual(json.loads((report.parent/'source-after.json').read_text())['changed'],['source.txt'])


if __name__ == '__main__':
    unittest.main()
