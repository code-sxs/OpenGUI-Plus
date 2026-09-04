/**
 * Module 3 — Action templates.
 *
 * A multi-step phone interaction ("open settings, scroll, toggle Wi-Fi") costs
 * the same tokens every single time it is described. Recording it once as a
 * template means the next run is one call with a couple of variables.
 *
 * Recording happens in memory because a half-finished recording is not worth
 * persisting; only the finished template is stored, on the project scope.
 *
 * Every ADB step degrades gracefully: when no `AdbRunner` is injected (console
 * running on a laptop with no phone) the step is reported as skipped instead
 * of throwing, so a template can be rehearsed for its non-ADB steps.
 *
 * @module modules/action-template
 */

import type { AdbRunner } from '../../core/adb-runner.js'
import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import type { Iso8601, Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'
import {
  extractVariables,
  missingVariables,
  substitute,
  type StepParams,
  type TemplateVariable,
} from './variables.js'

export type ActionStepType =
  | 'connect'
  | 'launch'
  | 'shell'
  | 'tap'
  | 'swipe'
  | 'input'
  | 'screenshot'
  | 'wait'
  | 'snippet'
  | 'disconnect'

export const ACTION_STEP_TYPES: readonly ActionStepType[] = [
  'connect', 'launch', 'shell', 'tap', 'swipe', 'input', 'screenshot', 'wait', 'snippet', 'disconnect',
]

export interface ActionStep {
  readonly id: string
  readonly type: ActionStepType
  readonly params: StepParams
  readonly note?: string
}

export interface ActionTemplate {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly steps: readonly ActionStep[]
  readonly variables: readonly TemplateVariable[]
  readonly runCount: number
  readonly createdAt: Iso8601
  readonly updatedAt: Iso8601
}

/** Per-step outcome returned by `execute`. */
export interface StepResult {
  readonly stepId: string
  readonly type: ActionStepType
  readonly ok: boolean
  readonly detail?: string
  readonly skipped?: boolean
}

export interface ExecutionReport {
  readonly templateId: string
  readonly executedAt: Iso8601
  readonly results: readonly StepResult[]
  readonly ok: boolean
  readonly runCount: number
}

interface RecordingSession {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly steps: ActionStep[]
  readonly createdAt: Iso8601
}

const STORE_KEY = 'action-templates'
const DEFAULT_WAIT_MS = 1000
const MAX_WAIT_MS = 5 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Pull one of several accepted keys out of a step's params. */
function param(params: StepParams, ...keys: readonly string[]): string | number | undefined {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toInt(value: string | number | undefined): number | undefined {
  const number = toNumber(value)
  return number === undefined ? undefined : Math.round(number)
}

function normaliseParams(value: unknown): StepParams {
  if (!isRecord(value)) return {}
  const out: Record<string, string | number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === 'boolean') out[key] = raw ? '1' : '0'
  }
  return out
}

function normaliseStep(row: Record<string, unknown>): ActionStep | null {
  const type = readString(row, 'type')
  if (type === undefined || isStepType(type) === false) return null
  return {
    id: readString(row, 'id') ?? createId('stp'),
    type,
    params: normaliseParams(row.params),
    ...(readString(row, 'note') === undefined ? {} : { note: readString(row, 'note')! }),
  }
}

function isStepType(value: string): value is ActionStepType {
  return (ACTION_STEP_TYPES as readonly string[]).includes(value)
}

function normaliseTemplate(row: Record<string, unknown>): ActionTemplate | null {
  const id = readString(row, 'id')
  const name = readString(row, 'name')
  if (id === undefined || name === undefined) return null
  const rawSteps = Array.isArray(row.steps) ? row.steps : []
  const steps = rawSteps.filter(isRecord).map(normaliseStep).filter((step): step is ActionStep => step !== null)
  const now = new Date().toISOString()
  const variables = Array.isArray(row.variables)
    ? row.variables.filter(isRecord).map(entry => normaliseVariable(entry)).filter((entry): entry is TemplateVariable => entry !== null)
    : extractVariables(steps)
  return {
    id,
    name,
    steps,
    variables: variables.length > 0 ? variables : extractVariables(steps),
    runCount: typeof row.runCount === 'number' && Number.isFinite(row.runCount) ? Math.max(0, Math.floor(row.runCount)) : 0,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    ...(readString(row, 'description') === undefined ? {} : { description: readString(row, 'description')! }),
  }
}

function normaliseVariable(entry: Record<string, unknown>): TemplateVariable | null {
  const name = readString(entry, 'name')
  if (name === undefined) return null
  return {
    name,
    label: readString(entry, 'label') ?? name,
    required: entry.required !== false,
    ...(readString(entry, 'defaultValue') === undefined ? {} : { defaultValue: readString(entry, 'defaultValue')! }),
  }
}

/** Build the module. */
export function createActionTemplateModule(): PlusModule {
  let context: ModuleContext | null = null
  let templates: ActionTemplate[] = []
  const recordings = new Map<string, RecordingSession>()

  async function persist(): Promise<void> {
    if (context === null) return
    await context.store.set(STORE_KEY, templates)
  }

  async function load(ctx: ModuleContext): Promise<void> {
    const stored = await ctx.store.get(STORE_KEY, [] as readonly unknown[])
    if (!Array.isArray(stored)) {
      templates = []
      return
    }
    templates = (stored as readonly unknown[])
      .filter(isRecord)
      .map(normaliseTemplate)
      .filter((row): row is ActionTemplate => row !== null)
  }

  function adb(): AdbRunner | null {
    return context?.adb ?? null
  }

  /** Fill `{{variable}}` placeholders in every string parameter of a step. */
  function resolveParams(step: ActionStep, variables: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(step.params)) {
      out[key] = typeof value === 'string' ? substitute(value, variables) : String(value)
    }
    return out
  }

  async function runStep(step: ActionStep, variables: Readonly<Record<string, string>>): Promise<StepResult> {
    const runner = adb()
    const params = resolveParams(step, variables)

    if (step.type === 'connect' || step.type === 'disconnect') {
      if (context === null) return { stepId: step.id, type: step.type, ok: false, detail: '模块未启动', skipped: true }
      const target = `wlan-connection.${step.type}`
      const result = await context.call(target, {})
      return result.ok
        ? { stepId: step.id, type: step.type, ok: true, detail: `${target} 已执行` }
        : { stepId: step.id, type: step.type, ok: false, detail: result.error }
    }

    if (step.type === 'snippet') {
      const alias = params.alias ?? params.name
      if (alias === undefined || alias.length === 0) {
        return { stepId: step.id, type: step.type, ok: false, detail: 'snippet 步骤缺少 alias' }
      }
      if (context === null) return { stepId: step.id, type: step.type, ok: false, detail: '模块未启动', skipped: true }
      const result = await context.call('snippet-library.resolve', { alias })
      return result.ok
        ? { stepId: step.id, type: step.type, ok: true, detail: `已解析别名 ${alias}` }
        : { stepId: step.id, type: step.type, ok: false, detail: result.error }
    }

    if (step.type === 'wait') {
      const ms = toInt(param(step.params, 'ms', 'duration', 'durationMs')) ?? DEFAULT_WAIT_MS
      const clamped = Math.min(Math.max(ms, 0), MAX_WAIT_MS)
      await new Promise(resolve => setTimeout(resolve, clamped))
      return { stepId: step.id, type: step.type, ok: true, detail: `等待 ${clamped}ms` }
    }

    // Everything below needs adb.
    if (runner === null) {
      return { stepId: step.id, type: step.type, ok: false, skipped: true, detail: 'adb 不可用，已跳过该步骤' }
    }

    switch (step.type) {
      case 'launch': {
        const packageName = param(step.params, 'package', 'packageName', 'app')
        if (packageName === undefined) return { stepId: step.id, type: step.type, ok: false, detail: 'launch 步骤缺少 package' }
        const result = await runner.run(['shell', 'monkey', '-p', String(packageName), '-c', 'android.intent.category.LAUNCHER', '1'])
        return { stepId: step.id, type: step.type, ok: result.code === 0, detail: result.stdout.trim() || `已启动 ${String(packageName)}` }
      }
      case 'shell': {
        const command = param(step.params, 'command', 'cmd')
        if (command === undefined) return { stepId: step.id, type: step.type, ok: false, detail: 'shell 步骤缺少 command' }
        const result = await runner.run(['shell', ...String(command).split(/\s+/).filter(part => part.length > 0)])
        return { stepId: step.id, type: step.type, ok: result.code === 0, detail: result.stdout.trim() || result.stderr.trim() || `已执行 ${String(command)}` }
      }
      case 'tap': {
        const x = toInt(param(step.params, 'x'))
        const y = toInt(param(step.params, 'y'))
        if (x === undefined || y === undefined) return { stepId: step.id, type: step.type, ok: false, detail: 'tap 步骤需要 x 和 y' }
        await runner.run(['shell', 'input', 'tap', String(x), String(y)])
        return { stepId: step.id, type: step.type, ok: true, detail: `点击 (${x}, ${y})` }
      }
      case 'swipe': {
        const x1 = toInt(param(step.params, 'x1', 'fromX'))
        const y1 = toInt(param(step.params, 'y1', 'fromY'))
        const x2 = toInt(param(step.params, 'x2', 'toX'))
        const y2 = toInt(param(step.params, 'y2', 'toY'))
        const duration = toInt(param(step.params, 'duration', 'durationMs')) ?? 300
        if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
          return { stepId: step.id, type: step.type, ok: false, detail: 'swipe 步骤需要 x1, y1, x2, y2' }
        }
        await runner.run(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)])
        return { stepId: step.id, type: step.type, ok: true, detail: `滑动 (${x1},${y1}) → (${x2},${y2}) ${duration}ms` }
      }
      case 'input': {
        const text = param(step.params, 'text', 'value')
        if (text === undefined) return { stepId: step.id, type: step.type, ok: false, detail: 'input 步骤缺少 text' }
        const escaped = String(text).replace(/\s/g, '%s')
        await runner.run(['shell', 'input', 'text', escaped])
        return { stepId: step.id, type: step.type, ok: true, detail: `已输入文本（${String(text).length} 字符）` }
      }
      case 'screenshot': {
        const result = await runner.run(['exec-out', 'screencap', '-p'])
        // The PNG can be megabytes; only the size survives into the report.
        const bytes = Buffer.byteLength(result.stdout, 'utf8')
        return { stepId: step.id, type: step.type, ok: result.code === 0 && bytes > 0, detail: `截屏完成，约 ${bytes} 字节` }
      }
      default:
        return { stepId: step.id, type: step.type, ok: false, detail: `未支持的步骤类型 ${step.type}`, skipped: true }
    }
  }

  /** Shared by `execute` and the scheduler's template target. */
  async function executeTemplate(template: ActionTemplate, rawVariables: Readonly<Record<string, string>>): Promise<Result<ExecutionReport>> {
    const missing = missingVariables(template.steps, rawVariables)
    if (missing.length > 0) {
      return fail(`缺少必填变量：${missing.map(name => `{{${name}}}`).join('、')}`)
    }
    const variables: Record<string, string> = {}
    for (const variable of template.variables) {
      const supplied = rawVariables[variable.name]
      if (typeof supplied === 'string' && supplied.length > 0) variables[variable.name] = supplied
      else if (variable.defaultValue !== undefined) variables[variable.name] = variable.defaultValue
    }

    const results: StepResult[] = []
    for (const step of template.steps) {
      try {
        results.push(await runStep(step, variables))
      }
      catch (error) {
        results.push({ stepId: step.id, type: step.type, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }

    const stamp = new Date().toISOString()
    const updated: ActionTemplate = { ...template, runCount: template.runCount + 1, updatedAt: stamp }
    templates = templates.map(row => (row.id === template.id ? updated : row))
    await persist()

    const report: ExecutionReport = {
      templateId: template.id,
      executedAt: stamp,
      results,
      ok: results.every(result => result.ok || result.skipped === true),
      runCount: updated.runCount,
    }
    context?.events.publish('action-template', PLUS_EVENTS.templateExecuted, {
      templateId: template.id,
      name: template.name,
      ok: report.ok,
      steps: results.length,
      at: stamp,
    })
    return ok(report)
  }

  const module = defineModule({
    id: 'action-template',
    name: '动作模板',
    version: '0.1.0',
    summary: '把多步操作录成模板，支持 {{变量}} 占位与一键执行，显著降低重复操作的 Token 消耗。',
    dependsOn: ['wlan-connection', 'snippet-library'],

    methods: {
      async startRecording(input) {
        const name = readString(input, 'name')
        if (name === undefined) return fail('startRecording 需要 name')
        const id = readString(input, 'recordingId') ?? createId('rec')
        const session: RecordingSession = {
          id,
          name,
          steps: [],
          createdAt: new Date().toISOString(),
          ...(readString(input, 'description') === undefined ? {} : { description: readString(input, 'description')! }),
        }
        recordings.set(id, session)
        return { recordingId: id, name }
      },

      async recordStep(input) {
        const recordingId = readString(input, 'recordingId')
        if (recordingId === undefined) return fail('recordStep 需要 recordingId')
        const session = recordings.get(recordingId)
        if (session === undefined) return fail(`未找到录制会话 "${recordingId}"`)
        const type = readString(input, 'type')
        if (type === undefined) return fail('recordStep 需要 type')
        if (isStepType(type) === false) {
          return fail(`非法步骤类型 "${type}"; 可选：${ACTION_STEP_TYPES.join(' | ')}`)
        }
        const step: ActionStep = {
          id: readString(input, 'id') ?? createId('stp'),
          type,
          params: normaliseParams(input.params),
          ...(readString(input, 'note') === undefined ? {} : { note: readString(input, 'note')! }),
        }
        const steps = [...session.steps, step]
        recordings.set(recordingId, { ...session, steps })
        return { recordingId, step, total: steps.length }
      },

      /** Finish recording: scan params for `{{vars}}` and store the template. */
      async stopRecording(input) {
        const recordingId = readString(input, 'recordingId')
        if (recordingId === undefined) return fail('stopRecording 需要 recordingId')
        const session = recordings.get(recordingId)
        if (session === undefined) return fail(`未找到录制会话 "${recordingId}"`)
        const now = new Date().toISOString()
        const template: ActionTemplate = {
          id: createId('tpl'),
          name: session.name,
          steps: session.steps,
          variables: extractVariables(session.steps),
          runCount: 0,
          createdAt: now,
          updatedAt: now,
          ...(session.description === undefined ? {} : { description: session.description }),
        }
        templates = [...templates, template]
        await persist()
        recordings.delete(recordingId)
        return { template, recordingId }
      },

      async list() {
        return { templates, total: templates.length }
      },

      async get(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('get 需要 id')
        const template = templates.find(row => row.id === id)
        if (template === undefined) return fail(`未找到模板 "${id}"`)
        return { template }
      },

      async remove(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('remove 需要 id')
        if (templates.some(template => template.id === id) === false) return fail(`未找到模板 "${id}"`)
        templates = templates.filter(template => template.id !== id)
        await persist()
        return { removed: id, total: templates.length }
      },

      async update(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('update 需要 id')
        const existing = templates.find(template => template.id === id)
        if (existing === undefined) return fail(`未找到模板 "${id}"`)
        const rawSteps = input.steps
        let steps = existing.steps
        if (rawSteps !== undefined) {
          if (!Array.isArray(rawSteps)) return fail('steps 必须是数组')
          const parsed: ActionStep[] = []
          for (const row of rawSteps) {
            if (!isRecord(row)) return fail('steps 数组内存在非对象元素')
            const step = normaliseStep(row)
            if (step === null) return fail(`steps 内存在非法步骤类型；可选：${ACTION_STEP_TYPES.join(' | ')}`)
            parsed.push(step)
          }
          steps = parsed
        }
        const name = readString(input, 'name') ?? existing.name
        const updated: ActionTemplate = {
          ...existing,
          name,
          steps,
          // Re-derive variables so an edited step set cannot leave a stale one.
          variables: extractVariables(steps),
          updatedAt: new Date().toISOString(),
          ...(readString(input, 'description') === undefined
            ? (existing.description === undefined ? {} : { description: existing.description })
            : { description: readString(input, 'description')! }),
        }
        templates = templates.map(template => (template.id === id ? updated : template))
        await persist()
        return { template: updated }
      },

      async execute(input) {
        const id = readString(input, 'id') ?? readString(input, 'templateId')
        if (id === undefined) return fail('execute 需要 id')
        const template = templates.find(row => row.id === id)
        if (template === undefined) return fail(`未找到模板 "${id}"`)
        const result = await executeTemplate(template, readVariables(input.variables))
        return result.ok ? result.value : fail(result.error)
      },

      /** Called by demo-recorder: turn a recorded demo straight into a template. */
      async 'save-from-demo'(input) {
        const name = readString(input, 'name')
        if (name === undefined) return fail('save-from-demo 需要 name')
        const rawSteps = input.steps
        if (!Array.isArray(rawSteps) || rawSteps.length === 0) return fail('save-from-demo 需要非空的 steps 数组')
        const steps: ActionStep[] = []
        for (const row of rawSteps) {
          if (!isRecord(row)) return fail('steps 数组内存在非对象元素')
          const action = readString(row, 'action')
          if (action === undefined || isStepType(action) === false) {
            return fail(`非法 action "${String(action)}"; 可选：${ACTION_STEP_TYPES.join(' | ')}`)
          }
          steps.push({
            id: createId('stp'),
            type: action,
            params: normaliseParams(row.params),
            ...(readString(row, 'note') === undefined ? {} : { note: readString(row, 'note')! }),
          })
        }
        const now = new Date().toISOString()
        const template: ActionTemplate = {
          id: createId('tpl'),
          name,
          steps,
          variables: extractVariables(steps),
          runCount: 0,
          createdAt: now,
          updatedAt: now,
          ...(readString(input, 'description') === undefined ? {} : { description: readString(input, 'description')! }),
        }
        templates = [...templates, template]
        await persist()
        return { template }
      },
    },

    methodSpecs: [
      { name: 'startRecording', summary: '开始录制', input: { name: '模板名', description: '说明' } },
      { name: 'recordStep', summary: '追加一步', input: { recordingId: '会话 id', type: '步骤类型', params: '参数，值里可写 {{变量}}', note: '备注' } },
      { name: 'stopRecording', summary: '结束录制并自动提取 {{变量}}', input: { recordingId: '会话 id' } },
      { name: 'list', summary: '列出全部模板' },
      { name: 'get', summary: '查看单个模板', input: { id: '模板 id' } },
      { name: 'remove', summary: '删除模板', input: { id: '模板 id' } },
      { name: 'update', summary: '修改模板，改完重新提取变量', input: { id: '模板 id', name: '名称', description: '说明', steps: '步骤数组' } },
      { name: 'execute', summary: '按序执行模板', input: { id: '模板 id', variables: '变量值映射' } },
      { name: 'save-from-demo', summary: '由 demo-recorder 录制结果直接创建模板', input: { name: '模板名', description: '说明', steps: '[{ action, params, note }]' } },
    ],

    async start(ctx) {
      context = ctx
      await load(ctx)
    },

    async reseat(ctx) {
      context = ctx
      recordings.clear()
      await load(ctx)
    },

    async stop() {
      recordings.clear()
      context = null
      templates = []
    },

    async health() {
      const runner = adb()
      return {
        healthy: context !== null,
        detail: runner === null
          ? `${templates.length} 个模板（adb 不可用，ADB 类步骤会跳过）`
          : `${templates.length} 个模板，adb: ${runner.binary}`,
      }
    },
  })

  return module
}

/** Coerce the `variables` input bag into strings, ignoring anything else. */
function readVariables(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = String(raw)
  }
  return out
}

export { extractVariables, missingVariables, substitute }
export type { StepParams, TemplateVariable }
