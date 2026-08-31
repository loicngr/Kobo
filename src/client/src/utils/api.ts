/**
 * The single network entry point for the client.
 *
 * It sits ON TOP of the `window.fetch` override installed by
 * `boot/network-auth.ts` — token injection and the 401 login prompt keep
 * working untouched. What it adds is what 153 raw call sites lacked: a
 * request deadline, cancellation, and above all the SERVER's error message.
 * The backend answers `{ error: "<descriptive message>" }` on every failure;
 * 65 call sites used to throw that away to show `HTTP 500` instead.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly body: string

  constructor(message: string, status: number, code: string | undefined, body: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

export class ApiTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`)
    this.name = 'ApiTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Long enough for a slow git fetch behind the API, short enough that a hung
 *  request never leaves a spinner turning forever. Pass 0 to disable. */
export const DEFAULT_API_TIMEOUT_MS = 30_000

export interface ApiOptions extends Omit<RequestInit, 'body' | 'signal'> {
  /** Plain object → JSON.stringify + Content-Type. String/FormData/Blob → sent as-is. */
  body?: unknown
  /** Milliseconds before the request is aborted. 0 disables the deadline. */
  timeoutMs?: number
  /** Caller-owned cancellation, composed with the deadline. */
  signal?: AbortSignal
}

function extractError(raw: string, status: number): { message: string; code: string | undefined } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { message: `HTTP ${status}`, code: undefined }
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown; code?: unknown }
    const code = typeof parsed.code === 'string' ? parsed.code : undefined
    if (typeof parsed.error === 'string' && parsed.error.length > 0) return { message: parsed.error, code }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return { message: parsed.message, code }
    return { message: `HTTP ${status}`, code }
  } catch {
    // Not JSON (an HTML error page, a proxy banner…). Show a bounded excerpt
    // rather than an opaque status code.
    return { message: trimmed.slice(0, 500), code: undefined }
  }
}

/**
 * Fetches `path` and parses a successful JSON response as `T`.
 *
 * TYPE HONESTY NOTE — read before trusting the `T` you asked for: on a `204
 * No Content`, or any 2xx response with an empty body, this resolves to
 * `undefined`, not `T`. Nothing at compile time can stop that — the generic
 * is a promise about what a body-bearing response contains, not a guarantee
 * that a body exists. Callers of endpoints that may legitimately answer with
 * no body (DELETE-style routes, `204` acks, etc.) must write
 * `apiFetch<Workspace | undefined>(...)` or check the result before use;
 * callers of endpoints that always return a body can use `apiFetch<Workspace>(...)`
 * as documentation of intent, understanding it is not runtime-enforced.
 */
export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal, headers, ...rest } = options

  // Composed manually rather than via AbortSignal.any/timeout: those are not
  // uniformly present across the browsers Kōbō is opened in from a phone, and
  // the manual version is what lets us tell a deadline apart from a caller
  // abort in the catch below.
  const controller = new AbortController()
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : null
  const onCallerAbort = () => controller.abort()
  signal?.addEventListener('abort', onCallerAbort)

  const init: RequestInit = { ...rest, signal: controller.signal }
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof FormData || body instanceof Blob) {
      init.body = body as BodyInit
      if (headers) init.headers = headers
    } else {
      init.body = JSON.stringify(body)
      init.headers = { 'Content-Type': 'application/json', ...((headers as Record<string, string>) ?? {}) }
    }
  } else if (headers) {
    init.headers = headers
  }

  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    if (timedOut) throw new ApiTimeoutError(timeoutMs)
    throw err
  } finally {
    if (timer !== null) clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    const { message, code } = extractError(raw, res.status)
    throw new ApiError(message, res.status, code, raw)
  }

  // No body to parse: 204 by convention, or a 2xx with an empty payload.
  // See the type-honesty note above — the caller's `T` is not honored here.
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (text.length === 0) return undefined as T

  try {
    return JSON.parse(text) as T
  } catch (err) {
    // A 2xx response whose body isn't valid JSON is still a failure the
    // caller needs to handle — wrap it in ApiError so every failure path
    // (HTTP error, timeout, bad body) is catchable the same way.
    const reason = err instanceof Error ? err.message : String(err)
    throw new ApiError(
      `Server returned a non-JSON body for a successful response: ${reason}`,
      res.status,
      undefined,
      text,
    )
  }
}
