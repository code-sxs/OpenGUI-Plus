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
 * `defineTool` has changed shape between DSH releases, so the spec is built
 * after a one-shot dialect probe rather than hard-coded:
 *
 *   modern (dsh-tools >= rc.6, including rc.8)
 *     parameters  per-property map of value schemas  (NOT a JSON-Schema object)
 *     output      { schema, render(args, value) -> ContentBlock[] } — mandatory
 *     execute     returns the canonical value declared by output.schema
 *
 *   legacy
 *     parameters  JSON-Schema object `{ type: 'object', properties }`
 *     execute     returns a string
 *
 * Probing matters because the modern path throws on a legacy spec
 * ("parameters.type must be a value schema object") and reads
 * `options.output.render` unconditionally — which silently registered zero
 * tools when we shipped a spec without `output`.
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

export type DshDialect = 'modern' | 'legacy'

export interface DshRegistrationReport {
  readonly available: boolean
  readonly registered: readonly string[]
  readonly failed?: readonly { readonly name: string, readonly error: string }[]
  readonly dialect?: DshDialect
  readonly error?: string
}

const TOOLS_SPECIFIER = ['@deepseek-ai', 'dsh-tools'].join('/')

/** Never surfaced to users; `defineTool` only compiles, it does not register. */
const PROBE_TOOL_NAME = 'opengui_plus_dialect_probe'

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
 * Camel-case boundaries are split too, so `listReplays` becomes `list_replays`
 * rather than `listreplays`.
 */
export function dshToolName(moduleId: string, method: string): string {
  const slug = (value: string): string => value
    // split camelCase / PascalCase boundaries before collapsing separators
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return `opengui_plus_${slug(moduleId)}_${slug(method)}`
}

/** Value schema for one declared input field. */
function fieldSchema(hint: string, dialect: DshDialect): Record<string, unknown> {
  // Every module method validates and coerces its own input, so the loosest
  // schema that still carries the description is the right choice: `json`
  // accepts a string, number, object or array. `legacy` hosts get plain
  // `string`, which is all that dialect ever understood.
  if (dialect === 'modern') return { type: 'json', description: hint }
  return { type: 'string', description: hint }
}

function buildSpec(
  dialect: DshDialect,
  name: string,
  description: string,
  fields: Readonly<Record<string, string>>,
  dispatch: (target: string, input: Record<string, unknown>) => Promise<unknown>,
  target: string,
): Record<string, unknown> {
  const execute = async (input: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await dispatch(target, input ?? {})
    if (dialect === 'legacy') {
      return typeof result === 'string' ? result : JSON.stringify(result)
    }
    // `output.schema` is an object: hand back lossless JSON, never a bare string.
    return toJsonValue(result)
  }

  if (dialect === 'legacy') {
    return {
      name,
      description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(fields).map(([key, hint]) => [key, fieldSchema(hint, dialect)]),
        ),
      },
      execute,
      aliases: [target],
    }
  }

  return {
    name,
    description,
    parameters: Object.fromEntries(
      Object.entries(fields).map(([key, hint]) => [key, fieldSchema(hint, dialect)]),
    ),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): unknown[] => [{
        type: 'text',
        text: renderResult(value),
      }],
    },
    execute,
    isConcurrencySafe: () => false,
    aliases: [target],
  }
}

/**
 * Decide which `defineTool` shape the loaded DSH understands.
 *
 * A throwaway definition is compiled for each candidate — `defineTool` only
 * validates and returns, it does not add anything to a registry, so the probe
 * leaves no trace.
 */
export function detectDialect(bridge: DshBridge, logger?: Logger): DshDialect {
  const candidates: readonly DshDialect[] = ['modern', 'legacy']
  for (const dialect of candidates) {
    try {
      bridge.defineTool(buildSpec(dialect, PROBE_TOOL_NAME, 'dialect probe', {}, async () => ({}), 'probe.target'))
      return dialect
    }
    catch (error) {
      logger?.debug(`DSH defineTool 方言 ${dialect} 不可用: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return 'modern'
}

/** Strip functions/undefined so the value survives `output.schema` validation. */
function toJsonValue(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value ?? null))
    if (Array.isArray(parsed)) return { items: parsed as Record<string, unknown>[] }
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    return { result: parsed as string | number | boolean | null }
  }
  catch {
    return { result: typeof value === 'string' ? value : String(value) }
  }
}

/** Short, model-friendly rendering of a module result. */
function renderResult(value: unknown): string {
  if (value === null || value === undefined) return '（无返回）'
  if (typeof value === 'string') return value
  try {
    const text = JSON.stringify(value)
    // Keep the tool result cheap: a giant dump costs tokens and annoys the reader.
    return text !== undefined && text.length <= 4000 ? text : `${text.slice(0, 4000)}…（已截断）`
  }
  catch {
    return String(value)
  }
}

/** Register all module methods with a probe result. */
export async function registerWithDsh(
  modules: readonly PlusModule[],
  dispatch: (target: string, input: Record<string, unknown>) => Promise<unknown>,
  logger?: Logger,
): Promise<DshRegistrationReport> {
  const bridge = await probeDsh(logger)
  if (bridge === null) return { available: false, registered: [] }
  return registerWithDshBridge(bridge, modules, dispatch, logger)
}

/** Same as {@link registerWithDsh} for an already-probed bridge (used by tests). */
export async function registerWithDshBridge(
  bridge: DshBridge,
  modules: readonly PlusModule[],
  dispatch: (target: string, input: Record<string, unknown>) => Promise<unknown>,
  logger?: Logger,
): Promise<DshRegistrationReport> {
  const dialect = detectDialect(bridge, logger)
  const registered: string[] = []
  const failed: { readonly name: string, readonly error: string }[] = []

  for (const module of modules) {
    for (const [method] of Object.entries(module.methods)) {
      const name = dshToolName(module.id, method)
      const spec = module.methodSpecs?.find(candidate => candidate.name === method)
      const description = `[OpenGUI-Plus/${module.name}] ${spec?.summary ?? method}`
      try {
        bridge.defineTool(
          buildSpec(
            dialect,
            name,
            description,
            spec?.input ?? {},
            dispatch,
            `${module.id}.${method}`,
          ),
        )
        registered.push(name)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failed.push({ name, error: message })
        logger?.warn(`注册 DSH 工具 ${name} 失败: ${message}`)
      }
    }
  }

  logger?.info(`已向 DSH 注册 ${registered.length} 个工具（方言：${dialect}）`)
  return {
    available: true,
    registered,
    dialect,
    ...(failed.length > 0 ? { failed } : {}),
  }
}

/** Convenience used by the plugin entry point. */
export function isDshContext(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '$' in value === false && 'effect' in value
}
