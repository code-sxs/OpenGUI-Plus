/**
 * Module registry: registration, dependency-ordered startup, project re-seating.
 *
 * When the user switches project group, `reseat` hands every module a fresh
 * `ModuleContext` pointing at the new project's storage. Modules keep their
 * in-memory caches of global data (device pool, marketplace index) and only
 * reload project-specific state.
 *
 * @module core/registry
 */

import type { ModuleContext, ModuleHealth, PlusModule } from './module.js'
import type { ModuleId } from './types.js'
import { fail, ok, type Result } from './types.js'

export interface RegistryStatus {
  readonly id: ModuleId
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly started: boolean
  readonly methods: readonly string[]
  readonly methodSpecs: readonly { readonly name: string, readonly summary: string }[]
  readonly health: ModuleHealth
}

export class ModuleRegistry {
  private readonly modules = new Map<ModuleId, PlusModule>()
  private readonly started = new Set<ModuleId>()
  private contextFactory: (() => ModuleContext) | null = null

  register(module: PlusModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`opengui-plus: module "${module.id}" is already registered`)
    }
    this.modules.set(module.id, module)
  }

  /** Topological start; missing optional dependencies are skipped quietly. */
  async startAll(factory: () => ModuleContext): Promise<void> {
    this.contextFactory = factory
    for (const id of this.order()) {
      const module = this.modules.get(id)!
      if (this.started.has(id)) continue
      await module.start(factory())
      this.started.add(id)
    }
  }

  /** Point every started module at a new project. */
  async reseatAll(factory: () => ModuleContext): Promise<void> {
    this.contextFactory = factory
    for (const id of this.order()) {
      if (!this.started.has(id)) continue
      const module = this.modules.get(id)!
      await module.reseat?.(factory())
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.order()].reverse()) {
      if (!this.started.has(id)) continue
      const module = this.modules.get(id)!
      await module.stop()
      this.started.delete(id)
    }
  }

  get(id: ModuleId): PlusModule | undefined {
    return this.modules.get(id)
  }

  list(): readonly PlusModule[] {
    return this.order().map(id => this.modules.get(id)!)
  }

  /** Dispatch a call by `module.method`; the CLI, HTTP and DSH layers share this. */
  async call(target: string, input: Record<string, unknown> = {}): Promise<Result<unknown>> {
    const dot = target.indexOf('.')
    if (dot <= 0) return fail(`opengui-plus: expected "module.method", received "${target}"`)
    const id = target.slice(0, dot) as ModuleId
    const method = target.slice(dot + 1)
    const module = this.modules.get(id)
    if (module === undefined) return fail(`opengui-plus: unknown module "${id}"`)
    if (!this.started.has(id)) return fail(`opengui-plus: module "${id}" is not started`)
    const fn = module.methods[method]
    if (fn === undefined) return fail(`opengui-plus: module "${id}" has no method "${method}"`)
    try {
      return ok(await fn(input))
    }
    catch (error) {
      return fail(`${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async status(): Promise<readonly RegistryStatus[]> {
    const out: RegistryStatus[] = []
    for (const module of this.list()) {
      const started = this.started.has(module.id)
      out.push({
        id: module.id,
        name: module.name,
        version: module.version,
        summary: module.summary,
        started,
        methods: Object.keys(module.methods),
        methodSpecs: (module.methodSpecs ?? []).map(spec => ({
          name: spec.name,
          summary: spec.summary,
        })),
        health: started ? await module.health() : { healthy: false, detail: 'not started' },
      })
    }
    return out
  }

  private order(): readonly ModuleId[] {
    const seen = new Set<ModuleId>()
    const out: ModuleId[] = []
    const visit = (id: ModuleId, trail: Set<ModuleId>): void => {
      if (seen.has(id)) return
      if (trail.has(id)) {
        throw new Error(`opengui-plus: circular module dependency at "${id}"`)
      }
      const module = this.modules.get(id)
      if (module === undefined) return
      trail.add(id)
      for (const dependency of module.dependsOn ?? []) visit(dependency, trail)
      trail.delete(id)
      seen.add(id)
      out.push(id)
    }
    for (const id of this.modules.keys()) visit(id, new Set())
    return out
  }
}
