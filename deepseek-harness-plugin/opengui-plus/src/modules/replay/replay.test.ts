import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventBus } from '../../core/events.js'
import { silentLogger } from '../../core/logger.js'
import type { ModuleContext } from '../../core/module.js'
import { PlusStore } from '../../core/store.js'
import { createReplayModule } from './index.js'

interface Harness {
  readonly module: ReturnType<typeof createReplayModule>
  readonly context: ModuleContext
  readonly store: PlusStore
  call(method: string, input?: Record<string, unknown>): Promise<any>
}

const dirs: string[] = []

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'plus-replay-'))
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
  const module = createReplayModule()
  return {
    module,
    context,
    store,
    async call(method, input = {}) {
      const fn = module.methods[method]
      if (fn === undefined) throw new Error(`missing method ${method}`)
      const result = await fn(input)
      return result.ok ? result.value : result
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
      // Best-effort cleanup.
    }
  }
})

describe('replay', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await boot()
  })

  it('录制一段任务执行并导出可分享的 HTML 回放', async () => {
    const start = await harness.call('startRecording', { name: '登录流程', taskLabel: 'task-42' })
    const sessionId = start.sessionId as string
    expect(sessionId).toBeTruthy()

    const f1 = await harness.call('markFrame', { sessionId, action: '点击登录', decision: '首页只有登录入口', ok: true })
    const frameId = f1.frameId as string

    const f2 = await harness.call('markFrame', {
      sessionId,
      action: '输入账号',
      ok: false,
      anomaly: JSON.stringify({ symptom: '输入框被遮挡', recovery: '等待动画结束' }),
    })

    const stop = await harness.call('stopRecording', { sessionId })
    expect(stop.status).toBe('ready')
    expect(stop.frames).toBe(2)

    const list = await harness.call('listReplays')
    expect(list.length).toBe(1)
    expect(list[0].name).toBe('登录流程')
    expect(list[0].frames).toBe(2)
    expect(list[0].taskLabel).toBe('task-42')

    const get = await harness.call('getReplay', { id: sessionId })
    expect(get.frames.length).toBe(2)
    expect(get.frames[1].anomaly?.symptom).toBe('输入框被遮挡')

    const html = await harness.call('exportReplay', { id: sessionId, format: 'html' })
    expect(html.filename).toContain('.html')
    expect(html.content).toContain('<!DOCTYPE html>')
    expect(html.content).toContain('登录流程')
    expect(html.content).toContain('FRAMES = [')
    // The escaped interpolation must be preserved verbatim for the browser runtime.
    expect(html.content).toContain('${i === current')
    expect(html.content).toContain('frame-img')

    const json = await harness.call('exportReplay', { id: sessionId, format: 'json' })
    const parsed = JSON.parse(json.content)
    expect(parsed.name).toBe('登录流程')
    expect(parsed.frames.length).toBe(2)
  })

  it('事后标注某帧的决策理由与异常', async () => {
    const start = await harness.call('startRecording', { name: '标注测试' })
    const sessionId = start.sessionId as string
    const marked = await harness.call('markFrame', { sessionId, action: '滑动' })
    const frameId = marked.frameId as string
    await harness.call('stopRecording', { sessionId })

    const anno = await harness.call('annotate', { sessionId, frameId, decision: '图像相似度不足' })
    expect(anno.annotated).toBe(true)

    const get = await harness.call('getReplay', { id: sessionId })
    expect(get.frames[0].decision).toBe('图像相似度不足')
  })

  it('统计回放的成功/失败/异常帧数', async () => {
    const start = await harness.call('startRecording', { name: '统计测试' })
    const sessionId = start.sessionId as string
    await harness.call('markFrame', { sessionId, action: 'a', ok: true })
    await harness.call('markFrame', { sessionId, action: 'b', ok: false })
    await harness.call('markFrame', { sessionId, action: 'c', ok: true, anomaly: '{"symptom":"卡顿"}' })
    await harness.call('stopRecording', { sessionId })

    const stats = await harness.call('stats', { id: sessionId })
    expect(stats.frames).toBe(3)
    expect(stats.okFrames).toBe(2)
    expect(stats.failedFrames).toBe(1)
    expect(stats.anomalies).toBe(1)
  })

  it('删除回放会清掉会话', async () => {
    const start = await harness.call('startRecording', { name: '删除测试' })
    const sessionId = start.sessionId as string
    await harness.call('stopRecording', { sessionId })

    const removed = await harness.call('removeReplay', { id: sessionId })
    expect(removed.removed).toBe(sessionId)

    const list = await harness.call('listReplays')
    expect(list.length).toBe(0)
  })

  it('对不存在的会话返回 fail', async () => {
    expect((await harness.call('getReplay', { id: 'nope' })).ok).toBe(false)
    expect((await harness.call('markFrame', { sessionId: 'nope', action: 'x' })).ok).toBe(false)
    expect((await harness.call('stats', { id: 'nope' })).ok).toBe(false)
  })
})
