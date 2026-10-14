// Exercise the distributable tarball, without real accounts or the source node_modules.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
  const initializeBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' },
  } })
  async function initializeHttp(token) {
    return fetch(`${backend}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: initializeBody,
      signal: AbortSignal.timeout(10_000),
    })
  }
  assert.equal((await initializeHttp()).status, 401, 'Packaged HTTP MCP must reject anonymous clients')
  // Only the disposable loopback operator can provision this short-lived, read-only key.
  const credentialResponse = await fetch(`${backend}/api/mcp-credentials`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'package-smoke', tools: ['list_workspaces'], allWorkspaces: true,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(credentialResponse.status, 201, 'Packaged MCP credential provisioning failed')
  const { token, credential } = await credentialResponse.json()
  assert.equal(typeof token, 'string', 'Missing packaged MCP credential')
  assert.equal(typeof credential?.id, 'string', 'Missing packaged MCP credential ID')
  const operatorResponse = await fetch(`${backend}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  })
  assert.equal(operatorResponse.status, 401, 'MCP credentials must not authorize operator routes')

  // Resolve the protocol client from the installed tarball's dependency tree, never the checkout.
  const requireInstalled = createRequire(path.join(installed, 'package.json'))
  const { Client } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href)
  const { StdioClientTransport } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
  const httpClient = new Client({ name: 'package-smoke-http', version: '1' })
  const stdioClient = new Client({ name: 'package-smoke-stdio', version: '1' })
  async function checkDiscoveryAndRead(client, transport) {
    const { tools } = await client.listTools({}, { timeout: 10_000 })
    assert.deepEqual(tools.map(tool => tool.name), ['list_workspaces'], `${transport} MCP must honor tool grants`)
    const result = await client.callTool({ name: 'list_workspaces', arguments: {} }, undefined, { timeout: 10_000 })
    assert.notEqual(result.isError, true, `${transport} MCP workspace read failed`)
    assert.deepEqual(JSON.parse(result.content[0].text), [], `${transport} MCP fresh workspace list must be empty`)
  }
  try {
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`${backend}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }), { timeout: 10_000 })
    assert.equal(httpClient.getServerVersion()?.name, 'kobo-workspaces')
    await checkDiscoveryAndRead(httpClient, 'HTTP')

    await stdioClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(installed, 'dist/mcp-server/kobo-tasks-server.js')],
      cwd: application,
      env: { ...env, KOBO_BACKEND_URL: backend, KOBO_MCP_TOKEN: token },
      stderr: 'ignore',
    }), { timeout: 10_000 })
    assert.equal(stdioClient.getServerVersion()?.name, 'kobo-tasks')
    // Initialization alone never exercises the stdio bridge's backend authentication.
    await checkDiscoveryAndRead(stdioClient, 'stdio')

    const revoked = await fetch(`${backend}/api/mcp-credentials/${encodeURIComponent(credential.id)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(10_000),
    })
    assert.equal(revoked.status, 200, 'Packaged MCP credential revocation failed')
    assert.equal((await initializeHttp(token)).status, 401, 'HTTP MCP must reject revoked credentials')
    const denied = await stdioClient.callTool({ name: 'list_workspaces', arguments: {} }, undefined, { timeout: 10_000 })
    assert.equal(denied.isError, true, 'Running stdio MCP must reject revoked credentials')
  } finally {
    await Promise.allSettled([stdioClient.close(), httpClient.close()])
  }
  console.log(`PASS: ${metadata.name}@${metadata.version} tarball install, native modules, startup, fresh settings, PWA, authenticated HTTP/stdio MCP and credential revocation (${process.platform}/${process.arch}).`)
} finally {
  for (const child of children.reverse()) await stop(child)
  await rm(temporary, { recursive: true, force: true })
}
