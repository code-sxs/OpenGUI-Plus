/**
 * Local fallback executor for marketplace workflows.
 *
 * The preferred path is `context.call('action-template.execute', …)`; that
 * module owns retries, screenshots and reporting. This file is the fallback
 * for when action-template is not installed, so it stays deliberately small:
 * it maps a step onto an `adb shell input …` invocation and records what
 * happened. It never spawns anything on its own — all device I/O goes through
 * the injected `AdbRunner`.
 *
 * @module modules/workflow-marketplace/runner
 */

import type { AdbRunner } from '../../core/adb-runner.js'

import type { WorkflowStep } from './schema.js'

export interface StepExecution {
  readonly stepId: string
  readonly action: string
  readonly ok: boolean
  readonly detail: string
  /** True when the step was not executed because adb is unavailable. */
  readonly skipped?: boolean
}

export interface LocalRunResult {
  readonly executed: readonly StepExecution[]
  readonly ok: boolean
  /** True when adb was missing and steps were recorded but not performed. */
  readonly degraded: boolean
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Substitute `{{name}}` placeholders; unknown names are left verbatim. */
export function fillTemplate(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => {
    const value = variables[key]
    return value === undefined ? whole : value
  })
}

function stringParam(step: WorkflowStep, key: string, variables: Readonly<Record<string, string>>): string | undefined {
  const value = step.params[key]
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return undefined
  return fillTemplate(value, variables)
}

function numberParam(step: WorkflowStep, key: string, variables: Readonly<Record<string, string>>): number | undefined {
  const value = stringParam(step, key, variables)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Actions handled without touching the device. */
const PASSIVE_ACTIONS = new Set(['screenshot', 'collect', 'assert'])

/**
 * Execute steps in order against one device.
 *
 * A missing adb runner is not an error: the steps are still walked so the
 * caller sees what *would* have run, each marked `skipped`, and the overall
 * result carries `degraded: true`.
 */
export async function runStepsLocally(
  runner: AdbRunner | null,
  steps: readonly WorkflowStep[],
  variables: Readonly<Record<string, string>> = {},
): Promise<LocalRunResult> {
  const executed: StepExecution[] = []

  for (const step of steps) {
    if (PASSIVE_ACTIONS.has(step.action)) {
      executed.push({
        stepId: step.id,
        action: step.action,
        ok: true,
        detail: '由上层模块处理，本地执行跳过',
      })
      continue
    }

    if (step.action === 'wait') {
      const ms = numberParam(step, 'ms', variables) ?? numberParam(step, 'duration', variables) ?? 1000
      await sleep(Math.min(Math.max(ms, 0), 60_000))
      executed.push({ stepId: step.id, action: step.action, ok: true, detail: `等待 ${ms}ms` })
      continue
    }

    if (runner === null) {
      executed.push({
        stepId: step.id,
        action: step.action,
        ok: true,
        detail: 'adb 不可用，步骤未实际执行',
        skipped: true,
      })
      continue
    }

    const args = buildArgs(step, variables)
    if (args === undefined) {
      executed.push({
        stepId: step.id,
        action: step.action,
        ok: false,
        detail: `无法为动作 "${step.action}" 构造 adb 参数`,
      })
      break
    }
    try {
      const result = await runner.run(args)
      if (result.code !== 0) {
        executed.push({
          stepId: step.id,
          action: step.action,
          ok: false,
          detail: `adb ${args.join(' ')} 失败: ${result.stderr.trim() || `退出码 ${result.code}`}`,
        })
        break
      }
      executed.push({ stepId: step.id, action: step.action, ok: true, detail: `adb ${args.join(' ')}` })
    }
    catch (error) {
      executed.push({
        stepId: step.id,
        action: step.action,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
      break
    }
  }

  // `skipped` is only set when adb was missing, so it is an accurate
  // "this run did not really happen" signal.
  const degraded = executed.some(entry => entry.skipped === true)
  const completed = executed.length === steps.length
  return {
    executed,
    ok: completed && !degraded && executed.every(entry => entry.ok),
    degraded,
  }
}

/** Translate one step into `adb` arguments; `undefined` means "cannot express it". */
function buildArgs(step: WorkflowStep, variables: Readonly<Record<string, string>>): readonly string[] | undefined {
  switch (step.action) {
    case 'launch': {
      const pkg = stringParam(step, 'package', variables)
      return pkg === undefined ? undefined : ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']
    }
    case 'tap': {
      const x = numberParam(step, 'x', variables)
      const y = numberParam(step, 'y', variables)
      return x === undefined || y === undefined ? undefined : ['shell', 'input', 'tap', String(x), String(y)]
    }
    case 'input': {
      const text = stringParam(step, 'text', variables)
      // Spaces would be split into separate adb arguments, so quote the payload.
      return text === undefined ? undefined : ['shell', 'input', 'text', text.replaceAll(' ', '%s')]
    }
    case 'swipe': {
      const x1 = numberParam(step, 'x1', variables)
      const y1 = numberParam(step, 'y1', variables)
      const x2 = numberParam(step, 'x2', variables)
      const y2 = numberParam(step, 'y2', variables)
      const duration = numberParam(step, 'duration', variables) ?? 300
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined
      return ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)]
    }
    case 'keyevent': {
      const code = numberParam(step, 'code', variables)
      return code === undefined ? undefined : ['shell', 'input', 'keyevent', String(code)]
    }
    case 'shell': {
      const command = stringParam(step, 'command', variables)
      if (command === undefined) return undefined
      // Intentionally split on whitespace only: `adb shell` takes an argv, and
      // a template author writing `am start -W` expects exactly that.
      return ['shell', ...command.split(/\s+/).filter(part => part.length > 0)]
    }
    default:
      return undefined
  }
}
