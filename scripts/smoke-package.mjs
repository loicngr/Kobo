// Exercise the distributable tarball, without real accounts or the source node_modules.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kobo-package-'))
const children = []
const application = path.join(temporary, 'installation é with spaces')
await mkdir(application)
const home = path.join(temporary, 'home')
await mkdir(home)
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  TMPDIR: temporary,
  KOBO_HOME: path.join(application, 'data'),
  NODE_ENV: 'production',
  npm_config_cache: path.join(temporary, 'npm-cache'),
  npm_config_userconfig: path.join(home, '.npmrc'),
  npm_config_globalconfig: path.join(home, 'global.npmrc'),
  CI: '1',
}

async function run(command, args, cwd = application) {
  return exec(command, args, { cwd, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
}

async function freePort() {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return port
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close').catch(() => {})
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 5000)
  await closed
  clearTimeout(force)
}

try {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const explicit = process.argv[2]
  let tarball
  if (explicit) tarball = path.resolve(explicit)
  else {
    await readFile(path.join(root, 'dist/server/index.js'))
    await readFile(path.join(root, 'src/client/dist/pwa/index.html'))
    const packed = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root)
    tarball = path.join(temporary, JSON.parse(packed.stdout)[0].filename)
  }
  await writeFile(path.join(application, 'package.json'), JSON.stringify({ private: true }))
  await run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', tarball])
  const installed = path.join(application, 'node_modules', metadata.name)
  const installedMetadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
  assert.equal(installedMetadata.version, metadata.version)
  // Native dependencies must load from the installed package, not the checkout.
  await run(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(path.join(installed, 'package.json'))});
    const Database = require('better-sqlite3');
    const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();
    // Same preparation as the packaged terminal service (node-pty 1.1.0 macOS prebuilds).
    const { ensureSpawnHelperExecutable } = await import(${JSON.stringify(pathToFileURL(path.join(installed, 'dist/server/utils/node-pty-spawn-helper.js')).href)});
    ensureSpawnHelperExecutable();
    const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf kobo-smoke'], { env: process.env });
    let text = ''; pty.onData(chunk => { text += chunk });
    const timeout = setTimeout(() => { pty.kill(); process.exitCode = 1 }, 5000);
    pty.onExit(({exitCode}) => { clearTimeout(timeout); if (exitCode || !text.includes('kobo-smoke')) process.exitCode = 1 });
  `])
  const port = await freePort()
  const backend = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [path.join(installed, 'dist/server/index.js')], {
    cwd: application, env: { ...env, PORT: String(port), SERVER_PORT: String(port) }, stdio: 'ignore',
  })
  children.push(server)
  server.on('error', () => {})
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Packaged server exited before readiness')
    try {
      const response = await fetch(`${backend}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) { ready = true; break }
    } catch { /* Poll only this disposable server. */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert(ready, 'Packaged server did not become healthy')
  const index = await fetch(backend)
  assert(index.ok)
  const html = await index.text()
  assert(html.includes('<html'))
  const entry = html.match(/src="([^"]+\.js)"/)
  assert(entry, 'Missing bundled JS entry')
  const bundle = await fetch(new URL(entry[1], backend))
  assert(bundle.ok && /javascript/.test(bundle.headers.get('content-type')), 'Missing JavaScript bundle')
  assert(!(await bundle.text()).includes('<!DOCTYPE html>'), 'Bundle resolved to SPA fallback')
  for (const asset of ['/sw.js', '/sounds/neutral.wav', '/sounds/ready.wav']) {
    const response = await fetch(`${backend}${asset}`)
    assert(response.ok, `Missing asset: ${asset}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (asset.endsWith('.wav')) {
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
      assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
    } else {
      assert(/javascript/.test(response.headers.get('content-type')), 'Missing service worker')
      assert(!bytes.toString().includes('<!DOCTYPE html>'), 'Worker resolved to SPA fallback')
    }
  }
  const settings = await (await fetch(`${backend}/api/settings`)).json()
  assert.equal(settings.global.skillSuite, 'standard')
  assert.equal(settings.global.notionEnabled, false)
  assert.equal(settings.global.onboardingComplete, false)
  const initialize = await fetch(`${backend}/api/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } } }),
  })
  assert(initialize.ok, 'Packaged HTTP MCP initialization failed')
  const initializedText = await initialize.text()
  const initializedJson = initializedText.startsWith('event:') || initializedText.startsWith('data:')
    ? initializedText.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim()
    : initializedText
  assert.equal(JSON.parse(initializedJson).result?.serverInfo?.name, 'kobo-workspaces')
  const mcp = spawn(process.execPath, [path.join(installed, 'dist/mcp-server/kobo-tasks-server.js')], {
    cwd: application,
    env: { ...env, KOBO_DB_PATH: path.join(env.KOBO_HOME, 'kobo.db'), KOBO_SETTINGS_PATH: path.join(env.KOBO_HOME, 'settings.json'), KOBO_BACKEND_URL: backend },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  children.push(mcp)
  await new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => reject(new Error('Packaged stdio MCP initialization timed out')), 10_000)
    const failed = () => { clearTimeout(timeout); reject(new Error('Packaged stdio MCP closed before initialization')) }
    mcp.once('error', failed)
    mcp.once('exit', failed)
    mcp.stdout.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\n'); buffer = lines.pop()
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.id === 1) {
            clearTimeout(timeout); mcp.removeListener('exit', failed)
            if (message.result?.serverInfo?.name === 'kobo-tasks') resolve()
            else reject(new Error('Unexpected packaged MCP response'))
          }
        } catch { /* Ignore non-protocol output. */ }
      }
    })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } } }) + '\n')
  })
  console.log(`PASS: ${metadata.name}@${metadata.version} tarball install, native modules, startup, fresh settings, PWA, HTTP and stdio MCP (${process.platform}/${process.arch}).`)
} finally {
  for (const child of children.reverse()) await stop(child)
  await rm(temporary, { recursive: true, force: true })
}
