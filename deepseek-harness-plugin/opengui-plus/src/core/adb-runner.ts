/**
 * Thin ADB execution abstraction.
 *
 * Modules never shell out to `adb` directly: they call an `AdbRunner`. That
 * keeps the wireless-connection and device-pool modules testable on machines
 * with no phone attached, and lets us respect the upstream OpenGUI rule that
 * every device operation goes through a single auditable seam.
 *
 * @module core/adb-runner
 */

import { spawn } from 'node:child_process'

export interface AdbRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export interface AdbRunner {
  /** Run `adb <args>` and resolve with the captured output. */
  run(args: readonly string[], timeoutMs?: number): Promise<AdbRunResult>
  /**
   * Run `adb <args>` and write `stdin` to the child process.
   *
   * `adb pair <host:port>` on older platform-tools builds prints
   * `Enter pairing code:` and reads the secret from stdin instead of taking it
   * as an argument. Optional so hand-written runners keep compiling; callers
   * must fall back to {@link AdbRunner.run} when it is missing.
   */
  runWithStdin?(args: readonly string[], stdin: string, timeoutMs?: number): Promise<AdbRunResult>
  /**
   * Run `adb <args>` and resolve with the raw stdout bytes.
   *
   * The text-oriented {@link AdbRunner.run} decodes stdout as UTF-8, which
   * mangles binary data such as `screencap -p` PNG output. `execOut` is
   * reserved for callers that need the exact byte stream. Optional so hand-
   * written runners keep compiling; fall back to writing to `/sdcard/` and
   * pulling when it is missing.
   */
  execOut?(args: readonly string[], timeoutMs?: number): Promise<{ readonly stdout: Buffer, readonly stderr: string, readonly code: number }>
  /**
   * Cheap reachability check (`adb version`). Lets a host degrade to
   * console-only mode instead of advertising capabilities it cannot honour.
   */
  probe?(): Promise<boolean>
  /** Path of the adb binary in use, for display in the console. */
  readonly binary: string
}

export interface AdbRawResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly code: number
}

export interface SpawnAdbOptions {
  /** Absolute path to adb; defaults to `adb` on PATH. */
  readonly binary?: string
  /** Environment override; merged over `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const DEFAULT_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 10_000

/** Shared spawn plumbing for both `run` and `runWithStdin`. */
function spawnOnce(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  stdin: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<AdbRunResult> {
  return new Promise<AdbRunResult>((resolve, reject) => {
    // stdin is always a pipe so the same code path serves both entry points;
    // callers that pass no input simply close it immediately.
    const child = spawn(binary, [...args], {
      env: { ...process.env, ...(env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`adb ${args.join(' ')}: timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => { /* adb may exit before reading stdin */ })
    if (stdin === undefined) child.stdin.end()
    else {
      child.stdin.write(stdin)
      child.stdin.end()
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // A missing adb binary is a normal state, not an exception: machines
      // without platform-tools still run the CLI and the console. Rejecting
      // here used to crash `opengui-plus modules` with an unhandled rejection.
      resolve({
        stdout: '',
        stderr: `adb 不可用（${error.message}）；请安装 platform-tools 或设置 OPENGUI_PLUS_ADB`,
        code: 127,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}

/**
 * Same plumbing as {@link spawnOnce} but keeps stdout as raw Buffer, which
 * is the only way to ship binary output (`screencap -p`, `dd`, …) back to
 * the caller without mangling it through a UTF-8 codec.
 */
function spawnRawOnce(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<AdbRawResult> {
  return new Promise<AdbRawResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: { ...process.env, ...(env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`adb ${args.join(' ')}: timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => undefined)
    child.stdin.end()
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.alloc(0),
        stderr: `adb 不可用（${error.message}）；请安装 platform-tools 或设置 OPENGUI_PLUS_ADB`,
        code: 127,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code: code ?? 0 })
    })
  })
}

/** Real runner: spawns the adb binary. */
export function createAdbRunner(options: SpawnAdbOptions = {}): AdbRunner {
  const binary = options.binary ?? process.env.OPENGUI_PLUS_ADB ?? 'adb'
  return {
    binary,
    async run(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return spawnOnce(binary, args, timeoutMs, undefined, options.env)
    },
    async runWithStdin(args, stdin, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return spawnOnce(binary, args, timeoutMs, stdin, options.env)
    },
    async execOut(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return spawnRawOnce(binary, args, timeoutMs, options.env)
    },
    async probe() {
      const result = await spawnOnce(binary, ['version'], PROBE_TIMEOUT_MS, undefined, options.env)
      return result.code === 0 && /android debug bridge/i.test(result.stdout)
    },
  }
}

/** Scripted responses keyed by the joined argument string. */
export type AdbScript = Readonly<Record<string, AdbRunResult | string>>

function normalise(result: AdbRunResult | string): AdbRunResult {
  return typeof result === 'string' ? { stdout: result, stderr: '', code: 0 } : result
}

/** Test/demo runner that also records every command it was asked to run. */
export interface FakeAdbRunner extends AdbRunner {
  /** Arguments of every call, in order, joined with spaces. */
  readonly calls: readonly string[]
}

/**
 * Deterministic runner for tests and demos.
 * Unmatched commands return an empty successful result, so callers that only
 * care about their scripted commands keep working. A pattern ending in `*`
 * matches any command with that prefix, which keeps `-s <serial> shell ...`
 * stubs short.
 */
export function createFakeAdbRunner(script: AdbScript = {}, binary = 'adb-fake'): FakeAdbRunner {
  const calls: string[] = []

  function lookup(args: readonly string[]): AdbRunResult {
    const key = args.join(' ')
    const hit = script[key]
    if (hit !== undefined) return normalise(hit)
    for (const [pattern, value] of Object.entries(script)) {
      if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) return normalise(value)
    }
    return { stdout: '', stderr: '', code: 0 }
  }

  return {
    binary,
    calls,
    async run(args) {
      calls.push(args.join(' '))
      return lookup(args)
    },
    async runWithStdin(args, stdin) {
      // Record the piped secret as `(stdin: …)` so tests can assert the code
      // really was written to adb without leaking it into a bare command log.
      calls.push(`${args.join(' ')} (stdin: ${stdin.trim()})`)
      const key = `${args.join(' ')} <${stdin.trim()}>`
      const hit = script[key]
      if (hit !== undefined) return normalise(hit)
      return lookup(args)
    },
    async probe() {
      return script.probe === undefined ? true : normalise(script.probe).stdout !== 'unavailable'
    },
  }
}
