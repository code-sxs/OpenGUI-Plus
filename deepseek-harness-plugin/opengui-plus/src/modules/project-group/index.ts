/**
 * Module 5 — Project groups.
 *
 * A project group is one context of work: a phone, an app under test, a set of
 * snippets belonging to a client. Switching groups has to move *every* module's
 * data, which this module cannot do by itself — it only owns the registry of
 * groups. It publishes `projectSwitched`; the host listens, calls
 * `registry.reseatAll()` with a context pointing at the new project, and every
 * module reloads. That keeps project-group ignorant of snippets, templates,
 * schedules and whatever ships next.
 *
 * Deletion works the same way: the group is removed from the registry here and
 * its id is queued under `pending-project-cleanup`; the host owns the actual
 * directory removal.
 *
 * @module modules/project-group
 */

import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import type { Iso8601, Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'

export interface ProjectGroup {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly deviceIds: readonly string[]
  readonly tags: readonly string[]
  readonly createdAt: Iso8601
  readonly updatedAt: Iso8601
  readonly lastUsedAt?: Iso8601
}

const GROUPS_KEY = 'projects'
const CURRENT_KEY = 'current-project'
const CLEANUP_KEY = 'pending-project-cleanup'
const HOST_MODULE = '__host__'

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

function normaliseGroup(row: Record<string, unknown>): ProjectGroup | null {
  const id = readString(row, 'id')
  const name = readString(row, 'name')
  if (id === undefined || name === undefined) return null
  const now = new Date().toISOString()
  return {
    id,
    name,
    deviceIds: readStringArray(row.deviceIds),
    tags: readStringArray(row.tags),
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    ...(readString(row, 'description') === undefined ? {} : { description: readString(row, 'description')! }),
    ...(readString(row, 'lastUsedAt') === undefined ? {} : { lastUsedAt: readString(row, 'lastUsedAt')! }),
  }
}

/** Build the module. */
export function createProjectGroupModule(): PlusModule {
  let context: ModuleContext | null = null
  let groups: ProjectGroup[] = []
  let currentId: string | null = null

  async function persistGroups(): Promise<void> {
    if (context === null) return
    await context.global.set(GROUPS_KEY, groups)
  }

  async function persistCurrent(): Promise<void> {
    if (context === null) return
    if (currentId === null) await context.global.delete(CURRENT_KEY)
    else await context.global.set(CURRENT_KEY, currentId)
  }

  async function load(ctx: ModuleContext): Promise<void> {
    const stored = await ctx.global.get(GROUPS_KEY, [] as readonly unknown[])
    groups = Array.isArray(stored)
      ? (stored as readonly unknown[]).filter(isRecord).map(normaliseGroup).filter((row): row is ProjectGroup => row !== null)
      : []
    const storedCurrent = await ctx.global.get<string | null>(CURRENT_KEY, null)
    currentId = typeof storedCurrent === 'string' && groups.some(group => group.id === storedCurrent)
      ? storedCurrent
      : null
  }

  /** Queue a project id for the host to physically delete later. */
  async function queueCleanup(projectId: string): Promise<void> {
    if (context === null) return
    await context.global.update<string[]>(CLEANUP_KEY, [], (current) => {
      const list = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === 'string') : []
      return list.includes(projectId) ? list : [...list, projectId]
    })
  }

  function find(id: string): ProjectGroup | undefined {
    return groups.find(group => group.id === id)
  }

  /** Call the internal host module, turning "not wired up" into a clear error. */
  async function callHost(method: string, input: Record<string, unknown>): Promise<Result<unknown>> {
    if (context === null) return fail('模块未启动')
    const result = await context.call(`${HOST_MODULE}.${method}`, input)
    if (!result.ok && /unknown module|not started/i.test(result.error)) {
      return fail(`宿主能力 __host__.${method} 未就绪：${result.error}`)
    }
    return result
  }

  const module = defineModule({
    id: 'project-group',
    name: '项目组管理',
    version: '0.1.0',
    summary: '管理多项目组：切换、复制、导入导出，切换后由宿主统一重置各模块数据。',

    methods: {
      async create(input) {
        const name = readString(input, 'name')
        if (name === undefined) return fail('create 需要 name')
        const now = new Date().toISOString()
        const group: ProjectGroup = {
          id: readString(input, 'id') ?? createId('prj'),
          name,
          deviceIds: readStringArray(input.deviceIds),
          tags: readStringArray(input.tags),
          createdAt: now,
          updatedAt: now,
          ...(readString(input, 'description') === undefined ? {} : { description: readString(input, 'description')! }),
        }
        if (find(group.id) !== undefined) return fail(`项目组 id "${group.id}" 已存在`)
        groups = [...groups, group]
        await persistGroups()
        return { group, groups }
      },

      async list() {
        return { groups, current: currentId, total: groups.length }
      },

      async current() {
        const group = currentId === null ? undefined : find(currentId)
        return { current: group ?? null }
      },

      /**
       * Switch the active group. Only the event is published here: the host
       * listens for `projectSwitched` and re-seats every module, so this module
       * never touches another module's state.
       */
      async switch(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('switch 需要 id')
        const group = find(id)
        if (group === undefined) return fail(`未找到项目组 "${id}"`)
        const now = new Date().toISOString()
        currentId = id
        groups = groups.map(row => (row.id === id ? { ...row, lastUsedAt: now, updatedAt: now } : row))
        await persistGroups()
        await persistCurrent()
        if (context !== null) {
          context.events.publish('project-group', PLUS_EVENTS.projectSwitched, { projectId: id, name: group.name })
        }
        return { current: find(id) ?? group, switched: true }
      },

      async update(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('update 需要 id')
        const existing = find(id)
        if (existing === undefined) return fail(`未找到项目组 "${id}"`)
        const updated: ProjectGroup = {
          ...existing,
          name: readString(input, 'name') ?? existing.name,
          deviceIds: Array.isArray(input.deviceIds) ? readStringArray(input.deviceIds) : existing.deviceIds,
          tags: Array.isArray(input.tags) ? readStringArray(input.tags) : existing.tags,
          updatedAt: new Date().toISOString(),
          ...(readString(input, 'description') === undefined
            ? (existing.description === undefined ? {} : { description: existing.description })
            : { description: readString(input, 'description')! }),
        }
        groups = groups.map(group => (group.id === id ? updated : group))
        await persistGroups()
        return { group: updated }
      },

      /**
       * Remove a group from the registry and queue its data directory for the
       * host. The active group cannot be removed — switch away first.
       */
      async remove(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('remove 需要 id')
        const existing = find(id)
        if (existing === undefined) return fail(`未找到项目组 "${id}"`)
        if (currentId === id) return fail(`不能删除当前激活的项目组 "${existing.name}"，请先切换到其他项目组`)
        groups = groups.filter(group => group.id !== id)
        await persistGroups()
        await queueCleanup(id)
        return { removed: id, queued: true, total: groups.length }
      },

      /** Copy a group and all of its module data through the host. */
      async duplicate(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('duplicate 需要 id')
        const source = find(id)
        if (source === undefined) return fail(`未找到项目组 "${id}"`)
        const newId = readString(input, 'newId') ?? createId('prj')
        if (find(newId) !== undefined) return fail(`项目组 id "${newId}" 已存在`)
        const result = await callHost('copyProject', { from: id, to: newId })
        if (!result.ok) return fail(result.error)
        const now = new Date().toISOString()
        const group: ProjectGroup = {
          id: newId,
          name: readString(input, 'name') ?? `${source.name} 副本`,
          deviceIds: [...source.deviceIds],
          tags: [...source.tags],
          createdAt: now,
          updatedAt: now,
          ...(source.description === undefined ? {} : { description: source.description }),
        }
        groups = [...groups, group]
        await persistGroups()
        return { group, from: id, groups }
      },

      async export(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('export 需要 id')
        if (find(id) === undefined) return fail(`未找到项目组 "${id}"`)
        const result = await callHost('exportProject', { id })
        if (!result.ok) return fail(result.error)
        return { projectId: id, payload: result.value }
      },

      async import(input) {
        const payload = input.payload ?? input.bundle
        if (payload === undefined) return fail('import 需要 payload')
        const result = await callHost('importProject', {
          payload,
          ...(readString(input, 'name') === undefined ? {} : { name: readString(input, 'name')! }),
        })
        if (!result.ok) return fail(result.error)
        const value = result.value
        if (!isRecord(value) || readString(value, 'id') === undefined) {
          return fail('宿主返回的导入结果缺少 id 字段')
        }
        const now = new Date().toISOString()
        const group: ProjectGroup = {
          id: readString(value, 'id')!,
          name: readString(value, 'name') ?? '导入的项目组',
          deviceIds: readStringArray(value.deviceIds),
          tags: readStringArray(value.tags),
          createdAt: now,
          updatedAt: now,
          ...(readString(value, 'description') === undefined ? {} : { description: readString(value, 'description')! }),
        }
        if (find(group.id) !== undefined) return fail(`项目组 id "${group.id}" 已存在`)
        groups = [...groups, group]
        await persistGroups()
        return { group, groups }
      },
    },

    methodSpecs: [
      { name: 'create', summary: '创建项目组', input: { name: '名称', description: '说明', deviceIds: '关联设备', tags: '标签' } },
      { name: 'list', summary: '列出全部项目组' },
      { name: 'current', summary: '查看当前激活的项目组' },
      { name: 'switch', summary: '切换项目组（发布事件，由宿主重置各模块数据）', input: { id: '项目组 id' } },
      { name: 'update', summary: '修改项目组', input: { id: '项目组 id', name: '名称', description: '说明', deviceIds: '设备', tags: '标签' } },
      { name: 'remove', summary: '删除项目组并提交清理队列', input: { id: '项目组 id' } },
      { name: 'duplicate', summary: '复制项目组及其全部模块数据', input: { id: '源项目组 id', name: '新名称', newId: '可选新 id' } },
      { name: 'export', summary: '导出项目组数据包', input: { id: '项目组 id' } },
      { name: 'import', summary: '导入项目组数据包', input: { payload: '数据包', name: '可选新名称' } },
    ],

    async start(ctx) {
      context = ctx
      await load(ctx)
      if (currentId === null && ctx.projectId !== null && find(ctx.projectId) !== undefined) {
        currentId = ctx.projectId
        await persistCurrent()
      }
    },

    async reseat(ctx) {
      context = ctx
      await load(ctx)
    },

    async stop() {
      context = null
      groups = []
      currentId = null
    },

    async health() {
      const current = currentId === null ? undefined : find(currentId)
      return {
        healthy: context !== null,
        detail: `${groups.length} 个项目组${current === undefined ? '' : `，当前：${current.name}`}`,
      }
    },
  })

  return module
}

export { CURRENT_KEY, CLEANUP_KEY, GROUPS_KEY }
export { normaliseGroup }
