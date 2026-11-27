import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FetchTransport, type HttpTransport } from '@backblaze-labs/b2-sdk'

/**
 * Harness for the standalone B2 simulator (backblaze-labs/b2-simulator), the
 * HTTP server the simulator-backed tests run against. Each test file starts
 * one server and resets it between tests (`POST /reset` on its control port).
 *
 * The server comes from a local checkout of backblaze-labs/b2-simulator named
 * by `B2_SIMULATOR_DIR` (see DEVELOPMENT.md, "Standalone B2 simulator").
 */

export const SIMULATOR_DIR_ENV = 'B2_SIMULATOR_DIR'

/**
 * Start-up settings matching the SDK's in-process simulator these tests were
 * written against: its `ts-sdk` profile, and credentials, capabilities and
 * scope not enforced (that simulator's default; a test that needs strict auth
 * asks for it with `reset({ strictAuth: true })`). `--max-connections` is
 * raised because one test seeds 1001 files concurrently, which opens more
 * connections than the server's default budget of 1024.
 */
const SERVER_ARGS = [
  '--control',
  '--profile',
  'ts-sdk',
  '--permissive-auth',
  '--no-partner-authorize',
  '--max-connections',
  '4096',
] as const

const EXIT_WITH_OWNER = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '_exit-with-owner.mjs'),
).href

const READY_PATTERNS = {
  http: /^SIMULATOR-LISTENING (http:\/\/127\.0\.0\.1:\d+)$/m,
  https: /^SIMULATOR-LISTENING (https:\/\/127\.0\.0\.1:\d+)$/m,
  control: /^SIMULATOR-CONTROL (http:\/\/127\.0\.0\.1:\d+)$/m,
}

/** Enough environment to run node, and never a B2 credential. */
const SERVER_ENV_NAMES = [
  'PATH',
  'Path',
  'SystemRoot',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
]

/** Engine settings `POST /reset` accepts (docs/CONTRACT.md, "Reset"). */
export interface SimulatorConfig {
  minimumPartSize?: number
  recommendedPartSize?: number
  authTokenTtlMs?: number
  strictAuth?: boolean
}

/** A fault for `POST /faults` (docs/CONTRACT.md, "Control plane"). */
export interface SimulatorFault {
  on: string
  status: number
  code: string
  message?: string
  count?: number
  skip?: number
  retryAfter?: number
}

export interface StandaloneSimulator {
  readonly httpOrigin: string
  readonly controlOrigin: string
  /** A transport that sends every request to this server (see {@link originRewritingTransport}). */
  transport(): HttpTransport
  /** Empty the server; `config` applies until the next reset. */
  reset(config?: SimulatorConfig): Promise<void>
  injectFailure(fault: SimulatorFault): Promise<{ id: number; clear(): Promise<void> }>
  /** Move the server's virtual clock forward (token expiry, retention). */
  advanceTime(ms: number): Promise<void>
  stop(): Promise<void>
}

export function resolveSimulatorServeScript(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[SIMULATOR_DIR_ENV]?.trim()
  if (!dir) {
    throw new Error(
      `${SIMULATOR_DIR_ENV} is not set. Simulator-backed tests need a local checkout of ` +
        `backblaze-labs/b2-simulator: clone it and set ${SIMULATOR_DIR_ENV}=/absolute/path/to/b2-simulator ` +
        '(see DEVELOPMENT.md, "Standalone B2 simulator").',
    )
  }
  if (!isAbsolute(dir)) {
    throw new Error(`${SIMULATOR_DIR_ENV} must be an absolute path, got ${dir}.`)
  }
  const serveScript = join(dir, 'bin', 'simulator', 'serve.mjs')
  if (!existsSync(serveScript)) {
    throw new Error(
      `${SIMULATOR_DIR_ENV}=${dir} has no bin/simulator/serve.mjs; point it at a ` +
        'backblaze-labs/b2-simulator checkout.',
    )
  }
  return serveScript
}

function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of SERVER_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ http: string; control: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const fail = (reason: string) => {
      cleanup()
      child.kill('SIGKILL')
      reject(new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }
    const timer = setTimeout(
      () => fail(`simulator did not print its listening lines within ${timeoutMs} ms`),
      timeoutMs,
    )
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const http = READY_PATTERNS.http.exec(stdout)?.[1]
      const https = READY_PATTERNS.https.exec(stdout)?.[1]
      const control = READY_PATTERNS.control.exec(stdout)?.[1]
      if (http && https && control) {
        cleanup()
        resolve({ http, control })
      }
    }
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    }
    const onExit = (code: number | null, signal: string | null) =>
      fail(`simulator exited before listening (code ${code}, signal ${signal})`)
    const onError = (err: Error) => fail(`simulator could not start: ${err.message}`)
    function cleanup() {
      clearTimeout(timer)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function control(origin: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`simulator control ${method} ${path} answered ${response.status}: ${text}`)
  }
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>
}

/**
 * Send every request to `origin`, keeping path and query, and answer as if the
 * server lived at the origin the client asked for.
 *
 * The SDK's in-process simulator served any host and echoed the requested
 * origin in the URLs it minted (`apiUrl`, `downloadUrl`, `s3ApiUrl`, upload
 * URLs), so the client kept talking to `https://api.backblazeb2.com`-style
 * hosts. The standalone server mints its own loopback origin instead; JSON
 * answers get it replaced by the requested one, and file bodies and headers
 * pass through untouched. Nothing ever leaves the loopback interface.
 */
export function originRewritingTransport(origin: string): HttpTransport {
  const inner = new FetchTransport()
  return {
    async send(request) {
      const requested = new URL(request.url)
      const response = await inner.send({
        ...request,
        url: new URL(`${requested.pathname}${requested.search}`, origin).href,
        // No per-request timeout on the loopback hop, as with the in-process
        // simulator: a test that fakes timers to skip retry backoff must not
        // fire the timeout of a request still in flight to this server.
        retry: { ...request.retry, requestTimeoutMs: 0 },
      })
      const json = (response.headers.get('content-type') ?? '').includes('json')
      if (!json || request.method === 'HEAD' || requested.origin === origin) return response
      const text = await response.text()
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      return new Response(text.split(origin).join(requested.origin), {
        status: response.status,
        headers,
      })
    },
  }
}

export async function startStandaloneSimulator(
  options: { startTimeoutMs?: number } = {},
): Promise<StandaloneSimulator> {
  const serveScript = resolveSimulatorServeScript()
  const child = spawn(
    process.execPath,
    ['--import', EXIT_WITH_OWNER, serveScript, ...SERVER_ARGS],
    {
      // stdin stays open: its end is the signal that this owner is gone.
      env: serverEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const origins = await waitForReady(child, options.startTimeoutMs ?? 15_000)
  // Keep draining output so a chatty server never blocks on a full pipe.
  child.stdout?.resume()
  child.stderr?.resume()
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })

  return {
    httpOrigin: origins.http,
    controlOrigin: origins.control,
    transport: () => originRewritingTransport(origins.http),
    reset: async (config) => {
      await control(origins.control, 'POST', '/reset', config ? { config } : {})
    },
    injectFailure: async (fault) => {
      const { id } = await control(origins.control, 'POST', '/faults', fault)
      return {
        id: Number(id),
        clear: async () => {
          await control(origins.control, 'DELETE', `/faults/${id}`)
        },
      }
    },
    advanceTime: async (ms) => {
      await control(origins.control, 'POST', '/clock', { advanceMs: ms })
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        await exited
        clearTimeout(timer)
      }
    },
  }
}
