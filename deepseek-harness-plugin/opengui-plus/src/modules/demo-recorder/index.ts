/**
 * Module 6 — AI task demonstration recording.
 *
 * The idea: a human performs a phone task once, the recorder turns the
 * performance into a parameterised workflow, and later corrections ("修正示范")
 * are applied as revisions instead of re-recording everything.
 *
 * Recording is deliberately loss-tolerant. A step is always appended, even
 * when adb is missing or the screenshot fails; only the `screenState` block is
 * left empty. Losing page context is annoying, losing the action sequence is
 * fatal, so the two failure modes are not treated the same.
 *
 * @module modules/demo-recorder
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import { fail } from '../../core/types.js'

import { adbScreenshot, probeScreenState, type ScreenshotCapture } from './capture.js'
import type { DemoRecording, DemoScreenState, DemoStep, DemoTemplate, DemoVariable } from './types.js'
import { extractVariables, mergeVariables, normaliseSteps } from './variables.js'

const STORE_KEY = 'demo-recordings'
/** Where screenshots live, relative to `context.dataDir`. */
const SCREENSHOT_ROOT = 'demo-screenshots'

export interface DemoRecorderOptions {
  /** Injectable PNG capture; tests replace it instead of spawning adb. */
  readonly capture?: ScreenshotCapture
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Build the module. Exported as a factory so tests can inject a fake capture. */
export function createDemoRecorderModule(options: DemoRecorderOptions = {}): PlusModule {
  let context: ModuleContext | null = null
  let recordings: DemoRecording[] = []
  const capture = options.capture ?? adbScreenshot

  async function persist(): Promise<void> {
    if (context === null) return
    await context.store.set(STORE_KEY, recordings)
  }

  function find(id: string): DemoRecording | undefined {
    return recordings.find(recording => recording.id === id)
  }

  function replace(next: DemoRecording): DemoRecording {
    recordings = recordings.map(recording => (recording.id === next.id ? next : recording))
    return next
  }

  /** Write the PNG under `<dataDir>/demo-screenshots/<recordingId>/` and return its relative path. */
  async function saveScreenshot(recordingId: string, stepId: string, png: Buffer): Promise<string | undefined> {
    if (context === null) return undefined
    const relativePath = `${SCREENSHOT_ROOT}/${recordingId}/${stepId}.png`
    try {
      const target = join(context.dataDir, SCREENSHOT_ROOT, recordingId, `${stepId}.png`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, png)
      return relativePath
    }
    catch (error) {
      context.logger.warn(`截图保存失败: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Read page state from adb, plus a screenshot; every part is optional. */
  async function readScreenState(recordingId: string, stepId: string): Promise<DemoScreenState | undefined> {
    const runner = context?.adb ?? null
    if (runner === null) return undefined
    const state: DemoScreenState = await probeScreenState(runner, { withText: true })
    const png = await capture(runner)
    if (png !== null) {
      const screenshotPath = await saveScreenshot(recordingId, stepId, png)
      if (screenshotPath !== undefined) state.screenshotPath = screenshotPath
    }
    return Object.keys(state).length > 0 ? state : undefined
  }

  const module = defineModule({
    id: 'demo-recorder',
    name: 'AI 任务演示录制',
    version: '0.1.0',
    summary: '录制一次人工示范，自动记录操作序列与页面状态，生成可复用模板并支持"修正示范"迭代。',

    methods: {
      async startDemo(input) {
        const name = readString(input, 'name')
        if (name === undefined) return fail('startDemo needs "name"')
        const now = new Date().toISOString()
        const recording: DemoRecording = {
          id: createId('demo'),
          name,
          steps: [],
          variables: [],
          status: 'recording',
          revision: 0,
          revisionHistory: [],
          createdAt: now,
          updatedAt: now,
          ...(readString(input, 'description') === undefined
            ? {}
            : { description: readString(input, 'description')! }),
        }
        recordings = [...recordings, recording]
        await persist()
        return { recordingId: recording.id, name: recording.name, status: recording.status }
      },

      /**
       * Append one step. `captureScreen` asks for a screenshot plus page dump;
       * without adb the step is still recorded, just with no `screenState`.
       */
      async captureStep(input) {
        const id = readString(input, 'recordingId')
        if (id === undefined) return fail('captureStep needs "recordingId"')
        const current = find(id)
        if (current === undefined) return fail(`unknown recording "${id}"`)
        const action = readString(input, 'action')
        if (action === undefined) return fail('captureStep needs "action"')

        const params: Record<string, string | number> = {}
        if (isRecord(input.params)) {
          for (const [key, value] of Object.entries(input.params)) {
            if (typeof value === 'string' || typeof value === 'number') params[key] = value
          }
        }

        const stepId = createId('stp')
        const captureScreen = input.captureScreen !== false
        const screenState = captureScreen
          ? await readScreenState(id, stepId)
          : undefined

        const step: DemoStep = {
          id: stepId,
          at: new Date().toISOString(),
          action,
          params,
          ...(screenState === undefined ? {} : { screenState }),
          ...(readString(input, 'note') === undefined ? {} : { note: readString(input, 'note')! }),
        }

        const variables = mergeVariables(current.variables, extractVariables([...current.steps, step]))
        replace({ ...current, steps: [...current.steps, step], variables, updatedAt: step.at })
        await persist()
        return { step, variables, total: current.steps.length + 1 }
      },

      async stopDemo(input) {
        const id = readString(input, 'recordingId')
        if (id === undefined) return fail('stopDemo needs "recordingId"')
        const current = find(id)
        if (current === undefined) return fail(`unknown recording "${id}"`)
        const next: DemoRecording = {
          ...current,
          status: current.status === 'revised' ? 'revised' : 'ready',
          updatedAt: new Date().toISOString(),
        }
        replace(next)
        await persist()
        context?.events.publish('demo-recorder', PLUS_EVENTS.recordingFinished, {
          recordingId: next.id,
          name: next.name,
          steps: next.steps.length,
        })
        return next
      },

      async listDemos() {
        return { recordings, total: recordings.length }
      },

      async getDemo(input) {
        const id = readString(input, 'id') ?? readString(input, 'recordingId')
        if (id === undefined) return fail('getDemo needs "id"')
        const current = find(id)
        return current === undefined ? fail(`unknown recording "${id}"`) : current
      },

      async removeDemo(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('removeDemo needs "id"')
        const before = recordings.length
        recordings = recordings.filter(recording => recording.id !== id)
        if (recordings.length === before) return fail(`unknown recording "${id}"`)
        await persist()
        return { removed: id, total: recordings.length }
      },

      /**
       * 修正示范: replace the step list wholesale and bump the revision.
       * Input is validated first — an invalid step list must not touch the
       * stored recording, or the user loses the version they were correcting.
       */
      async revise(input) {
        const id = readString(input, 'id') ?? readString(input, 'recordingId')
        if (id === undefined) return fail('revise needs "id"')
        const current = find(id)
        if (current === undefined) return fail(`unknown recording "${id}"`)

        let steps = current.steps
        if (input.steps !== undefined) {
          const parsed = normaliseSteps(input.steps)
          if (!parsed.ok) return parsed
          steps = parsed.value
        }
        const note = readString(input, 'note') ?? '修正示范'
        const revision = current.revision + 1
        const at = new Date().toISOString()
        const next: DemoRecording = {
          ...current,
          steps,
          variables: mergeVariables(current.variables, extractVariables(steps)),
          status: 'revised',
          revision,
          revisionHistory: [...current.revisionHistory, { at, note, revision }],
          updatedAt: at,
        }
        replace(next)
        await persist()
        return next
      },

      /**
       * Turn a recording into a workflow template.
       *
       * The preferred path hands it to `action-template`; when that module is
       * absent (it ships separately) the caller gets the standard JSON back
       * with `persisted: false` so the UI can offer a file download instead.
       */
      async toTemplate(input) {
        const id = readString(input, 'id') ?? readString(input, 'recordingId')
        if (id === undefined) return fail('toTemplate needs "id"')
        const current = find(id)
        if (current === undefined) return fail(`unknown recording "${id}"`)
        const template = buildTemplate(current)
        if (context === null) {
          return { persisted: false, reason: '模块尚未启动', template }
        }
        try {
          const result = await context.call('action-template.save-from-demo', { template })
          if (result.ok) return { persisted: true, template, result: result.value }
          return { persisted: false, reason: result.error, template }
        }
        catch (error) {
          return {
            persisted: false,
            reason: `action-template 不可用: ${error instanceof Error ? error.message : String(error)}`,
            template,
          }
        }
      },
    },

    methodSpecs: [
      { name: 'startDemo', summary: '开始一次演示录制', input: { name: '录制名称', description: '可选说明' } },
      { name: 'captureStep', summary: '记录一个操作步骤', input: { recordingId: '录制 id', action: '动作，如 tap / input / launch', params: '动作参数，值中可写 {{变量}}', note: '补充说明', captureScreen: '是否截图，默认 true' } },
      { name: 'stopDemo', summary: '结束录制并标记为 ready', input: { recordingId: '录制 id' } },
      { name: 'listDemos', summary: '列出全部录制' },
      { name: 'getDemo', summary: '查看单个录制', input: { id: '录制 id' } },
      { name: 'removeDemo', summary: '删除录制', input: { id: '录制 id' } },
      { name: 'revise', summary: '修正示范：全量替换步骤并升级修订号', input: { id: '录制 id', steps: '修正后的步骤数组', note: '修订说明' } },
      { name: 'toTemplate', summary: '导出为工作流模板并尝试写入动作模板模块', input: { id: '录制 id' } },
    ],

    async start(ctx) {
      context = ctx
      const stored = await ctx.store.get(STORE_KEY, [] as readonly DemoRecording[])
      recordings = Array.isArray(stored)
        ? stored.filter(isRecord).map(normaliseRecording).filter((row): row is DemoRecording => row !== null)
        : []
    },

    async reseat(ctx) {
      context = ctx
      const stored = await ctx.store.get(STORE_KEY, [] as readonly DemoRecording[])
      recordings = Array.isArray(stored)
        ? stored.filter(isRecord).map(normaliseRecording).filter((row): row is DemoRecording => row !== null)
        : []
    },

    async stop() {
      context = null
    },

    async health() {
      const adb = context?.adb ?? null
      return {
        healthy: true,
        detail: adb === null
          ? `已加载 ${recordings.length} 条录制；adb 不可用，截图将留空`
          : `已加载 ${recordings.length} 条录制；adb: ${adb.binary}`,
      }
    },
  })

  return module
}

/** Coerce a stored JSON row into a DemoRecording, dropping malformed entries. */
function normaliseRecording(row: Record<string, unknown>): DemoRecording | null {
  const id = readString(row, 'id')
  if (id === undefined) return null
  const steps = Array.isArray(row.steps)
    ? row.steps.filter(isRecord).map((step) => {
      const action = readString(step, 'action')
      if (action === undefined) return null
      const params: Record<string, string | number> = {}
      if (isRecord(step.params)) {
        for (const [key, value] of Object.entries(step.params)) {
          if (typeof value === 'string' || typeof value === 'number') params[key] = value
        }
      }
      const screenState = isRecord(step.screenState) ? step.screenState : undefined
      return {
        id: readString(step, 'id') ?? createId('stp'),
        at: readString(step, 'at') ?? new Date(0).toISOString(),
        action,
        params,
        ...(screenState === undefined
          ? {}
          : {
            screenState: {
              ...(readString(screenState, 'activity') === undefined ? {} : { activity: readString(screenState, 'activity')! }),
              ...(readString(screenState, 'packageName') === undefined ? {} : { packageName: readString(screenState, 'packageName')! }),
              ...(readString(screenState, 'screenshotPath') === undefined ? {} : { screenshotPath: readString(screenState, 'screenshotPath')! }),
              ...(readString(screenState, 'textSummary') === undefined ? {} : { textSummary: readString(screenState, 'textSummary')! }),
            },
          }),
        ...(readString(step, 'note') === undefined ? {} : { note: readString(step, 'note')! }),
      } satisfies DemoStep
    }).filter((step): step is DemoStep => step !== null)
    : []

  const variables: DemoVariable[] = []
  if (Array.isArray(row.variables)) {
    for (const variable of row.variables) {
      if (!isRecord(variable)) continue
      const name = readString(variable, 'name')
      if (name === undefined) continue
      variables.push({
        name,
        label: readString(variable, 'label') ?? name,
        required: variable.required !== false,
        ...(readString(variable, 'defaultValue') === undefined
          ? {}
          : { defaultValue: readString(variable, 'defaultValue')! }),
      })
    }
  }

  const status = row.status
  return {
    id,
    name: readString(row, 'name') ?? id,
    steps,
    variables,
    status: status === 'recording' || status === 'revised' ? status : 'ready',
    revision: typeof row.revision === 'number' && Number.isInteger(row.revision) ? row.revision : 0,
    revisionHistory: Array.isArray(row.revisionHistory)
      ? row.revisionHistory.filter(isRecord).map(entry => ({
        at: readString(entry, 'at') ?? new Date(0).toISOString(),
        note: readString(entry, 'note') ?? '',
        revision: typeof entry.revision === 'number' ? entry.revision : 0,
      }))
      : [],
    createdAt: readString(row, 'createdAt') ?? new Date(0).toISOString(),
    updatedAt: readString(row, 'updatedAt') ?? new Date(0).toISOString(),
    ...(readString(row, 'description') === undefined ? {} : { description: readString(row, 'description')! }),
  }
}

/** Project a recording onto the standard workflow template document. */
export function buildTemplate(recording: DemoRecording): DemoTemplate {
  return {
    formatVersion: 1,
    id: recording.id,
    name: recording.name,
    description: recording.description ?? `由演示录制「${recording.name}」生成`,
    category: 'other',
    author: 'demo-recorder',
    version: `1.${recording.revision}`,
    tags: ['demo-recorder', ...recording.variables.map(variable => variable.name)],
    taskIntent: recording.description ?? recording.name,
    preconditions: [],
    steps: recording.steps.map(step => ({
      id: step.id,
      action: step.action,
      params: step.params,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
    parameters: recording.variables.map(variable => ({
      name: variable.name,
      label: variable.label,
      description: `演示录制抽取的变量「${variable.label}」`,
      required: variable.required,
      ...(variable.defaultValue === undefined ? {} : { defaultValue: variable.defaultValue }),
    })),
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
  }
}

export { extractVariables, mergeVariables, normaliseSteps } from './variables.js'
export { extractUiText, parseFocusedWindow } from './capture.js'
export type { DemoRecording, DemoScreenState, DemoStep, DemoTemplate, DemoVariable } from './types.js'
export type { ScreenshotCapture } from './capture.js'
