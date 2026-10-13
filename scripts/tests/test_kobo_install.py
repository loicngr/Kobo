#!/usr/bin/env python3
"""Installer contract tests; no daemon, network, or production files."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'kobo-install'
loader = importlib.machinery.SourceFileLoader('kobo_install', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = Path(self.tmp.name) / 'stack'
        self.config = dict(domain='kobo.example.com', projects_directory=str(self.stack / 'projects'),
                           network='web', entrypoint='websecure', certresolver='letsencrypt',
                           docker_socket=False, github_app_id=None, github_installation_id=None,
                           github_private_key=None, version='2.1.16', uid=str(os.getuid() or 1000), gid=str(os.getgid() or 1000))
        self.installer = m.Installer(self.stack)

    def test_check_does_not_write_or_build(self):
        with patch.object(self.installer, 'preflight'), patch.object(self.installer, 'collisions'), \
             patch.object(self.installer, 'validate_compose'), patch.object(self.installer, 'build') as build:
            self.installer.execute(self.config, check=True)
        self.assertFalse(self.stack.exists())
        build.assert_not_called()

    def test_refuses_unmanaged_stack_without_overwriting(self):
        self.stack.mkdir()
        file = self.stack / 'compose.yaml'
        file.write_text('user-owned')
        with self.assertRaises(m.InstallError):
            self.installer.assert_fresh()
        self.assertEqual(file.read_text(), 'user-owned')

    def test_rejects_interpolation_and_invalid_identifiers(self):
        for field, value in [('domain', 'https://example.com'), ('domain', 'x`evil'),
                             ('network', 'web\nattack'), ('entrypoint', '${OTHER}'),
                             ('projects_directory', '/tmp/${HOME}'),
                             ('projects_directory', '/root'), ('projects_directory', '/'),
                             ('projects_directory', 'relative')]:
            with self.subTest(field=field), self.assertRaises(m.InstallError):
                m.validate_config({**self.config, field: value})

    def test_renders_no_socket_and_optional_resolver(self):
        compose, env = m.render({**self.config, 'certresolver': ''}, self.stack)
        self.assertNotIn('tls.certresolver:', compose)
        self.assertNotIn('      - /var/run/docker.sock:', compose)
        self.assertIn("KOBO_DOMAIN='kobo.example.com'", env)

    def test_runtime_identity_is_explicit_and_root_is_refused(self):
        for bad in ('0', '-1', '01', 'root', '1000;id', '2147483648'):
            for field in ('uid', 'gid'):
                with self.subTest(field=field, bad=bad), self.assertRaises(m.InstallError):
                    m.validate_config({**self.config, field: bad})
        compose, env = m.render({**self.config, 'uid': '1234', 'gid': '2345'}, self.stack)
        self.assertIn("KOBO_UID='1234'", env)
        self.assertIn("KOBO_GID='2345'", env)
        self.assertIn('entrypoint: ["kobo-vps-entrypoint"]', compose)
        self.assertIn('NPM_CONFIG_INCLUDE: dev', compose)

    def test_new_configuration_defaults_to_host_user_without_changing_legacy_config(self):
        args = m.arguments(['--directory', str(self.stack), '--yes', '--domain', 'kobo.example.com',
                            '--network', 'web', '--entrypoint', 'websecure'])
        with patch.object(m.os, 'getuid', return_value=1234), patch.object(m.os, 'getgid', return_value=2345):
            config = m.configure(args, self.installer)
        self.assertEqual((config['uid'], config['gid']), ('1234', '2345'))
        legacy = {k: v for k, v in self.config.items() if k not in ('uid', 'gid')}
        self.installer.state = {'config': legacy}
        self.assertNotIn('uid', m.configure(args, self.installer))

    def test_github_setup_runs_as_agent_for_new_installation(self):
        self.installer.state = {'config': self.config}
        with patch.object(self.installer, 'run') as run:
            self.installer.configure_github()
        for call in run.call_args_list:
            self.assertIn('kobo-vps-entrypoint', call.args[0])
            self.assertIn('--exec', call.args[0])

    def test_new_projects_require_matching_owner_unless_installer_is_root(self):
        config = {**self.config, 'uid': '1234', 'gid': '2345'}
        with patch.object(m.os, 'getuid', return_value=3456), self.assertRaises(m.InstallError):
            m.validate_config(config)
        with patch.object(m.os, 'getuid', return_value=0), patch.object(m.os, 'chown') as chown:
            m.validate_config(config)
            self.installer.initialize(config)
        chown.assert_called_once_with(Path(config['projects_directory']), 1234, 2345)

    def test_existing_projects_are_not_chowned(self):
        Path(self.config['projects_directory']).mkdir(parents=True)
        with patch.object(self.installer, 'assert_fresh'), patch.object(m.os, 'getuid', return_value=0), \
             patch.object(m.os, 'chown') as chown:
            self.installer.initialize(self.config)
        chown.assert_not_called()

    def test_github_mounts_are_readonly_and_private_key_is_not_copied(self):
        key = Path(self.tmp.name) / 'key.pem'
        key.write_text('PRIVATE TEST FIXTURE')
        key.chmod(0o600)
        config = {**self.config, 'github_app_id': 'Iv1app', 'github_installation_id': '123',
                  'github_private_key': str(key), 'docker_socket': True}
        m.validate_config(config)
        compose, env = m.render(config, self.stack)
        self.assertIn('/run/secrets/kobo-github-app.pem', compose)
        self.assertEqual(compose.count('read_only: true'), 4)
        self.assertNotIn('PRIVATE TEST FIXTURE', compose + env)
        self.assertIn('      - /var/run/docker.sock:', compose)

    def test_partial_github_configuration_fails(self):
        with self.assertRaises(m.InstallError):
            m.validate_config({**self.config, 'github_app_id': '123'})

    def test_managed_edits_and_missing_files_are_preserved(self):
        self.installer.initialize(self.config)
        file = self.stack / '.env'
        file.write_text('custom')
        with self.assertRaises(m.InstallError):
            self.installer.verify_files()
        self.assertEqual(file.read_text(), 'custom')
        file.unlink()
        with self.assertRaises(m.InstallError):
            self.installer.verify_files()

    def test_complete_rerun_does_not_start_or_reset_git(self):
        self.installer.initialize(self.config)
        self.installer.save(phase='complete')
        with patch.object(self.installer, 'preflight'), patch.object(self.installer, 'validate_compose'), \
             patch.object(self.installer, 'run') as run:
            self.installer.execute(self.config)
        run.assert_not_called()

    def test_completed_stack_accepts_only_updater_image_change(self):
        self.installer.initialize(self.config)
        self.installer.save(phase='complete')
        file = self.stack / 'compose.yaml'
        file.write_text(m.updater.image_config(file.read_text(), 'kobo:2.2.0-release'))
        self.installer.verify_files()
        file.write_text(file.read_text().replace('restart: unless-stopped', 'restart: always'))
        with self.assertRaises(m.InstallError):
            self.installer.verify_files()

    def test_prepared_image_cannot_be_replaced(self):
        self.installer.initialize(self.config)
        self.installer.save(phase='prepared', image='kobo:expected')
        with self.assertRaises(m.InstallError):
            self.installer.verify_files()

    def test_project_collision_is_refused(self):
        with patch.object(self.installer, 'run', return_value='existing-container'), \
             self.assertRaises(m.InstallError):
            self.installer.collisions()

    def test_router_in_another_compose_project_is_not_replaced(self):
        with patch.object(self.installer, 'run', side_effect=['', '', 'other-project-container']), \
             self.assertRaises(m.InstallError):
            self.installer.collisions()

    def test_manifest_and_env_are_private(self):
        self.installer.initialize(self.config)
        for file in ('.env', '.kobo-install.json'):
            self.assertEqual((self.stack / file).stat().st_mode & 0o777, 0o600)
        state = json.loads((self.stack / '.kobo-install.json').read_text())
        self.assertEqual(state['phase'], 'configured')

    def test_changed_options_refuse_reconfiguration(self):
        self.installer.initialize(self.config)
        with self.assertRaises(m.InstallError):
            self.installer.execute({**self.config, 'domain': 'other.example.com'}, check=True)

    def test_prepare_then_start_reuses_built_image(self):
        def build(*args):
            return 'kobo:test-release'
        with patch.object(self.installer, 'preflight'), patch.object(self.installer, 'collisions'), \
             patch.object(self.installer, 'validate_compose'), patch.object(self.installer, 'run') as run, \
             patch.object(self.installer, 'resolve', return_value=('2.1.16', 'a' * 40)), \
             patch.object(self.installer, 'build', side_effect=build) as built, \
             patch.object(self.installer, 'assert_started'), patch.object(self.installer, 'verify'):
            self.installer.execute(self.config, prepare=True)
            self.assertEqual(self.installer.state['phase'], 'prepared')
            self.assertFalse(any('up' in call.args[0] for call in run.call_args_list))
            self.installer.execute(self.config)
            built.assert_called_once()
            self.assertEqual(self.installer.state['phase'], 'complete')
            self.assertEqual(sum('up' in call.args[0] for call in run.call_args_list), 1)

    def test_retry_verification_never_recreates_container(self):
        self.installer.initialize(self.config)
        image = 'kobo:test-release'
        self.installer.compose_file.write_text(m.updater.image_config(self.installer.compose_file.read_text(), image))
        self.installer.save(phase='verifying', image=image, version='2.1.16')
        with patch.object(self.installer, 'preflight'), patch.object(self.installer, 'validate_compose'), \
             patch.object(self.installer, 'assert_started'), patch.object(self.installer, 'verify'), \
             patch.object(self.installer, 'run') as run:
            self.installer.execute(self.config)
            self.assertEqual(self.installer.state['phase'], 'complete')
            run.assert_not_called()

    def test_failed_start_cannot_adopt_unhealthy_or_unrelated_container(self):
        self.installer.state = {'image': 'kobo:expected'}
        for image, running, health, directory in [('kobo:other', True, 'healthy', str(self.stack)),
                                                  ('kobo:expected', False, 'healthy', str(self.stack)),
                                                  ('kobo:expected', True, 'unhealthy', str(self.stack)),
                                                  ('kobo:expected', True, 'healthy', '/other')]:
            info = {'Config': {'Image': image, 'Labels': {
                'com.docker.compose.project': 'kobo', 'com.docker.compose.service': 'kobo',
                'com.docker.compose.project.working_dir': directory, 'com.docker.compose.config-hash': 'hash'}},
                'State': {'Running': running, 'Health': {'Status': health}}}
            with self.subTest(image=image, health=health, directory=directory), \
                 patch.object(self.installer, 'run', side_effect=['id', json.dumps([info]), 'kobo hash']), \
                 self.assertRaises(m.InstallError):
                self.installer.assert_started()

    def test_shell_compose_overrides_are_removed_only_in_the_child(self):
        overrides = {'KOBO_DOMAIN': 'evil.example.com', 'COMPOSE_FILE': '/other.yml'}
        with patch.dict(os.environ, overrides):
            def command(*args, **kwargs):
                self.assertNotIn('KOBO_DOMAIN', kwargs['env'])
                self.assertNotIn('COMPOSE_FILE', kwargs['env'])
                self.assertEqual(os.environ['KOBO_DOMAIN'], overrides['KOBO_DOMAIN'])
                return m.updater.subprocess.CompletedProcess(args[0], 0, stdout=b'', stderr=b'')
            with patch.object(m.updater.subprocess, 'run', side_effect=command):
                self.installer.run(['docker', 'compose', 'config'])
            self.assertEqual(os.environ['KOBO_DOMAIN'], overrides['KOBO_DOMAIN'])

    def test_github_configuration_never_stores_a_raw_token_in_git(self):
        with patch.object(self.installer, 'run') as run:
            self.installer.configure_github()
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn('--check', commands[0])
        self.assertEqual(commands[-1][-1], '!/usr/local/bin/gh auth git-credential')

    def test_preflight_refuses_remote_daemon_before_mutations(self):
        with patch.dict(os.environ, {'DOCKER_HOST': 'ssh://other-host'}, clear=True), \
             patch.object(m.shutil, 'which', return_value='/bin/tool'), \
             patch.object(self.installer, 'run') as run, self.assertRaises(m.InstallError):
            self.installer.preflight(self.config)
        run.assert_not_called()

    def test_space_and_hash_in_project_path_are_quoted_in_env(self):
        config = {**self.config, 'projects_directory': str(self.stack / 'my #projects')}
        m.validate_config(config)
        _, env = m.render(config, self.stack)
        self.assertIn(f"KOBO_PROJECTS_DIR='{config['projects_directory']}'\n", env)


if __name__ == '__main__':
    unittest.main()
