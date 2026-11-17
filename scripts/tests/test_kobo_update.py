#!/usr/bin/env python3
"""No Docker, network or production state: exercise updater failure boundaries."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat as stat_module
import tempfile
import subprocess
import sys
import tarfile
from types import SimpleNamespace
import urllib.error

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
        self.trigger_calls = []  # (method, path, body, timeout)
        self.reports = []  # (phase, reason) actually sent to /update-trigger/report
        self.maintenance_calls = []
        self.locatable = True
        self.running = 'container'  # what `compose ps -q kobo` answers now
        self.after_launch = 'container-new'  # `up` with a new image recreates the container; None: none runs
        self.report_targets = []  # container each report was sent to
        self.poll_reply = {'status': 200, 'body': {'protocol': 1, 'request': None}}
        self.stop_reply = {'status': 200, 'body': {'protocol': 1, 'stopped': 0, 'unconfirmed': 0, 'reserved': True}}
        self.report_reply = {'status': 200, 'body': {}}

    def locate(self):
        if not self.locatable or self.running is None:
            return False
        self.container = self.running
        return True

    def trigger(self, method, path, body=None, timeout=10):
        self.trigger_calls.append((method, path, body, timeout))
        if path == 'update-trigger/poll':
            return self.poll_reply
        if path == 'update-trigger/stop-agents':
            self.events.append('stop-agents')
            return self.stop_reply
        if path == 'update-trigger/report':
            self.reports.append((body['phase'], body.get('reason')))
            self.report_targets.append(self.container)
            return self.report_reply
        raise AssertionError(path)

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
        if self.ui and self.ui['stopAgents']:
            return  # mirrors Updater.idle: a forced stop does not wait for agents
        self.idle_checks += 1
        if self.fail == 'busy' or (self.fail == 'late-busy' and self.idle_checks == 2):
            raise m.UpdateError('busy', code='busy')

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
            if image == 'new':
                self.running = self.after_launch
            if self.fail == 'launch' and image == 'new':
                raise m.UpdateError('new failed')

    def maintenance(self, method):
        self.maintenance_calls.append(method)
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
        result = subprocess.run([sys.executable, str(path), '--help'], capture_output=True, text=True)
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
        self.assertEqual(u.state['backup_scope'], '/root/.config/kobo')
        self.assertEqual(u.state['backup_archive'], 'kobo.tar.gz')
        recovery = (u.job / 'RECOVERY.md').read_text()
        self.assertIn('replace\n.config/kobo completely', recovery)
        self.assertIn('Clone that\nstopped volume into a NEW Docker volume', recovery)
        self.assertNotIn('home.tar.gz', recovery)
        self.assertIs(u.state['backup_skipped'], False)
        self.assertIs(u.state['backup_complete'], True)
        self.assertNotIn('--skip-backup', recovery)

    def test_skip_backup_records_no_archive_and_warns(self):
        u = self.updater()
        with patch.object(m, 'say') as say:
            u.execute('latest', skip_backup=True)
        # The migration test on a database copy still runs.
        self.assertEqual(u.events, ['build','reserve','stop','backup','migration','start-new','verify'])
        self.assertEqual(u.state['phase'], 'complete')
        self.assertIs(u.state['backup_skipped'], True)
        self.assertIs(u.state['backup_complete'], False)
        self.assertIsNone(u.state['backup_archive'])
        self.assertIsNone(u.state['backup_scope'])
        said = ' '.join(call.args[0] for call in say.call_args_list)
        self.assertIn('WARNING: --skip-backup', said)
        self.assertIn('No backup was created', said)
        self.assertNotIn('kobo.tar.gz"', said)
        recovery = (u.job / 'RECOVERY.md').read_text()
        self.assertIn('NO BACKUP ARCHIVE EXISTS', recovery)
        self.assertNotIn('contents of kobo.tar.gz', recovery)
        self.assertNotIn('backup_complete=true', recovery)

    def test_skip_backup_failure_still_restarts_old(self):
        u = self.updater('migration')
        with self.assertRaises(m.UpdateError):
            u.execute('latest', skip_backup=True)
        self.assertEqual(u.events, ['build','reserve','stop','backup','migration','start-old'])
        self.assertEqual(u.state['phase'], 'aborted')
        self.assertIs(u.state['backup_complete'], False)

    def test_skip_backup_is_documented_and_refused_with_check_or_prepare(self):
        result = subprocess.run([sys.executable, str(path), '--help'], capture_output=True, text=True)
        self.assertIn('--skip-backup', result.stdout)
        for mode in ('--check', '--prepare'):
            result = subprocess.run([sys.executable, str(path), '--skip-backup', mode], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('--skip-backup only applies', result.stderr)
        u = self.updater()
        with patch.object(m, 'say') as say:
            u.execute('latest', prepare_only=True, skip_backup=True)
        self.assertIs(u.state['backup_skipped'], False)
        self.assertFalse(any('WARNING' in call.args[0] for call in say.call_args_list))

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


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = Path(self.tmp.name)
        self.home = self.stack / 'home'
        self.data = self.home / '.config/kobo'
        self.data.mkdir(parents=True)
        for name in ['kobo.db', 'kobo.db-wal', 'kobo.db-shm', 'settings.json', 'skills.json']:
            (self.data / name).write_bytes(('fixture-' + name).encode())
        (self.data / 'attachments').mkdir()
        (self.data / 'attachments/image.png').write_bytes(b'attachment')
        for directory in ['.claude', '.codex', '.cache', '.npm', 'projects']:
            target = self.home / directory
            target.mkdir()
            (target / 'excluded').write_bytes(b'must not be archived')
        self.u = m.Updater(self.stack)
        self.u.job = self.stack / 'job'
        self.u.job.mkdir()
        self.u.log = self.u.job / 'update.log'
        self.u.volume = 'home-volume'
        self.u.old_image = 'sha256:old'
        self.command = None
        real_run = subprocess.run

        def local_tar(args, **kwargs):
            self.command = args
            self.assertIn('--read-only', args)
            self.assertIn('type=volume,src=home-volume,dst=/data,readonly', args)
            # Run the exact tar arguments against a temporary fixture, not Docker.
            entrypoint = args[args.index('--entrypoint') + 1]
            tar_args = args[args.index(self.u.old_image) + 1:]
            if entrypoint == 'sh':
                # --skip-backup: the same shell script, pointed at the fixture instead of /data.
                return real_run(['sh', '-c', tar_args[1].replace('/data', str(self.home))], **kwargs)
            tar_args[tar_args.index('/data')] = str(self.home)
            return real_run(['tar', *tar_args], **kwargs)
        patcher = patch.object(m.subprocess, 'run', side_effect=local_tar)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_archives_only_kobo_and_copies_sqlite_sidecars_for_migration(self):
        check = self.u.backup()
        with tarfile.open(self.u.job / 'kobo.tar.gz') as archive:
            names = set(archive.getnames())
        self.assertIn('./.config/kobo/settings.json', names)
        self.assertIn('./.config/kobo/skills.json', names)
        self.assertIn('./.config/kobo/attachments/image.png', names)
        self.assertTrue(all(n == './.config/kobo' or n.startswith('./.config/kobo/') for n in names))
        self.assertEqual({p.name for p in check.iterdir()}, {'kobo.db', 'kobo.db-wal', 'kobo.db-shm'})
        for item in check.iterdir():
            self.assertEqual(item.read_bytes(), (self.data / item.name).read_bytes())
        self.assertFalse((self.u.job / 'home.tar.gz').exists())

    def test_does_not_follow_symlinks_outside_kobo(self):
        (self.data / 'external-cache').symlink_to(self.home / '.cache', target_is_directory=True)
        self.u.backup()
        with tarfile.open(self.u.job / 'kobo.tar.gz') as archive:
            self.assertTrue(archive.getmember('./.config/kobo/external-cache').issym())
            self.assertNotIn('./.config/kobo/external-cache/excluded', archive.getnames())

    def test_rejects_missing_database(self):
        (self.data / 'kobo.db').unlink()
        with self.assertRaisesRegex(m.UpdateError, 'does not contain'):
            self.u.backup()

    def test_rejects_symlink_database(self):
        (self.data / 'kobo.db').unlink()
        (self.data / 'kobo.db').symlink_to(self.home / '.claude/excluded')
        with self.assertRaisesRegex(m.UpdateError, 'Unexpected SQLite'):
            self.u.backup()

    def test_missing_data_directory_fails_backup(self):
        self.data.rename(self.home / 'moved')
        with self.assertRaisesRegex(m.UpdateError, 'Failed: backup'):
            self.u.backup()

    def test_skip_backup_creates_no_archive_but_copies_sqlite_for_migration(self):
        self.u.skip_backup = True
        check = self.u.backup()
        self.assertEqual({p.name for p in self.u.job.iterdir()}, {'update.log', 'migration-check'})
        self.assertEqual({p.name for p in check.iterdir()}, {'kobo.db', 'kobo.db-wal', 'kobo.db-shm'})
        for item in check.iterdir():
            self.assertEqual(item.read_bytes(), (self.data / item.name).read_bytes())
        self.assertNotIn('./.config/kobo', self.command)

    def test_skip_backup_tolerates_absent_sidecars_but_requires_database(self):
        (self.data / 'kobo.db-wal').unlink()
        (self.data / 'kobo.db-shm').unlink()
        self.u.skip_backup = True
        self.assertEqual({p.name for p in self.u.backup().iterdir()}, {'kobo.db'})
        (self.data / 'kobo.db').unlink()
        self.u.job = self.stack / 'job2'
        self.u.job.mkdir()
        self.u.log = self.u.job / 'update.log'
        with self.assertRaisesRegex(m.UpdateError, 'does not contain'):
            self.u.backup()
        self.assertFalse(any(p.suffix in {'.tar', '.gz'} for p in self.u.job.iterdir()))

    def test_skip_backup_rejects_symlink_database(self):
        (self.data / 'kobo.db').unlink()
        (self.data / 'kobo.db').symlink_to(self.home / '.claude/excluded')
        self.u.skip_backup = True
        with self.assertRaisesRegex(m.UpdateError, 'Unexpected SQLite'):
            self.u.backup()


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
            if 'du' in args:
                self.assertEqual(args[-1], '/root/.config/kobo')
                return '100 /root/.config/kobo'
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
                          'KOBO_UID': '0', 'KOBO_GID': '0',
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


REQUEST = {'id': 'r1', 'skipBackup': False, 'stopAgents': False}


class Capturing(m.Updater):
    """Real Updater methods; only the subprocess boundary is scripted."""
    def __init__(self, stack, replies=None, fail=False):
        super().__init__(stack)
        self.calls = []
        self.replies = list(replies or [])
        self.fail = fail

    def run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if self.fail:
            raise m.UpdateError('boom')
        return self.replies.pop(0) if self.replies else ''


class UiRequestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = Path(self.tmp.name)
        (self.stack / 'compose.yaml').write_text(COMPOSE)
        quiet = patch.object(m, 'say')
        quiet.start()
        self.addCleanup(quiet.stop)

    def serve(self, fail=None, request=REQUEST, installed='2.1.16', expected=0, **attrs):
        u = Simulated(self.stack, fail, installed)
        for key, value in attrs.items():
            setattr(u, key, value)
        if request is not None:
            u.poll_reply = {'status': 200, 'body': {'protocol': 1, 'request': request}}
        with patch.object(m, 'Updater', lambda stack: u):
            self.assertEqual(m.serve_ui_request(self.stack), expected)
        return u

    def test_serve_without_request_does_nothing(self):
        u = self.serve(request=None)
        self.assertEqual(u.events, [])
        self.assertEqual(u.reports, [])
        self.assertFalse((self.stack / 'updates').exists())

    def test_serve_quiet_on_legacy_runtime_and_missing_container(self):
        u = self.serve(request=None, poll_reply={'status': 404, 'body': {}})
        self.assertEqual((u.events, u.reports), ([], []))
        self.assertFalse((self.stack / 'updates').exists())
        u = self.serve(request=REQUEST, locatable=False)
        self.assertEqual(u.trigger_calls, [])
        self.assertEqual(u.events, [])
        with patch.object(m, 'say') as say:
            self.serve(request=None)
        say.assert_not_called()

    def test_serve_runs_update_and_reports_phases(self):
        u = self.serve()
        self.assertEqual([phase for phase, _ in u.reports], ['building', 'restarting', 'complete'])
        self.assertEqual(u.state['phase'], 'complete')
        self.assertIs(u.state['backup_complete'], True)
        self.assertEqual(u.events, ['build', 'reserve', 'stop', 'backup', 'migration', 'start-new', 'verify'])
        for _, path, body, _ in u.trigger_calls[1:]:
            self.assertEqual(body['id'], 'r1')

    def test_serve_honours_skip_backup(self):
        u = self.serve(request={**REQUEST, 'skipBackup': True})
        self.assertIs(u.state['backup_skipped'], True)
        self.assertEqual(u.state['phase'], 'complete')

    def test_serve_reports_up_to_date(self):
        u = self.serve(installed='2.1.17')
        self.assertEqual(u.reports, [('up-to-date', None)])
        self.assertEqual(u.events, [])

    def test_serve_reports_busy_refusal(self):
        u = self.serve('busy')
        self.assertEqual(u.reports[-1], ('refused', 'busy'))
        self.assertFalse((self.stack / 'updates').exists())

    def test_held_lock_leaves_the_request_pending_without_polling(self):
        import fcntl
        with (self.stack / '.update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(m, 'say') as say:
                u = self.serve()
        self.assertEqual((u.trigger_calls, u.reports, u.events), ([], [], []))
        say.assert_not_called()

    def test_unopenable_lock_is_reported_without_polling_or_failing_the_unit(self):
        with patch.object(m, 'update_lock', side_effect=PermissionError('x')), patch.object(m, 'say') as say:
            u = self.serve()
        self.assertEqual((u.trigger_calls, u.reports, u.events), ([], [], []))
        say.assert_called_once_with('Cannot open the update lock in the stack directory; check its owner.')

    def test_lock_is_held_while_polling(self):
        import fcntl
        held = []

        def poll(method, path, body=None, timeout=10):
            with (self.stack / '.update.lock').open('a') as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(False)
                except BlockingIOError:
                    held.append(True)
            return {'status': 200, 'body': {'protocol': 1, 'request': None}}

        self.serve(request=None, trigger=poll)
        self.assertEqual(held, [True])

    def test_registry_http_error_reports_unknown_not_its_status(self):
        def resolve(requested):
            raise urllib.error.HTTPError('https://registry', 503, 'unavailable', {}, None)
        u = self.serve(resolve=resolve)
        self.assertEqual(u.reports[-1], ('refused', 'unknown'))

    def test_report_only_sends_known_reasons(self):
        u = Simulated(self.stack)
        u.ui = dict(REQUEST)
        u.report('refused', 503)
        self.assertEqual(u.reports, [('refused', 'unknown')])
        for reason in ('busy', 'already-running', 'interrupted-update', 'legacy-runtime', 'unknown'):
            u.reported = None
            u.report('refused', reason)
            self.assertEqual(u.reports[-1], ('refused', reason))

    def test_serve_mode_rejects_skip_backup_and_version(self):
        for extra in (['--skip-backup'], ['2.1.17']):
            result = subprocess.run([sys.executable, str(path), '--serve-ui-request', *extra],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('--serve-ui-request', result.stderr)

    def test_serve_exit_code_is_1_only_for_recovery_required(self):
        for fail in ('busy', 'migration', None):
            self.assertEqual(self.serve(fail).state.get('phase') in (None, 'aborted', 'complete'), True)
        u = self.serve('launch', expected=1)
        self.assertEqual(u.state['phase'], 'recovery-required')

    def job(self, name, state):
        job = self.stack / 'updates' / name
        job.mkdir(parents=True, exist_ok=True)
        (job / 'state.json').write_text(state)
        return job

    def test_recovery_required_job_keeps_the_unit_failed_without_polling(self):
        self.job('20261117T100000Z-a', '{"phase": "complete"}')
        job = self.job('20261117T110000Z-b', '{"phase": "recovery-required"}')
        for _ in range(2):
            with patch.object(m, 'say') as say:
                u = self.serve(expected=1)
            self.assertEqual((u.trigger_calls, u.events, u.reports), ([], [], []))
            say.assert_called_once()
            line = say.call_args.args[0]
            self.assertIn(job.name, line)
            self.assertNotIn(str(self.stack), line)
        for phase in ('aborted', 'complete'):
            (job / 'state.json').write_text(json.dumps({'phase': phase}))
            with patch.object(m, 'say') as say:
                self.serve(request=None)
            say.assert_not_called()

    def test_ui_request_id_is_recorded_only_for_ui_runs(self):
        u = self.serve()
        self.assertEqual(json.loads((u.job / 'state.json').read_text())['ui_request_id'], 'r1')
        plain = Simulated(self.stack)
        plain.execute('latest')
        self.assertNotIn('ui_request_id', json.loads((plain.job / 'state.json').read_text()))

    def test_recovery_report_is_sent_again_on_each_run(self):
        first = self.serve('launch', expected=1)
        job = first.job.name
        for _ in range(2):
            with patch.object(m, 'say') as say:
                u = self.serve(expected=1)
            self.assertEqual([c[1] for c in u.trigger_calls], ['update-trigger/report'])
            self.assertEqual(u.trigger_calls[0][2], {'id': 'r1', 'phase': 'recovery-required'})
            self.assertEqual(u.report_targets, ['container'])  # located again before sending
            self.assertEqual(u.events, [])
            self.assertIn(job, say.call_args.args[0])

    def test_recovery_report_resend_never_raises(self):
        self.job('20261117T110000Z-b', '{"phase": "recovery-required", "ui_request_id": "r7"}')
        u = self.serve(expected=1, report_reply=None, running=None)
        self.assertEqual(u.reports, [('recovery-required', None)])

    def test_unreadable_job_state_is_left_to_the_execute_check(self):
        self.job('broken', 'not json')
        self.job('list', '[]')
        self.serve(request=None)

    def test_no_updates_directory_is_silent(self):
        with patch.object(m, 'say') as say:
            self.serve(request=None)
        say.assert_not_called()

    def test_recovery_report_goes_to_the_recreated_container(self):
        u = self.serve('launch', expected=1)
        self.assertEqual(u.reports[-1], ('recovery-required', None))
        self.assertEqual(u.report_targets[-1], 'container-new')

    def test_complete_report_goes_to_the_recreated_container(self):
        u = self.serve()
        self.assertEqual(u.reports[-1], ('complete', None))
        self.assertEqual(u.report_targets[-1], 'container-new')

    def test_final_report_stays_best_effort_when_no_container_is_found(self):
        u = self.serve('launch', expected=1, after_launch=None)
        self.assertEqual(u.state['phase'], 'recovery-required')
        self.assertEqual(u.reports[-1], ('recovery-required', None))
        self.assertEqual(u.report_targets[-1], 'container')

    def test_reservation_conflict_in_a_ui_run_is_reported_busy(self):
        conflict = Capturing(self.stack, ['{"status": 409}'])
        conflict.container = 'cid'

        def maintenance(method):
            if method == 'POST':
                conflict.maintenance('POST')

        u = self.serve(maintenance=maintenance)
        # Nothing was stopped: the restart is never announced before the reservation is obtained.
        self.assertEqual(u.reports, [('building', None), ('refused', 'busy')])
        self.assertEqual(u.state['phase'], 'aborted')

    def test_reservation_conflict_message_of_a_plain_run_is_unchanged(self):
        conflict = Capturing(self.stack, ['{"status": 409}'])
        conflict.container = 'cid'
        u = Simulated(self.stack)
        u.maintenance = lambda method: conflict.maintenance('POST') if method == 'POST' else None
        with patch.object(m, 'Updater', lambda stack: u), patch.object(m.signal, 'signal'), \
                patch.object(m, 'say') as say, patch.object(m.os, 'umask'), \
                patch.object(sys, 'argv', ['kobo-update', '--directory', str(self.stack)]):
            self.assertEqual(m.main(), 1)
        # Unchanged wording, including the double period main() has always printed for this message.
        say.assert_called_with('Stopped: ' + 'Update reservation POST refused (HTTP 409).' + '.')

    def test_main_propagates_serve_exit_code(self):
        for code in (0, 1):
            with patch.object(m, 'serve_ui_request', return_value=code), patch.object(m.signal, 'signal'), \
                    patch.object(sys, 'argv', ['kobo-update', '--serve-ui-request', '--directory', str(self.stack)]):
                self.assertEqual(m.main(), code)

    def test_failure_before_the_try_is_still_reported(self):
        def broken():
            raise RuntimeError('disk full')
        u = self.serve(recovery_notes=broken)
        self.assertEqual(u.reports[-1], ('refused', 'unknown'))
        job = next((self.stack / 'updates').iterdir())
        self.assertEqual(json.loads((job / 'state.json').read_text())['phase'], 'building')
        self.assertEqual(u.events, [])

    def test_serve_reports_unknown_for_uncoded_refusal(self):
        u = self.serve('legacy')
        self.assertEqual(u.reports[-1], ('refused', 'unknown'))

    def test_forced_stop_skips_idle_and_stops_agents(self):
        u = self.serve('busy', request={**REQUEST, 'stopAgents': True})
        self.assertEqual(u.state['phase'], 'complete')
        self.assertEqual(u.events, ['build', 'stop-agents', 'stop', 'backup', 'migration', 'start-new', 'verify'])
        stops = [c for c in u.trigger_calls if c[1] == 'update-trigger/stop-agents']
        self.assertEqual(stops, [('POST', 'update-trigger/stop-agents',
                                  {'id': 'r1', 'owner': u.maintenance_owner}, 60)])
        self.assertNotIn('POST', u.maintenance_calls)
        self.assertIn('GET', u.maintenance_calls)
        self.assertEqual([phase for phase, _ in u.reports],
                         ['building', 'stopping-agents', 'restarting', 'complete'])

    def check_forced_refusal(self, u, code):
        self.assertEqual(u.state['phase'], 'aborted')
        self.assertEqual(u.reports[-1], ('refused', code))
        self.assertNotIn('stop', u.events)
        self.assertEqual(u.maintenance_calls.count('DELETE'), 1)
        self.assertNotIn('POST', u.maintenance_calls)

    def test_forced_stop_unconfirmed_refuses(self):
        for reply, code in (({'status': 409, 'body': {'code': 'busy', 'stopped': 0, 'unconfirmed': 1}}, 'busy'),
                            ({'status': 200, 'body': {'protocol': 1, 'stopped': 0, 'unconfirmed': 1,
                                                      'reserved': True}}, 'unknown')):
            with self.subTest(reply=reply):
                u = self.serve(request={**REQUEST, 'stopAgents': True}, stop_reply=reply)
                self.check_forced_refusal(u, code)

    def test_forced_stop_refusal_releases_reservation(self):
        u = self.serve(request={**REQUEST, 'stopAgents': True},
                       stop_reply={'status': 409, 'body': {'code': 'busy', 'stopped': 1, 'unconfirmed': 0}})
        self.check_forced_refusal(u, 'busy')

    def test_forced_stop_lost_reply_releases_reservation(self):
        u = self.serve(request={**REQUEST, 'stopAgents': True}, stop_reply=None)
        self.check_forced_refusal(u, 'unknown')

    def test_forced_stop_not_accepted_is_unknown_not_busy(self):
        # Kōbō restarted during the build: the request is gone and the 409 carries no code.
        for reply in ({'status': 409, 'body': {'error': 'Unknown update request or agents not to be stopped'}},
                      {'status': 500, 'body': {'error': 'boom'}},
                      {'status': 409, 'body': 'not an object'},
                      {'status': 409, 'body': {'code': 'other'}},
                      {}):
            with self.subTest(reply=reply):
                with patch.object(m, 'say') as say:
                    u = self.serve(request={**REQUEST, 'stopAgents': True}, stop_reply=reply)
                self.check_forced_refusal(u, 'unknown')
                self.assertIn('not accepted', say.call_args.args[0])

    def test_forced_stop_conflict_reports_already_running(self):
        u = self.serve(request={**REQUEST, 'stopAgents': True},
                       stop_reply={'status': 409, 'body': {'code': 'conflict', 'stopped': 0, 'unconfirmed': 0}})
        self.check_forced_refusal(u, 'already-running')

    def test_forced_stop_requires_integer_zero_unconfirmed(self):
        for unconfirmed in (False, 0.0):
            u = self.serve(request={**REQUEST, 'stopAgents': True},
                           stop_reply={'status': 200, 'body': {'protocol': 1, 'stopped': 0,
                                                               'unconfirmed': unconfirmed, 'reserved': True}})
            self.check_forced_refusal(u, 'unknown')

    def test_forced_stop_requires_reserved_reply(self):
        u = self.serve(request={**REQUEST, 'stopAgents': True},
                       stop_reply={'status': 200, 'body': {'protocol': 1, 'stopped': 0, 'unconfirmed': 0}})
        self.check_forced_refusal(u, 'unknown')

    def test_late_failure_after_stop_reports_aborted_not_refused(self):
        u = self.serve('migration')
        self.assertEqual(u.state['phase'], 'aborted')
        self.assertEqual(u.reports[-1], ('aborted', None))

    def test_launch_failure_reports_recovery_required(self):
        u = self.serve('launch', expected=1)
        self.assertEqual(u.reports[-1], ('recovery-required', None))

    def test_report_failure_does_not_change_outcome(self):
        u = self.serve(report_reply=None)
        self.assertEqual(u.state['phase'], 'complete')

    def test_report_409_is_ignored(self):
        u = self.serve(report_reply={'status': 409, 'body': {'error': 'Unknown update request'}})
        self.assertEqual(u.state['phase'], 'complete')

    def test_report_never_raises_and_skips_duplicates(self):
        u = Simulated(self.stack)
        u.report('building')  # no ui: no-op
        self.assertEqual(u.trigger_calls, [])
        u.ui = dict(REQUEST)
        u.report('building')
        u.report('building')
        u.report('refused', 'busy')
        self.assertEqual(u.reports, [('building', None), ('refused', 'busy')])
        self.assertEqual(u.trigger_calls[0],
                         ('POST', 'update-trigger/report', {'id': 'r1', 'phase': 'building'}, 10))

    def test_plain_run_never_calls_trigger(self):
        u = Simulated(self.stack)
        u.execute('latest')
        self.assertEqual(u.trigger_calls, [])
        self.assertEqual(u.maintenance_calls, ['GET', 'POST'])
        c = Capturing(self.stack, ['{"status":200,"protocol":1}'])
        c.container = 'cid'
        c.maintenance('POST')
        self.assertEqual(c.calls[0][0], ['docker', 'exec', 'cid', 'node', '-e', m.MAINTENANCE_JS,
                                         'POST', c.maintenance_owner])

    def test_trigger_runs_in_container_and_never_raises(self):
        c = Capturing(self.stack, ['{"status": 200, "body": {"request": null}}'])
        c.container = 'cid'
        self.assertEqual(c.trigger('POST', 'update-trigger/stop-agents', {'id': 'r1'}, 60),
                         {'status': 200, 'body': {'request': None}})
        args = c.calls[0][0]
        self.assertEqual(args[:6], ['docker', 'exec', 'cid', 'node', '-e', m.TRIGGER_JS])
        self.assertEqual(args[6:], ['POST', 'update-trigger/stop-agents', '{"id": "r1"}', '60000'])
        c.replies = ['not json']
        self.assertIsNone(c.trigger('GET', 'update-trigger/poll'))
        self.assertIsNone(Capturing(self.stack, fail=True).trigger('GET', 'update-trigger/poll'))

    def test_locate_finds_exactly_one_container_and_never_raises(self):
        c = Capturing(self.stack, ['abc\n'])
        self.assertIs(m.Updater.locate(c), True)
        self.assertEqual(c.container, 'abc')
        for output in ('', 'a\nb'):
            self.assertIs(m.Updater.locate(Capturing(self.stack, [output])), False)
        self.assertIs(m.Updater.locate(Capturing(self.stack, fail=True)), False)

    def test_forced_stop_does_not_check_idle(self):
        c = Capturing(self.stack, ['{"sessions": 2, "workspaces": 1}'])
        c.ui = dict(REQUEST, stopAgents=True)
        c.idle()
        self.assertEqual(c.calls, [])
        c.ui = dict(REQUEST)
        with self.assertRaises(m.UpdateError) as caught:
            c.idle()
        self.assertEqual(caught.exception.code, 'busy')

    def test_error_codes(self):
        self.assertIsNone(m.UpdateError('x').code)
        c = Capturing(self.stack, ['{"status":404}'])
        c.container = 'cid'
        with self.assertRaises(m.UpdateError) as caught:
            c.maintenance('GET')
        self.assertEqual(caught.exception.code, 'legacy-runtime')
        job = self.stack / 'updates' / 'old'
        job.mkdir(parents=True)
        (job / 'state.json').write_text('{"phase": "building"}')
        with self.assertRaises(m.UpdateError) as caught:
            Simulated(self.stack).execute('latest')
        self.assertEqual(caught.exception.code, 'interrupted-update')
        with m.update_lock(self.stack):
            with self.assertRaises(m.UpdateError) as caught:
                with m.update_lock(self.stack):
                    pass
        self.assertEqual(caught.exception.code, 'already-running')


REAL_OWNER_UID = m.owner_uid
SERVICE = """[Unit]
Description=Run a Kōbō update requested from the web interface
After=docker.service

[Service]
Type=oneshot
User=deploy
WorkingDirectory=/srv/kobo
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/srv/kobo/bin/kobo-update --serve-ui-request --directory /srv/kobo
TimeoutStopSec=600
KillMode=mixed
"""
TIMER = """[Unit]
Description=Poll Kōbō for an update requested from the web interface

[Timer]
OnBootSec=1min
OnUnitInactiveSec=1min
AccuracySec=5s
Unit=kobo-ui-update.service

[Install]
WantedBy=timers.target
"""
RELOAD = ['systemctl', 'daemon-reload']
ENABLE = ['systemctl', 'enable', '--now', 'kobo-ui-update.timer']
DISABLE = ['systemctl', 'disable', '--now', 'kobo-ui-update.timer']


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.stack = root / 'stack'
        self.stack.mkdir()
        self.stack.chmod(0o755)
        (self.stack / 'compose.yaml').write_text(COMPOSE)
        self.script = self.make_script(self.stack / 'kobo-update')
        self.units = root / 'units'
        self.units.mkdir()
        self.calls = []
        self.systemctl_fails = None
        self.owner = 'deploy'
        self.uid = os.getuid() or 1000  # files made by the test are owned by us (or by root, also accepted)
        self.euid = 0
        self.said = []
        for target, new in (
                (m.os, {'geteuid': lambda: self.euid}),
                (m, {'owner_uid': lambda stack: self.uid}),
                (m.pwd, {'getpwuid': self.getpwuid}),
                (m.subprocess, {'run': self.systemctl}),
                (m.shutil, {'which': lambda name: '/usr/bin/' + name}),
                (m, {'say': lambda message: self.said.append(message)})):
            for name, value in new.items():
                patcher = patch.object(target, name, value)
                patcher.start()
                self.addCleanup(patcher.stop)

    def make_script(self, path, mode=0o755, content=b'#!/usr/bin/env python3\n'):
        path.write_bytes(content)
        path.chmod(mode)
        return path

    def getpwuid(self, uid):
        if self.owner is None:
            raise KeyError(uid)
        return SimpleNamespace(pw_name=self.owner)

    def systemctl(self, args, **kwargs):
        self.calls.append(args)
        self.assertEqual(args[0], 'systemctl')
        self.assertNotIn('shell', kwargs)
        failed = self.systemctl_fails is not None and self.systemctl_fails in args
        return subprocess.CompletedProcess(args, 1 if failed else 0, b'', b'secret stderr')

    def install(self, script=None):
        m.install_ui_trigger(self.stack, self.units, script=script or self.script)

    def assert_untouched(self):
        self.assertEqual(sorted(self.units.iterdir()), [])
        self.assertEqual(self.calls, [])

    def refused(self, word, script=None):
        with self.assertRaises(m.UpdateError) as caught:
            self.install(script)
        self.assertIn(word, str(caught.exception))
        self.assert_untouched()

    def test_unit_files_exact_text(self):
        files = m.unit_files(Path('/srv/kobo'), Path('/srv/kobo/bin/kobo-update'), 'deploy')
        self.assertEqual(files, {'kobo-ui-update.service': SERVICE, 'kobo-ui-update.timer': TIMER})

    def test_unit_files_for_both_layouts(self):
        resolved = self.stack.resolve()
        for script in (resolved / 'bin' / 'kobo-update', resolved / 'kobo-update'):
            service = m.unit_files(resolved, script, 'deploy')['kobo-ui-update.service']
            self.assertIn(f'\nExecStart={script} --serve-ui-request --directory {resolved}\n', service)
            self.assertIn(f'\nWorkingDirectory={resolved}\n', service)
            self.assertNotIn(self.tmp.name + '/units', service)

    def test_install_writes_two_files_then_reloads_and_enables(self):
        self.install()
        self.assertEqual(sorted(p.name for p in self.units.iterdir()),
                         ['kobo-ui-update.service', 'kobo-ui-update.timer'])
        for p in self.units.iterdir():
            self.assertEqual(p.stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.units / 'kobo-ui-update.service').read_text(),
                         m.unit_files(self.stack.resolve(), self.script.resolve(), 'deploy')['kobo-ui-update.service'])
        self.assertEqual(self.calls, [RELOAD, ENABLE])
        self.assertEqual(len(self.said), 2)
        self.assertIn('every minute', self.said[0])
        self.assertIn('--uninstall-ui-trigger', self.said[1])
        self.assertEqual(sorted(p.name for p in self.stack.iterdir()), ['compose.yaml', 'kobo-update'])

    def test_install_refusals_write_nothing(self):
        cases = [('not root', lambda: setattr(self, 'euid', 1000), 'sudo'),
                 ('uid 0 owner', lambda: setattr(self, 'uid', 0), 'root'),
                 ('no passwd entry', lambda: setattr(self, 'owner', None), 'user'),
                 ('no compose', lambda: (self.stack / 'compose.yaml').unlink(), 'compose.yaml')]
        for name, arrange, word in cases:
            with self.subTest(name):
                self.setUp()
                arrange()
                self.refused(word)

    def test_user_name_is_validated(self):
        for bad in ('a%b', 'evil\nExecStart=/bin/sh', '', '1abc', 'a b', 'deploy\n'):
            with self.subTest(bad):
                self.setUp()
                self.owner = bad
                self.refused('user')
        for good in ('deploy', '_svc', 'a.b-c_d', 'machine$'):
            self.setUp()
            self.owner = good
            self.install()

    def test_unsafe_paths_are_refused(self):
        for bad in ('my stack', 'a"b', "a'b", 'a\\b', 'a%b', 'a$b'):
            with self.subTest(bad):
                stack = Path(self.tmp.name) / bad
                stack.mkdir()
                stack.chmod(0o755)
                (stack / 'compose.yaml').write_text(COMPOSE)
                script = self.make_script(stack / 'kobo-update')
                with self.assertRaises(m.UpdateError):
                    m.install_ui_trigger(stack, self.units, script=script)
                self.assert_untouched()
        with self.assertRaises(m.UpdateError):
            m.unit_files(self.stack.resolve(), Path('/opt/my tools/kobo-update'), 'deploy')

    def test_script_must_be_trustworthy(self):
        self.script.chmod(0o775)
        self.refused('writable by group or others')
        self.script.chmod(0o757)
        self.refused('writable by group or others')
        self.script.chmod(0o755)
        self.stack.chmod(0o777)
        self.refused('script directory')
        self.stack.chmod(0o755)
        self.script.chmod(0o644)
        self.refused('not executable')
        self.make_script(self.script, content=b'print("no shebang")\n')
        self.refused('#!')
        self.refused('not found', self.stack / 'missing')

    def owned_by(self, uid):
        """The script and its directory as if `uid` owned them: a test cannot chown."""
        real = Path.stat
        mine = {os.path.realpath(self.script), os.path.realpath(self.stack)}

        def stat(path, *args, **kwargs):
            st = real(path, *args, **kwargs)
            if os.path.realpath(path) not in mine:
                return st
            fields = list(st)
            fields[stat_module.ST_UID] = uid
            return os.stat_result(fields)

        patcher = patch.object(Path, 'stat', stat)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_script_must_be_executable_by_the_unit_user(self):
        # The check runs as root, for whom any exec bit is enough; the unit runs as the stack owner.
        cases = [(self.uid, 0o700, None), (self.uid, 0o755, None), (self.uid, 0o655, 'not executable'),
                 (0, 0o755, None), (0, 0o705, None), (0, 0o700, 'readable and executable by others'),
                 (0, 0o750, 'readable and executable by others'), (0, 0o701, 'readable and executable by others')]
        for owner, mode, word in cases:
            with self.subTest(owner=owner, mode=oct(mode)):
                self.setUp()
                self.owned_by(owner)
                self.script.chmod(mode)
                if word:
                    self.refused(word)
                else:
                    self.install()

    def test_script_or_directory_owned_by_a_third_user_is_refused(self):
        if os.getuid() == 0:
            self.skipTest('files made by root are always accepted')
        self.uid = os.getuid() + 1
        self.refused('owned by')

    def test_unit_directory_and_systemctl_are_required(self):
        with self.assertRaises(m.UpdateError) as caught:
            m.install_ui_trigger(self.stack, self.units / 'absent', script=self.script)
        self.assertIn('systemd', str(caught.exception))
        with patch.object(m.shutil, 'which', lambda name: None):
            self.refused('systemd')
        self.assert_untouched()

    def test_systemctl_failure_cleans_up_a_first_install(self):
        for failing in ('daemon-reload', 'enable'):
            with self.subTest(failing):
                self.setUp()
                self.systemctl_fails = failing
                with self.assertRaises(m.UpdateError) as caught:
                    self.install()
                self.assertNotIn('secret', str(caught.exception))
                self.assertIn('systemctl status kobo-ui-update.timer', str(caught.exception))
                self.assertEqual(sorted(self.units.iterdir()), [])
                self.assertEqual(self.calls[-2:], [DISABLE, RELOAD])
        self.setUp()
        with patch.object(m.subprocess, 'run', side_effect=FileNotFoundError('systemctl')):
            with self.assertRaises(m.UpdateError) as caught:
                self.install()
        self.assertIn('not installed', str(caught.exception))
        self.assertEqual(sorted(self.units.iterdir()), [])

    def test_failed_reinstall_restores_the_working_install(self):
        self.install()
        before = {p.name: p.read_bytes() for p in self.units.iterdir()}
        other = self.make_script(self.stack / 'moved-kobo-update')
        for failing in ('enable', 'daemon-reload'):
            with self.subTest(failing):
                self.calls.clear()
                self.systemctl_fails = failing
                with self.assertRaises(m.UpdateError):
                    self.install(other)
                self.assertEqual({p.name: p.read_bytes() for p in self.units.iterdir()}, before)
                self.assertNotIn(DISABLE, self.calls)
                self.assertEqual(self.calls[-1], RELOAD)

    def test_uninstall_removes_files_and_tolerates_absence(self):
        self.install()
        self.calls.clear()
        before = sorted(p.name for p in self.stack.iterdir())
        m.uninstall_ui_trigger(self.units)
        self.assertEqual(sorted(self.units.iterdir()), [])
        self.assertEqual(self.calls, [DISABLE, RELOAD])
        self.assertEqual(sorted(p.name for p in self.stack.iterdir()), before)
        m.uninstall_ui_trigger(self.units)  # nothing left: still fine
        self.systemctl_fails = 'disable'  # unit not loaded
        m.uninstall_ui_trigger(self.units)
        self.systemctl_fails = 'daemon-reload'
        with self.assertRaises(m.UpdateError):
            m.uninstall_ui_trigger(self.units)

    def test_uninstall_requires_root(self):
        self.euid = 1000
        with self.assertRaises(m.UpdateError):
            m.uninstall_ui_trigger(self.units)
        self.assertEqual(self.calls, [])

    def test_owner_lookup_uses_the_real_directory_owner(self):
        self.assertEqual(REAL_OWNER_UID(self.stack), os.getuid())

    def test_cli_rejects_extra_options(self):
        for mode in ('--install-ui-trigger', '--uninstall-ui-trigger'):
            for extra in (['--skip-backup'], ['2.1.17']):
                argv = ['kobo-update', mode, '--directory', str(self.stack), *extra]
                with patch.object(sys, 'argv', argv), patch.object(m.signal, 'signal'), \
                        patch.object(sys, 'stderr', new=open(os.devnull, 'w')):
                    with self.assertRaises(SystemExit) as caught:
                        m.main()
                self.assertEqual(caught.exception.code, 2)
        self.assert_untouched()

    def test_main_runs_modes_and_reports_refusals(self):
        argv = ['kobo-update', '--install-ui-trigger', '--directory', str(self.stack)]
        with patch.object(sys, 'argv', argv), patch.object(m.signal, 'signal'), \
                patch.object(m, 'install_ui_trigger') as install:
            self.assertEqual(m.main(), 0)
        install.assert_called_once_with(self.stack)
        argv = ['kobo-update', '--uninstall-ui-trigger', '--directory', str(self.stack)]
        with patch.object(sys, 'argv', argv), patch.object(m.signal, 'signal'), \
                patch.object(m, 'uninstall_ui_trigger') as uninstall:
            self.assertEqual(m.main(), 0)
        uninstall.assert_called_once_with()
        self.euid = 1000
        argv = ['kobo-update', '--install-ui-trigger', '--directory', str(self.stack)]
        with patch.object(sys, 'argv', argv), patch.object(m.signal, 'signal'):
            self.assertEqual(m.main(), 1)
        self.assertTrue(self.said[-1].startswith('Stopped: '))
        self.assertFalse((self.stack / 'updates').exists())


if __name__ == '__main__':
    unittest.main()
