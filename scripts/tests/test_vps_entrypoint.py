"""Portable launcher validation tests: never change the host's home or users."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'kobo-vps-entrypoint'


class EntrypointTests(unittest.TestCase):
    def test_bad_ids_fail_before_executing_any_command(self):
        for field in ('KOBO_UID', 'KOBO_GID'):
            for value in ('0', '-1', '01', 'root', '1;id', '2147483648'):
                with self.subTest(field=field, value=value):
                    result = subprocess.run(['sh', str(SCRIPT), 'echo', 'UNEXPECTED'],
                                            env={**os.environ, field: value}, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('UNEXPECTED', result.stdout)

    @unittest.skipUnless(os.getuid() != 0 and os.getgid() != 0,
                         'Needs a non-root host; root bootstrap is checked in Docker.')
    def test_existing_non_root_identity_executes_with_persistent_home(self):
        env = {**os.environ, 'KOBO_UID': str(os.getuid()), 'KOBO_GID': str(os.getgid())}
        result = subprocess.run(['sh', str(SCRIPT), '--exec', 'sh', '-c', 'printf "%s" "$HOME"'],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '/root')
        env['KOBO_UID'] = str(os.getuid() + 1)
        result = subprocess.run(['sh', str(SCRIPT), 'echo', 'UNEXPECTED'],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('UNEXPECTED', result.stdout)

    @unittest.skipUnless(os.getuid() != 0 and os.getgid() != 0,
                         'Needs a non-root host; root bootstrap is checked in Docker.')
    def test_identity_check_ignores_an_id_executable_in_the_runtime_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            fake_id = Path(temporary) / 'id'
            fake_id.write_text('#!/bin/sh\ncase "$1" in\n'
                               '  -u) printf "%s" "$KOBO_UID" ;;\n'
                               '  -g) printf "%s" "$KOBO_GID" ;;\nesac\n')
            fake_id.chmod(0o755)
            env = {**os.environ, 'KOBO_UID': str(os.getuid() + 1), 'KOBO_GID': str(os.getgid()),
                   'PATH': temporary + os.pathsep + os.environ['PATH']}
            result = subprocess.run(['sh', str(SCRIPT), '--exec', 'echo', 'UNEXPECTED'],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('The runtime user must match', result.stderr)
            self.assertNotIn('UNEXPECTED', result.stdout)
