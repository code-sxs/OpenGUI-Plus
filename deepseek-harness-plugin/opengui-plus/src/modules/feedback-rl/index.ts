/**
 * Module 8 — Human feedback reinforcement loop.
 *
 * Every task run ends with a human verdict (success / partial / failure). Two
 * things happen with it:
 *
 *   1. the raw verdict is kept as an append-only `FeedbackRecord`, so the
 *      success rate of a task can be measured over time;
 *   2. failures and partials that carry a symptom are distilled into an
 *      `Experience` — a (symptom, resolution) pair keyed by the normalised
 *      symptom, merged across repeats and counted when retrieved.
 *
 * The loop closes through `queryRelevant` / `markApplied`: the AI asks for
 * relevant experience before a run, and reports whether following it helped.
 * `successAfterApply / hitCount` then says whether that piece of advice is
 * actually worth surfacing again.
 *
 * Retrieval is lexical only (see `keywords.ts`); no external model is involved.
 *
 * @module modules/feedback-rl
 */

import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import { fail, ok } from '../../core/types.js'

import { rank, roundScore, tokenize } from './keywords.js'

const RECORDS_KEY = 'feedback-records'
const EXPERIENCES_KEY = 'feedback-experiences'

export type Outcome = 'success' | 'partial' | 'failure'

const OUTCOMES: readonly Outcome[] = ['success', 'partial', 'failure']

/** What went wrong, and how it was fixed. */
export interface FailureBranch {
  readonly symptom: string
  readonly step?: string
  readonly resolution?: string
}

export interface FeedbackContext {
  readonly deviceModel?: string
  readonly packageName?: string
  readonly templateId?: string
}

export interface FeedbackRecord {
  readonly id: string
  readonly taskLabel: string
  readonly outcome: Outcome
  readonly failureBranch?: FailureBranch
  readonly comment?: string
  readonly context?: FeedbackContext
  readonly createdAt: string
}

/** Distilled (symptom → resolution) knowledge, merged across feedbacks. */
export interface Experience {
  readonly id: string
  readonly symptom: string
  readonly resolution: string
  readonly sourceFeedbackIds: readonly string[]
  readonly hitCount: number
  readonly successAfterApply: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ExperienceMatch {
  readonly id: string
  readonly symptom: string
  readonly resolution: string
  readonly hitCount: number
  readonly successAfterApply: number
  readonly score: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Symptom identity: case- and whitespace-insensitive.
 * Two operators describing the same failure in different words ("登录失败" vs
 * " 登录失败 ") must converge onto one experience entry.
 */
export function normaliseSymptom(symptom: string): string {
  return symptom.trim().replace(/\s+/g, ' ').toLowerCase()
}

function readOutcome(value: unknown): Outcome | undefined {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value)
    ? value as Outcome
    : undefined
}

function readContext(source: Record<string, unknown>): FeedbackContext | undefined {
  const raw = source.context
  if (!isRecord(raw)) return undefined
  const context: { deviceModel?: string, packageName?: string, templateId?: string } = {}
  const deviceModel = readString(raw, 'deviceModel')
  const packageName = readString(raw, 'packageName')
  const templateId = readString(raw, 'templateId')
  if (deviceModel !== undefined) context.deviceModel = deviceModel
  if (packageName !== undefined) context.packageName = packageName
  if (templateId !== undefined) context.templateId = templateId
  return Object.keys(context).length > 0 ? context : undefined
}

export function createFeedbackRlModule(): PlusModule {
  let context: ModuleContext | null = null
  let records: FeedbackRecord[] = []
  let experiences: Experience[] = []

  async function persistRecords(): Promise<void> {
    if (context === null) return
    await context.global.set(RECORDS_KEY, records)
  }

  async function persistExperiences(): Promise<void> {
    if (context === null) return
    await context.global.set(EXPERIENCES_KEY, experiences)
  }

  /**
   * Distil a verdict into experience.
   *
   * Merging rule: an existing entry with the same normalised symptom gains the
   * feedback id and — only when the new report actually carries a resolution —
   * has its resolution overwritten, on the assumption that the latest fix is
   * the one that worked. Reports without a resolution must not erase a known
   * good one.
   */
  function digest(record: FeedbackRecord): void {
    const branch = record.failureBranch
    if (branch === undefined) return
    const symptom = branch.symptom.trim()
    if (symptom.length === 0) return
    const key = normaliseSymptom(symptom)
    const existing = experiences.find(entry => normaliseSymptom(entry.symptom) === key)
    const at = new Date().toISOString()
    if (existing === undefined) {
      experiences = [...experiences, {
        id: createId('exp'),
        symptom,
        resolution: branch.resolution?.trim() ?? '',
        sourceFeedbackIds: [record.id],
        hitCount: 0,
        successAfterApply: 0,
        createdAt: at,
        updatedAt: at,
      }]
      return
    }
    const resolution = branch.resolution?.trim()
    experiences = experiences.map((entry) => {
      if (entry.id !== existing.id) return entry
      return {
        ...entry,
        symptom,
        resolution: resolution !== undefined && resolution.length > 0 ? resolution : entry.resolution,
        sourceFeedbackIds: entry.sourceFeedbackIds.includes(record.id)
          ? entry.sourceFeedbackIds
          : [...entry.sourceFeedbackIds, record.id],
        updatedAt: at,
      }
    })
  }

  const module = defineModule({
    id: 'feedback-rl',
    name: '人类反馈强化学习回路',
    version: '0.1.0',
    summary: '收集人工成败判定，自动沉淀失败经验并在下次执行前检索复用，形成闭环学习。',

    methods: {
      async record(input) {
        const taskLabel = readString(input, 'taskLabel')
        if (taskLabel === undefined) return fail('record needs "taskLabel"')
        const rawOutcome = readOutcome(input.outcome)
        if (rawOutcome === undefined) {
          return fail('outcome 必须是 success | partial | failure 之一')
        }
        const outcome: Outcome = rawOutcome
        const symptom = readString(input, 'symptom')?.trim()
        const resolution = readString(input, 'resolution')?.trim()
        const step = readString(input, 'step')?.trim()

        const record: FeedbackRecord = {
          id: createId('fbk'),
          taskLabel: taskLabel.trim(),
          outcome,
          createdAt: new Date().toISOString(),
          ...(symptom === undefined && step === undefined && resolution === undefined
            ? {}
            : {
              failureBranch: {
                symptom: symptom ?? '',
                ...(step === undefined ? {} : { step }),
                ...(resolution === undefined ? {} : { resolution }),
              },
            }),
          ...(readString(input, 'comment') === undefined ? {} : { comment: readString(input, 'comment')!.trim() }),
          ...(readContext(input) === undefined ? {} : { context: readContext(input)! }),
        }

        records = [...records, record]
        const distilled = outcome !== 'success' && symptom !== undefined && symptom.length > 0
        if (distilled) digest(record)
        await persistRecords()
        if (distilled) await persistExperiences()

        context?.events.publish('feedback-rl', PLUS_EVENTS.feedbackRecorded, {
          id: record.id,
          taskLabel: record.taskLabel,
          outcome: record.outcome,
          distilled,
        })
        return { record, distilled }
      },

      async listRecords(input) {
        const taskLabel = readString(input, 'taskLabel')
        const outcome = input.outcome === undefined ? undefined : readOutcome(input.outcome)
        if (input.outcome !== undefined && outcome === undefined) {
          return fail('outcome 必须是 success | partial | failure 之一')
        }
        const rawLimit = input.limit
        const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50

        const filtered = records
          .filter(record => taskLabel === undefined || record.taskLabel === taskLabel)
          .filter(record => outcome === undefined || record.outcome === outcome)
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        return { items: filtered.slice(0, limit), total: filtered.length }
      },

      async listExperiences() {
        const items = [...experiences].toSorted((a, b) => b.hitCount - a.hitCount
          || b.successAfterApply - a.successAfterApply
          || b.updatedAt.localeCompare(a.updatedAt))
        return { items, total: items.length }
      },

      /**
       * Retrieve experience relevant to a symptom.
       *
       * Every returned entry gets `hitCount++`: being retrieved is itself a
       * signal that the symptom recurs, even when the operator ignores the
       * advice. `markApplied` is what says whether the advice was any good.
       */
      async queryRelevant(input) {
        const symptom = readString(input, 'symptom')
        if (symptom === undefined) return fail('queryRelevant needs "symptom"')
        const rawLimit = input.limit
        const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 5

        const query = tokenize(symptom)
        const ranked = rank(query, experiences, entry => `${entry.symptom} ${entry.resolution}`, entry => entry.hitCount)
        const top = ranked.slice(0, limit)
        const matches: ExperienceMatch[] = top.map(({ item, score }) => ({
          id: item.id,
          symptom: item.symptom,
          resolution: item.resolution,
          hitCount: item.hitCount + 1,
          successAfterApply: item.successAfterApply,
          score: roundScore(score),
        }))
        const hitIds = new Set(top.map(({ item }) => item.id))
        if (hitIds.size > 0) {
          experiences = experiences.map(entry => (hitIds.has(entry.id) ? { ...entry, hitCount: entry.hitCount + 1 } : entry))
          await persistExperiences()
        }
        return { query: symptom, total: matches.length, experiences: matches }
      },

      async markApplied(input) {
        const experienceId = readString(input, 'experienceId') ?? readString(input, 'id')
        if (experienceId === undefined) return fail('markApplied needs "experienceId"')
        const target = experiences.find(entry => entry.id === experienceId)
        if (target === undefined) return fail(`unknown experience "${experienceId}"`)
        const worked = input.worked === true
        experiences = experiences.map((entry) => {
          if (entry.id !== experienceId) return entry
          return {
            ...entry,
            successAfterApply: worked ? entry.successAfterApply + 1 : entry.successAfterApply,
            updatedAt: new Date().toISOString(),
          }
        })
        await persistExperiences()
        return { experienceId, worked, successAfterApply: target.successAfterApply + (worked ? 1 : 0) }
      },

      /** Aggregate view for the console dashboard. */
      async summary() {
        const byOutcome = { success: 0, partial: 0, failure: 0 }
        for (const record of records) byOutcome[record.outcome] += 1

        const symptomCounts = new Map<string, { readonly label: string, count: number }>()
        for (const record of records) {
          const symptom = record.failureBranch?.symptom
          if (symptom === undefined || symptom.trim().length === 0) continue
          const key = normaliseSymptom(symptom)
          const existing = symptomCounts.get(key)
          symptomCounts.set(key, { label: symptom.trim(), count: (existing?.count ?? 0) + 1 })
        }
        const topSymptoms = [...symptomCounts.entries()]
          .map(([, value]) => ({ symptom: value.label, count: value.count }))
          .toSorted((a, b) => b.count - a.count || a.symptom.localeCompare(b.symptom, 'zh-Hans-CN'))
          .slice(0, 5)

        const scored = records.length - byOutcome.failure
        return {
          total: records.length,
          success: byOutcome.success,
          partial: byOutcome.partial,
          failure: byOutcome.failure,
          successRate: records.length === 0 ? 0 : roundScore(byOutcome.success / records.length),
          nonFailureRate: records.length === 0 ? 0 : roundScore(scored / records.length),
          experiences: experiences.length,
          totalHits: experiences.reduce((sum, entry) => sum + entry.hitCount, 0),
          topSymptoms,
        }
      },

      async successRate(input) {
        const taskLabel = readString(input, 'taskLabel')
        if (taskLabel === undefined) return fail('successRate needs "taskLabel"')
        const rows = records.filter(record => record.taskLabel === taskLabel)
        const counts = { success: 0, partial: 0, failure: 0 }
        for (const record of rows) counts[record.outcome] += 1
        return {
          taskLabel,
          total: rows.length,
          success: counts.success,
          partial: counts.partial,
          failure: counts.failure,
          rate: rows.length === 0 ? 0 : roundScore(counts.success / rows.length),
        }
      },
    },

    methodSpecs: [
      { name: 'record', summary: '记录一次人工判定', input: { taskLabel: '任务标识', outcome: 'success | partial | failure', symptom: '失败现象', step: '失败步骤', resolution: '解决办法', comment: '备注', context: '设备 / 包名 / 模板上下文' } },
      { name: 'listRecords', summary: '列出反馈记录', input: { taskLabel: '可选任务过滤', outcome: '可选结果过滤', limit: '返回条数，默认 50' } },
      { name: 'listExperiences', summary: '列出沉淀的经验（按命中次数降序）' },
      { name: 'queryRelevant', summary: '按现象检索相关经验', input: { symptom: '当前遇到的现象', limit: '返回条数，默认 5' } },
      { name: 'markApplied', summary: '标记某条经验是否被采纳并奏效', input: { experienceId: '经验 id', worked: '是否奏效' } },
      { name: 'summary', summary: '反馈与经验聚合统计' },
      { name: 'successRate', summary: '单个任务的成功率', input: { taskLabel: '任务标识' } },
    ],

    async start(ctx) {
      context = ctx
      records = await loadRecords(ctx)
      experiences = await loadExperiences(ctx)
    },

    async reseat(ctx) {
      // Feedback is global knowledge, not project state: switching project must
      // not hide what the operator already taught the system.
      context = ctx
    },

    async stop() {
      context = null
    },

    async health() {
      return {
        healthy: true,
        detail: `${records.length} 条反馈，${experiences.length} 条经验`,
      }
    },
  })

  return module
}

async function loadRecords(ctx: ModuleContext): Promise<FeedbackRecord[]> {
  const stored = await ctx.global.get(RECORDS_KEY, [] as readonly FeedbackRecord[])
  if (!Array.isArray(stored)) return []
  return stored.filter(isRecord).map(normaliseRecord).filter((row): row is FeedbackRecord => row !== null)
}

async function loadExperiences(ctx: ModuleContext): Promise<Experience[]> {
  const stored = await ctx.global.get(EXPERIENCES_KEY, [] as readonly Experience[])
  if (!Array.isArray(stored)) return []
  return stored.filter(isRecord).map(normaliseExperience).filter((row): row is Experience => row !== null)
}

export function normaliseRecord(row: Record<string, unknown>): FeedbackRecord | null {
  const id = readString(row, 'id')
  const taskLabel = readString(row, 'taskLabel')
  const outcome = readOutcome(row.outcome)
  if (id === undefined || taskLabel === undefined || outcome === undefined) return null

  const rawBranch = row.failureBranch
  const branch = isRecord(rawBranch)
    ? {
      symptom: readString(rawBranch, 'symptom') ?? '',
      ...(readString(rawBranch, 'step') === undefined ? {} : { step: readString(rawBranch, 'step')! }),
      ...(readString(rawBranch, 'resolution') === undefined ? {} : { resolution: readString(rawBranch, 'resolution')! }),
    }
    : undefined

  return {
    id,
    taskLabel,
    outcome,
    createdAt: readString(row, 'createdAt') ?? new Date(0).toISOString(),
    ...(branch === undefined ? {} : { failureBranch: branch }),
    ...(readString(row, 'comment') === undefined ? {} : { comment: readString(row, 'comment')! }),
    ...(readContext(row) === undefined ? {} : { context: readContext(row)! }),
  }
}

export function normaliseExperience(row: Record<string, unknown>): Experience | null {
  const id = readString(row, 'id')
  const symptom = readString(row, 'symptom')
  if (id === undefined || symptom === undefined) return null
  const number = (key: string): number => {
    const raw = row[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0
  }
  return {
    id,
    symptom,
    resolution: typeof row.resolution === 'string' ? row.resolution : '',
    sourceFeedbackIds: Array.isArray(row.sourceFeedbackIds)
      ? row.sourceFeedbackIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    hitCount: number('hitCount'),
    successAfterApply: number('successAfterApply'),
    createdAt: readString(row, 'createdAt') ?? new Date(0).toISOString(),
    updatedAt: readString(row, 'updatedAt') ?? new Date(0).toISOString(),
  }
}

export { rank, roundScore, tokenize, overlapScore } from './keywords.js'
export type { Outcome as FeedbackOutcome }
export { ok }
