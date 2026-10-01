import i18n from 'src/i18n'

/**
 * The single network entry point for the client.
 *
 * It sits ON TOP of the `window.fetch` override installed by
 * `boot/network-auth.ts` — token injection and the 401 login prompt keep
 * working untouched. What it adds is what raw call sites lacked: a
 * request deadline, cancellation, and above all the SERVER's error message.
 * The backend answers `{ error: "<descriptive message>" }` on every failure;
 * Legacy call sites used to throw that away to show `HTTP 500` instead.
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
  readonly executionMayContinue: boolean

  constructor(timeoutMs: number, executionMayContinue = false) {
    super(i18n.global.t(executionMayContinue ? 'api.mutationTimeout' : 'api.timeout', { seconds: timeoutMs / 1000 }))
    this.name = 'ApiTimeoutError'
    this.timeoutMs = timeoutMs
    this.executionMayContinue = executionMayContinue
  }
}

/** Long enough for a slow git fetch behind the API, short enough that a hung
 *  request never leaves a spinner turning forever. Pass 0 to disable. */
export const DEFAULT_API_TIMEOUT_MS = 30_000

/** These endpoints can legitimately wait for Git, scripts or transcription.
 * Keep reads bounded and leave time for the server's own operation timeout. */
export function apiTimeoutForPath(path: string, method = 'GET'): number {
  const pathname = path.split('?')[0] ?? path
  const verb = method.toUpperCase()
  if (pathname.startsWith('/api/voice/') && pathname.endsWith('/transcribe')) return 330_000
  if (pathname.endsWith('/run-setup-script') || (pathname === '/api/workspaces' && method === 'POST')) return 330_000
  if (pathname.startsWith('/api/dev-server/') && pathname.endsWith('/start')) return 180_000
  if (verb === 'POST' && /^\/api\/workspaces\/[^/]+\/(archive|start-review|switch-engine)$/.test(pathname))
    return 180_000
  if (verb === 'DELETE' && /^\/api\/workspaces\/[^/]+$/.test(pathname)) return 180_000
  if (verb === 'POST' && /^\/api\/dev-server\/[^/]+\/stop$/.test(pathname)) return 180_000
  if (
    pathname.startsWith('/api/git/') ||
    pathname.startsWith('/api/pull-requests') ||
    /\/(push|force-push|pull|fetch|rebase|merge|git\/[^/]+|change-source-branch|change-pr-base|merge-pr|restore-worktree|purge-worktree|open-pr|rename-branch|resync-branch)$/.test(
      pathname,
    )
  )
    return 180_000
  if (/\/(attachments|sounds|events\.csv|diagnostic\.json)$/.test(pathname)) return 90_000
  return DEFAULT_API_TIMEOUT_MS
}

export interface ApiOptions extends Omit<RequestInit, 'body' | 'signal'> {
  /** Plain object → JSON.stringify + Content-Type. String/FormData/Blob → sent as-is. */
  body?: unknown
  /** Milliseconds before the request is aborted. 0 disables the deadline. */
  timeoutMs?: number
  /** Caller-owned cancellation, composed with the deadline. */
  signal?: AbortSignal | null
  /** Used by apiFetchResponseForStatus: consume error bodies but release successful bodies. */
  statusOnlySuccess?: boolean
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

function createDeadline(timeoutMs: number, signal?: AbortSignal | null, method = 'GET') {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const onCallerAbort = () => {
    controller.abort(signal?.reason)
    dispose()
  }
  const dispose = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    signal?.removeEventListener('abort', onCallerAbort)
  }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      dispose()
    }, timeoutMs)
  }
  const abortReason = () =>
    timedOut
      ? new ApiTimeoutError(timeoutMs, !['GET', 'HEAD'].includes(method.toUpperCase()))
      : (controller.signal.reason ?? new DOMException('Aborted', 'AbortError'))

  // Settle even if a transport/body implementation fails to react to abort.
  // The work promise retains a rejection handler, so its eventual failure
  // after the deadline does not become an unhandled rejection.
  async function run<T>(work: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw abortReason()
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortReason())
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([work(), aborted])
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
    }
  }
  return { signal: controller.signal, run, dispose }
}

function requestInit(options: ApiOptions, signal: AbortSignal): RequestInit {
  const {
    body,
    timeoutMs: _timeoutMs,
    signal: _callerSignal,
    statusOnlySuccess: _statusOnlySuccess,
    headers,
    ...rest
  } = options
  const init: RequestInit = { ...rest, signal }
  if (body !== undefined) {
    if (
      typeof body === 'string' ||
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof URLSearchParams ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body)
    ) {
      init.body = body as BodyInit
      if (headers) init.headers = headers
    } else {
      init.body = JSON.stringify(body)
      const jsonHeaders = new Headers(headers)
      if (!jsonHeaders.has('Content-Type')) jsonHeaders.set('Content-Type', 'application/json')
      // Preserve Headers/tuple inputs and explicitly supplied network tokens.
      init.headers = Object.fromEntries(jsonHeaders.entries())
    }
  } else if (headers) init.headers = headers
  return init
}

/** Build an error while preserving the backend's message and discriminator. */
export async function apiResponseError(response: Response): Promise<ApiError> {
  const raw = await response.text()
  const { message, code } = extractError(raw, response.status)
  return new ApiError(message, response.status, code, raw)
}

function discardResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  } catch {
    // A synthetic or already locked body needs no further handling.
  }
}

/**
 * Response transport for downloads and callers interpreting HTTP statuses.
 * Fetch and body consumption share one deadline and caller cancellation.
 * Consume via json/text/blob/arrayBuffer/formData (not a raw streaming reader).
 * HTTP failures are returned so existing business-specific 409/401 handling
 * remains intact; use apiResponseError when throwing them.
 * No mutation is retried: an aborted request may already have executed.
 */
export async function apiFetchResponse(path: string, options: ApiOptions = {}): Promise<Response> {
  const deadline = createDeadline(
    options.timeoutMs ?? apiTimeoutForPath(path, options.method),
    options.signal,
    options.method,
  )
  try {
    const response = await deadline.run(() => fetch(path, requestInit(options, deadline.signal)))
    if (options.statusOnlySuccess && response.ok) discardResponseBody(response)
    if (
      (options.statusOnlySuccess && response.ok) ||
      response.status === 204 ||
      response.body === null ||
      options.method === 'HEAD'
    )
      deadline.dispose()
    const consumers = new Set<PropertyKey>(['json', 'text', 'blob', 'arrayBuffer', 'formData', 'bytes'])
    return new Proxy(response, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (consumers.has(property) && typeof value === 'function') {
          return async (...args: unknown[]) => {
            try {
              return await deadline.run(() => value.apply(target, args) as Promise<unknown>)
            } finally {
              deadline.dispose()
            }
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  } catch (error) {
    deadline.dispose()
    throw error
  }
}

/** Inspect HTTP status while retaining an error body for custom error handling. */
export function apiFetchResponseForStatus(path: string, options: ApiOptions = {}): Promise<Response> {
  return apiFetchResponse(path, { ...options, statusOnlySuccess: true })
}

/** Fetch a status without retaining a deadline or an unread response body. */
export async function apiFetchStatus(path: string, options: ApiOptions = {}): Promise<Pick<Response, 'ok' | 'status'>> {
  const deadline = createDeadline(
    options.timeoutMs ?? apiTimeoutForPath(path, options.method),
    options.signal,
    options.method,
  )
  try {
    const response = await deadline.run(() => fetch(path, requestInit(options, deadline.signal)))
    // The caller asked only for headers. Cancel downloads without waiting for
    // the stream's source to acknowledge cancellation.
    discardResponseBody(response)
    return { ok: response.ok, status: response.status }
  } finally {
    deadline.dispose()
  }
}

/** Mutation acknowledgement: keep error details and release the body deadline on success. */
export async function apiFetchOk(path: string, options: ApiOptions = {}): Promise<void> {
  const response = await apiFetchResponse(path, options)
  if (!response.ok) throw await apiResponseError(response)
  await response.text()
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
  const deadline = createDeadline(
    options.timeoutMs ?? apiTimeoutForPath(path, options.method),
    options.signal,
    options.method,
  )
  try {
    return await deadline.run(async () => {
      const response = await fetch(path, requestInit(options, deadline.signal))
      if (!response.ok) throw await apiResponseError(response)
      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (text.length === 0) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new ApiError(
          `Server returned a non-JSON body for a successful response: ${reason}`,
          response.status,
          undefined,
          text,
        )
      }
    })
  } finally {
    deadline.dispose()
  }
}
