import { createRequire } from 'node:module'

const localRequire = createRequire(import.meta.url)

/**
 * Snapshot of the host platform used to decide which Claude CLI binary
 * variant to load. Extracted as a structure so the resolver can be tested
 * against synthetic platforms without spawning processes.
 */
export interface PlatformProbe {
  platform: NodeJS.Platform
  arch: string
  /** True when the runtime libc is glibc, false on musl, false on non-Linux. */
  isGlibc: boolean
}

/**
 * Detect the live host's platform/arch/libc from `process`. `glibcVersionRuntime`
 * lives in the diagnostic report header on glibc systems and is absent on musl.
 * Available since Node 12; Kōbō requires Node ≥ 20 (see AGENTS.md).
 */
export function detectPlatform(): PlatformProbe {
  const report = (process as { report?: { getReport(): { header?: { glibcVersionRuntime?: string } } } }).report
  const glibcVersion = report?.getReport().header?.glibcVersionRuntime
  return {
    platform: process.platform,
    arch: process.arch,
    isGlibc: typeof glibcVersion === 'string' && glibcVersion.length > 0,
  }
}

/**
 * Resolve an explicit path to the Claude CLI binary that matches the host
 * libc — or `undefined` to fall back to the SDK's built-in resolution.
 *
 * Why this exists: on Linux glibc systems npm installs both
 * `@anthropic-ai/claude-agent-sdk-linux-${arch}` (glibc) and
 * `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl` because npm doesn't
 * filter `optionalDependencies` by the `libc` field. The SDK's internal
 * resolver tries the musl variant first and returns its path; that binary
 * then ENOENTs at exec because its dynamic linker (`/lib/ld-musl-*.so.1`)
 * is absent on glibc systems, surfacing the misleading "Claude Code native
 * binary not found" error.
 *
 * Returning the explicit glibc path here overrides the SDK's choice and
 * sidesteps the bug.
 *
 * On every other platform (musl Linux, macOS, Windows, unknown libc, or
 * unsupported arch), this returns `undefined` so the SDK keeps its default
 * resolution behaviour.
 */
export function resolveClaudeBinaryPath(
  probe: PlatformProbe = detectPlatform(),
  resolveFn: (id: string) => string = (id) => localRequire.resolve(id),
): string | undefined {
  if (probe.platform !== 'linux') return undefined
  if (!probe.isGlibc) return undefined
  if (probe.arch !== 'x64' && probe.arch !== 'arm64') return undefined

  try {
    return resolveFn(`@anthropic-ai/claude-agent-sdk-linux-${probe.arch}/claude`)
  } catch {
    return undefined
  }
}
