/**
 * `adb` probes used to describe what is on screen during a recording.
 *
 * Why this file spawns `adb` itself for screenshots: `AdbRunner.run()` decodes
 * stdout as UTF-8, which irreversibly mangles PNG bytes. Screenshots therefore
 * need a raw-Buffer spawn. The binary path still comes from the injected
 * runner, and the capture is injectable, so the module stays testable without
 * a phone.
 *
 * @module modules/demo-recorder/capture
 */

import { spawn } from 'node:child_process'

import type { AdbRunner } from '../../core/adb-runner.js'

import type { DemoScreenState } from './types.js'

const SCREENSHOT_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 8_000
const MAX_TEXT_NODES = 12

/**
 * Grab the raw PNG bytes of the current screen, or `null` when adb is not
 * reachable / the device refuses.
 */
export type ScreenshotCapture = (runner: AdbRunner) => Promise<Buffer | null>

export const adbScreenshot: ScreenshotCapture = (runner) => {
  return new Promise<Buffer | null>((resolve) => {
    let child
    try {
      child = spawn(runner.binary, ['exec-out', 'screencap', '-p'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch {
      resolve(null)
      return
    }
    if (child.stdout === null || child.stderr === null) {
      child.kill()
      resolve(null)
      return
    }

    const chunks: Buffer[] = []
    let settled = false
    const finish = (buffer: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(buffer)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(chunks.length > 0 ? Buffer.concat(chunks) : null)
    }, SCREENSHOT_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stderr.on('data', () => { /* adb noise is not actionable here */ })
    child.on('error', () => { finish(null) })
    child.on('close', (code) => {
      const buffer = Buffer.concat(chunks)
      // A zero-byte capture means the screen was not ready; treat it as a miss
      // rather than writing an empty .png that later breaks image viewers.
      finish(code === 0 && buffer.length > 0 ? buffer : null)
    })
  })
}

/**
 * Pull the focused activity out of `adb shell dumpsys window`.
 *
 * Real output contains several lines; `mCurrentFocus` is the reliable one and
 * `mFocusedApp` is the fallback used by some OEM builds:
 *
 *   mCurrentFocus=Window{6f1a2 u0 com.foo/.MainActivity}
 *   mFocusedApp=Window{6f1a2 u0 com.foo/.MainActivity}
 */
export function parseFocusedWindow(dumpsys: string): Pick<DemoScreenState, 'activity' | 'packageName'> {
  const match = /mCurrentFocus=Window\{([^}]*)\}/.exec(dumpsys)
    ?? /mFocusedApp=Window\{([^}]*)\}/.exec(dumpsys)
  const inside = match?.[1]
  if (inside === undefined) return {}
  const tokens = inside.trim().split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (last === undefined || last.length === 0 || last === 'null') return {}

  const slash = last.indexOf('/')
  if (slash <= 0) return { packageName: last }
  const packageName = last.slice(0, slash)
  const rawActivity = last.slice(slash + 1)
  if (rawActivity.length === 0) return { packageName }
  // A leading dot means the activity name is relative to the package.
  const activity = rawActivity.startsWith('.') ? `${packageName}${rawActivity}` : rawActivity
  return { activity, packageName }
}

/**
 * Reduce a `uiautomator dump` XML to the handful of strings a human or an LLM
 * would use to recognise the page.
 */
export function extractUiText(xml: string, limit = MAX_TEXT_NODES): string | undefined {
  const texts: string[] = []
  const pattern = /\btext="([^"]*)"/g
  for (let match = pattern.exec(xml); match !== null; match = pattern.exec(xml)) {
    const value = unescapeXml(match[1] ?? '').trim()
    if (value.length === 0) continue
    if (texts.includes(value)) continue
    texts.push(value)
    if (texts.length >= limit) break
  }
  return texts.length > 0 ? texts.join(' / ') : undefined
}

/**
 * Read the focused window and, best-effort, the visible text.
 * Every probe is optional: a phone that answers slowly must not lose the step.
 */
export async function probeScreenState(
  runner: AdbRunner,
  options: { readonly withText?: boolean } = {},
): Promise<Omit<DemoScreenState, 'screenshotPath'>> {
  const state: Omit<DemoScreenState, 'screenshotPath'> = {}
  try {
    const dump = await runner.run(['shell', 'dumpsys', 'window'], PROBE_TIMEOUT_MS)
    Object.assign(state, parseFocusedWindow(dump.stdout))
  }
  catch {
    // Offline device: the step is still recorded, just without page context.
  }
  if (options.withText === true) {
    try {
      // /dev/tty makes uiautomator write the hierarchy to stdout instead of a
      // file on the device, which saves a pull and leaves nothing behind.
      const dump = await runner.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], PROBE_TIMEOUT_MS)
      const summary = extractUiText(dump.stdout)
      if (summary !== undefined) state.textSummary = summary
    }
    catch {
      // Text is a nicety; ignore.
    }
  }
  return state
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
