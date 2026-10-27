#!/usr/bin/env python3
"""Disposable RSA keys and mocked HTTPS; no real credentials, Docker or network."""
import base64
import fcntl
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / 'kobo-github-app-token'
loader = importlib.machinery.SourceFileLoader('github_app_token', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)


def decode(segment):
    return base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4))


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())


class HelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.key = Path(cls.keys.name) / 'app.pem'
        subprocess.run(['openssl', 'genrsa', '-out', str(cls.key), '2048'], check=True,
                       capture_output=True)
        cls.public = Path(cls.keys.name) / 'public.pem'
        subprocess.run(['openssl', 'rsa', '-in', str(cls.key), '-pubout', '-out', str(cls.public)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / 'config.json'
        self.data = {'app_id': 'Iv23clientid', 'installation_id': '123456',
                     'private_key': str(self.key)}
        self.config.write_text(json.dumps(self.data))
        self.cache = self.root / 'cache'
        self.now = 1800000000
        self.expires = datetime.fromtimestamp(self.now + 3600, timezone.utc).isoformat()
        self.requests = []
        self.clock = patch.object(m.time, 'time', return_value=self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.opener = patch.object(m.urllib.request, 'build_opener')
        self.mock_opener = self.opener.start().return_value
        self.mock_opener.open.side_effect = self.request
        self.addCleanup(self.opener.stop)

    def request(self, request, timeout):
        self.requests.append(request)
        self.assertLessEqual(timeout, 30)
        return Response({'token': 'ghs_test_only', 'expires_at': self.expires})

    def token(self):
        return m.get_token(self.config, self.cache)

    def test_signs_real_rs256_jwt_and_uses_fixed_github_endpoint(self):
        self.assertEqual(self.token()['token'], 'ghs_test_only')
        request = self.requests[0]
        self.assertEqual(request.full_url,
                         'https://api.github.com/app/installations/123456/access_tokens')
        self.assertEqual(request.method, 'POST')
        jwt = request.get_header('Authorization').removeprefix('Bearer ')
        header, payload, signature = jwt.split('.')
        self.assertEqual(json.loads(decode(header))['alg'], 'RS256')
        self.assertEqual(json.loads(decode(payload)),
                         {'iat': self.now - 60, 'exp': self.now + 540, 'iss': 'Iv23clientid'})
        sig_file = self.root / 'signature'
        sig_file.write_bytes(decode(signature))
        checked = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(self.public),
                                  '-signature', str(sig_file)], input=f'{header}.{payload}'.encode(),
                                 capture_output=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_reuses_private_cache_and_actual_expiry(self):
        first = self.token()
        self.assertEqual(first['expires_at'], self.expires)
        self.assertEqual(self.token(), first)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.cache.stat().st_mode & 0o777, 0o700)
        for file in self.cache.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_refreshes_before_expiry(self):
        self.token()
        with patch.object(m.time, 'time', return_value=self.now + 3500):
            self.expires = datetime.fromtimestamp(self.now + 7100, timezone.utc).isoformat()
            self.token()
        self.assertEqual(len(self.requests), 2)

    def test_identity_change_invalidates_cache(self):
        self.token()
        self.data['installation_id'] = '678'
        self.config.write_text(json.dumps(self.data))
        self.token()
        self.assertEqual(len(self.requests), 2)
        self.assertIn('/678/', self.requests[-1].full_url)

    def test_key_rotation_invalidates_cache(self):
        key = self.root / 'rotating.pem'
        key.write_bytes(self.key.read_bytes())
        self.data['private_key'] = str(key)
        self.config.write_text(json.dumps(self.data))
        self.token()
        subprocess.run(['openssl', 'genrsa', '-out', str(key), '2048'], check=True,
                       capture_output=True)
        self.token()
        self.assertEqual(len(self.requests), 2)

    def test_concurrent_calls_refresh_once(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            tokens = list(pool.map(lambda _: self.token()['token'], range(6)))
        self.assertEqual(tokens, ['ghs_test_only'] * 6)
        self.assertEqual(len(self.requests), 1)

    def test_rejects_unsafe_configuration(self):
        for field, value in [('installation_id', '../escape'), ('private_key', 'relative.pem'),
                             ('app_id', ''), ('installation_id', True)]:
            with self.subTest(field=field, value=value):
                data = {**self.data, field: value}
                self.config.write_text(json.dumps(data))
                with self.assertRaises(m.TokenError):
                    self.token()
        self.assertEqual(self.requests, [])

    def test_never_returns_expired_cache_after_refresh_failure(self):
        self.token()
        response = io.BytesIO(b'secret-response')
        self.mock_opener.open.side_effect = HTTPError('secret-url', 401, 'secret-body', {}, response)
        with patch.object(m.time, 'time', return_value=self.now + 4000):
            with self.assertRaises(m.TokenError) as caught:
                self.token()
        self.assertNotIn('secret', str(caught.exception))
        self.assertTrue(response.closed)

    def test_rejects_invalid_token_response(self):
        for response in [{'token': 'secret\nheader', 'expires_at': self.expires},
                         {'token': 'secret', 'expires_at': 'invalid'},
                         {'token': 'secret', 'expires_at': '2020-01-01T00:00:00Z'},
                         {'token': '', 'expires_at': self.expires}]:
            with self.subTest(response=response):
                self.mock_opener.open.side_effect = lambda *a, **kw: Response(response)
                with self.assertRaises(m.TokenError):
                    self.token()

    def test_redirect_handler_refuses_redirects(self):
        handler = m.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, '', {}, 'https://evil.test'))

    def test_cache_directory_must_be_private_and_not_symlink(self):
        self.cache.mkdir(mode=0o755)
        with self.assertRaises(m.TokenError):
            self.token()
        self.cache.rmdir()
        self.cache.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(m.TokenError):
            self.token()
        self.assertEqual(self.requests, [])

    def test_lock_wait_is_bounded_without_refresh(self):
        self.cache.mkdir(mode=0o700)
        lock = self.cache / 'token.lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            with patch.object(m, 'LOCK_TIMEOUT', 0):
                with self.assertRaisesRegex(m.TokenError, 'Timed out'):
                    self.token()
        finally:
            os.close(fd)
        self.assertEqual(self.requests, [])

    def test_invalid_key_fails_before_contacting_github(self):
        key = self.root / 'invalid.pem'
        key.write_text('secret-invalid-key-material')
        self.data['private_key'] = str(key)
        self.config.write_text(json.dumps(self.data))
        with self.assertRaises(m.TokenError) as caught:
            self.token()
        self.assertNotIn('secret-invalid', str(caught.exception))
        self.assertEqual(self.requests, [])

    def test_cache_symlink_does_not_read_or_overwrite_target(self):
        self.cache.mkdir(mode=0o700)
        outside = self.root / 'outside'
        outside.write_text('preserve me')
        (self.cache / 'token.json').symlink_to(outside)
        with self.assertRaises(OSError):
            self.token()
        self.assertEqual(outside.read_text(), 'preserve me')
        self.assertEqual(self.requests, [])

    def test_check_outputs_status_without_secret(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            result = m.main(['--config', str(self.config), '--cache-dir', str(self.cache), '--check'])
        self.assertEqual(result, 0)
        self.assertNotIn('ghs_test_only', stdout.getvalue())
        self.assertEqual(json.loads(stdout.getvalue())['status'], 'ok')

    def test_cli_errors_never_print_remote_secrets_or_traceback(self):
        self.mock_opener.open.side_effect = OSError('Bearer sensitive-jwt-response')
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = m.main(['--config', str(self.config), '--cache-dir', str(self.cache)])
        self.assertEqual(result, 1)
        self.assertEqual(stdout.getvalue(), '')
        self.assertNotIn('sensitive', stderr.getvalue())
        self.assertNotIn('Traceback', stderr.getvalue())


class WrapperTest(unittest.TestCase):
    def test_explicit_tokens_win_and_arguments_are_preserved(self):
        wrapper_path = SCRIPT.with_name('kobo-gh')
        self.assertTrue(wrapper_path.exists(), 'The gh wrapper must be shipped')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gh = root / 'gh'
            gh.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                          'print(json.dumps([os.getenv("GH_TOKEN"),os.getenv("GITHUB_TOKEN"),sys.argv[1:]]))\n')
            helper = root / 'helper'
            helper.write_text('#!/bin/sh\necho called >> "' + str(root / 'calls') + '"\necho minted\n')
            wrapper = root / 'wrapper'
            wrapper.write_text(wrapper_path.read_text().replace('/usr/bin/gh', str(gh)).replace(
                '/usr/local/bin/kobo-github-app-token', str(helper)))
            for script in (gh, helper, wrapper):
                script.chmod(0o700)
            env = {key: value for key, value in os.environ.items()
                   if key not in ('GH_TOKEN', 'GITHUB_TOKEN')}
            for override, expected in [({}, ['minted', None]),
                                       ({'GH_TOKEN': 'explicit'}, ['explicit', None]),
                                       ({'GITHUB_TOKEN': 'other'}, [None, 'other'])]:
                result = subprocess.run([str(wrapper), 'api', 'has spaces', '--jq', '.x'],
                                        env={**env, **override}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), [*expected, ['api', 'has spaces', '--jq', '.x']])
            self.assertEqual((root / 'calls').read_text(), 'called\n')
            helper.write_text('#!/bin/sh\nexit 1\n')
            failed = subprocess.run([str(wrapper), 'api'], env=env, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(failed.stdout, '')


if __name__ == '__main__':
    unittest.main()
