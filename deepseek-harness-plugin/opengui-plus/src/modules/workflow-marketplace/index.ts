/**
 * Module 7 — Workflow template marketplace.
 *
 * Three pools of templates are merged into one browsable catalogue:
 *
 *   builtin    read-only seeds shipped in `builtin.ts` (sample data)
 *   published  templates this user published, in global storage
 *   installed  templates this user pulled in, in global storage
 *
 * Ratings and download counts live beside the templates rather than inside
 * them, because seeds are constants and a user's own numbers must survive an
 * upgrade that changes the seed list.
 *
 * @module modules/workflow-marketplace
 */

import { PLUS_EVENTS } from '../../core/events.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import { fail, ok } from '../../core/types.js'

import { BUILTIN_WORKFLOWS } from './builtin.js'
import { runStepsLocally, type StepExecution } from './runner.js'
import {
  averageRating,
  parseWorkflowJson,
  validateWorkflow,
  WORKFLOW_CATEGORIES,
  WORKFLOW_CATEGORY_LABELS,
  workflowFilename,
  type WorkflowCategory,
  type WorkflowTemplate,
} from './schema.js'

const INSTALLED_KEY = 'market-installed'
const PUBLISHED_KEY = 'market-published'
const RATINGS_KEY = 'market-ratings'
const STATS_KEY = 'market-stats'

export type WorkflowSource = 'builtin' | 'published' | 'installed'

/** A catalogue row: the template plus everything the UI wants to show. */
export interface MarketItem extends WorkflowTemplate {
  readonly source: WorkflowSource
  readonly installed: boolean
  readonly published: boolean
  readonly downloads: number
  readonly averageRating: number
  readonly ratingCount: number
}

export interface RatingEntry {
  readonly at: string
  readonly score: number
  readonly comment?: string
}

interface RatingBucket {
  ratingSum: number
  ratingCount: number
  entries: RatingEntry[]
}

interface DownloadBucket {
  downloads: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Build the module. */
export function createWorkflowMarketplaceModule(): PlusModule {
  let context: ModuleContext | null = null
  let installed: WorkflowTemplate[] = []
  let published: WorkflowTemplate[] = []
  let ratings: Record<string, RatingBucket> = {}
  let downloads: Record<string, DownloadBucket> = {}

  async function persistInstalled(): Promise<void> {
    await context?.global.set(INSTALLED_KEY, installed)
  }

  async function persistPublished(): Promise<void> {
    await context?.global.set(PUBLISHED_KEY, published)
  }

  async function persistRatings(): Promise<void> {
    await context?.global.set(RATINGS_KEY, ratings)
  }

  async function persistDownloads(): Promise<void> {
    await context?.global.set(STATS_KEY, downloads)
  }

  function statsFor(id: string): { downloads: number, ratingSum: number, ratingCount: number } {
    const own = ratings[id]
    const ownDownloads = downloads[id]?.downloads ?? 0
    const seed = BUILTIN_WORKFLOWS.find(template => template.id === id)?.stats
    const local = [...published, ...installed].find(template => template.id === id)?.stats
    const base = local ?? seed
    return {
      downloads: ownDownloads + (base?.downloads ?? 0),
      ratingSum: (own?.ratingSum ?? 0) + (base?.ratingSum ?? 0),
      ratingCount: (own?.ratingCount ?? 0) + (base?.ratingCount ?? 0),
    }
  }

  function decorate(template: WorkflowTemplate, source: WorkflowSource): MarketItem {
    const stats = statsFor(template.id)
    return {
      ...template,
      source,
      installed: installed.some(row => row.id === template.id),
      published: published.some(row => row.id === template.id),
      downloads: stats.downloads,
      averageRating: averageRating(stats),
      ratingCount: stats.ratingCount,
    }
  }

  /**
   * Every distinct template, newest-wins per id.
   * Installed copies take precedence: they are the version the user runs.
   */
  function catalogue(): readonly MarketItem[] {
    const byId = new Map<string, MarketItem>()
    const push = (template: WorkflowTemplate, source: WorkflowSource): void => {
      byId.set(template.id, decorate(template, source))
    }
    for (const template of BUILTIN_WORKFLOWS) push(template, 'builtin')
    for (const template of published) push(template, 'published')
    for (const template of installed) push(template, 'installed')
    return [...byId.values()]
  }

  function lookup(id: string): MarketItem | undefined {
    return catalogue().find(item => item.id === id)
  }

  function upsert(list: WorkflowTemplate[], template: WorkflowTemplate): WorkflowTemplate[] {
    return list.some(row => row.id === template.id)
      ? list.map(row => (row.id === template.id ? template : row))
      : [...list, template]
  }

  /** Resolve `{{name}}` parameters against supplied variables and defaults. */
  function resolveVariables(
    template: WorkflowTemplate,
    supplied: Record<string, string>,
  ): { values: Record<string, string>, missing: readonly string[] } {
    const values: Record<string, string> = { ...supplied }
    const missing: string[] = []
    for (const parameter of template.parameters) {
      const given = values[parameter.name]
      if (given !== undefined && given.length > 0) continue
      if (parameter.defaultValue !== undefined && parameter.defaultValue.length > 0) {
        values[parameter.name] = parameter.defaultValue
        continue
      }
      if (parameter.required) missing.push(parameter.label || parameter.name)
    }
    return { values, missing }
  }

  const module = defineModule({
    id: 'workflow-marketplace',
    name: '工作流模板市场',
    version: '0.1.0',
    summary: '`.opengui-workflow` 模板格式与内置市场：分类浏览、一键导入导出、安装评分与运行。',

    methods: {
      async categories() {
        const counts = new Map<WorkflowCategory, number>()
        for (const category of WORKFLOW_CATEGORIES) counts.set(category, 0)
        for (const item of catalogue()) {
          counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
        }
        return {
          categories: WORKFLOW_CATEGORIES.map(category => ({
            id: category,
            label: WORKFLOW_CATEGORY_LABELS[category],
            count: counts.get(category) ?? 0,
          })),
          total: catalogue().length,
        }
      },

      async browse(input) {
        const category = readString(input, 'category')
        if (category !== undefined && !WORKFLOW_CATEGORIES.includes(category as WorkflowCategory)) {
          return fail(`unknown category "${category}"；可选: ${WORKFLOW_CATEGORIES.join(' | ')}`)
        }
        const query = readString(input, 'query')?.toLowerCase()
        const sort = readString(input, 'sort') ?? 'recent'

        let items = catalogue()
        if (category !== undefined) items = items.filter(item => item.category === category)
        if (query !== undefined) {
          items = items.filter((item) => {
            const haystack = [item.name, item.description, item.taskIntent, item.author, ...item.tags]
              .join(' ')
              .toLowerCase()
            return haystack.includes(query)
          })
        }

        const sorted = items.toSorted((a, b) => {
          if (sort === 'downloads' && a.downloads !== b.downloads) return b.downloads - a.downloads
          if (sort === 'rating') {
            if (a.averageRating !== b.averageRating) return b.averageRating - a.averageRating
            if (a.ratingCount !== b.ratingCount) return b.ratingCount - a.ratingCount
          }
          return b.updatedAt.localeCompare(a.updatedAt)
        })

        return { items: sorted, total: sorted.length, sort }
      },

      async detail(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('detail needs "id"')
        const item = lookup(id)
        if (item === undefined) return fail(`unknown template "${id}"`)
        return { ...item, ratings: ratings[id]?.entries ?? [] }
      },

      async install(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('install needs "id"')
        const item = lookup(id)
        if (item === undefined) return fail(`unknown template "${id}"`)

        const template = stripStats(installed.find(row => row.id === id)
          ?? published.find(row => row.id === id)
          ?? BUILTIN_WORKFLOWS.find(row => row.id === id)!)
        installed = upsert(installed, template)
        await persistInstalled()

        const bucket = downloads[id] ?? { downloads: 0 }
        const nextDownloads = bucket.downloads + 1
        downloads = { ...downloads, [id]: { downloads: nextDownloads } }
        await persistDownloads()

        context?.events.publish('workflow-marketplace', PLUS_EVENTS.marketplaceInstalled, {
          id,
          name: template.name,
          downloads: statsFor(id).downloads,
        })
        return { installed: true, template: decorate(template, 'installed') }
      },

      async uninstall(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('uninstall needs "id"')
        if (!installed.some(row => row.id === id)) return fail(`template "${id}" 未安装`)
        installed = installed.filter(row => row.id !== id)
        await persistInstalled()
        return { uninstalled: true, id, total: installed.length }
      },

      async listInstalled() {
        return { items: installed.map(row => decorate(row, 'installed')), total: installed.length }
      },

      async publish(input) {
        const candidate = input.template ?? input.json ?? input.workflow
        if (candidate === undefined) return fail('publish needs "template" (or "json")')

        const parsed = typeof candidate === 'string'
          ? parseWorkflowJson(candidate)
          : validateWorkflow(candidate)
        if (!parsed.ok) return parsed

        const template = stripStats(parsed.value)
        published = upsert(published, template)
        await persistPublished()
        return { published: true, template: decorate(template, 'published') }
      },

      async rate(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('rate needs "id"')
        const rawScore = input.score
        const score = typeof rawScore === 'number' ? rawScore : Number(rawScore)
        if (!Number.isFinite(score)) return fail('score 必须是 1~5 的数字')
        if (score < 1 || score > 5) return fail(`score 必须在 1~5 之间，收到 ${score}`)
        if (lookup(id) === undefined) return fail(`unknown template "${id}"`)

        const bucket = ratings[id] ?? { ratingSum: 0, ratingCount: 0, entries: [] }
        const entry: RatingEntry = {
          at: new Date().toISOString(),
          score,
          ...(readString(input, 'comment') === undefined ? {} : { comment: readString(input, 'comment')! }),
        }
        ratings = {
          ...ratings,
          [id]: {
            ratingSum: bucket.ratingSum + score,
            ratingCount: bucket.ratingCount + 1,
            entries: [...bucket.entries, entry],
          },
        }
        await persistRatings()
        const stats = statsFor(id)
        return {
          id,
          score,
          ratingCount: stats.ratingCount,
          averageRating: averageRating(stats),
        }
      },

      async exportWorkflow(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('exportWorkflow needs "id"')
        const item = lookup(id)
        if (item === undefined) return fail(`unknown template "${id}"`)
        const template = stripStats(item)
        return {
          filename: workflowFilename(template.name),
          content: `${JSON.stringify(template, null, 2)}\n`,
          template,
        }
      },

      async importWorkflow(input) {
        const candidate = input.json ?? input.template ?? input.workflow
        if (candidate === undefined) return fail('importWorkflow needs "json" (or "template")')

        const parsed = typeof candidate === 'string'
          ? parseWorkflowJson(candidate)
          : validateWorkflow(candidate)
        if (!parsed.ok) return parsed

        const template = stripStats(parsed.value)
        installed = upsert(installed, template)
        await persistInstalled()
        return { imported: true, template: decorate(template, 'installed') }
      },

      /**
       * One-click run. Prefers `action-template.execute` and falls back to a
       * local adb walk, so a marketplace install is runnable even when the
       * action-template module is not part of the build.
       */
      async run(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('run needs "id"')
        const item = lookup(id)
        if (item === undefined) return fail(`unknown template "${id}"`)

        const supplied: Record<string, string> = {}
        if (isRecord(input.variables)) {
          for (const [key, value] of Object.entries(input.variables)) {
            if (typeof value === 'string' || typeof value === 'number') supplied[key] = String(value)
          }
        }
        const resolved = resolveVariables(item, supplied)
        if (resolved.missing.length > 0) {
          return {
            templateId: id,
            ok: false,
            executed: [] as StepExecution[],
            error: `缺少必填参数: ${resolved.missing.join('、')}`,
          }
        }

        const template = stripStats(item)
        if (context !== null) {
          try {
            const delegated = await context.call('action-template.execute', {
              template,
              variables: resolved.values,
            })
            if (delegated.ok) {
              return {
                templateId: id,
                ok: true,
                executed: [] as StepExecution[],
                delegated: true,
                result: delegated.value,
              }
            }
            context.logger.debug(`action-template.execute 不可用，改为本地执行: ${delegated.error}`)
          }
          catch (error) {
            context.logger.debug(`action-template.execute 抛出异常，改为本地执行: ${String(error)}`)
          }
        }

        const local = await runStepsLocally(context?.adb ?? null, template.steps, resolved.values)
        return {
          templateId: id,
          ok: local.ok,
          executed: local.executed,
          degraded: local.degraded,
          variables: resolved.values,
          ...(local.ok || local.degraded ? {} : { error: '执行中断，请查看 executed 明细' }),
        }
      },
    },

    methodSpecs: [
      { name: 'categories', summary: '列出分类及每个分类下的模板数' },
      { name: 'browse', summary: '浏览市场', input: { category: '可选分类', query: '关键词', sort: 'downloads | rating | recent' } },
      { name: 'detail', summary: '查看模板详情与评分明细', input: { id: '模板 id' } },
      { name: 'install', summary: '一键安装模板到本地', input: { id: '模板 id' } },
      { name: 'uninstall', summary: '卸载已安装模板', input: { id: '模板 id' } },
      { name: 'listInstalled', summary: '列出已安装模板' },
      { name: 'publish', summary: '发布模板到市场', input: { template: '模板对象', json: '或 .opengui-workflow 的 JSON 文本' } },
      { name: 'rate', summary: '给模板评分', input: { id: '模板 id', score: '1~5', comment: '可选评语' } },
      { name: 'exportWorkflow', summary: '导出为 .opengui-workflow 文件', input: { id: '模板 id' } },
      { name: 'importWorkflow', summary: '导入 .opengui-workflow', input: { json: '文件文本', template: '或已解析对象' } },
      { name: 'run', summary: '一键运行模板', input: { id: '模板 id', variables: '参数值，键为参数名' } },
    ],

    async start(ctx) {
      context = ctx
      installed = await loadTemplates(ctx, INSTALLED_KEY)
      published = await loadTemplates(ctx, PUBLISHED_KEY)
      ratings = await loadBuckets<RatingBucket>(ctx, RATINGS_KEY, isRatingBucket)
      downloads = await loadBuckets<DownloadBucket>(ctx, STATS_KEY, isDownloadBucket)
      ctx.logger.info(`模板市场就绪：内置 ${BUILTIN_WORKFLOWS.length} 个，已安装 ${installed.length} 个，已发布 ${published.length} 个`)
    },

    async stop() {
      context = null
    },

    async health() {
      return {
        healthy: true,
        detail: `内置 ${BUILTIN_WORKFLOWS.length} / 已发布 ${published.length} / 已安装 ${installed.length}；adb ${context?.adb === null || context?.adb === undefined ? '不可用' : '可用'}`,
      }
    },
  })

  return module
}

/** Drop the `stats` block so local counters are the single source of truth. */
function stripStats(template: WorkflowTemplate): WorkflowTemplate {
  const { stats: _stats, ...rest } = template
  return rest
}

async function loadTemplates(ctx: ModuleContext, key: string): Promise<WorkflowTemplate[]> {
  const stored = await ctx.global.get(key, [] as readonly unknown[])
  if (!Array.isArray(stored)) return []
  const out: WorkflowTemplate[] = []
  for (const entry of stored) {
    const parsed = validateWorkflow(entry)
    if (parsed.ok) out.push(parsed.value)
    else ctx.logger.warn(`模板市场跳过非法条目: ${parsed.error}`)
  }
  return out
}

async function loadBuckets<T>(
  ctx: ModuleContext,
  key: string,
  guard: (value: unknown) => value is T,
): Promise<Record<string, T>> {
  const stored = await ctx.global.get(key, {} as Record<string, unknown>)
  if (!isRecord(stored)) return {}
  const out: Record<string, T> = {}
  for (const [id, value] of Object.entries(stored)) {
    if (guard(value)) out[id] = value
  }
  return out
}

function isRatingBucket(value: unknown): value is RatingBucket {
  if (!isRecord(value)) return false
  if (typeof value.ratingSum !== 'number' || typeof value.ratingCount !== 'number') return false
  if (!Array.isArray(value.entries)) return false
  return value.entries.every((entry) => {
    if (!isRecord(entry)) return false
    return typeof entry.at === 'string' && typeof entry.score === 'number'
  })
}

function isDownloadBucket(value: unknown): value is DownloadBucket {
  return isRecord(value) && typeof value.downloads === 'number'
}

export {
  averageRating,
  parseWorkflowJson,
  validateWorkflow,
  workflowFilename,
  WORKFLOW_CATEGORIES,
  WORKFLOW_CATEGORY_LABELS,
  WORKFLOW_FILE_EXTENSION,
  WORKFLOW_FORMAT_VERSION,
} from './schema.js'
export { BUILTIN_WORKFLOWS } from './builtin.js'
export { fillTemplate, runStepsLocally } from './runner.js'
export type { StepExecution } from './runner.js'
export type {
  WorkflowCategory,
  WorkflowParameter,
  WorkflowStep,
  WorkflowTemplate,
} from './schema.js'
