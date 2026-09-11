import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCompiledMcpServerPath, getDbPath, getMcpServerSourcePath } from '../utils/paths.js'
import { getLanHostnames, isAllowedRequestHost, resolveProxyHostname } from './network-access-service.js'

interface ConnectionInput {
  port: number
  networkEnabled: boolean
  behindProxy: boolean
  proxyHostname: string | null
  lanHostnames: string[]
  command: string
  compiledPath: string | null
  sourcePath: string | null
  loaderPath: string | null
  databasePath: string
}

/** No request/forwarded headers or credentials participate in generated metadata. */
export function buildMcpConnectionInfo(input: ConnectionInput) {
  const backendUrl = `http://127.0.0.1:${input.port}`
  const args = input.compiledPath
    ? [input.compiledPath]
    : input.sourcePath && input.loaderPath
      ? ['--import', pathToFileURL(input.loaderPath).href, input.sourcePath]
      : null
  return {
    localUrl: `${backendUrl}/api/mcp`,
    lanUrls: input.networkEnabled
      ? input.lanHostnames
          .map((host) => `${host.includes(':') ? `[${host}]` : host}:${input.port}`)
          .filter((host) =>
            isAllowedRequestHost({
              host,
              enabled: input.networkEnabled,
              lanHostnames: input.lanHostnames,
              behindProxy: input.behindProxy,
              proxyHostname: input.proxyHostname,
            }),
          )
          .map((host) => `http://${host}/api/mcp`)
      : [],
    networkEnabled: input.networkEnabled,
    behindProxy: input.behindProxy,
    proxyHostname: input.proxyHostname,
    localRequiresToken: input.behindProxy,
    stdio: args
      ? {
          command: input.command,
          args,
          env: { KOBO_DB_PATH: input.databasePath, KOBO_BACKEND_URL: backendUrl, KOBO_WORKSPACE_ID: '' },
        }
      : null,
  }
}

export function getMcpConnectionInfo(
  port: number,
  settings: { networkAccessEnabled: boolean; networkAccessBehindProxy: boolean },
  databasePath = getDbPath(),
) {
  const source = getMcpServerSourcePath()
  let loaderPath: string | null = null
  try {
    loaderPath = createRequire(import.meta.url).resolve('tsx')
  } catch {
    /* Production installs can omit the development loader. */
  }
  return buildMcpConnectionInfo({
    port,
    networkEnabled: settings.networkAccessEnabled,
    behindProxy: settings.networkAccessBehindProxy,
    proxyHostname: resolveProxyHostname(),
    lanHostnames: getLanHostnames(),
    command: process.execPath,
    compiledPath: getCompiledMcpServerPath(),
    sourcePath: fs.existsSync(source) ? source : null,
    loaderPath,
    databasePath: path.resolve(databasePath),
  })
}
