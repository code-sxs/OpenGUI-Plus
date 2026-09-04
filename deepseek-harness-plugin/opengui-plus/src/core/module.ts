/**
 * The OpenGUI-Plus module contract.
 *
 * A module is a self-contained slice of functionality that:
 *   - declares its identity and the API methods it exposes,
 *   - receives a `ModuleContext` on `start`,
 *   - never imports from another module's internals (only from `core/`),
 *   - can be stopped cleanly.
 *
 * The DSH adapter turns `api` into DSH tools; the console server turns `api`
 * into HTTP routes; the CLI turns `api` into subcommands. A module author
 * writes none of that glue.
 *
 * @module core/module
 */

import type { EventBus } from './events.js'
import type { ModuleId, Result } from './types.js'
import type { ScopedStore } from './store.js'
import type { Logger } from './logger.js'
import type { AdbRunner } from './adb-runner.js'

/** Everything a module is allowed to touch from the host. */
export interface ModuleContext {
  /** Project-scoped storage; switches automatically when the user changes project. */
  readonly store: ScopedStore
  /** Global storage, shared by every project. */
  readonly global: ScopedStore
  readonly events: EventBus
  readonly logger: Logger
  /** Currently active project id (`null` before a project is created). */
  readonly projectId: string | null
  /** Absolute data directory, for modules that manage files (screen recordings). */
  readonly dataDir: string
  /** Host capabilities, so modules degrade instead of crashing. */
  readonly capabilities: HostCapabilities
  /** ADB runner, or `null` when adb is unavailable (console-only mode). */
  readonly adb: AdbRunner | null
  /**
   * Call another module: `call('wlan-connection.listDevices')`.
   * Modules stay decoupled because they talk through the registry instead of
   * importing each other's internals.
   */
  readonly call: (target: string, input?: Record<string, unknown>) => Promise<Result<unknown>>
}

/** What the surrounding host can actually do for a module. */
export interface HostCapabilities {
  /** ADB is reachable, so real device operations are possible. */
  readonly adb: boolean
  /** A DSH host loaded this plugin (as opposed to the standalone console). */
  readonly dsh: boolean
  /** Screen recording is available (drives the replay module). */
  readonly screenRecording: boolean
}

/** Shape of one callable method on a module API. */
export type ModuleMethod = (input: Record<string, unknown>) => Promise<unknown>

/** Declarative description of one API method, used by docs, CLI and DSH tools. */
export interface MethodSpec {
  readonly name: string
  readonly summary: string
  /** JSON-schema-ish field notes; documentation only, not enforced at runtime. */
  readonly input?: Readonly<Record<string, string>>
}

export interface ModuleHealth {
  readonly healthy: boolean
  readonly detail?: string
}

export interface PlusModule {
  readonly id: ModuleId
  readonly name: string
  readonly version: string
  readonly summary: string
  /** Modules listed here are started first; missing ones are ignored. */
  readonly dependsOn?: readonly ModuleId[]

  /** Callable surface. Keys become CLI subcommands, HTTP routes and DSH tools. */
  readonly methods: Readonly<Record<string, ModuleMethod>>
  /** Documentation for `methods`; also drives console form generation. */
  readonly methodSpecs?: readonly MethodSpec[]

  start(context: ModuleContext): Promise<void>
  stop(): Promise<void>
  health(): Promise<ModuleHealth>
  /** Re-point the module at a different project without a restart. */
  reseat?(context: ModuleContext): Promise<void>
}

/** Helper so module authors get a compile error instead of a silent mismatch. */
export function defineModule(module: PlusModule): PlusModule {
  return module
}
