/**
 * Cross-module call helper.
 *
 * `ModuleRegistry.call` wraps whatever a module method returned in its own
 * `Result`, so a caller that goes through `context.call` sees
 * `{ ok: true, value: { ok: false, error: '…' } }` when the *callee* failed.
 * Checking only the outer `ok` turns every failure into a silent success —
 * which is exactly the bug F-01 was (a scheduler task pointing at a snippet
 * alias that does not exist reported "已解析别名").
 *
 * `callModule` collapses the two envelopes into one, so callers never have to
 * remember the double wrapping. It is the only sanctioned way for a module to
 * call another module.
 *
 * @module core/call
 */

import type { ModuleContext } from './module.js'
import { fail, ok, type Result } from './types.js'

/**
 * Recognise the module-level `Result` envelope.
 *
 * A module method may also return a bare domain object (`{ templates, total }`),
 * so a missing `ok` is not an error — it just means there is nothing to unwrap.
 */
export function isResultLike(value: unknown): value is { readonly ok: boolean, readonly value?: unknown, readonly error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { readonly ok?: unknown }
  return typeof candidate.ok === 'boolean'
}

/**
 * Call `module.method` through the registry and return the callee's own result.
 *
 * - registry-level failure (unknown module / method, thrown) → `fail`
 * - callee returned a `Result` → that exact result
 * - callee returned a bare value → `ok(value)`
 */
export async function callModule<T = unknown>(
  context: Pick<ModuleContext, 'call'>,
  target: string,
  input: Record<string, unknown> = {},
): Promise<Result<T>> {
  let outer: Result<unknown>
  try {
    outer = await context.call(target, input)
  }
  catch (error) {
    return fail(`${target} 调用失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!outer.ok) return fail(outer.error)
  const inner = outer.value
  if (!isResultLike(inner)) return ok(inner as T)
  if (inner.ok) return ok(inner.value as T)
  return fail(inner.error ?? `${target} 返回失败但未给出原因`)
}

/** Same as {@link callModule} but tolerates a missing host (used during startup). */
export function callBound(
  call: ModuleContext['call'],
): (target: string, input?: Record<string, unknown>) => Promise<Result<unknown>> {
  return (target, input) => callModule({ call }, target, input ?? {})
}
