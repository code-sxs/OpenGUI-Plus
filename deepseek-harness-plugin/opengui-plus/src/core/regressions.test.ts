/**
 * Regression tests for the five defects found during the DeepSeek Harness
 * acceptance run (F-01 … F-05).
 *
 * Every test here failed (or silently "passed" for the wrong reason) before the
 * fix. They drive the real `PlusHost` rather than isolated modules, because
 * four of the five bugs lived in the seams between modules and the host.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFakeAdbRunner, type FakeAdbRunner } from './adb-runner.js'
import { PlusHost } from '../host.js'
import { dshToolName, registerWithDsh } from '../dsh/adapter.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plus-regress-'))
  dirs.push(dir)
  return dir
}

async function boot(adb: FakeAdbRunner | null = null): Promise<{ host: PlusHost, call: (target: string, input?: Record<string, unknown>) => Promise<any> }> {
  const host = await PlusHost.create({
    dataDir: tempDir(),
    adb,
    capabilities: { adb: adb !== null },
  })
  return {
    host,
    async call(target, input = {}) {
      const outer = await host.call(target, input)
      expect(outer.ok).toBe(true)
      return outer.value
    },
  }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    }
    catch {
      // Best-effort cleanup; a locked temp file on Windows is not a test failure.
    }
  }
})

describe('F-01 scheduler 跨模块调用必须解包 Result', () => {
  it('create 指向不存在的快捷指令时应当失败，而不是静默创建', async () => {
    const { call } = await boot()
    const created = await call('scheduler.create', {
      name: 'unk',
      schedule: { kind: 'once', at: '2099-01-01T00:00:00+08:00' },
      target: { type: 'snippet', alias: 'definitely-not-exist' },
    })
    expect(created.ok).toBe(false)
    expect(created.error).toContain('definitely-not-exist')
  })

  it('create 指向存在的快捷指令时成功，runNow 解析成功', async () => {
    const { call } = await boot()
    await call('snippet-library.save', { alias: 'ping', command: 'adb shell ping' })

    const created = await call('scheduler.create', {
      name: 'ok-task',
      schedule: { kind: 'once', at: '2099-01-01T00:00:00+08:00' },
      target: { type: 'snippet', alias: 'ping' },
    })
    expect(created.ok).toBeUndefined()

    const ran = await call('scheduler.runNow', { id: created.task.id })
    expect(ran.ok).toBe(true)
    expect(ran.detail).toContain('ping')
  })

  it('指向不存在的模板时 create 与 update 都失败', async () => {
    const { call } = await boot()
    const bad = await call('scheduler.create', {
      name: 'bad-template',
      schedule: { kind: 'daily', at: '09:00' },
      target: { type: 'template', templateId: 'tpl-nope' },
    })
    expect(bad.ok).toBe(false)

    await call('snippet-library.save', { alias: 'ping', command: 'x' })
    const good = await call('scheduler.create', {
      name: 'good',
      schedule: { kind: 'daily', at: '09:00' },
      target: { type: 'snippet', alias: 'ping' },
    })
    const moved = await call('scheduler.update', {
      id: good.task.id,
      target: { type: 'template', templateId: 'tpl-nope' },
    })
    expect(moved.ok).toBe(false)
    expect(moved.error).toContain('tpl-nope')
  })
})

describe('F-02 project-group.switch 并发写入', () => {
  it('连续切换项目组不再因 rename 竞态报错，且数据隔离成立', async () => {
    const { call } = await boot()

    const a = await call('project-group.create', { name: 'A' })
    const b = await call('project-group.create', { name: 'B' })
    expect(a.ok).toBeUndefined()
    expect(b.ok).toBeUndefined()

    const switchA = await call('project-group.switch', { id: a.group.id })
    expect(switchA.switched).toBe(true)
    await call('snippet-library.save', { alias: 'only-in-a', command: 'echo a' })

    const switchB = await call('project-group.switch', { id: b.group.id })
    expect(switchB.ok).toBeUndefined()
    expect(switchB.switched).toBe(true)
    const inB = await call('snippet-library.list')
    expect(inB.snippets.some((row: { alias: string }) => row.alias === 'only-in-a')).toBe(false)

    const backToA = await call('project-group.switch', { id: a.group.id })
    expect(backToA.ok).toBeUndefined()
    const inA = await call('snippet-library.list')
    expect(inA.snippets.some((row: { alias: string }) => row.alias === 'only-in-a')).toBe(true)
  })

  it('切换后 project-group.current 必须指向新项目组，而不是被 reseat 冲回 null', async () => {
    const { host, call } = await boot()

    const a = await call('project-group.create', { name: 'A' })
    const b = await call('project-group.create', { name: 'B' })

    await call('project-group.switch', { id: a.group.id })
    expect((await call('project-group.current')).current?.id).toBe(a.group.id)

    await call('project-group.switch', { id: b.group.id })
    expect((await call('project-group.current')).current?.id).toBe(b.group.id)

    // The host owns the same file (`global/current-project.json`); the module
    // must not overwrite it with a stale pointer after the host has switched.
    expect(host.activeProjectId).toBe(b.group.id)
  })

  it('当前项目组指针能跨重启存活', async () => {
    const dataDir = tempDir()
    const first = await PlusHost.create({ dataDir, adb: null, capabilities: { adb: false } })
    const created = await first.call('project-group.create', { name: 'Persisted' })
    const groupId = (created.value as { group: { id: string } }).group.id
    await first.call('project-group.switch', { id: groupId })

    const second = await PlusHost.create({ dataDir, adb: null, capabilities: { adb: false } })
    expect(second.activeProjectId).toBe(groupId)
    const current = await second.call('project-group.current')
    expect((current.value as { current: { id: string } | null }).current?.id).toBe(groupId)
  })

  it('store.update 在同一 key 上不会自锁死（读-改-写只占一个队列位）', async () => {
    const { host } = await boot()
    const scope = host.store.global()
    // A deadlock here never resolves, so the test would time out — the await
    // itself is the assertion.
    const first = await scope.update<string[]>('queue-key', [], current => [...current, 'one'])
    const second = await scope.update<string[]>('queue-key', [], current => [...current, 'two'])
    expect(first).toEqual(['one'])
    expect(second).toEqual(['one', 'two'])
  })

  it('并发写同一 key 时不丢更新', async () => {
    const { host } = await boot()
    const scope = host.store.global()
    await Promise.all([
      scope.update<string[]>('race', [], current => [...current, 'a']),
      scope.update<string[]>('race', [], current => [...current, 'b']),
      scope.update<string[]>('race', [], current => [...current, 'c']),
    ])
    const final = await scope.get<string[]>('race', [])
    expect(final.sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('F-03 demo-recorder.toTemplate 真持久化', () => {
  it('toTemplate 之后 action-template.list 能看到模板', async () => {
    const { call } = await boot()

    const demo = await call('demo-recorder.startDemo', { name: '录一个流程' })
    await call('demo-recorder.captureStep', {
      recordingId: demo.recordingId,
      action: 'launch',
      params: { package: '{{pkg}}' },
      captureScreen: false,
    })
    await call('demo-recorder.captureStep', {
      recordingId: demo.recordingId,
      action: 'wait',
      params: { ms: 100 },
      captureScreen: false,
    })
    await call('demo-recorder.stopDemo', { recordingId: demo.recordingId })

    const converted = await call('demo-recorder.toTemplate', { id: demo.recordingId })
    expect(converted.persisted).toBe(true)
    expect(converted.templateId).toBeTruthy()

    const listed = await call('action-template.list')
    expect(listed.total).toBe(1)
    expect(listed.templates[0].name).toBe('录一个流程')
    expect(listed.templates[0].variables.map((row: { name: string }) => row.name)).toEqual(['pkg'])
  })
})

describe('投屏：wlan-connection.screencap', () => {
  it('fake runner 有 execOut 时直接返回 PNG 字节并写到 <dataDir>/screenshots', async () => {
    const dataDir = tempDir()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff])
    const adb = createFakeAdbRunner({})
    adb.execOut = async (args) => {
      adb.calls.push(args.join(' '))
      return { stdout: png, stderr: '', code: 0 }
    }
    const host = await PlusHost.create({ dataDir, adb, capabilities: { adb: true } })
    const result = await host.call('wlan-connection.screencap', { serial: 'emulator-5554' })
    expect(result.ok).toBe(true)
    expect(result.value?.path).toMatch(/^screenshots\/emulator-5554-\d+\.png$/)
    expect(result.value?.bytes).toBe(png.length)
    const absolute = join(dataDir, result.value!.path as string)
    const { readFile } = await import('node:fs/promises')
    const onDisk = await readFile(absolute)
    expect(onDisk.equals(png)).toBe(true)
    expect(adb.calls.some(entry => entry.includes('exec-out screencap -p'))).toBe(true)
  })

  it('runner 没有 execOut 时走 shell+pull 兜底', async () => {
    const dataDir = tempDir()
    const adb = createFakeAdbRunner({})
    const host = await PlusHost.create({ dataDir, adb, capabilities: { adb: true } })
    const result = await host.call('wlan-connection.screencap', { serial: 'fallback-1' })
    expect(result.ok).toBe(true)
    expect(adb.calls.some(entry => entry.includes('shell screencap -p'))).toBe(true)
    expect(adb.calls.some(entry => entry.includes('pull'))).toBe(true)
  })
})

describe('设备发现：wlan-connection.discover 必须包含 mDNS 可配对设备', () => {
  it('pickPairable 归类 pairing/connect、去重、剔除已连接', async () => {
    const { pickPairable } = await import('../modules/wlan-connection/index.js')
    const { MDNS_PAIRING_TYPE, MDNS_CONNECT_TYPE } = await import('../modules/wlan-connection/pairing.js')
    const services = [
      { name: 'adb-1234._adb-tls-pairing._tcp', type: MDNS_PAIRING_TYPE, host: '192.168.1.20', port: 37121 },
      { name: 'adb-1234._adb._tcp', type: MDNS_CONNECT_TYPE, host: '192.168.1.20', port: 5555 },
      // Same host:port twice (different service names) — must dedupe to one.
      { name: 'dup._adb-tls-pairing._tcp', type: MDNS_PAIRING_TYPE, host: '10.0.0.5', port: 41237 },
      { name: 'dup._adb-tls-pairing._tcp', type: MDNS_PAIRING_TYPE, host: '10.0.0.5', port: 41237 },
      // Irrelevant service type — must be ignored.
      { name: 'http._http._tcp', type: '_http._tcp', host: '10.0.0.99', port: 80 },
    ]
    const out = pickPairable(
      services,
      new Set(['192.168.1.20:5555']), // 192.168.1.20:5555 is already connected → drop
      new Set(['10.0.0.5:41237']),     // 10.0.0.5:41237 already saved → mark known
    )
    expect(out).toHaveLength(2)
    const pairing = out.find(p => p.port === 37121)
    const known = out.find(p => p.port === 41237)
    expect(pairing).toMatchObject({ kind: 'pairing', host: '192.168.1.20', known: false })
    expect(known).toMatchObject({ kind: 'pairing', host: '10.0.0.5', known: true })
  })

  it('discover 在 adb 不可用时不崩，pairable 为空数组', async () => {
    const { host, call } = await boot(null)
    const result = await host.call('wlan-connection.discover', {})
    expect(result.ok).toBe(true)
    expect(result.value?.devices).toEqual([])
    expect(result.value?.pairable).toEqual([])
    // adb 不可用时必须明确告诉前端原因，否则用户会以为「没设备」实际是 adb 没装
    expect(typeof result.value?.adbError).toBe('string')
    expect(result.value?.adbError).toMatch(/adb/i)
  })

  it('discover 收到 mDNS 配对服务时一并返回（不被 adb devices 屏蔽）', async () => {
    const adb = createFakeAdbRunner({
      'devices -l': { stdout: 'List of devices attached\n\n', stderr: '', code: 0 },
      'mdns services': {
        stdout: [
          'List of discovered mdns services',
          'studio-aaaa\t_adb-tls-pairing._tcp\t192.168.1.42:39231',
          'studio-bbbb\t_adb-tls-connect._tcp\t192.168.1.43:5555',
        ].join('\n'),
        stderr: '',
        code: 0,
      },
    })
    const host = await PlusHost.create({ dataDir: tempDir(), adb, capabilities: { adb: true } })
    const result = await host.call('wlan-connection.discover', {})
    expect(result.ok).toBe(true)
    const pairable = result.value?.pairable ?? []
    expect(pairable).toHaveLength(2)
    expect(pairable.find((p: any) => p.port === 39231)).toMatchObject({ kind: 'pairing', host: '192.168.1.42' })
    expect(pairable.find((p: any) => p.port === 5555)).toMatchObject({ kind: 'connect', host: '192.168.1.43' })
    // Confirm mDNS was actually queried (proves we no longer ignore it).
    expect(adb.calls.some(c => c === 'mdns services')).toBe(true)
  })

  it('diagnose 在 adb 可用时返回 version / devices / mdns 原始输出', async () => {
    const adb = createFakeAdbRunner({
      version: { stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '', code: 0 },
      'devices -l': { stdout: 'List of devices attached\nemulator-5554\tdevice product:foo model:Pixel\n', stderr: '', code: 0 },
      'mdns services': { stdout: 'List of discovered mdns services\n', stderr: '', code: 0 },
    })
    const host = await PlusHost.create({ dataDir: tempDir(), adb, capabilities: { adb: true } })
    const result = await host.call('wlan-connection.diagnose', {})
    expect(result.ok).toBe(true)
    const d: any = result.value
    expect(d.adbAvailable).toBe(true)
    expect(typeof d.binary).toBe('string')
    expect(d.version?.stdout).toMatch(/Android Debug Bridge/)
    expect(d.devices?.stdout).toMatch(/emulator-5554/)
    expect(d.mdns?.stdout).toMatch(/List of discovered mdns services/)
    // 确认三条命令都被实际调用过
    expect(adb.calls).toContain('version')
    expect(adb.calls.some(c => c === 'devices -l')).toBe(true)
    expect(adb.calls).toContain('mdns services')
  })

  it('diagnose 在 adb 不可用时返回 adbAvailable:false 与原因', async () => {
    const { host } = await boot(null)
    const result = await host.call('wlan-connection.diagnose', {})
    expect(result.ok).toBe(true)
    const d: any = result.value
    expect(d.adbAvailable).toBe(false)
    expect(d.binary).toBeNull()
    expect(typeof d.reason).toBe('string')
    expect(d.version).toBeNull()
    expect(d.devices).toBeNull()
    expect(d.mdns).toBeNull()
  })
})

describe('F-05 action-template 变量替换', () => {
  it('执行时 {{pkg}} 被真实替换后再交给 adb', async () => {
    const adb = createFakeAdbRunner({ 'shell monkey*': { stdout: 'Events injected: 1', code: 0 } })
    const { call } = await boot(adb)

    const rec = await call('action-template.startRecording', { name: '启动应用' })
    await call('action-template.recordStep', {
      recordingId: rec.recordingId,
      type: 'launch',
      params: { package: '{{pkg1}}' },
    })
    const stopped = await call('action-template.stopRecording', { recordingId: rec.recordingId })

    const report = await call('action-template.execute', {
      id: stopped.template.id,
      variables: { pkg1: 'com.android.settings' },
    })

    expect(report.ok).toBe(true)
    expect(report.results[0].ok).toBe(true)
    // The literal placeholder must never reach adb.
    expect(adb.calls.some(entry => entry.includes('{{pkg1}}'))).toBe(false)
    expect(adb.calls.some(entry => entry.includes('com.android.settings'))).toBe(true)
  })

  it('缺少必填变量时执行失败，不把占位符传给 adb', async () => {
    const adb = createFakeAdbRunner({})
    const { call } = await boot(adb)
    const rec = await call('action-template.startRecording', { name: '需要变量' })
    await call('action-template.recordStep', {
      recordingId: rec.recordingId,
      type: 'launch',
      params: { package: '{{pkg1}}' },
    })
    const stopped = await call('action-template.stopRecording', { recordingId: rec.recordingId })

    const failure = await call('action-template.execute', { id: stopped.template.id })
    expect(failure.ok).toBe(false)
    expect(failure.error).toContain('{{pkg1}}')
    expect(adb.calls.some(entry => entry.includes('monkey'))).toBe(false)
  })
})

describe('F-04 dsh adapter 与 dsh-tools 的 defineTool 契约', () => {
  it('驼峰方法名会被切成下划线', () => {
    expect(dshToolName('replay', 'listReplays')).toBe('opengui_plus_replay_list_replays')
    expect(dshToolName('wlan-connection', 'status')).toBe('opengui_plus_wlan_connection_status')
    expect(dshToolName('action-template', 'save-from-demo')).toBe('opengui_plus_action_template_save_from_demo')
  })

  it('modern 方言：parameters 是属性表，且带 output.render', async () => {
    const specs: any[] = []
    const fake = {
      // Emulate dsh-tools rc.8: `output.render` is read unconditionally and a
      // JSON-Schema `parameters` object is rejected.
      defineTool(spec: any) {
        if (spec.parameters !== undefined && spec.parameters.type !== undefined) {
          throw new Error('parameters.type must be a value schema object')
        }
        if (spec.output === undefined) throw new Error('output is required')
        if (typeof spec.output.render !== 'function') throw new Error('output.render must be a function')
        spec.output.render({}, { ok: true })
        specs.push(spec)
        return spec
      },
    }

    // No real DSH is installed here, so the bridge is supplied directly.
    const { host } = await boot()
    const { registerWithDshBridge } = await import('../dsh/adapter.js')
    const built = await registerWithDshBridge(
      fake,
      host.registry.list(),
      async (target, input) => host.call(target, input),
    )
    expect(built.dialect).toBe('modern')
    expect(specs.length).toBeGreaterThan(0)
    const sample = specs.find(spec => spec.name === 'opengui_plus_snippet_library_save')!
    expect(sample).toBeTruthy()
    // Per-property map, not `{ type: 'object', properties }`.
    expect(sample.parameters.type).toBeUndefined()
    expect(sample.parameters.alias).toBeTruthy()
    expect(sample.output.schema).toEqual({ type: 'object', additionalProperties: true })
  })

  it('legacy 方言：回退为 JSON-Schema object 参数且 execute 返回字符串', async () => {
    const specs: any[] = []
    const fake = {
      defineTool(spec: any) {
        if (spec.parameters === undefined || spec.parameters.type !== 'object') {
          throw new Error('legacy host expects a JSON-Schema object')
        }
        if (spec.output !== undefined) throw new Error('legacy host rejects output')
        specs.push(spec)
        return spec
      },
    }
    const { host } = await boot()
    const { registerWithDshBridge } = await import('../dsh/adapter.js')
    const built = await registerWithDshBridge(
      fake,
      host.registry.list(),
      async (target, input) => host.call(target, input),
    )
    expect(built.dialect).toBe('legacy')
    expect(specs.length).toBeGreaterThan(0)
    const out = await specs[0].execute({})
    expect(typeof out).toBe('string')
  })
})
