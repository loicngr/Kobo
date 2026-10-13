"""Portable launcher validation tests: never change the host's home or users."""
import os
from pathlib import Path
import subprocess
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

    @unittest.skipUnless(Path('/usr/bin/id').is_file() and os.getuid() != 0 and os.getgid() != 0,
                         'Needs a non-root host with /usr/bin/id; root bootstrap is checked in Docker.')
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
