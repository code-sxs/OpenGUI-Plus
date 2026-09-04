/**
 * OpenGUI-Plus plugin entry point.
 *
 * Two host shapes are supported:
 *
 *   1. **DeepSeek Harness / Codex** — call {@link apply}. It builds a
 *      {@link PlusHost}, registers every module method as a DSH tool, and
 *      resolves when startup finishes. Missing DSH packages degrade to a
 *      no-op registration instead of a crash.
 *
 *   2. **Standalone** — call {@link PlusHost.create} (or run the CLI) to get
 *      the same modules with an HTTP console on top.
 *
 * Nothing in this file touches the upstream OpenGUI plugin. OpenGUI-Plus is a
 * sibling package that imports zero upstream code.
 *
 * @module dsh-opengui-plus
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { createAdbRunner } from './core/adb-runner.js'
import { Logger, silentLogger } from './core/logger.js'
import type { PlusModule } from './core/module.js'
import type { Result } from './core/types.js'
import { registerWithDsh, type DshRegistrationReport } from './dsh/adapter.js'
import { DEFAULT_PROJECT_ID, PlusHost, defaultModules } from './host.js'

export { PlusHost, defaultModules, DEFAULT_PROJECT_ID } from './host.js'
export type { ProjectBundle } from './host.js'
export { ModuleRegistry } from './core/registry.js'
export { EventBus, PLUS_EVENTS } from './core/events.js'
export { createStore, PlusStore } from './core/store.js'
export { Logger, silentLogger } from './core/logger.js'
export { createAdbRunner, createFakeAdbRunner } from './core/adb-runner.js'
export type { AdbRunner, FakeAdbRunner } from './core/adb-runner.js'
export { defineModule } from './core/module.js'
export type { ModuleContext, PlusModule, HostCapabilities } from './core/module.js'
export { ok, fail, attempt, attemptAsync } from './core/types.js'
export type { Result, Iso8601, ModuleId } from './core/types.js'
export { registerWithDsh, dshToolName, probeDsh } from './dsh/adapter.js'
export { startConsoleServer } from './runtime/server.js'
export { runCli, parseArgs } from './runtime/cli.js'
export { createWirelessConnectionModule } from './modules/wlan-connection/index.js'
export { createSnippetLibraryModule } from './modules/snippet-library/index.js'
export { createActionTemplateModule } from './modules/action-template/index.js'
export { createSchedulerModule } from './modules/scheduler/index.js'
export { createProjectGroupModule } from './modules/project-group/index.js'
export { createDemoRecorderModule } from './modules/demo-recorder/index.js'
export { createWorkflowMarketplaceModule } from './modules/workflow-marketplace/index.js'
export { createFeedbackRlModule } from './modules/feedback-rl/index.js'
export { createDevicePoolModule } from './modules/device-pool/index.js'
export { createReplayModule } from './modules/replay/index.js'

export interface PlusPluginOptions {
  /** Override the data directory; defaults to `~/.opengui-plus`. */
  readonly dataDir?: string
  readonly logger?: Logger
  /** Skip ADB entirely (useful in CI or documentation builds). */
  readonly withoutAdb?: boolean
}

function defaultDataDir(): string {
  return resolve(process.env.OPENGUI_PLUS_DATA_DIR ?? join(homedir(), '.opengui-plus'))
}

/**
 * Build a host with the ten modules, without starting a console.
 * This is what tests and embedding hosts want.
 */
export async function createPlus(options: PlusPluginOptions = {}): Promise<PlusHost> {
  return PlusHost.create({
    dataDir: options.dataDir ?? defaultDataDir(),
    logger: options.logger ?? silentLogger(),
    adb: options.withoutAdb === true ? null : createAdbRunner(),
    capabilities: { dsh: false },
  })
}

/**
 * DSH / Codex plugin entry point.
 *
 * The parameter is intentionally `unknown`: OpenGUI-Plus cannot depend on
 * `@deepseek-ai/cordis` types because that package is not installable from the
 * public registry. We only read the pieces we need.
 */
export async function apply(
  _context: unknown = {},
  options: PlusPluginOptions = {},
): Promise<{ readonly host: PlusHost, readonly dsh: DshRegistrationReport }> {
  const logger = options.logger ?? new Logger('info')
  const host = await PlusHost.create({
    dataDir: options.dataDir ?? defaultDataDir(),
    logger,
    adb: options.withoutAdb === true ? null : createAdbRunner(),
    capabilities: { dsh: true },
  })

  const dispatch = async (target: string, input: Record<string, unknown>): Promise<unknown> => {
    const result: Result<unknown> = await host.call(target, input)
    return result.ok ? result.value : { error: result.error }
  }

  const dsh = await registerWithDsh(host.registry.list(), dispatch, logger)
  return { host, dsh }
}

/** Alias for hosts that look for a default export. */
export default { apply, createPlus, defaultModules, PlusHost }

/** Re-exported for hosts that want to enumerate modules before booting. */
export function listModuleFactories(): readonly (() => PlusModule)[] {
  return defaultModules().map(module => () => module)
}
