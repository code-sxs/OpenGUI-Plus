/**
 * Module 4 — Scheduler.
 *
 * Runs saved snippets and action templates on a wall clock, so "screenshot the
 * build every morning at nine" is one call instead of a person. A 30-second
 * timer in `start()` calls `tick()`, which fires every task whose `nextRunAt`
 * has passed. `nextRunAt` is recomputed from the schedule rather than by adding
 * a fixed interval, so a machine that slept through its slot fires once on
 * wake and then re-aligns instead of catching up with a burst.
 *
 * @module modules/scheduler
 */

import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import type { Iso8601, Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'
import { cronMatches, nextCronRun, parseCron } from './cron.js'

export type ScheduleKind =
  | { readonly kind: 'once', readonly at: Iso8601 }
  | { readonly kind: 'daily', readonly at: string }
  | { readonly kind: 'weekly', readonly weekdays: readonly number[], readonly at: string }
  | { readonly kind: 'cron', readonly expression: string }

export type ScheduleTarget =
  | { readonly type: 'snippet', readonly alias: string }
  | { readonly type: 'template', readonly templateId: string, readonly variables?: Readonly<Record<string, string>> }
  | { readonly type: 'flow', readonly steps: readonly string[] }

export type RunStatus = 'success' | 'failure' | 'skipped'

export interface ScheduledTask {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly schedule: ScheduleKind
  readonly target: ScheduleTarget
  readonly lastRunAt?: Iso8601
  readonly lastStatus?: RunStatus
  readonly lastError?: string
  readonly nextRunAt?: Iso8601
  readonly runCount: number
  readonly createdAt: Iso8601
  readonly updatedAt: Iso8601
}

export interface ScheduleRunLog {
  readonly id: string
  readonly taskId: string
  readonly taskName: string
  readonly at: Iso8601
  readonly status: RunStatus
  readonly detail?: string
  readonly error?: string
  readonly trigger: 'manual' | 'automatic'
}

const TASKS_KEY = 'schedules'
const RUNS_KEY = 'schedule-runs'
const TICK_MS = 30_000
const RUN_LOG_LIMIT = 200
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isTime(value: string): boolean {
  return TIME_PATTERN.test(value)
}

/** Validate the `schedule` input; returns a normalised copy. */
function parseSchedule(value: unknown): Result<ScheduleKind> {
  if (!isRecord(value)) return fail('schedule 必须是对象')
  const kind = readString(value, 'kind')
  if (kind === 'once') {
    const at = readString(value, 'at')
    if (at === undefined) return fail('once 计划需要 at（ISO 时间）')
    if (Number.isNaN(Date.parse(at))) return fail(`at 不是合法时间："${at}"`)
    return ok({ kind: 'once', at: new Date(at).toISOString() })
  }
  if (kind === 'daily') {
    const at = readString(value, 'at')
    if (at === undefined || isTime(at) === false) return fail('daily 计划的 at 必须是 HH:mm')
    return ok({ kind: 'daily', at })
  }
  if (kind === 'weekly') {
    const at = readString(value, 'at')
    if (at === undefined || isTime(at) === false) return fail('weekly 计划的 at 必须是 HH:mm')
    const raw = value.weekdays
    if (!Array.isArray(raw) || raw.length === 0) return fail('weekly 计划需要非空的 weekdays 数组')
    const weekdays: number[] = []
    for (const entry of raw) {
      const day = typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10)
      if (!Number.isInteger(day) || day < 0 || day > 6) return fail(`weekday 必须是 0-6（0=周日），收到 "${String(entry)}"`)
      if (weekdays.includes(day) === false) weekdays.push(day)
    }
    return ok({ kind: 'weekly', weekdays, at })
  }
  if (kind === 'cron') {
    const expression = readString(value, 'expression')
    if (expression === undefined) return fail('cron 计划需要 expression')
    try {
      parseCron(expression)
    }
    catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    return ok({ kind: 'cron', expression })
  }
  return fail(`未知的计划类型 "${String(kind)}"; 可选：once | daily | weekly | cron`)
}

function parseVariables(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = String(raw)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate the `target` input; returns a normalised copy. */
function parseTarget(value: unknown): Result<ScheduleTarget> {
  if (!isRecord(value)) return fail('target 必须是对象')
  const type = readString(value, 'type')
  if (type === 'snippet') {
    const alias = readString(value, 'alias')
    if (alias === undefined) return fail('snippet 目标需要 alias')
    return ok({ type: 'snippet', alias })
  }
  if (type === 'template') {
    const templateId = readString(value, 'templateId') ?? readString(value, 'id')
    if (templateId === undefined) return fail('template 目标需要 templateId')
    const variables = parseVariables(value.variables)
    return ok({ type: 'template', templateId, ...(variables === undefined ? {} : { variables }) })
  }
  if (type === 'flow') {
    const raw = value.steps
    if (!Array.isArray(raw) || raw.length === 0) return fail('flow 目标需要非空的 steps 数组')
    const steps: string[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string' || entry.trim().length === 0) return fail('flow 的每项必须是非空字符串')
      const text = entry.trim()
      const prefix = text.slice(0, text.indexOf(':'))
      const body = text.slice(text.indexOf(':') + 1).trim()
      if ((prefix !== 'snippet' && prefix !== 'template') || body.length === 0) {
        return fail(`flow 步骤 "${text}" 格式错误，应为 "snippet:<alias>" 或 "template:<id>"`)
      }
      steps.push(`${prefix}:${body}`)
    }
    return ok({ type: 'flow', steps })
  }
  return fail(`未知的目标类型 "${String(type)}"; 可选：snippet | template | flow`)
}

/** Next fire time for a non-recurring schedule in the past is already gone. */
export function computeNextRun(schedule: ScheduleKind, from: Date = new Date()): Iso8601 | undefined {
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at)
    return at > from.getTime() ? new Date(at).toISOString() : undefined
  }
  if (schedule.kind === 'cron') {
    const next = nextCronRun(schedule.expression, from)
    return next === null ? undefined : next.toISOString()
  }

  const [hourText, minuteText] = schedule.at.split(':')
  const hour = Number.parseInt(hourText ?? '0', 10)
  const minute = Number.parseInt(minuteText ?? '0', 10)
  const allowedDays = schedule.kind === 'weekly' ? new Set(schedule.weekdays) : null

  // Candidate days are always in local time; the console shows local time too.
  for (let offset = 0; offset < 366; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute, 0, 0)
    if (candidate.getTime() <= from.getTime()) continue
    if (allowedDays !== null && allowedDays.has(candidate.getDay()) === false) continue
    return candidate.toISOString()
  }
  return undefined
}

/** True when a `once` schedule has already elapsed (used by tick bookkeeping). */
function isExpired(schedule: ScheduleKind, now: Date): boolean {
  return schedule.kind === 'once' && Date.parse(schedule.at) <= now.getTime()
}

function normaliseTask(row: Record<string, unknown>): ScheduledTask | null {
  const id = readString(row, 'id')
  const name = readString(row, 'name')
  if (id === undefined || name === undefined) return null
  const schedule = parseSchedule(row.schedule)
  if (!schedule.ok) return null
  const target = parseTarget(row.target)
  if (!target.ok) return null
  const now = new Date().toISOString()
  return {
    id,
    name,
    enabled: row.enabled !== false,
    schedule: schedule.value,
    target: target.value,
    runCount: typeof row.runCount === 'number' && Number.isFinite(row.runCount) ? Math.max(0, Math.floor(row.runCount)) : 0,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    ...(readString(row, 'lastRunAt') === undefined ? {} : { lastRunAt: readString(row, 'lastRunAt')! }),
    ...(readString(row, 'lastError') === undefined ? {} : { lastError: readString(row, 'lastError')! }),
    ...(readString(row, 'nextRunAt') === undefined ? {} : { nextRunAt: readString(row, 'nextRunAt')! }),
    ...(row.lastStatus === 'success' || row.lastStatus === 'failure' || row.lastStatus === 'skipped'
      ? { lastStatus: row.lastStatus }
      : {}),
  }
}

/** Build the module. */
export function createSchedulerModule(): PlusModule {
  let context: ModuleContext | null = null
  let tasks: ScheduledTask[] = []
  let runs: ScheduleRunLog[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  async function persistTasks(): Promise<void> {
    if (context === null) return
    await context.store.set(TASKS_KEY, tasks)
  }

  async function persistRuns(): Promise<void> {
    if (context === null) return
    if (runs.length > RUN_LOG_LIMIT) runs = runs.slice(-RUN_LOG_LIMIT)
    await context.store.set(RUNS_KEY, runs)
  }

  async function load(ctx: ModuleContext): Promise<void> {
    const storedTasks = await ctx.store.get(TASKS_KEY, [] as readonly unknown[])
    tasks = Array.isArray(storedTasks)
      ? (storedTasks as readonly unknown[]).filter(isRecord).map(normaliseTask).filter((row): row is ScheduledTask => row !== null)
      : []
    const storedRuns = await ctx.store.get(RUNS_KEY, [] as readonly ScheduleRunLog[])
    runs = Array.isArray(storedRuns) ? storedRuns.slice(-RUN_LOG_LIMIT) : []
  }

  function appendRun(entry: ScheduleRunLog): void {
    runs = [...runs, entry].slice(-RUN_LOG_LIMIT)
    void persistRuns()
  }

  /** Dispatch one target; never throws. */
  async function runTarget(task: ScheduledTask): Promise<{ readonly ok: boolean, readonly detail?: string, readonly error?: string }> {
    if (context === null) return { ok: false, error: '模块未启动' }
    const target = task.target

    if (target.type === 'snippet') {
      const result = await context.call('snippet-library.resolve', { alias: target.alias })
      return result.ok
        ? { ok: true, detail: `已解析别名 ${target.alias}` }
        : { ok: false, error: result.error }
    }

    if (target.type === 'template') {
      const result = await context.call('action-template.execute', {
        id: target.templateId,
        ...(target.variables === undefined ? {} : { variables: target.variables }),
      })
      return result.ok ? { ok: true, detail: `已执行模板 ${target.templateId}` } : { ok: false, error: result.error }
    }

    const details: string[] = []
    for (const step of target.steps) {
      const colon = step.indexOf(':')
      const type = step.slice(0, colon)
      const body = step.slice(colon + 1)
      const callTarget = type === 'snippet' ? 'snippet-library.resolve' : 'action-template.execute'
      const input = type === 'snippet' ? { alias: body } : { id: body }
      const result = await context.call(callTarget, input)
      if (!result.ok) {
        return { ok: false, error: `步骤 "${step}" 失败：${result.error}` }
      }
      details.push(`${step} 完成`)
    }
    return { ok: true, detail: details.join('; ') }
  }

  /** Execute now, record the outcome and reschedule. `trigger` only affects the log. */
  async function fire(task: ScheduledTask, trigger: 'manual' | 'automatic'): Promise<{ readonly taskId: string, readonly ok: boolean, readonly detail?: string, readonly error?: string }> {
    const now = new Date()
    let outcome: { readonly ok: boolean, readonly detail?: string, readonly error?: string }
    try {
      outcome = await runTarget(task)
    }
    catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const stamp = now.toISOString()
    const status: RunStatus = outcome.ok ? 'success' : 'failure'
    const updated: ScheduledTask = {
      ...task,
      runCount: task.runCount + 1,
      lastRunAt: stamp,
      lastStatus: status,
      updatedAt: stamp,
      // A one-shot task has nothing left to schedule.
      nextRunAt: task.schedule.kind === 'once' ? undefined : computeNextRun(task.schedule, now),
      ...(outcome.error === undefined ? {} : { lastError: outcome.error }),
    }
    tasks = tasks.map(row => (row.id === task.id ? updated : row))
    await persistTasks()

    appendRun({
      id: createId('run'),
      taskId: task.id,
      taskName: task.name,
      at: stamp,
      status,
      trigger,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    })

    context?.events.publish('scheduler', PLUS_EVENTS.scheduleFired, {
      taskId: task.id,
      name: task.name,
      ok: outcome.ok,
      trigger,
      at: stamp,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    })

    return {
      taskId: task.id,
      ok: outcome.ok,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }
  }

  const module = defineModule({
    id: 'scheduler',
    name: '定时任务',
    version: '0.1.0',
    summary: '按一次/每日/每周/cron 计划触发快捷指令或动作模板，自动记录执行日志。',
    dependsOn: ['snippet-library', 'action-template'],

    methods: {
      async create(input) {
        const name = readString(input, 'name')
        if (name === undefined) return fail('create 需要 name')
        const schedule = parseSchedule(input.schedule)
        if (!schedule.ok) return fail(schedule.error)
        const target = parseTarget(input.target)
        if (!target.ok) return fail(target.error)
        const now = new Date().toISOString()
        const task: ScheduledTask = {
          id: createId('sch'),
          name,
          enabled: input.enabled !== false,
          schedule: schedule.value,
          target: target.value,
          nextRunAt: computeNextRun(schedule.value),
          runCount: 0,
          createdAt: now,
          updatedAt: now,
        }
        tasks = [...tasks, task]
        await persistTasks()
        return { task, tasks }
      },

      async list() {
        return { tasks, total: tasks.length }
      },

      async update(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('update 需要 id')
        const existing = tasks.find(task => task.id === id)
        if (existing === undefined) return fail(`未找到任务 "${id}"`)

        let schedule = existing.schedule
        if (input.schedule !== undefined) {
          const parsed = parseSchedule(input.schedule)
          if (!parsed.ok) return fail(parsed.error)
          schedule = parsed.value
        }
        let target = existing.target
        if (input.target !== undefined) {
          const parsed = parseTarget(input.target)
          if (!parsed.ok) return fail(parsed.error)
          target = parsed.value
        }

        const updated: ScheduledTask = {
          ...existing,
          name: readString(input, 'name') ?? existing.name,
          schedule,
          target,
          enabled: typeof input.enabled === 'boolean' ? input.enabled : existing.enabled,
          nextRunAt: computeNextRun(schedule),
          updatedAt: new Date().toISOString(),
        }
        tasks = tasks.map(task => (task.id === id ? updated : task))
        await persistTasks()
        return { task: updated }
      },

      async remove(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('remove 需要 id')
        if (tasks.some(task => task.id === id) === false) return fail(`未找到任务 "${id}"`)
        tasks = tasks.filter(task => task.id !== id)
        await persistTasks()
        return { removed: id, total: tasks.length }
      },

      async enable(input) {
        return setEnabled(input, true)
      },

      async disable(input) {
        return setEnabled(input, false)
      },

      async runNow(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('runNow 需要 id')
        const task = tasks.find(row => row.id === id)
        if (task === undefined) return fail(`未找到任务 "${id}"`)
        return fire(task, 'manual')
      },

      /**
       * Fire everything that is due. Re-entrancy is guarded by a boolean lock
       * because the 30s timer and a manual `runNow` can overlap.
       */
      async tick() {
        if (ticking) return { checked: 0, fired: [] as readonly { readonly taskId: string, readonly ok: boolean }[], skipped: true }
        ticking = true
        try {
          const now = new Date()
          const fired: { readonly taskId: string, readonly ok: boolean }[] = []
          for (const task of tasks) {
            if (task.enabled === false) continue
            if (task.nextRunAt === undefined) continue
            if (Date.parse(task.nextRunAt) > now.getTime()) continue
            const result = await fire(task, 'automatic')
            fired.push({ taskId: result.taskId, ok: result.ok })
          }
          return { checked: tasks.length, fired, at: now.toISOString() }
        }
        finally {
          ticking = false
        }
      },

      async nextRuns(input) {
        const rawLimit = input.limit
        const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 100)
          : 10
        const rows = tasks
          .filter(task => task.enabled && task.nextRunAt !== undefined)
          .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
          .slice(0, limit)
          .map(task => ({ id: task.id, name: task.name, nextRunAt: task.nextRunAt!, schedule: task.schedule }))
        return { runs: rows, total: rows.length }
      },

      async runs(input) {
        const rawLimit = input.limit
        const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, RUN_LOG_LIMIT)
          : 20
        return { runs: runs.slice(-limit).reverse(), total: runs.length }
      },
    },

    methodSpecs: [
      { name: 'create', summary: '创建定时任务', input: { name: '任务名', schedule: '{ kind, at | weekdays | expression }', target: '{ type: snippet | template | flow, ... }', enabled: '是否启用，默认 true' } },
      { name: 'list', summary: '列出全部任务' },
      { name: 'update', summary: '修改任务', input: { id: '任务 id', name: '名称', schedule: '计划', target: '目标', enabled: '是否启用' } },
      { name: 'remove', summary: '删除任务', input: { id: '任务 id' } },
      { name: 'enable', summary: '启用任务', input: { id: '任务 id' } },
      { name: 'disable', summary: '停用任务', input: { id: '任务 id' } },
      { name: 'runNow', summary: '立即执行一次', input: { id: '任务 id' } },
      { name: 'tick', summary: '检查并触发到期任务（内部每 30 秒调用）' },
      { name: 'nextRuns', summary: '按时间升序列出即将执行的任务', input: { limit: '数量，默认 10' } },
      { name: 'runs', summary: '查看执行日志', input: { limit: '数量，默认 20' } },
    ],

    async start(ctx) {
      context = ctx
      await load(ctx)
      // Expired one-shots are cleared so `nextRuns` does not show stale entries.
      const now = new Date()
      let changed = false
      tasks = tasks.map((task) => {
        if (task.nextRunAt === undefined && isExpired(task.schedule, now) === false && task.schedule.kind !== 'once') {
          changed = true
          return { ...task, nextRunAt: computeNextRun(task.schedule, now) }
        }
        return task
      })
      if (changed) await persistTasks()
      timer = setInterval(() => {
        void module.methods.tick!({})
      }, TICK_MS)
      // An unref'd timer would let the process exit mid-flight; node keeps a
      // ref'd one alive, which is what a scheduler wants.
    },

    async reseat(ctx) {
      context = ctx
      await load(ctx)
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      context = null
      tasks = []
      runs = []
    },

    async health() {
      return {
        healthy: context !== null,
        detail: `${tasks.filter(task => task.enabled).length}/${tasks.length} 个任务启用中，日志 ${runs.length} 条`,
      }
    },
  })

  async function setEnabled(input: Record<string, unknown>, enabled: boolean): Promise<unknown> {
    const id = readString(input, 'id')
    if (id === undefined) return fail(`${enabled ? 'enable' : 'disable'} 需要 id`)
    const existing = tasks.find(task => task.id === id)
    if (existing === undefined) return fail(`未找到任务 "${id}"`)
    const updated: ScheduledTask = {
      ...existing,
      enabled,
      updatedAt: new Date().toISOString(),
      nextRunAt: enabled ? computeNextRun(existing.schedule) : existing.nextRunAt,
    }
    tasks = tasks.map(task => (task.id === id ? updated : task))
    await persistTasks()
    return { task: updated }
  }

  return module
}

export { cronMatches, nextCronRun }
