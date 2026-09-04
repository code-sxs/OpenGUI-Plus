import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventBus } from '../../core/events.js'
import { silentLogger } from '../../core/logger.js'
import type { ModuleContext } from '../../core/module.js'
import { PlusStore } from '../../core/store.js'
import { createSnippetLibraryModule, type Snippet } from './index.js'

interface Harness {
  readonly module: ReturnType<typeof createSnippetLibraryModule>
  readonly context: ModuleContext
  readonly store: PlusStore
  call(method: string, input?: Record<string, unknown>): Promise<any>
}

const dirs: string[] = []

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'plus-snippet-'))
  dirs.push(dir)
  const store = new PlusStore(dir)
  const context: ModuleContext = {
    store: store.project('p1'),
    global: store.global(),
    events: new EventBus(),
    logger: silentLogger(),
    projectId: 'p1',
    dataDir: dir,
    capabilities: { adb: false, dsh: false, screenRecording: false },
    adb: null,
    call: async () => ({ ok: false, error: 'not wired in this test' }),
  }
  const module = createSnippetLibraryModule()
  return {
    module,
    context,
    store,
    async call(method, input = {}) {
      const fn = module.methods[method]
      if (fn === undefined) throw new Error(`missing method ${method}`)
      return fn(input)
    },
  }
}

async function boot(): Promise<Harness> {
  const harness = makeHarness()
  await harness.module.start(harness.context)
  return harness
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    }
    catch {
      // Best-effort cleanup; a locked temp directory must not fail the suite.
    }
  }
})

describe('snippet-library', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await boot()
  })

  it('首次启动写入内置默认指令', async () => {
    const result = await harness.call('list')
    expect(result.total).toBe(7)
    const aliases = (result.snippets as Snippet[]).map(row => row.alias).sort()
    expect(aliases).toEqual(['act', 'back', 'home', 'kill', 'launch', 'pkg', 'sc'])
  })

  it('已有数据时重启不会重复写入默认指令', async () => {
    await harness.call('save', { alias: 'mine', command: '自定义指令' })
    await harness.module.stop()
    await harness.module.start(harness.context)
    const result = await harness.call('list')
    expect(result.total).toBe(8)
    expect(result.snippets.filter((row: Snippet) => row.alias === 'mine')).toHaveLength(1)
  })

  it('save 新增指令并拒绝非法别名', async () => {
    const created = await harness.call('save', { alias: 'rec', command: '开始录屏', tags: ['调试'] })
    expect(created.snippet.id).toBeTruthy()
    expect(created.snippet.alias).toBe('rec')
    expect(created.snippet.tags).toEqual(['调试'])

    const blank = await harness.call('save', { alias: 'has space', command: 'x' })
    expect(blank.ok).toBe(false)
    expect(blank.error).toContain('别名不合法')

    const slashed = await harness.call('save', { alias: 'a/b', command: 'x' })
    expect(slashed.ok).toBe(false)

    const tooLong = await harness.call('save', { alias: 'x'.repeat(33), command: 'x' })
    expect(tooLong.ok).toBe(false)

    const noCommand = await harness.call('save', { alias: 'nocommand' })
    expect(noCommand.ok).toBe(false)
  })

  it('save 按 id 更新自己，但不允许抢占别人的别名', async () => {
    const first = await harness.call('save', { alias: 'sc2', command: '指令 A' })
    const other = await harness.call('save', { alias: 'other', command: '另一条' })

    // Updating by id is allowed, even when the alias is unchanged.
    const updated = await harness.call('save', { id: first.snippet.id, alias: 'sc2', command: '指令 C' })
    expect(updated.snippet.command).toBe('指令 C')
    expect(updated.snippet.id).toBe(first.snippet.id)
    expect(updated.snippet.createdAt).toBe(first.snippet.createdAt)

    // Pointing a different snippet at a taken alias is rejected.
    const clash = await harness.call('save', { id: other.snippet.id, alias: 'sc2', command: '抢占' })
    expect(clash.ok).toBe(false)
    expect(clash.error).toContain('已被其他指令占用')
  })

  it('resolve 展开指令并累加使用次数，找不到返回 fail', async () => {
    const first = await harness.call('resolve', { alias: 'sc' })
    expect(first.command).toContain('截屏')
    expect(first.snippet.useCount).toBe(1)

    const second = await harness.call('resolve', { alias: 'sc' })
    expect(second.snippet.useCount).toBe(2)

    expect((await harness.call('resolve', { alias: 'nope' })).ok).toBe(false)
    expect((await harness.call('resolve', {})).ok).toBe(false)
  })

  it('complete 按前缀返回别名，按使用次数降序', async () => {
    await harness.call('resolve', { alias: 'back' })
    await harness.call('resolve', { alias: 'back' })
    await harness.call('resolve', { alias: 'home' })

    const all = await harness.call('complete', { prefix: '' })
    expect(all.total).toBeUndefined()
    expect(all.aliases).toHaveLength(7)
    expect(all.aliases.slice(0, 2)).toEqual(['back', 'home'])
    expect(all.snippets[0].useCount).toBe(2)

    expect((await harness.call('complete', { prefix: 'a' })).aliases).toEqual(['act'])
    expect((await harness.call('complete', { prefix: 'zzz' })).aliases).toEqual([])
  })

  it('list 支持 tag 与 query 过滤', async () => {
    const byTag = await harness.call('list', { tag: '导航' })
    expect(byTag.snippets.map((row: Snippet) => row.alias).sort()).toEqual(['back', 'home'])

    const byQuery = await harness.call('list', { query: 'activity' })
    expect(byQuery.total).toBe(1)
    expect(byQuery.snippets[0].alias).toBe('act')

    const combined = await harness.call('list', { tag: '导航', query: 'home' })
    expect(combined.total).toBe(1)
    expect(combined.snippets[0].alias).toBe('home')

    const none = await harness.call('list', { tag: '不存在的标签' })
    expect(none.total).toBe(0)
  })

  it('listTags 统计每个标签下的指令数', async () => {
    const result = await harness.call('listTags')
    const map = new Map<string, number>(
      result.tags.map((row: { tag: string, count: number }) => [row.tag, row.count]),
    )
    expect(map.get('调试')).toBe(3)
    expect(map.get('应用操作')).toBe(2)
    expect(map.get('导航')).toBe(2)
    const counts = result.tags.map((row: { count: number }) => row.count)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('remove 按 id 或别名删除', async () => {
    const removed = await harness.call('remove', { alias: 'sc' })
    expect(removed.alias).toBe('sc')
    expect(removed.total).toBe(6)

    expect((await harness.call('remove', { alias: 'sc' })).ok).toBe(false)
    expect((await harness.call('remove', {})).ok).toBe(false)
  })

  it('exportJson / importJson 往返，merge 按别名覆盖且保留本地 id', async () => {
    const bundle = await harness.call('exportJson')
    expect(bundle.version).toBe(1)
    expect(bundle.snippets).toHaveLength(7)

    const imported = await harness.call('importJson', {
      payload: JSON.stringify({ version: 1, snippets: [{ alias: 'sc', command: '新的截屏指令' }] }),
    })
    expect(imported.mode).toBe('merge')
    expect(imported.updated).toBe(1)
    expect(imported.added).toBe(0)
    expect(imported.snippets).toHaveLength(7)
    const sc = (imported.snippets as Snippet[]).find(row => row.alias === 'sc')!
    expect(sc.command).toBe('新的截屏指令')
    const original = (bundle.snippets as Snippet[]).find(row => row.alias === 'sc')!
    expect(sc.id).toBe(original.id)
  })

  it('importJson merge 把新别名追加进来', async () => {
    const result = await harness.call('importJson', {
      payload: { version: 1, snippets: [{ alias: 'brand-new', command: '全新指令', tags: ['x'] }] },
    })
    expect(result.added).toBe(1)
    expect(result.total).toBe(8)
  })

  it('importJson replace 整体替换', async () => {
    const result = await harness.call('importJson', {
      payload: { version: 1, snippets: [{ alias: 'only', command: '唯一指令', tags: ['x'] }] },
      mode: 'replace',
    })
    expect(result.imported).toBe(1)
    expect(result.snippets).toHaveLength(1)
  })

  it('importJson 校验失败时不改动任何数据', async () => {
    const before = await harness.call('list')

    expect((await harness.call('importJson', { payload: '[]' })).ok).toBe(false)
    expect((await harness.call('importJson', { payload: '{oops' })).ok).toBe(false)
    expect((await harness.call('importJson', { payload: { version: 1 } })).ok).toBe(false)
    expect((await harness.call('importJson', {
      payload: { version: 1, snippets: [{ alias: 'has space', command: 'x' }] },
    })).ok).toBe(false)
    expect((await harness.call('importJson', {
      payload: { version: 1, snippets: [{ alias: 'ok-alias' }] },
    })).ok).toBe(false)
    expect((await harness.call('importJson', {
      payload: { version: 1, snippets: [{ alias: 'dup', command: 'a' }, { alias: 'dup', command: 'b' }] },
    })).ok).toBe(false)
    expect((await harness.call('importJson', {})).ok).toBe(false)
    expect((await harness.call('importJson', { payload: {}, mode: 'nonsense' })).ok).toBe(false)

    const after = await harness.call('list')
    expect(after.total).toBe(before.total)
    expect(after.snippets).toEqual(before.snippets)
  })

  it('数据写入项目作用域，切换项目后是另一份数据', async () => {
    await harness.call('save', { alias: 'p1only', command: '仅项目一' })

    const secondContext: ModuleContext = {
      ...harness.context,
      store: harness.store.project('p2'),
      projectId: 'p2',
    }
    await harness.module.reseat?.(secondContext)

    // A project that never had a library keeps it empty; seeding is a first-start concern.
    const inP2 = await harness.call('list')
    expect(inP2.total).toBe(0)
    expect(inP2.snippets.map((row: Snippet) => row.alias)).not.toContain('p1only')

    await harness.call('save', { alias: 'p2only', command: '仅项目二' })

    await harness.module.reseat?.(harness.context)
    const backInP1 = await harness.call('list')
    const aliases = backInP1.snippets.map((row: Snippet) => row.alias)
    expect(aliases).toContain('p1only')
    expect(aliases).not.toContain('p2only')
  })
})
