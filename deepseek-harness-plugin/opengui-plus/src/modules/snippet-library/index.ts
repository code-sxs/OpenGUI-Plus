/**
 * Module 2 — Snippet library.
 *
 * GUI automation is full of the same five sentences: "take a screenshot and
 * describe what you see", "which activity is in the foreground", "go home".
 * Typing them again on every turn costs tokens and patience, so this module
 * lets the user save a command under a short alias with tags and fire it by
 * typing `sc` instead.
 *
 * Everything is plain data on top of `ScopedStore`; no DSH dependency.
 *
 * @module modules/snippet-library
 */

import { isAliasSafe, createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import type { Iso8601, Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'

/** One saved command. Aliases are unique inside a project. */
export interface Snippet {
  readonly id: string
  /** Short alias, e.g. `sc`. Must not contain whitespace. */
  readonly alias: string
  /** The full instruction that gets substituted for the alias. */
  readonly command: string
  readonly tags: readonly string[]
  readonly description?: string
  /** Bumped by `resolve`; drives completion ordering. */
  readonly useCount: number
  readonly createdAt: Iso8601
  readonly updatedAt: Iso8601
}

/** Serialisable bundle produced by `exportJson` and accepted by `importJson`. */
export interface SnippetBundle {
  readonly version: number
  readonly snippets: readonly Snippet[]
}

export const SNIPPET_BUNDLE_VERSION = 1

const STORE_KEY = 'snippets'

/** Seeded on first start when the project has no snippets yet. */
const DEFAULT_SNIPPETS: readonly { readonly alias: string, readonly command: string, readonly tags: readonly string[], readonly description: string }[] = [
  { alias: 'sc', command: '截屏并返回当前界面的详细描述', tags: ['调试', '界面检查'], description: '截图并描述当前屏幕内容' },
  { alias: 'act', command: '获取当前前台 Activity 的完整类名', tags: ['调试'], description: '查询当前栈顶 Activity' },
  { alias: 'launch', command: '启动应用 {{package}}', tags: ['应用操作'], description: '通过包名启动应用' },
  { alias: 'home', command: '按下 Home 键返回主屏幕', tags: ['导航'], description: '回到桌面' },
  { alias: 'back', command: '按下返回键回到上一步', tags: ['导航'], description: '返回上一页' },
  { alias: 'pkg', command: '查看当前前台应用的包名', tags: ['调试'], description: '查询当前包名' },
  { alias: 'kill', command: '强制停止应用 {{package}}', tags: ['应用操作'], description: 'am force-stop 指定包名' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length > 0 && out.includes(trimmed) === false) out.push(trimmed)
  }
  return out
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function timestamp(value: unknown, fallback: Iso8601): Iso8601 {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function findByAlias(snippets: readonly Snippet[], alias: string): Snippet | undefined {
  const lowered = alias.toLowerCase()
  return snippets.find(snippet => snippet.alias.toLowerCase() === lowered)
}

/** Sort the way the console shows them: most used first, then alphabetical. */
function displayOrder(snippets: readonly Snippet[]): readonly Snippet[] {
  return [...snippets].sort((a, b) => {
    if (a.useCount !== b.useCount) return b.useCount - a.useCount
    return a.alias.localeCompare(b.alias, 'zh-Hans-CN')
  })
}

/**
 * Coerce a stored or imported row into a Snippet, or `null` when unusable.
 * Stored rows always carry timestamps through, so reloading never rewrites
 * history; imported rows without them get "now".
 */
function normalise(row: Record<string, unknown>): Snippet | null {
  const alias = readString(row, 'alias')
  const command = readString(row, 'command')
  if (alias === undefined || command === undefined) return null
  if (isAliasSafe(alias) === false) return null
  const now = new Date().toISOString()
  return {
    id: readString(row, 'id') ?? createId('snp'),
    alias,
    command,
    tags: readStringArray(row.tags),
    useCount: count(row.useCount),
    createdAt: timestamp(row.createdAt, now),
    updatedAt: timestamp(row.updatedAt, now),
    ...(readString(row, 'description') === undefined ? {} : { description: readString(row, 'description')! }),
  }
}

/** Validate a `SnippetBundle`-shaped value; returns the snippets it carries. */
function parseBundle(payload: unknown): Result<readonly Snippet[]> {
  let raw: unknown = payload
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown
    }
    catch {
      return fail('payload 不是合法 JSON 字符串')
    }
  }
  if (!isRecord(raw)) return fail('payload 必须是一个对象或 JSON 字符串')
  const rows = raw.snippets
  if (!Array.isArray(rows)) return fail('payload 缺少 snippets 数组')
  const snippets: Snippet[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isRecord(row)) return fail('snippets 数组内存在非对象元素')
    const snippet = normalise(row)
    if (snippet === null) return fail('snippets 内存在非法条目：alias 与 command 必填，且 alias 不能含空白或 /')
    if (seen.has(snippet.alias.toLowerCase())) {
      return fail(`payload 内 alias 重复："${snippet.alias}"`)
    }
    seen.add(snippet.alias.toLowerCase())
    snippets.push(snippet)
  }
  return ok(snippets)
}

/** Build the module. */
export function createSnippetLibraryModule(): PlusModule {
  let context: ModuleContext | null = null
  let snippets: Snippet[] = []

  async function persist(): Promise<void> {
    if (context === null) return
    await context.store.set(STORE_KEY, snippets)
  }

  async function load(ctx: ModuleContext): Promise<void> {
    const stored = await ctx.store.get(STORE_KEY, [] as readonly unknown[])
    if (Array.isArray(stored) === false) {
      snippets = []
      return
    }
    snippets = (stored as readonly unknown[])
      .filter(isRecord)
      .map(row => normalise(row))
      .filter((row): row is Snippet => row !== null)
  }

  const module = defineModule({
    id: 'snippet-library',
    name: '快捷指令库',
    version: '0.1.0',
    summary: '把常用操作指令存成别名，打标签、自动补全，减少重复打字。',

    methods: {
      /** Optional `tag` and `query` filters; query matches alias/command/description. */
      async list(input) {
        const tag = readString(input, 'tag')
        const rawQuery = readString(input, 'query')
        const query = rawQuery?.trim().toLowerCase()
        let rows = snippets
        if (tag !== undefined) {
          const lowered = tag.toLowerCase()
          rows = rows.filter(snippet => snippet.tags.some(candidate => candidate.toLowerCase() === lowered))
        }
        if (query !== undefined && query.length > 0) {
          rows = rows.filter((snippet) => {
            const haystack = [snippet.alias, snippet.command, snippet.description ?? ''].join('\n').toLowerCase()
            return haystack.includes(query)
          })
        }
        return { snippets: displayOrder(rows), total: rows.length }
      },

      /** Create or update; `id` updates, otherwise `alias` decides. */
      async save(input) {
        const alias = readString(input, 'alias')?.trim()
        if (alias === undefined) return fail('save 需要 alias')
        if (isAliasSafe(alias) === false) return fail(`别名不合法："${alias}"（不能含空白或 /，长度 1-32）`)
        const command = readString(input, 'command')
        if (command === undefined) return fail('save 需要 command')
        const tags = readStringArray(input.tags)
        const description = readString(input, 'description')
        const now = new Date().toISOString()

        const id = readString(input, 'id')
        const existing = id === undefined ? findByAlias(snippets, alias) : snippets.find(snippet => snippet.id === id)
        if (existing === undefined) {
          const clash = findByAlias(snippets, alias)
          if (clash !== undefined) return fail(`别名 "${alias}" 已存在，请使用 save 更新或换一个别名`)
          const snippet: Snippet = {
            id: createId('snp'),
            alias,
            command,
            tags,
            useCount: 0,
            createdAt: now,
            updatedAt: now,
            ...(description === undefined ? {} : { description }),
          }
          snippets = [...snippets, snippet]
          await persist()
          return { snippet, snippets: displayOrder(snippets) }
        }
        const clash = snippets.find(snippet => snippet.id !== existing.id && snippet.alias.toLowerCase() === alias.toLowerCase())
        if (clash !== undefined) return fail(`别名 "${alias}" 已被其他指令占用`)
        const updated: Snippet = {
          ...existing,
          alias,
          command,
          tags,
          updatedAt: now,
          ...(description === undefined
            ? (existing.description === undefined ? {} : { description: existing.description })
            : { description }),
        }
        snippets = snippets.map(snippet => (snippet.id === existing.id ? updated : snippet))
        await persist()
        return { snippet: updated, snippets: displayOrder(snippets) }
      },

      async remove(input) {
        const id = readString(input, 'id') ?? readString(input, 'alias')
        if (id === undefined) return fail('remove 需要 id 或 alias')
        const target = snippets.find(snippet => snippet.id === id || snippet.alias === id)
        if (target === undefined) return fail(`未找到指令 "${id}"`)
        snippets = snippets.filter(snippet => snippet.id !== target.id)
        await persist()
        return { removed: target.id, alias: target.alias, total: snippets.length }
      },

      /** Return the expanded command and bump `useCount`. */
      async resolve(input) {
        const alias = readString(input, 'alias')
        if (alias === undefined) return fail('resolve 需要 alias')
        const target = findByAlias(snippets, alias)
        if (target === undefined) return fail(`未找到别名 "${alias}"`)
        const updated: Snippet = { ...target, useCount: target.useCount + 1, updatedAt: new Date().toISOString() }
        snippets = snippets.map(snippet => (snippet.id === target.id ? updated : snippet))
        await persist()
        return { alias: updated.alias, command: updated.command, snippet: updated }
      },

      /** Prefix completion for the console input box; empty prefix returns the most used. */
      async complete(input) {
        const prefix = (readString(input, 'prefix') ?? '').trim().toLowerCase()
        const matched = snippets.filter(snippet => snippet.alias.toLowerCase().startsWith(prefix))
        const ordered = displayOrder(matched)
        return { aliases: ordered.map(snippet => snippet.alias), snippets: ordered }
      },

      async listTags() {
        const counter = new Map<string, number>()
        for (const snippet of snippets) {
          for (const tag of snippet.tags) counter.set(tag, (counter.get(tag) ?? 0) + 1)
        }
        const tags = [...counter.entries()]
          .map(([tag, total]) => ({ tag, count: total }))
          .sort((a, b) => (b.count === a.count ? a.tag.localeCompare(b.tag, 'zh-Hans-CN') : b.count - a.count))
        return { tags }
      },

      async exportJson() {
        const bundle: SnippetBundle = { version: SNIPPET_BUNDLE_VERSION, snippets: displayOrder(snippets) }
        return bundle
      },

      /**
       * Import a bundle. `merge` (default) overwrites by alias and keeps the
       * rest; `replace` swaps the whole library. Nothing is written when the
       * payload is invalid.
       */
      async importJson(input) {
        const payload = input.payload ?? input.bundle ?? input.json
        if (payload === undefined) return fail('importJson 需要 payload')
        const rawMode = readString(input, 'mode')
        if (rawMode !== undefined && rawMode !== 'merge' && rawMode !== 'replace') {
          return fail(`mode 只能是 merge 或 replace，收到 "${rawMode}"`)
        }
        const mode: 'merge' | 'replace' = rawMode === 'replace' ? 'replace' : 'merge'
        const parsed = parseBundle(payload)
        if (!parsed.ok) return parsed
        const incoming = parsed.value
        const now = new Date().toISOString()

        if (mode === 'replace') {
          snippets = [...incoming]
          await persist()
          return { imported: incoming.length, total: snippets.length, mode, snippets: displayOrder(snippets) }
        }

        let added = 0
        let updated = 0
        for (const row of incoming) {
          const existing = findByAlias(snippets, row.alias)
          if (existing === undefined) {
            snippets = [...snippets, { ...row, id: createId('snp'), createdAt: now, updatedAt: now }]
            added += 1
            continue
          }
          snippets = snippets.map(snippet => (snippet.id === existing.id
            ? {
                ...row,
                id: existing.id,
                useCount: Math.max(existing.useCount, row.useCount),
                createdAt: existing.createdAt,
                updatedAt: now,
              }
            : snippet))
          updated += 1
        }
        await persist()
        return { imported: incoming.length, added, updated, total: snippets.length, mode, snippets: displayOrder(snippets) }
      },
    },

    methodSpecs: [
      { name: 'list', summary: '列出全部指令', input: { tag: '按标签过滤', query: '按别名/指令/说明模糊搜索' } },
      { name: 'save', summary: '新增或更新指令', input: { alias: '别名，唯一且不含空白', command: '完整指令', tags: '标签数组', description: '说明', id: '可选，更新已有指令' } },
      { name: 'remove', summary: '删除指令', input: { id: '指令 id', alias: '也可用别名' } },
      { name: 'resolve', summary: '解析别名返回完整指令，并累加使用次数', input: { alias: '别名' } },
      { name: 'complete', summary: '按前缀补全别名', input: { prefix: '已输入的前缀' } },
      { name: 'listTags', summary: '列出所有标签及指令数量' },
      { name: 'exportJson', summary: '导出为可序列化数据包' },
      { name: 'importJson', summary: '导入数据包', input: { payload: '数据包对象或 JSON 字符串', mode: 'merge（默认）或 replace' } },
    ],

    async start(ctx) {
      context = ctx
      await load(ctx)
      if (snippets.length === 0) {
        const now = new Date().toISOString()
        snippets = DEFAULT_SNIPPETS.map(entry => ({
          id: createId('snp'),
          alias: entry.alias,
          command: entry.command,
          tags: [...entry.tags],
          description: entry.description,
          useCount: 0,
          createdAt: now,
          updatedAt: now,
        }))
        await persist()
      }
    },

    async reseat(ctx) {
      context = ctx
      await load(ctx)
    },

    async stop() {
      context = null
      snippets = []
    },

    async health() {
      return { healthy: context !== null, detail: `${snippets.length} 条快捷指令` }
    },
  })

  return module
}

export { DEFAULT_SNIPPETS }
