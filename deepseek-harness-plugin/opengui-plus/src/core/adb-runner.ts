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
  /** Path of the adb binary in use, for display in the console. */
  readonly binary: string
}

export interface SpawnAdbOptions {
  /** Absolute path to adb; defaults to `adb` on PATH. */
  readonly binary?: string
  /** Environment override; merged over `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const DEFAULT_TIMEOUT_MS = 20_000

/** Real runner: spawns the adb binary. */
export function createAdbRunner(options: SpawnAdbOptions = {}): AdbRunner {
  const binary = options.binary ?? process.env.OPENGUI_PLUS_ADB ?? 'adb'
  return {
    binary,
    async run(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<AdbRunResult>((resolve, reject) => {
        const child = spawn(binary, [...args], {
          env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
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
        child.on('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`adb ${args.join(' ')}: ${error.message}`))
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ stdout, stderr, code: code ?? 0 })
        })
      })
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
  return {
    binary,
    calls,
    async run(args) {
      const key = args.join(' ')
      calls.push(key)
      const hit = script[key]
      if (hit !== undefined) return normalise(hit)
      for (const [pattern, value] of Object.entries(script)) {
        if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) return normalise(value)
      }
      return { stdout: '', stderr: '', code: 0 }
    },
  }
}
