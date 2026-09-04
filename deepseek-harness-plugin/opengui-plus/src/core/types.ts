/**
 * Shared vocabulary for every OpenGUI-Plus module.
 *
 * Nothing in this file may import from DeepSeek Harness or from the upstream
 * OpenGUI plugin. The modules are plain domain logic so they can be unit
 * tested and run from the standalone console without a DSH host.
 */

/** ISO-8601 timestamp with milliseconds, e.g. `2026-09-04T09:20:00.000Z`. */
export type Iso8601 = string

/** Stable, short, human-transportable identifier. */
export type Id = string

/** Every module ships one of these so the registry can order and describe it. */
export type ModuleId =
  | 'wlan-connection'
  | 'snippet-library'
  | 'action-template'
  | 'scheduler'
  | 'project-group'
  | 'demo-recorder'
  | 'workflow-marketplace'
  | 'feedback-rl'
  | 'device-pool'
  | 'replay'
  /** Internal module owned by {@link PlusHost}; provides project copy/export/import. */
  | '__host__'

/** Explicit success/failure envelope; modules never throw across the API seam. */
export type Result<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: string }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T>(error: string): Result<T> {
  return { ok: false, error }
}

/** Wrap a throwing call so module methods stay total. */
export function attempt<T>(label: string, run: () => T): Result<T> {
  try {
    return ok(run())
  }
  catch (error) {
    return fail(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function attemptAsync<T>(label: string, run: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await run())
  }
  catch (error) {
    return fail(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A named, ordered list of values; used by every list-returning module API. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: number
}

export function page<T>(items: readonly T[]): Page<T> {
  return { items, total: items.length }
}

/** Sorting helper kept here because six modules sort by the same two keys. */
export function byNewestFirst(a: { readonly updatedAt: Iso8601 }, b: { readonly updatedAt: Iso8601 }): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

export function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN')
}
