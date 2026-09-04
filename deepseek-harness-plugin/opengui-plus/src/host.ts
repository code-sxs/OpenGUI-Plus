/**
 * PlusHost — the object that wires everything together.
 *
 * Responsibilities:
 *   - own the data directory, event bus, logger and module registry
 *   - hand every module a `ModuleContext` bound to the active project
 *   - react to project switches by re-seating every started module
 *   - expose the internal `__host__` module (project copy / export / import)
 *
 * The host deliberately knows nothing about what any individual module does.
 * That is what keeps OpenGUI-Plus decoupled from the upstream plugin.
 *
 * @module host
 */

import { cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createAdbRunner, type AdbRunner } from './core/adb-runner.js'
import { EventBus, PLUS_EVENTS } from './core/events.js'
import { Logger, silentLogger } from './core/logger.js'
import { defineModule, type HostCapabilities, type ModuleContext, type PlusModule } from './core/module.js'
import { ModuleRegistry } from './core/registry.js'
import { PlusStore } from './core/store.js'
import { fail, ok, type Result } from './core/types.js'
import { createWirelessConnectionModule } from './modules/wlan-connection/index.js'
import { createSnippetLibraryModule } from './modules/snippet-library/index.js'
import { createActionTemplateModule } from './modules/action-template/index.js'
import { createSchedulerModule } from './modules/scheduler/index.js'
import { createProjectGroupModule } from './modules/project-group/index.js'
import { createDemoRecorderModule } from './modules/demo-recorder/index.js'
import { createWorkflowMarketplaceModule } from './modules/workflow-marketplace/index.js'
import { createFeedbackRlModule } from './modules/feedback-rl/index.js'
import { createDevicePoolModule } from './modules/device-pool/index.js'
import { createReplayModule } from './modules/replay/index.js'

export const DEFAULT_PROJECT_ID = 'default'

/** Serialised form of one project, produced by `export` and consumed by `import`. */
export interface ProjectBundle {
  readonly format: 'opengui-plus-project'
  readonly version: 1
  readonly exportedAt: string
  readonly project: {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly deviceIds?: readonly string[]
    readonly tags?: readonly string[]
  }
  /** Raw per-module documents, keyed by the storage key each module uses. */
  readonly data: Readonly<Record<string, unknown>>
}

export interface PlusHostOptions {
  /** Directory for all persisted state; created on demand. */
  readonly dataDir: string
  /** Inject a fake runner in tests; omit to use the real adb binary. */
  readonly adb?: AdbRunner | null
  readonly logger?: Logger
  readonly capabilities?: Partial<HostCapabilities>
  /** Start the scheduler interval immediately; default true. */
  readonly autoStart?: boolean
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Owns the module registry and project lifecycle.
 *
 * Use {@link PlusHost.create} rather than the constructor: startup loads the
 * persisted active project before any module sees a context.
 */
export class PlusHost {
  readonly store: PlusStore
  readonly registry: ModuleRegistry
  readonly events: EventBus
  readonly logger: Logger
  readonly dataDir: string

  private readonly adbRunner: AdbRunner | null
  private readonly capabilities: HostCapabilities
  private currentProjectId: string
  private started = false

  private constructor(options: PlusHostOptions) {
    this.dataDir = options.dataDir
    this.store = new PlusStore(options.dataDir)
    this.events = new EventBus()
    this.logger = options.logger ?? silentLogger()
    this.adbRunner = options.adb === undefined ? createAdbRunner() : options.adb
    this.capabilities = {
      adb: this.adbRunner !== null && (options.capabilities?.adb ?? true),
      dsh: options.capabilities?.dsh ?? false,
      screenRecording: options.capabilities?.screenRecording ?? this.adbRunner !== null,
    }
    this.currentProjectId = DEFAULT_PROJECT_ID
    this.registry = new ModuleRegistry()
  }

  /** Build a host, register the ten modules, and start them. */
  static async create(options: PlusHostOptions): Promise<PlusHost> {
    const host = new PlusHost(options)
    for (const module of defaultModules()) host.registry.register(module)
    host.registry.register(host.createInternalModule())
    await host.start()
    return host
  }

  get activeProjectId(): string {
    return this.currentProjectId
  }

  async start(): Promise<void> {
    if (this.started) return
    const stored = await this.store.global().get<string>('current-project', DEFAULT_PROJECT_ID)
    if (typeof stored === 'string' && stored.length > 0) this.currentProjectId = stored
    await this.registry.startAll(() => this.context())
    this.events.onAny(PLUS_EVENTS.projectSwitched, (payload) => {
      if (!isJsonRecord(payload)) return
      const projectId = payload.projectId
      if (typeof projectId !== 'string' || projectId === this.currentProjectId) return
      void this.applyProjectSwitch(projectId)
    })
    await this.drainPendingCleanup()
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.registry.stopAll()
    await this.store.flush()
    this.started = false
  }

  /** Switch the active project and re-seat every module. */
  async switchProject(projectId: string): Promise<Result<string>> {
    if (projectId === this.currentProjectId) return ok(projectId)
    return this.applyProjectSwitch(projectId)
  }

  async call(target: string, input: Record<string, unknown> = {}): Promise<Result<unknown>> {
    return this.registry.call(target, input)
  }

  async status(): Promise<{
    readonly dataDir: string
    readonly activeProjectId: string
    readonly capabilities: HostCapabilities
    readonly adb: string | null
    readonly modules: readonly Awaited<ReturnType<ModuleRegistry['status']>>[number][]
    readonly recentEvents: readonly unknown[]
  }> {
    return {
      dataDir: this.dataDir,
      activeProjectId: this.currentProjectId,
      capabilities: this.capabilities,
      adb: this.adbRunner?.binary ?? null,
      modules: await this.registry.status(),
      recentEvents: this.events.recent(30),
    }
  }

  private async applyProjectSwitch(projectId: string): Promise<Result<string>> {
    try {
      this.currentProjectId = projectId
      await this.registry.reseatAll(() => this.context())
      await this.store.global().set('current-project', projectId)
      await this.drainPendingCleanup()
      this.logger.info(`已切换到项目组 ${projectId}`)
      return ok(projectId)
    }
    catch (error) {
      return fail(`切换项目组失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Remove data directories queued by `project-group.remove`. */
  private async drainPendingCleanup(): Promise<void> {
    const pending = await this.store.global().get<string[]>('pending-project-cleanup', [])
    if (!Array.isArray(pending) || pending.length === 0) return
    const remaining: string[] = []
    for (const id of pending) {
      if (typeof id !== 'string' || id === this.currentProjectId) continue
      try {
        await this.store.deleteProject(id)
      }
      catch (error) {
        this.logger.warn(`清理项目 ${id} 失败: ${error instanceof Error ? error.message : String(error)}`)
        remaining.push(id)
      }
    }
    await this.store.global().set('pending-project-cleanup', remaining)
  }

  private context(): ModuleContext {
    return {
      store: this.store.project(this.currentProjectId),
      global: this.store.global(),
      events: this.events,
      logger: this.logger.child(this.currentProjectId),
      projectId: this.currentProjectId,
      dataDir: this.dataDir,
      capabilities: this.capabilities,
      adb: this.adbRunner,
      call: (target, input) => this.registry.call(target, input ?? {}),
    }
  }

  /**
   * Internal module exposed to other modules as `__host__`.
   * It exists so project copy/export/import can touch the data directory
   * without any feature module importing filesystem internals.
   */
  private createInternalModule(): PlusModule {
    const host = this
    return defineModule({
      id: '__host__',
      name: '宿主内部服务',
      version: '0.1.0',
      summary: '项目组的复制、导出与导入（内部模块，供 project-group 调用）',
      methods: {
        async copyProject(input) {
          const from = typeof input.from === 'string' ? input.from : undefined
          const to = typeof input.to === 'string' ? input.to : undefined
          if (from === undefined || to === undefined) return fail('copyProject needs "from" and "to"')
          const source = join(host.dataDir, 'projects', from)
          const target = join(host.dataDir, 'projects', to)
          if (!existsSync(source)) return fail(`源项目 "${from}" 没有数据，无可复制内容`)
          await cp(source, target, { recursive: true })
          return { copied: true, from, to }
        },

        async exportProject(input) {
          const id = typeof input.id === 'string' ? input.id : undefined
          if (id === undefined) return fail('exportProject needs "id"')
          const scope = host.store.project(id)
          const keys = await scope.keys()
          const data: Record<string, unknown> = {}
          for (const key of keys) data[key] = await scope.get(key, null)
          const groups = await host.store.global().get<readonly Record<string, unknown>[]>('projects', [])
          const project = (Array.isArray(groups) ? groups : []).find(row => isJsonRecord(row) && row.id === id)
          const bundle: ProjectBundle = {
            format: 'opengui-plus-project',
            version: 1,
            exportedAt: new Date().toISOString(),
            project: {
              id,
              name: (isJsonRecord(project) && typeof project.name === 'string') ? project.name : id,
              ...(isJsonRecord(project) && typeof project.description === 'string' ? { description: project.description } : {}),
              ...(isJsonRecord(project) && Array.isArray(project.deviceIds) ? { deviceIds: project.deviceIds as readonly string[] } : {}),
              ...(isJsonRecord(project) && Array.isArray(project.tags) ? { tags: project.tags as readonly string[] } : {}),
            },
            data,
          }
          return bundle
        },

        async importProject(input) {
          const payload = input.payload
          if (!isJsonRecord(payload)) return fail('importProject needs a bundle object')
          if (payload.format !== 'opengui-plus-project') return fail('不是有效的 OpenGUI-Plus 项目包')
          const project = isJsonRecord(payload.project) ? payload.project : undefined
          if (project === undefined || typeof project.id !== 'string') return fail('项目包缺少 project.id')
          const data = isJsonRecord(payload.data) ? payload.data : {}
          const requestedName = typeof input.name === 'string' && input.name.length > 0 ? input.name : undefined
          const newId = typeof input.newId === 'string' && input.newId.length > 0
            ? input.newId
            : `${project.id}-${Date.now().toString(36)}`
          const scope = host.store.project(newId)
          for (const [key, value] of Object.entries(data)) await scope.set(key, value)
          const name = requestedName
            ?? (typeof project.name === 'string' ? project.name : newId)
          return {
            project: {
              id: newId,
              name,
              ...(typeof project.description === 'string' ? { description: project.description } : {}),
              deviceIds: Array.isArray(project.deviceIds) ? project.deviceIds : [],
              tags: Array.isArray(project.tags) ? project.tags : [],
            },
          }
        },
      },
      methodSpecs: [
        { name: 'copyProject', summary: '复制项目数据目录', input: { from: '源项目 id', to: '目标项目 id' } },
        { name: 'exportProject', summary: '导出项目为可分享数据包', input: { id: '项目 id' } },
        { name: 'importProject', summary: '导入项目包', input: { payload: '项目包对象', name: '可选新名称' } },
      ],
      async start() {},
      async stop() {},
      async health() {
        return { healthy: true, detail: '宿主服务就绪' }
      },
    })
  }
}

/** The ten feature modules, in dependency order (the registry re-sorts anyway). */
export function defaultModules(): readonly PlusModule[] {
  return [
    createWirelessConnectionModule(),
    createSnippetLibraryModule(),
    createActionTemplateModule(),
    createSchedulerModule(),
    createProjectGroupModule(),
    createDemoRecorderModule(),
    createWorkflowMarketplaceModule(),
    createFeedbackRlModule(),
    createDevicePoolModule(),
    createReplayModule(),
  ]
}

/** Remove a project's data directory directly; used by tests and the CLI. */
export async function purgeProject(dataDir: string, projectId: string): Promise<void> {
  await rm(join(dataDir, 'projects', projectId), { recursive: true, force: true })
}
