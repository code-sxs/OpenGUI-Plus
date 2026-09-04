/**
 * Optional DeepSeek Harness bridge.
 *
 * OpenGUI-Plus never imports DSH at module load time. The DSH packages are
 * release-candidate builds that are not installable from the public registry,
 * so a static import would make the whole plugin unbuildable.
 *
 * Instead we probe with a dynamic `import()` at runtime:
 *   - DSH present  -> every module method is registered as a DSH tool
 *   - DSH absent   -> nothing happens, the standalone console still works
 *
 * The specifier is built from variables on purpose: TypeScript must not try to
 * resolve packages that may not exist on disk.
 *
 * @module dsh/adapter
 */

import type { Logger } from '../core/logger.js'
import type { PlusModule } from '../core/module.js'

/** Shape of the tiny slice of DSH we depend on. */
export interface DshTooling {
  /** Register a tool; signature varies between DSH releases, so we stay permissive. */
  defineTool(spec: unknown): unknown
}

export interface DshBridge {
  readonly defineTool: (spec: unknown) => unknown
  readonly source: string
}

export interface DshRegistrationReport {
  readonly available: boolean
  readonly registered: readonly string[]
  readonly error?: string
}

const TOOLS_SPECIFIER = ['@deepseek-ai', 'dsh-tools'].join('/')

/**
 * Probe for a DSH host.
 * Returns `null` when the packages are missing, which is the normal case for
 * the standalone console.
 */
export async function probeDsh(logger?: Logger): Promise<DshBridge | null> {
  try {
    const loaded = await import(TOOLS_SPECIFIER) as Partial<DshTooling>
    if (typeof loaded.defineTool !== 'function') {
      logger?.debug('DSH 已加载但未提供 defineTool，跳过工具注册')
      return null
    }
    return { defineTool: loaded.defineTool.bind(loaded), source: TOOLS_SPECIFIER }
  }
  catch (error) {
    logger?.debug(`未检测到 DSH 宿主（${error instanceof Error ? error.message : String(error)}），以独立控制台模式运行`)
    return null
  }
}

/**
 * Turn every module method into a DSH tool named
 * `opengui_plus_<module>_<method>`.
 *
 * Method names are snake-cased because tool names are what the model sees in
 * its function list, and `snippet-library.resolve` is not a legal identifier.
 */
export function dshToolName(moduleId: string, method: string): string {
  const slug = (value: string): string => value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  return `opengui_plus_${slug(moduleId)}_${slug(method)}`
}

/** Register all module methods with a probe result. */
export async function registerWithDsh(
  modules: readonly PlusModule[],
  dispatch: (target: string, input: Record<string, unknown>) => Promise<unknown>,
  logger?: Logger,
): Promise<DshRegistrationReport> {
  const bridge = await probeDsh(logger)
  if (bridge === null) return { available: false, registered: [] }

  const registered: string[] = []
  for (const module of modules) {
    for (const [method, fn] of Object.entries(module.methods)) {
      const name = dshToolName(module.id, method)
      const spec = module.methodSpecs?.find(candidate => candidate.name === method)
      try {
        bridge.defineTool({
          name,
          description: `[OpenGUI-Plus/${module.name}] ${spec?.summary ?? method}`,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(spec?.input ?? {}).map(([key, hint]) => [key, { type: 'string', description: hint }]),
            ),
          },
          execute: async (input: Record<string, unknown> = {}) => {
            const result = await dispatch(`${module.id}.${method}`, input ?? {})
            return typeof result === 'string' ? result : JSON.stringify(result)
          },
          // Keep the escape hatch: models can also call the raw method.
          aliases: [`${module.id}.${method}`],
        })
        registered.push(name)
      }
      catch (error) {
        logger?.warn(`注册 DSH 工具 ${name} 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  logger?.info(`已向 DSH 注册 ${registered.length} 个工具`)
  return { available: true, registered }
}

/** Convenience used by the plugin entry point. */
export function isDshContext(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '$' in value === false && 'effect' in value
}
