#!/usr/bin/env python3
"""No Docker, network or production state: exercise updater failure boundaries."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys

sys.dont_write_bytecode = True
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'kobo-update'
loader = importlib.machinery.SourceFileLoader('kobo_update', str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
COMPOSE = 'name: kobo\nservices:\n  kobo:\n    image: kobo:old\n    volumes:\n      - kobo-home:/root\n'


class Simulated(m.Updater):
    def __init__(self, stack, fail=None, installed='2.1.16'):
        super().__init__(stack)
        self.fail = fail
        self.installed = installed
        self.events = []
        self.idle_checks = 0

    def inspect(self):
        self.container = 'container'
        self.old_image = 'sha256:old'
        self.volume = 'kobo_kobo-home'
        self.original = self.compose_file.read_bytes()
        self.original_mode = 0o644
        self.config_snapshot = {'name': 'test-kobo', 'services': {}}
        self.idle()
        return 'kobo:old'

    def idle(self):
        self.idle_checks += 1
        if self.fail == 'busy' or (self.fail == 'late-busy' and self.idle_checks == 2):
            raise m.UpdateError('busy')

    def resolve(self, requested):
        return '2.1.17', 'a' * 40

    def build(self, version, sha):
        self.events.append('build')
        if self.fail == 'build':
            raise m.UpdateError('build failed')
        if self.fail == 'compose-changed':
            self.compose_file.write_text(COMPOSE + '# concurrent edit\n')
        return 'kobo:new'

    def run(self, args, **kwargs):
        if '--format' in args and 'config' in args:
            return json.dumps({'changed': True} if self.fail == 'env-changed' else self.config_snapshot)
        if 'stop' in args:
            self.events.append('stop')
        if 'inspect' in args:
            return json.dumps([{'State': {'Running': False}}])
        return ''

    def logged(self, args, **kwargs):
        if m.MIGRATION_JS in args:
            self.events.append('migration')
            if self.fail == 'migration':
                raise m.UpdateError('migration failed')
        if 'up' in args:
            image = 'new' if 'kobo:new' in self.compose_file.read_text() else 'old'
            self.events.append('start-' + image)
            if self.fail == 'launch' and image == 'new':
                raise m.UpdateError('new failed')

    def maintenance(self, method):
        if method == 'GET' and self.fail == 'legacy':
            raise m.UpdateError('Missing atomic update reservation; use --prepare and upgrade manually first.')
        if method == 'POST':
            self.events.append('reserve')
            if self.fail in {'reservation', 'release', 'late-reservation-busy'}:
                raise m.UpdateError('reservation reply lost')
        if method == 'DELETE':
            self.events.append('release')
            if self.fail == 'release':
                raise m.UpdateError('release failed')

    def backup(self):
        self.events.append('backup')
        if self.fail == 'backup':
            raise m.UpdateError('backup failed')
        p = self.job / 'migration-check'
        p.mkdir()
        return p

    def verify(self, version):
        self.events.append('verify')
        if self.fail == 'verify':
            raise m.UpdateError('HTTPS failed')


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = Path(self.tmp.name)
        (self.stack / 'compose.yaml').write_text(COMPOSE)
        quiet = patch.object(m, 'say')
        quiet.start()
        self.addCleanup(quiet.stop)

    def updater(self, fail=None, installed='2.1.16'):
        return Simulated(self.stack, fail, installed)

    def test_compose_uses_selected_directory_not_private_project_name(self):
        u = m.Updater(self.stack)
        command = u.compose('config')
        self.assertEqual(command[command.index('--project-directory') + 1], str(self.stack.resolve()))
        self.assertNotIn('-p', command)

    def test_help_exposes_directory_and_has_no_private_host(self):
        result = subprocess.run(['python3', str(path), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--directory', result.stdout)
        self.assertNotIn('PUBLIC_URL =', path.read_text())

    def test_success_order_and_preserved_mounts(self):
        u = self.updater()
        u.execute('latest')
        self.assertEqual(u.events, ['build','reserve','stop','backup','migration','start-new','verify'])
        self.assertEqual(u.state['phase'], 'complete')
        self.assertEqual(u.compose_file.read_text(), COMPOSE.replace('kobo:old','kobo:new'))
        self.assertEqual((u.job / 'compose.before.yaml').read_text(), COMPOSE)

    def test_check_never_builds_or_stops(self):
        u = self.updater()
        u.execute('latest', check_only=True)
        self.assertEqual(u.events, [])
        self.assertFalse((self.stack / 'updates').exists())

    def test_prepare_never_stops(self):
        u = self.updater()
        u.execute('latest', prepare_only=True)
        self.assertEqual(u.events, ['build'])
        self.assertEqual(u.state['phase'], 'prepared')
        self.assertEqual(u.compose_file.read_text(), COMPOSE)

    def test_current_version_is_noop(self):
        u = self.updater(installed='2.1.17')
        u.execute('latest')
        self.assertEqual(u.events, [])

    def test_active_agents_block_before_build(self):
        u = self.updater('busy')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, [])

    def test_build_failure_never_stops(self):
        u = self.updater('build')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build'])
        self.assertEqual(u.state['phase'], 'aborted')

    def test_agents_started_during_build_block_deployment(self):
        u = self.updater('late-busy')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build'])

    def test_concurrent_compose_edit_preserved(self):
        u = self.updater('compose-changed')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build'])
        self.assertIn('concurrent edit', u.compose_file.read_text())

    def test_changed_environment_blocks_shutdown(self):
        u = self.updater('env-changed')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build'])

    def test_legacy_runtime_fails_before_build_or_shutdown(self):
        u = self.updater('legacy')
        with self.assertRaisesRegex(m.UpdateError, 'atomic'):
            u.execute('latest')
        self.assertEqual(u.events, [])

    def test_prepare_still_supports_legacy_runtime(self):
        u = self.updater('legacy')
        u.execute('latest', prepare_only=True)
        self.assertEqual(u.events, ['build'])

    def test_lost_reservation_response_releases_without_stopping(self):
        u = self.updater('reservation')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build', 'reserve', 'release'])
        self.assertEqual(u.state['phase'], 'aborted')

    def test_agent_starting_after_last_idle_check_is_rejected_by_reservation(self):
        u = self.updater('late-reservation-busy')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.idle_checks, 2)
        self.assertEqual(u.events, ['build', 'reserve', 'release'])
        self.assertNotIn('stop', u.events)

    def test_failed_reservation_cleanup_blocks_future_updates(self):
        u = self.updater('release')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.state['phase'], 'recovery-required')
        with self.assertRaisesRegex(m.UpdateError, 'Interrupted'):
            self.updater().execute('latest')

    def test_interrupted_stop_is_confirmed_before_restarting_old_image(self):
        u = self.updater()
        original_run = u.run
        state = {'running': True, 'stops': 0}
        def run(args, **kwargs):
            if 'stop' in args:
                state['stops'] += 1
                if state['stops'] == 1:
                    raise m.UpdateError('stop reply lost')
                state['running'] = False
                u.events.append('confirmed-stop')
                return ''
            if 'inspect' in args:
                return json.dumps([{'State': {'Running': state['running']}}])
            return original_run(args, **kwargs)
        u.run = run
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build', 'reserve', 'confirmed-stop', 'start-old'])
        self.assertEqual(u.state['phase'], 'aborted')

    def test_backup_failure_restarts_old(self):
        u = self.updater('backup')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build','reserve','stop','backup','start-old'])
        self.assertEqual(u.state['phase'], 'aborted')
        self.assertEqual(u.compose_file.read_text(), COMPOSE)

    def test_migration_failure_restarts_old(self):
        u = self.updater('migration')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertEqual(u.events, ['build','reserve','stop','backup','migration','start-old'])
        self.assertEqual(u.state['phase'], 'aborted')

    def test_launch_failure_never_runs_old_image_on_new_db(self):
        u = self.updater('launch')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertNotIn('start-old', u.events)
        self.assertEqual(u.state['phase'], 'recovery-required')
        self.assertIn('kobo:new', u.compose_file.read_text())

    def test_https_failure_preserves_running_new_version(self):
        u = self.updater('verify')
        with self.assertRaises(m.UpdateError):
            u.execute('latest')
        self.assertNotIn('start-old', u.events)
        self.assertEqual(u.state['phase'], 'recovery-required')

    def test_interrupted_update_blocks_new_attempt(self):
        p = self.stack / 'updates' / 'interrupted'
        p.mkdir(parents=True)
        (p / 'state.json').write_text('{"phase":"launching"}')
        u = self.updater()
        with self.assertRaisesRegex(m.UpdateError, 'Interrupted'):
            u.execute('latest')
        self.assertEqual(u.events, [])

    def test_multiple_images_fail_closed(self):
        with self.assertRaises(m.UpdateError):
            m.image_config(COMPOSE + '    image: other\n', 'new')

    def test_version_validation(self):
        self.assertEqual(m.normalize_version('v2.1.17'), '2.1.17')
        for value in ('--help', '../../tmp', '1.2', '1.2.3;rm', '1.2.3-beta'):
            with self.assertRaises(m.UpdateError):
                m.normalize_version(value)

    def test_annotated_tag_resolution(self):
        u = self.updater()
        u.run = lambda args: 'b' * 40 + '\trefs/tags/v2.1.17\n' + 'a' * 40 + '\trefs/tags/v2.1.17^{}'
        self.assertEqual(m.Updater.resolve(u, '2.1.17'), ('2.1.17', 'a' * 40))

    def test_downgrade_refused(self):
        u = self.updater()
        with self.assertRaisesRegex(m.UpdateError, 'Downgrade'):
            m.Updater.resolve(u, '2.0.0')


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = Path(self.tmp.name)
        (self.stack / 'compose.yaml').write_text(COMPOSE)
        self.u = m.Updater(self.stack)
        self.info = {'State': {'Running': True}, 'Image': 'sha256:old',
                     'Config': {'Image': 'kobo:old'},
                     'Mounts': [{'Destination': '/root', 'Type': 'volume', 'Name': 'custom_home'}]}
        self.config = {'name': 'custom-project', 'volumes': {'home': {'name': 'custom_home'}},
                       'services': {'kobo': {'image': 'kobo:old',
                       'volumes': [{'type': 'volume', 'source': 'home', 'target': '/root'}],
                       'environment': {'KOBO_HOME': '/root/.config/kobo',
                       'KOBO_NETWORK_ACCESS_ENABLED': 'true', 'KOBO_NETWORK_ACCESS_BEHIND_PROXY': 'true',
                       'KOBO_NETWORK_ACCESS_PROXY_HOST': 'workshop.example.org'}}}}
        def run(args, **kwargs):
            if 'ps' in args: return 'container-id'
            if 'inspect' in args: return json.dumps([self.info])
            if 'config' in args: return json.dumps(self.config)
            if '-p' in args and 'node' in args: return '2.1.16'
            if m.BUSY_JS in args: return '{"sessions":0,"workspaces":0}'
            if 'du' in args: return '100 /root'
            if 'context' in args: return 'unix:///var/run/docker.sock'
            if 'info' in args: return '/var/lib/docker'
            if 'run' in args: return str(100 * 1024**3)
            if 'version' in args: return 'v2'
            raise AssertionError(args)
        self.u.run = run

    def test_custom_project_hostname_and_volume_are_discovered(self):
        with patch.object(m.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 100 * 1024**3})()):
            self.u.inspect()
        self.assertEqual(self.u.project_name, 'custom-project')
        self.assertEqual(self.u.public_url, 'https://workshop.example.org')
        self.assertEqual(self.u.volume, 'custom_home')
        command = self.u.compose('ps')
        self.assertEqual(command[command.index('-p')+1], 'custom-project')

    def test_changed_home_volume_is_refused(self):
        self.config['volumes']['home']['name'] = 'different_home'
        with self.assertRaises(m.UpdateError): self.u.inspect()

    def test_nested_home_mount_cannot_silently_escape_backup(self):
        self.info['Mounts'].append({'Destination': '/root/.config/kobo', 'Type': 'bind'})
        with self.assertRaises(m.UpdateError): self.u.inspect()


class ComposeEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = Path(self.tmp.name)
        # Observe the actual child-process environment, without invoking Docker.
        command = self.stack / 'docker'
        command.write_text(f'#!{sys.executable}\nimport json, os, sys\n'
                           'keys = {"KOBO_DOMAIN", "KOBO_PROJECTS_DIR", "TRAEFIK_NETWORK", '
                           '"TRAEFIK_ENTRYPOINT", "TRAEFIK_CERTRESOLVER", "GH_TOKEN", "DOCKER_CONTEXT"}\n'
                           'env = {k: v for k, v in os.environ.items() if k in keys or k.startswith("COMPOSE_")}\n'
                           'print(json.dumps({"env": env, "args": sys.argv[1:]}))\n')
        command.chmod(0o755)
        self.u = m.Updater(self.stack)
        self.u.log = self.stack / 'private.log'
        self.overrides = {'KOBO_DOMAIN': 'wrong.example.com', 'KOBO_PROJECTS_DIR': '/other-projects',
                          'TRAEFIK_NETWORK': 'other-network', 'TRAEFIK_ENTRYPOINT': 'other-entrypoint',
                          'TRAEFIK_CERTRESOLVER': 'other-resolver', 'COMPOSE_FILE': '/other.yml',
                          'COMPOSE_PROJECT_NAME': 'other-project', 'COMPOSE_ENV_FILES': '/other.env',
                          'COMPOSE_PROFILES': 'unwanted', 'COMPOSE_REMOVE_ORPHANS': 'true'}

    def test_capture_and_logged_compose_ignore_ambient_deployment_overrides(self):
        for logged in (False, True):
            with self.subTest(logged=logged), patch.dict(os.environ, {
                    **self.overrides, 'PATH': str(self.stack) + os.pathsep + os.environ['PATH'],
                    'GH_TOKEN': 'test-explicit-token', 'DOCKER_CONTEXT': 'test-context'}):
                command = self.u.compose('config')
                if logged:
                    self.u.logged(command)
                    received = json.loads(self.u.log.read_text())
                else:
                    received = json.loads(self.u.run(command))
                for key, value in self.overrides.items():
                    self.assertNotIn(key, received['env'])
                    self.assertEqual(os.environ[key], value)
                self.assertEqual(received['env']['GH_TOKEN'], 'test-explicit-token')
                self.assertEqual(received['env']['DOCKER_CONTEXT'], 'test-context')
                args = received['args']
                self.assertEqual(args[args.index('--env-file') + 1], str(self.stack.resolve() / '.env'))

    def test_non_compose_process_keeps_its_environment(self):
        with patch.dict(os.environ, {'PATH': str(self.stack) + os.pathsep + os.environ['PATH'],
                                    'KOBO_DOMAIN': 'caller.example.com'}):
            received = json.loads(self.u.run(['docker', 'build', '.']))
        self.assertEqual(received['env']['KOBO_DOMAIN'], 'caller.example.com')


if __name__ == '__main__':
    unittest.main()
