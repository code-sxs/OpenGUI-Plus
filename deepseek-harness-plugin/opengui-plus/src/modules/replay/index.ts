/**
 * Module 10 — Execution visualization replay.
 *
 * Records a task as an ordered, timestamped sequence of frames. Each frame can
 * capture a screenshot, an AI decision note, and an anomaly + recovery note.
 * When the recording stops, the host can export a self-contained HTML player so
 * the run can be reviewed or shared without the console.
 *
 * Like every OpenGUI-Plus module this file imports nothing from upstream
 * OpenGUI; it only depends on `core/`. When `adb` is not available screenshots
 * are skipped gracefully instead of failing the frame.
 *
 * @module replay
 */

import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createId } from '../../core/id.js'
import { PLUS_EVENTS } from '../../core/events.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import { fail, ok, type Result } from '../../core/types.js'

const SESSIONS_KEY = 'replay-sessions'

interface ReplayAnomaly {
  readonly symptom: string
  readonly recovery?: string
}

interface ReplayFrame {
  readonly id: string
  readonly index: number
  readonly at: string
  readonly elapsedMs: number
  readonly action?: string
  readonly params?: Record<string, string | number>
  readonly decision?: string
  readonly anomaly?: ReplayAnomaly
  readonly screenshotPath?: string
  readonly ok: boolean
  readonly detail?: string
}

interface ReplaySession {
  readonly id: string
  readonly name: string
  readonly taskLabel?: string
  readonly status: 'recording' | 'ready'
  readonly startedAt: string
  readonly endedAt?: string
  readonly durationMs?: number
  readonly frames: ReplayFrame[]
  readonly createdAt: string
  readonly updatedAt: string
}

interface ReplayExport {
  readonly filename: string
  readonly content: string
  readonly path?: string
}

function readString(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key]
  return typeof value === 'string' ? value : fallback
}

function dirFor(dataDir: string, sessionId: string): string {
  return join(dataDir, 'replays', sessionId)
}

function buildFrame(
  session: ReplaySession,
  input: Record<string, unknown>,
): { frame: ReplayFrame, screenshot?: { data: string, path: string } } | { error: string } {
  const index = session.frames.length
  const startedAt = Date.parse(session.startedAt)
  const at = new Date().toISOString()
  const elapsedMs = Number.isNaN(startedAt) ? 0 : Math.max(0, Date.now() - startedAt)

  const action = readString(input, 'action')
  const decision = readString(input, 'decision')
  const detail = readString(input, 'detail')

  let anomaly: ReplayAnomaly | undefined
  const rawAnomaly = input.anomaly
  if (typeof rawAnomaly === 'string' && rawAnomaly.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawAnomaly) as Record<string, unknown>
      const symptom = readString(parsed, 'symptom')
      if (symptom.length > 0) anomaly = { symptom, ...(readString(parsed, 'recovery') ? { recovery: readString(parsed, 'recovery') } : {}) }
    }
    catch {
      anomaly = { symptom: rawAnomaly }
    }
  }
  else if (typeof rawAnomaly === 'object' && rawAnomaly !== null) {
    const record = rawAnomaly as Record<string, unknown>
    const symptom = readString(record, 'symptom')
    if (symptom.length > 0) anomaly = { symptom, ...(readString(record, 'recovery') ? { recovery: readString(record, 'recovery') } : {}) }
  }

  const paramsRaw = input.params
  const params = typeof paramsRaw === 'object' && paramsRaw !== null && !Array.isArray(paramsRaw)
    ? paramsRaw as Record<string, string | number>
    : undefined

  const okFlag = input.ok === undefined ? true : input.ok !== false && input.ok !== 'false'

  const frame: ReplayFrame = {
    id: createId('frame'),
    index,
    at,
    elapsedMs,
    ...(action.length > 0 ? { action } : {}),
    ...(params ? { params } : {}),
    ...(decision.length > 0 ? { decision } : {}),
    ...(anomaly ? { anomaly } : {}),
    ok: okFlag,
    ...(detail.length > 0 ? { detail } : {}),
  }

  return { frame }
}

async function captureScreenshot(context: ModuleContext, sessionId: string, frameId: string, index: number): Promise<string | undefined> {
  if (context.adb === null) return undefined
  const dir = dirFor(context.dataDir, sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${index}-${frameId}.png`)
  try {
    const result = await context.adb.run(['exec-out', 'screencap', '-p'])
    const buffer = Buffer.from(result.stdout, 'binary')
    if (buffer.length === 0) return undefined
    await writeFile(path, buffer)
    return path
  }
  catch (error) {
    context.logger.warn(`回放截图失败: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function renderHtml(session: ReplaySession): string {
  const framesJson = JSON.stringify(session.frames.map(frame => ({
    index: frame.index,
    elapsedMs: frame.elapsedMs,
    action: frame.action ?? '',
    params: frame.params ?? {},
    decision: frame.decision ?? '',
    anomaly: frame.anomaly ?? null,
    ok: frame.ok,
    detail: frame.detail ?? '',
    screenshot: frame.screenshotPath ?? '',
  })))

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenGUI-Plus 回放 · ${escapeHtml(session.name)}</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --accent:#818cf8; --ok:#34d399; --bad:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,"PingFang SC",sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid #334155; display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; }
  .meta { color:var(--muted); font-size:12px; }
  .layout { display:grid; grid-template-columns: 220px 1fr; gap:16px; padding:16px 20px; }
  .timeline { display:flex; flex-direction:column; gap:6px; max-height:80vh; overflow:auto; }
  .step { padding:10px 12px; border-radius:10px; background:var(--panel); cursor:pointer; border:1px solid transparent; }
  .step.active { border-color:var(--accent); }
  .step .t { color:var(--muted); font-size:11px; }
  .step .a { font-weight:600; }
  .step .anom { color:var(--bad); font-size:11px; margin-top:2px; }
  .viewer { background:var(--panel); border-radius:14px; padding:16px; min-height:420px; }
  .frame-img { width:100%; max-width:360px; border-radius:12px; display:block; margin:0 auto 14px; background:#0b1220; }
  .card h3 { margin:0 0 6px; font-size:14px; }
  .kv { color:var(--muted); font-size:12px; }
  .decision { background:#172554; border-left:3px solid var(--accent); padding:8px 12px; border-radius:8px; margin:10px 0; }
  .anomaly { background:#3b0d0d; border-left:3px solid var(--bad); padding:8px 12px; border-radius:8px; margin:10px 0; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; }
  .badge.ok { background:#064e3b; color:var(--ok); }
  .badge.bad { background:#4c0519; color:var(--bad); }
  .nav { display:flex; gap:8px; margin-top:14px; }
  .nav button { background:#334155; color:var(--text); border:0; padding:8px 14px; border-radius:9px; cursor:pointer; }
  .empty { color:var(--muted); text-align:center; padding:40px; }
</style>
</head>
<body>
<header>
  <h1>OpenGUI-Plus 执行回放</h1>
  <div>
    <div class="meta">${escapeHtml(session.name)}${session.taskLabel ? ` · ${escapeHtml(session.taskLabel)}` : ''}</div>
    <div class="meta">${session.frames.length} 帧 · ${session.durationMs ?? 0} ms</div>
  </div>
</header>
<div class="layout">
  <nav class="timeline" id="timeline"></nav>
  <section class="viewer" id="viewer"></section>
</div>
<script>
  const FRAMES = ${framesJson};
  let current = 0;
  const timeline = document.getElementById('timeline');
  const viewer = document.getElementById('viewer');

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return (m > 0 ? m + 'm' : '') + (s % 60) + 's ' + (ms % 1000) + 'ms';
  }

  function render() {
    timeline.innerHTML = FRAMES.map((f, i) => \`
      <div class="step \${i === current ? 'active' : ''}" data-i="\${i}">
        <div class="t">#\${f.index} · \${fmt(f.elapsedMs)}</div>
        <div class="a">\${f.action || '(无动作)'}</div>
        \${f.anomaly ? '<div class="anom">⚠ ' + escape(f.anomaly.symptom) + '</div>' : ''}
      </div>\`).join('');
    timeline.querySelectorAll('.step').forEach(el => el.addEventListener('click', () => { current = +el.dataset.i; render(); }));
    const f = FRAMES[current];
    if (!f) { viewer.innerHTML = '<div class="empty">暂无帧</div>'; return; }
    viewer.innerHTML = \`
      <h3>第 \${f.index} 帧 <span class="badge \${f.ok ? 'ok' : 'bad'}">\${f.ok ? '成功' : '失败'}</span>
        <span class="kv"> · \${fmt(f.elapsedMs)}</span></h3>
      \${f.screenshot ? '<img class="frame-img" src="' + f.screenshot + '">' : '<div class="empty">无截图</div>'}
      \${f.action ? '<div class="kv">动作：' + escape(f.action) + '</div>' : ''}
      \${f.params && Object.keys(f.params).length ? '<div class="kv">参数：' + escape(JSON.stringify(f.params)) + '</div>' : ''}
      \${f.decision ? '<div class="decision"><b>AI 决策</b><br>' + escape(f.decision) + '</div>' : ''}
      \${f.anomaly ? '<div class="anomaly"><b>异常</b>：' + escape(f.anomaly.symptom) + (f.anomaly.recovery ? '<br><b>恢复</b>：' + escape(f.anomaly.recovery) + '' : '') + '</div>' : ''}
      \${f.detail ? '<div class="kv">详情：' + escape(f.detail) + '</div>' : ''}
      <div class="nav">
        <button onclick="shift(-1)">← 上一帧</button>
        <button onclick="shift(1)">下一帧 →</button>
      </div>\`;
  }
  function shift(d) { current = Math.max(0, Math.min(FRAMES.length - 1, current + d)); render(); }
  function escape(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  document.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') shift(-1); if (e.key === 'ArrowRight') shift(1); });
  render();
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch))
}

export function createReplayModule(): PlusModule {
  let context: ModuleContext | null = null
  let sessions: ReplaySession[] = []

  async function persist(): Promise<void> {
    if (context === null) return
    await context.store.set(SESSIONS_KEY, sessions)
  }

  const module = defineModule({
    id: 'replay',
    name: '任务执行可视化回放',
    version: '0.1.0',
    summary: '逐帧记录动作、AI 决策理由与异常恢复，导出可分享的单文件 HTML 回放',
    methods: {
      async startRecording(input) {
        if (context === null) return fail('模块未启动')
        const name = readString(input, 'name')
        if (name.length === 0) return fail('需要 name')
        const session: ReplaySession = {
          id: createId('replay'),
          name,
          ...(readString(input, 'taskLabel') ? { taskLabel: readString(input, 'taskLabel') } : {}),
          status: 'recording',
          startedAt: new Date().toISOString(),
          frames: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        sessions = [session, ...sessions]
        await persist()
        return ok({ sessionId: session.id, name: session.name, startedAt: session.startedAt })
      },

      async markFrame(input) {
        if (context === null) return fail('模块未启动')
        const sessionId = readString(input, 'sessionId')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        if (session.status !== 'recording') return fail('会话已结束，无法追加帧')

        const built = buildFrame(session, input)
        if ('error' in built) return fail(built.error)

        let screenshotPath: string | undefined
        if (input.captureScreenshot === true || input.captureScreenshot === 'true') {
          screenshotPath = await captureScreenshot(context, sessionId, built.frame.id, built.frame.index)
        }
        const frame: ReplayFrame = screenshotPath ? { ...built.frame, screenshotPath } : built.frame
        sessions = sessions.map(row => (row.id === sessionId ? { ...row, frames: [...row.frames, frame], updatedAt: new Date().toISOString() } : row))
        await persist()
        return ok({ frameId: frame.id, index: frame.index, screenshot: screenshotPath !== undefined })
      },

      async stopRecording(input) {
        if (context === null) return fail('模块未启动')
        const sessionId = readString(input, 'sessionId')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        const endedAt = new Date().toISOString()
        const startedAt = Date.parse(session.startedAt)
        const durationMs = Number.isNaN(startedAt) ? 0 : Math.max(0, Date.now() - startedAt)
        sessions = sessions.map(row => (row.id === sessionId
          ? { ...row, status: 'ready', endedAt, durationMs, updatedAt: endedAt }
          : row))
        await persist()
        context.events.publish('replay', PLUS_EVENTS.replayReady, { sessionId, frames: session.frames.length })
        return ok({ sessionId, frames: session.frames.length, durationMs, status: 'ready' })
      },

      async listReplays() {
        return ok(sessions.map(row => ({
          id: row.id,
          name: row.name,
          status: row.status,
          frames: row.frames.length,
          startedAt: row.startedAt,
          durationMs: row.durationMs ?? null,
          ...(row.taskLabel ? { taskLabel: row.taskLabel } : {}),
        })))
      },

      async getReplay(input) {
        const sessionId = readString(input, 'id')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        return ok(session)
      },

      async removeReplay(input) {
        if (context === null) return fail('模块未启动')
        const sessionId = readString(input, 'id')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        sessions = sessions.filter(row => row.id !== sessionId)
        await persist()
        const dir = dirFor(context.dataDir, sessionId)
        if (existsSync(dir)) {
          try {
            await rm(dir, { recursive: true, force: true })
          }
          catch (error) {
            context.logger.warn(`清理回放目录失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return ok({ removed: sessionId })
      },

      async annotate(input) {
        if (context === null) return fail('模块未启动')
        const sessionId = readString(input, 'sessionId')
        const frameId = readString(input, 'frameId')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        const decision = readString(input, 'decision')
        let anomaly: ReplayAnomaly | undefined
        const rawAnomaly = input.anomaly
        if (typeof rawAnomaly === 'string' && rawAnomaly.trim().length > 0) {
          try {
            const parsed = JSON.parse(rawAnomaly) as Record<string, unknown>
            const symptom = readString(parsed, 'symptom')
            if (symptom.length > 0) anomaly = { symptom, ...(readString(parsed, 'recovery') ? { recovery: readString(parsed, 'recovery') } : {}) }
          }
          catch { anomaly = { symptom: rawAnomaly } }
        }
        else if (typeof rawAnomaly === 'object' && rawAnomaly !== null) {
          const record = rawAnomaly as Record<string, unknown>
          const symptom = readString(record, 'symptom')
          if (symptom.length > 0) anomaly = { symptom, ...(readString(record, 'recovery') ? { recovery: readString(record, 'recovery') } : {}) }
        }
        sessions = sessions.map(row => row.id === sessionId
          ? {
              ...row,
              frames: row.frames.map(frame => frame.id === frameId
                ? {
                    ...frame,
                    ...(decision.length > 0 ? { decision } : {}),
                    ...(anomaly ? { anomaly } : {}),
                  }
                : frame),
              updatedAt: new Date().toISOString(),
            }
          : row)
        await persist()
        return ok({ sessionId, frameId, annotated: true })
      },

      async exportReplay(input) {
        if (context === null) return fail('模块未启动')
        const sessionId = readString(input, 'id')
        const format = readString(input, 'format', 'html')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        if (format === 'json') {
          const content = JSON.stringify(session, null, 2)
          return ok({ filename: `${session.name}.replay.json`, content } as ReplayExport)
        }
        const content = renderHtml(session)
        const dir = dirFor(context.dataDir, sessionId)
        await mkdir(dir, { recursive: true })
        const path = join(dir, `${session.name}.replay.html`)
        await writeFile(path, content)
        return ok({ filename: `${session.name}.replay.html`, content, path } as ReplayExport)
      },

      async stats(input) {
        const sessionId = readString(input, 'id')
        const session = sessions.find(row => row.id === sessionId)
        if (session === undefined) return fail('会话不存在')
        const okFrames = session.frames.filter(frame => frame.ok).length
        const anomalies = session.frames.filter(frame => frame.anomaly !== undefined).length
        return ok({
          id: session.id,
          name: session.name,
          frames: session.frames.length,
          okFrames,
          failedFrames: session.frames.length - okFrames,
          anomalies,
          durationMs: session.durationMs ?? 0,
        })
      },
    },
    methodSpecs: [
      { name: 'startRecording', summary: '开始录制一次任务执行', input: { name: '回放名', taskLabel: '可选关联任务' } },
      { name: 'markFrame', summary: '记录一帧（动作/决策/异常）', input: { sessionId: '会话 id', action: '动作', decision: 'AI 决策理由', anomaly: '异常 JSON', captureScreenshot: '是否抓截图' } },
      { name: 'stopRecording', summary: '结束录制', input: { sessionId: '会话 id' } },
      { name: 'listReplays', summary: '列出回放' },
      { name: 'getReplay', summary: '查看完整回放', input: { id: '会话 id' } },
      { name: 'removeReplay', summary: '删除回放及其截图', input: { id: '会话 id' } },
      { name: 'annotate', summary: '事后补充某帧的决策理由或异常', input: { sessionId: '会话 id', frameId: '帧 id', decision: '决策', anomaly: '异常 JSON' } },
      { name: 'exportReplay', summary: '导出单文件 HTML 或 JSON 回放', input: { id: '会话 id', format: 'html|json' } },
      { name: 'stats', summary: '回放统计', input: { id: '会话 id' } },
    ],
    async start(ctx) {
      context = ctx
      sessions = await ctx.store.get<ReplaySession[]>(SESSIONS_KEY, [])
    },
    async reseat(ctx) {
      context = ctx
      sessions = await ctx.store.get<ReplaySession[]>(SESSIONS_KEY, [])
    },
    async stop() {
      context = null
    },
    async health() {
      return { healthy: true, detail: `已加载 ${sessions.length} 个回放会话` }
    },
  })

  return module
}
