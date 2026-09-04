/**
 * Placeholder extraction and step validation for the demo recorder.
 *
 * Both halves are pure, which is where most of the module's tests live.
 *
 * @module modules/demo-recorder/variables
 */

import { createId } from '../../core/id.js'
import { fail, ok, type Result } from '../../core/types.js'

import type { DemoStep, DemoVariable } from './types.js'

/** `{{name}}`, tolerant of inner spacing and of CJK identifiers. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*\}\}/g

/** Collect every `{{variable}}` referenced by a step's params, in first-seen order. */
export function extractVariables(steps: readonly DemoStep[]): DemoVariable[] {
  const found: DemoVariable[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    for (const value of Object.values(step.params)) {
      if (typeof value !== 'string') continue
      for (let match = PLACEHOLDER.exec(value); match !== null; match = PLACEHOLDER.exec(value)) {
        const name = match[1]
        if (name === undefined || seen.has(name)) continue
        seen.add(name)
        found.push({ name, label: name, required: true })
      }
    }
  }
  return found
}

/**
 * Merge freshly extracted placeholders into the existing list, so a user-supplied
 * `defaultValue` or `label` survives the next `revise`.
 */
export function mergeVariables(
  previous: readonly DemoVariable[],
  extracted: readonly DemoVariable[],
): DemoVariable[] {
  const byName = new Map(previous.map(variable => [variable.name, variable]))
  const merged: DemoVariable[] = []
  for (const variable of extracted) {
    const existing = byName.get(variable.name)
    if (existing === undefined) {
      merged.push(variable)
      continue
    }
    merged.push({
      ...existing,
      name: variable.name,
      // A placeholder still present in the steps stays required.
      required: true,
      ...(existing.label.length > 0 ? { label: existing.label } : { label: variable.name }),
    })
  }
  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readParams(source: Record<string, unknown>): Record<string, string | number> {
  const raw = source.params
  if (!isRecord(raw)) return {}
  const params: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = value
  }
  return params
}

function readScreenState(source: Record<string, unknown>): DemoStep['screenState'] {
  const raw = source.screenState
  if (!isRecord(raw)) return undefined
  const state: NonNullable<DemoStep['screenState']> = {}
  const activity = readString(raw, 'activity')
  const packageName = readString(raw, 'packageName')
  const screenshotPath = readString(raw, 'screenshotPath')
  const textSummary = readString(raw, 'textSummary')
  if (activity !== undefined) state.activity = activity
  if (packageName !== undefined) state.packageName = packageName
  if (screenshotPath !== undefined) state.screenshotPath = screenshotPath
  if (textSummary !== undefined) state.textSummary = textSummary
  return Object.keys(state).length > 0 ? state : undefined
}

/**
 * Coerce user-supplied steps into `DemoStep[]`.
 *
 * The only hard rule is that every step carries a non-empty `action`; ids,
 * timestamps and screen state are filled in when missing so a caller can send
 * a minimal `{ action, params }` list.
 */
export function normaliseSteps(input: unknown): Result<DemoStep[]> {
  if (!Array.isArray(input)) return fail('steps must be an array')
  const now = new Date().toISOString()
  const steps: DemoStep[] = []
  for (const [index, entry] of input.entries()) {
    if (!isRecord(entry)) return fail(`step ${index}: expected an object`)
    const action = readString(entry, 'action')
    if (action === undefined) return fail(`step ${index}: missing "action"`)
    steps.push({
      id: readString(entry, 'id') ?? createId('stp'),
      at: readString(entry, 'at') ?? now,
      action,
      params: readParams(entry),
      ...(readScreenState(entry) === undefined ? {} : { screenState: readScreenState(entry)! }),
      ...(readString(entry, 'note') === undefined ? {} : { note: readString(entry, 'note')! }),
    })
  }
  return ok(steps)
}
