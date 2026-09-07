/**
 * Console smoke test.
 *
 * Boots the real host behind the console server and drives the same endpoints
 * `web/index.html` does. Unlike the unit tests this exercises the whole
 * HTTP → registry → module stack, which is where the Harness acceptance run
 * found its defects (double-wrapped Results, Windows rename races, un-substituted
 * template variables).
 *
 * Run after `npm run build`:
 *
 *   node scripts/console-smoke.mjs
 *
 * It also cross-checks every method name hard-coded in `web/index.html` against
 * the live registry, because a server-side rename would otherwise surface only
 * as a silent HTTP 400 in the browser.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const { PlusHost, createFakeAdbRunner, startConsoleServer } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)

const TARGET_RE = /'((?:wlan-connection|snippet-library|action-template|scheduler|project-group|demo-recorder|workflow-marketplace|feedback-rl|device-pool|replay|__host__)\.[a-zA-Z-]+)'/g

const adb = createFakeAdbRunner({
  'shell wm size': 'Physical size: 1080x2400',
  'shell getprop ro.product.model': 'smoke-device',
  'devices': 'List of devices attached\nemulator-5554\tdevice\n',
})
const host = await PlusHost.create({
  dataDir: mkdtempSync(join(tmpdir(), 'plus-smoke-')),
  adb,
  capabilities: { adb: true },
})

const server = await startConsoleServer({ plusHost: host, port: 0 })
const base = server.url.replace(/\/+$/, '')
console.log(`console: ${base}`)

const results = []
function record(name, ok, note) {
  results.push({ name, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`)
}

async function api(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) }
  catch { json = { ok: false, error: text.slice(0, 200) } }
  return { status: response.status, json }
}

/** Mirror of the browser's unwrap: strip the registry envelope, then the inner Result. */
function isResultEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.ok !== 'boolean') return false
  return value.ok === false ? typeof value.error === 'string' : 'value' in value
}

async function call(target, input = {}) {
  const { status, json } = await api('/api/call', { target, input })
  if (status !== 200) return { status, ok: false, error: `http ${status}: ${json.error ?? ''}` }
  const inner = isResultEnvelope(json.value) ? json.value : null
  const payload = inner ?? json
  return { status, ok: payload.ok === true, value: payload.value, error: payload.error }
}

/* ---------------- endpoints ---------------- */

{
  const { status, json } = await api('/api/status')
  record('GET /api/status', status === 200 && (json.modules ?? []).length === 11,
    `modules=${(json.modules ?? []).length}（含内部 __host__）`)
}

let registry = []
{
  const { json } = await api('/api/modules')
  registry = json.modules ?? []
  const specs = registry.flatMap(m => m.methodSpecs ?? [])
  const withInput = specs.filter(s => s.input && Object.keys(s.input).length > 0).length
  record('GET /api/modules 透出方法清单', registry.length === 11 && specs.length >= 100,
    `methods=${specs.length} 带入参提示=${withInput}`)
  const empty = registry.filter(m => (m.methodSpecs ?? []).length === 0).map(m => m.id)
  record('每个模块都有可调用方法', empty.length === 0, empty.join(','))
}

{
  const used = []
  for (const file of ['web/index.html', 'web/app.html']) {
    const html = readFileSync(join(ROOT, file), 'utf8')
    for (const match of html.matchAll(TARGET_RE)) used.push(match[1])
  }
  const usedSet = [...new Set(used)]
  const known = new Set(registry.flatMap(m => (m.methodSpecs ?? []).map(s => `${m.id}.${s.name}`)))
  const missing = usedSet.filter(target => !known.has(target))
  record('前端卡片方法名全部存在于注册表（index + app）', missing.length === 0,
    missing.length ? `不存在: ${missing.join(', ')}` : `校验 ${usedSet.length} 个引用`)
}

/* ---------------- 模块一 无线调试 ---------------- */

{
  const qr = await call('wlan-connection.generatePairingQr', { serviceName: 'smoke', scale: 4 })
  const value = qr.value ?? {}
  record('wlan-connection.generatePairingQr',
    qr.ok && typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:image') && typeof value.qrText === 'string',
    qr.ok ? `png=${String(value.dataUrl).length}B` : qr.error)

  const parsed = await call('wlan-connection.parsePairingQr', { qr: String(value.qrText ?? '') })
  record('wlan-connection.parsePairingQr', parsed.ok, parsed.error ?? JSON.stringify(parsed.value ?? {}).slice(0, 70))

  const guide = await call('wlan-connection.pairingGuide', {})
  record('wlan-connection.pairingGuide', guide.ok, guide.error ?? '')
}

/* ---------------- 模块三 动作模板（F-05） ---------------- */

{
  const saved = await call('action-template.save-from-demo', {
    name: 'smoke-tpl',
    steps: [{ action: 'launch', params: { package: '{{pkg}}' } }],
  })
  const id = saved.value?.template?.id
  record('action-template.save-from-demo', saved.ok && typeof id === 'string', saved.ok ? `id=${id}` : saved.error)

  const executed = await call('action-template.execute', { id, variables: { pkg: 'com.android.settings' } })
  const hit = adb.calls.some(entry => entry.includes('com.android.settings'))
  const leaked = adb.calls.some(entry => entry.includes('{{'))
  record('F-05 变量替换后进 adb', executed.ok && hit && !leaked,
    `命中包名=${hit} 残留占位符=${leaked}`)

  const noVars = await call('action-template.execute', { id })
  record('F-05 缺变量必须失败', noVars.ok === false, noVars.error ?? '(意外成功)')
}

/* ---------------- 模块二 + 模块四（F-01） ---------------- */

{
  await call('snippet-library.save', { alias: 'smoke-snip', command: 'shell echo hi' })

  const bad = await call('scheduler.create', {
    name: 'bad', schedule: { kind: 'once', at: '2099-01-01T00:00:00+08:00' },
    target: { type: 'snippet', alias: 'nope-not-here' },
  })
  record('F-01 不存在的别名必须失败', bad.ok === false && String(bad.error).includes('nope-not-here'), bad.error ?? '(意外成功)')

  const good = await call('scheduler.create', {
    name: 'good', schedule: { kind: 'once', at: '2099-01-01T00:00:00+08:00' },
    target: { type: 'snippet', alias: 'smoke-snip' },
  })
  record('F-01 存在的别名创建成功', good.ok === true, good.error ?? '')

  const taskId = good.value?.task?.id
  if (taskId) {
    const run = await call('scheduler.runNow', { id: taskId })
    record('scheduler.runNow 真实执行', run.ok === true, JSON.stringify(run.value ?? run.error).slice(0, 100))
    const runs = await call('scheduler.runs', {})
    record('scheduler.runs 有执行日志', runs.ok && (runs.value?.runs ?? []).length >= 1,
      `count=${(runs.value?.runs ?? []).length}`)
  }
  else record('scheduler.runNow 真实执行', false, 'create 未返回 id')
}

/* ---------------- 模块五 项目组（F-02） ---------------- */

{
  const a = await call('project-group.create', { name: 'A' })
  const b = await call('project-group.create', { name: 'B' })
  const idA = a.value?.group?.id
  const idB = b.value?.group?.id

  await call('project-group.switch', { id: idA })
  await call('snippet-library.save', { alias: 'only-in-a', command: 'echo a' })

  const s2 = await call('project-group.switch', { id: idB })
  const inB = await call('snippet-library.list', {})
  const isolated = (inB.value?.snippets ?? []).every(row => row.alias !== 'only-in-a')

  const s3 = await call('project-group.switch', { id: idA })
  const current = await call('project-group.current', {})
  const inA = await call('snippet-library.list', {})

  record('F-02 A→B→A 连续切换无 EPERM', s2.ok && s3.ok && isolated,
    [s2.error, s3.error].filter(Boolean).join(' | ') || `隔离成立=${isolated}`)
  record('F-02 current 指向新项目组而非 null', current.value?.current?.id === idA,
    `current=${current.value?.current?.id ?? 'null'}`)
  record('F-02 切回后数据仍在',
    (inA.value?.snippets ?? []).some(row => row.alias === 'only-in-a'))
}

/* ---------------- 模块六 演示录制（F-03） ---------------- */

{
  const started = await call('demo-recorder.startDemo', { name: 'smoke-demo' })
  const rid = started.value?.recordingId
  record('demo-recorder.startDemo', started.ok && typeof rid === 'string', started.ok ? `id=${rid}` : started.error)

  await call('demo-recorder.captureStep', { recordingId: rid, action: 'launch', params: { package: '{{pkg}}' } })
  await call('demo-recorder.stopDemo', { recordingId: rid })

  const conv = await call('demo-recorder.toTemplate', { id: rid, name: 'from-demo' })
  const list = await call('action-template.list', {})
  const found = (list.value?.templates ?? []).find(row => row.name === 'from-demo')
  record('F-03 toTemplate 真写入模板库', conv.ok && conv.value?.persisted === true && found !== undefined,
    conv.ok ? `templateId=${conv.value?.templateId ?? '-'} 在库中=${found !== undefined}` : conv.error)
  if (found) {
    const names = (found.variables ?? []).map(v => v.name ?? v)
    record('F-03 模板变量被抽取', JSON.stringify(names) === '["pkg"]', JSON.stringify(names))
  }
}

/* ---------------- 模块九 设备池 ---------------- */

{
  const reg = await call('device-pool.register', { name: 'smoke-dev', serial: 'emulator-5554' })
  const list = await call('device-pool.list', {})
  record('device-pool.register/list', reg.ok && (list.value?.devices ?? []).length >= 1,
    reg.ok ? `devices=${(list.value?.devices ?? []).length}` : reg.error)
  const un = await call('device-pool.unregister', { id: reg.value?.device?.id })
  record('device-pool.unregister', un.ok, un.error ?? '')
}

/* ---------------- 模块十 执行回放 ---------------- */

{
  const rec = await call('replay.startRecording', { name: 'smoke-replay' })
  const sid = rec.value?.sessionId
  record('replay.startRecording', rec.ok && typeof sid === 'string', rec.ok ? `session=${sid}` : rec.error)
  if (typeof sid === 'string') {
    await call('replay.markFrame', { sessionId: sid, action: 'tap', decision: '命中按钮' })
    await call('replay.stopRecording', { sessionId: sid })
    const exported = await call('replay.exportReplay', { id: sid, format: 'html' })
    const html = exported.value?.html ?? exported.value?.content ?? ''
    record('replay.exportReplay 产出可下载 HTML', exported.ok && html.includes('<'),
      exported.ok ? `len=${html.length}` : exported.error)
    const removed = await call('replay.removeReplay', { id: sid })
    record('replay.removeReplay', removed.ok, removed.error ?? '')
  }
}

/* ---------------- 模块七 / 模块八 ---------------- */

{
  const browse = await call('workflow-marketplace.browse', {})
  record('workflow-marketplace.browse', browse.ok,
    browse.error ?? `count=${(browse.value?.items ?? browse.value?.templates ?? []).length}`)

  await call('feedback-rl.record', { taskLabel: 'smoke', outcome: 'failure', symptom: '连不上', resolution: '重连' })
  const rel = await call('feedback-rl.queryRelevant', { symptom: '连不上' })
  record('feedback-rl.queryRelevant 能检索到经验', rel.ok && (rel.value?.total ?? 0) >= 1,
    `total=${rel.value?.total ?? 0}`)
}

/* ---------------- 静态资源与事件 ---------------- */

{
  const page = await fetch(`${base}/index.html`)
  const text = await page.text()
  record('GET /index.html 前端可加载', page.status === 200 && /<!doctype html>/i.test(text),
    `bytes=${text.length}`)

  const app = await fetch(`${base}/app.html`)
  const appText = await app.text()
  record('GET /app.html 普通用户工作台可加载', app.status === 200 && /<!doctype html>/i.test(appText),
    `bytes=${appText.length}`)
  const events = await fetch(`${base}/api/events/recent`)
  record('GET /api/events/recent', events.status === 200)
}

const failed = results.filter(row => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const row of failed) console.log(`  - ${row.name}: ${row.note}`)
}
await server.close().catch(() => undefined)
process.exit(failed.length > 0 ? 1 : 0)
