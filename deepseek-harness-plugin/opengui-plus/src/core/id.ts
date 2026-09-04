import { randomUUID } from 'node:crypto'

/**
 * Identifier helpers.
 *
 * Ids are short enough to type in a terminal yet random enough to avoid
 * collisions across imported project bundles. `createId` accepts a prefix so a
 * log line reads `prj_8f2a` rather than an opaque blob.
 */
export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/** Deterministic id used by tests and by importers that must be reproducible. */
export function createIdFrom(prefix: string, seed: () => string = randomUUID): string {
  return `${prefix}_${seed().replaceAll('-', '').slice(0, 12)}`
}

/** Lowercase, dash-separated slug for aliases and template names. */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : createId('slug')
}

/** True when a string is safe to use as an alias (no whitespace, no control chars). */
export function isAliasSafe(alias: string): boolean {
  if (alias.length === 0 || alias.length > 32) return false
  return /^[^\s]+$/.test(alias) && !alias.includes('/')
}
