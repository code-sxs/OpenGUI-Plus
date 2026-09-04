/**
 * The `.opengui-workflow` interchange format.
 *
 * This is the contract between the marketplace, the demo recorder, the action
 * template module and anything a user exports to a colleague. It is therefore
 * validated hard: a document that reaches `validateWorkflow().ok` must be
 * executable without further guessing.
 *
 * Versioning rule: a reader accepts any `formatVersion` it knows
 * (1..WORKFLOW_FORMAT_VERSION). Writers always emit WORKFLOW_FORMAT_VERSION.
 *
 * @module modules/workflow-marketplace/schema
 */

import { fail, ok, type Result } from '../../core/types.js'

export const WORKFLOW_FORMAT_VERSION = 1
export const WORKFLOW_FILE_EXTENSION = '.opengui-workflow'

export const WORKFLOW_CATEGORIES = [
  'social-operations',
  'app-testing',
  'auto-checkin',
  'data-collection',
  'other',
] as const

export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number]

/** Chinese labels, so the console never has to keep its own lookup table. */
export const WORKFLOW_CATEGORY_LABELS: Readonly<Record<WorkflowCategory, string>> = {
  'social-operations': '社媒运营',
  'app-testing': 'App 测试',
  'auto-checkin': '自动打卡',
  'data-collection': '数据采集',
  'other': '其他',
}

export type WorkflowParams = Record<string, string | number>

export interface WorkflowStep {
  readonly id: string
  readonly action: string
  readonly params: WorkflowParams
  readonly note?: string
}

export interface WorkflowParameter {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly defaultValue?: string
  readonly required: boolean
}

export interface WorkflowStats {
  readonly downloads: number
  readonly ratingSum: number
  readonly ratingCount: number
}

export interface WorkflowTemplate {
  readonly formatVersion: number
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: WorkflowCategory
  readonly author: string
  readonly version: string
  readonly tags: readonly string[]
  /** What the workflow is meant to achieve; written for an LLM to read. */
  readonly taskIntent: string
  /** Things that must hold before step 1, e.g. "设备已授权 USB 调试". */
  readonly preconditions: readonly string[]
  readonly steps: readonly WorkflowStep[]
  readonly parameters: readonly WorkflowParameter[]
  readonly stats?: WorkflowStats
  readonly createdAt: string
  readonly updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): Result<string> {
  const value = source[key]
  if (typeof value !== 'string') return fail(`${path}.${key} 必须是非空字符串`)
  const trimmed = value.trim()
  return trimmed.length > 0 ? ok(trimmed) : fail(`${path}.${key} 必须是非空字符串`)
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stringList(source: Record<string, unknown>, key: string, path: string): Result<readonly string[]> {
  const value = source[key]
  if (value === undefined) return ok([])
  if (!Array.isArray(value)) return fail(`${path}.${key} 必须是字符串数组`)
  return ok(value.filter((entry): entry is string => typeof entry === 'string'))
}

function paramsOf(source: Record<string, unknown>, path: string): Result<WorkflowParams> {
  const raw = source.params
  if (raw === undefined) return ok({})
  if (!isRecord(raw)) return fail(`${path}.params 必须是对象`)
  const params: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number') {
      params[key] = value
      continue
    }
    if (typeof value === 'boolean') {
      // Booleans arrive routinely from JSON forms; keep them as a string so the
      // executor can still interpolate them into adb arguments.
      params[key] = value ? 'true' : 'false'
      continue
    }
    return fail(`${path}.params.${key} 必须是字符串或数字`)
  }
  return ok(params)
}

function stepsOf(source: Record<string, unknown>, path: string): Result<readonly WorkflowStep[]> {
  const raw = source.steps
  if (!Array.isArray(raw)) return fail(`${path}.steps 必须是数组`)
  if (raw.length === 0) return fail(`${path}.steps 不能为空`)

  const steps: WorkflowStep[] = []
  const usedIds = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const here = `${path}.steps[${index}]`
    if (!isRecord(entry)) return fail(`${here} 必须是对象`)
    const id = requiredString(entry, 'id', here)
    if (!id.ok) return id
    const action = requiredString(entry, 'action', here)
    if (!action.ok) return action
    if (usedIds.has(id.value)) return fail(`${here}.id 重复: "${id.value}"`)
    usedIds.add(id.value)
    const params = paramsOf(entry, here)
    if (!params.ok) return params
    steps.push({
      id: id.value,
      action: action.value,
      params: params.value,
      ...(optionalString(entry, 'note') === undefined ? {} : { note: optionalString(entry, 'note')! }),
    })
  }
  return ok(steps)
}

function parametersOf(source: Record<string, unknown>, path: string): Result<readonly WorkflowParameter[]> {
  const raw = source.parameters
  if (raw === undefined) return ok([])
  if (!Array.isArray(raw)) return fail(`${path}.parameters 必须是数组`)

  const parameters: WorkflowParameter[] = []
  const usedNames = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const here = `${path}.parameters[${index}]`
    if (!isRecord(entry)) return fail(`${here} 必须是对象`)
    const name = requiredString(entry, 'name', here)
    if (!name.ok) return name
    if (usedNames.has(name.value)) return fail(`${here}.name 重复: "${name.value}"`)
    usedNames.add(name.value)
    const label = requiredString(entry, 'label', here)
    if (!label.ok) return label

    const defaultCandidate = optionalString(entry, 'defaultValue')
    const description = optionalString(entry, 'description')
    const required = entry.required === undefined ? true : entry.required === true

    parameters.push({
      name: name.value,
      label: label.value,
      required,
      ...(description === undefined ? {} : { description }),
      // Fill the default from `default` too: hand-written JSON often uses it.
      ...(defaultCandidate === undefined
        ? (optionalString(entry, 'default') === undefined
          ? {}
          : { defaultValue: optionalString(entry, 'default')! })
        : { defaultValue: defaultCandidate }),
    })
  }
  return ok(parameters)
}

function statsOf(source: Record<string, unknown>, path: string): Result<WorkflowStats | undefined> {
  const raw = source.stats
  if (raw === undefined) return ok(undefined)
  if (!isRecord(raw)) return fail(`${path}.stats 必须是对象`)
  const numbers: Record<string, number> = {}
  for (const key of ['downloads', 'ratingSum', 'ratingCount'] as const) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fail(`${path}.stats.${key} 必须是非负数字`)
    }
    numbers[key] = value
  }
  return ok({
    downloads: numbers.downloads ?? 0,
    ratingSum: numbers.ratingSum ?? 0,
    ratingCount: numbers.ratingCount ?? 0,
  })
}

/**
 * Strictly validate an unknown value as a `.opengui-workflow` document.
 *
 * Returns the normalised template (trimmed strings, defaults filled) so the
 * rest of the module never has to re-check a field.
 */
export function validateWorkflow(input: unknown, path = 'template'): Result<WorkflowTemplate> {
  if (!isRecord(input)) return fail(`${path} 必须是 JSON 对象`)

  const formatVersion = input.formatVersion
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    return fail(`${path}.formatVersion 必须是正整数`)
  }
  if (formatVersion > WORKFLOW_FORMAT_VERSION) {
    return fail(`${path}.formatVersion ${formatVersion} 高于本端支持的 ${WORKFLOW_FORMAT_VERSION}，请升级 OpenGUI-Plus`)
  }

  const id = requiredString(input, 'id', path)
  if (!id.ok) return id
  const name = requiredString(input, 'name', path)
  if (!name.ok) return name
  const description = requiredString(input, 'description', path)
  if (!description.ok) return description
  const author = requiredString(input, 'author', path)
  if (!author.ok) return author
  const version = requiredString(input, 'version', path)
  if (!version.ok) return version
  const taskIntent = requiredString(input, 'taskIntent', path)
  if (!taskIntent.ok) return taskIntent

  const category = input.category
  if (typeof category !== 'string' || !WORKFLOW_CATEGORIES.includes(category as WorkflowCategory)) {
    return fail(`${path}.category 必须是以下之一: ${WORKFLOW_CATEGORIES.join(' | ')}`)
  }

  const steps = stepsOf(input, path)
  if (!steps.ok) return steps
  const parameters = parametersOf(input, path)
  if (!parameters.ok) return parameters
  const tags = stringList(input, 'tags', path)
  if (!tags.ok) return tags
  const preconditions = stringList(input, 'preconditions', path)
  if (!preconditions.ok) return preconditions
  const stats = statsOf(input, path)
  if (!stats.ok) return stats

  const now = new Date().toISOString()
  return ok({
    formatVersion: WORKFLOW_FORMAT_VERSION,
    id: id.value,
    name: name.value,
    description: description.value,
    category: category as WorkflowCategory,
    author: author.value,
    version: version.value,
    tags: tags.value,
    taskIntent: taskIntent.value,
    preconditions: preconditions.value,
    steps: steps.value,
    parameters: parameters.value,
    createdAt: optionalString(input, 'createdAt') ?? now,
    updatedAt: optionalString(input, 'updatedAt') ?? now,
    ...(stats.value === undefined ? {} : { stats: stats.value }),
  })
}

/** Parse a `.opengui-workflow` file body; bad JSON yields a `fail`, never a throw. */
export function parseWorkflowJson(text: string): Result<WorkflowTemplate> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  }
  catch (error) {
    return fail(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateWorkflow(parsed)
}

/** Filename for an exported template: `<name>.opengui-workflow`, filesystem-safe. */
export function workflowFilename(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${safe.length > 0 ? safe : 'workflow'}${WORKFLOW_FILE_EXTENSION}`
}

/** Average of a stats block; `0` when nobody rated yet. */
export function averageRating(stats: WorkflowStats | undefined): number {
  if (stats === undefined || stats.ratingCount <= 0) return 0
  return Math.round((stats.ratingSum / stats.ratingCount) * 100) / 100
}
