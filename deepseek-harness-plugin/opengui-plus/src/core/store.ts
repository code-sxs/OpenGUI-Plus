/**
 * JSON persistence with project scoping.
 *
 * Layout:
 *   <root>/global/<key>.json            cross-project data (project list, device pool)
 *   <root>/projects/<projectId>/<key>.json   per-project data (snippets, templates, schedules)
 *
 * Two rules make this safe to use from every module concurrently:
 *   1. Writes are atomic (temp file + rename) so a crash never leaves a
 *      half-written document behind.
 *   2. Writes to the same key are serialised through a promise chain, so two
 *      modules calling `update` at once cannot lose each other's changes.
 *
 * @module core/store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * A JSON document must be one of these to round-trip through the store.
 * Declared for documentation and for callers that want the annotation; the
 * write methods accept any value and let `JSON.stringify` reject the rest
 * (circular references are the only realistic failure).
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue }

/** Optional migration applied when an on-disk document predates the code. */
export type Migrate<T> = (raw: unknown, storedVersion: number) => T

const ENVELOPE_VERSION = 1

interface Envelope {
  readonly version: number
  readonly data: unknown
}

/** Read/write surface scoped to one project (or to the global namespace). */
export class ScopedStore {
  constructor(
    private readonly directory: string,
    private readonly queues: Map<string, Promise<unknown>>,
  ) {}

  async get<T>(key: string, fallback: T, migrate?: Migrate<T>): Promise<T> {
    const file = this.fileFor(key)
    if (!existsSync(file)) return fallback
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Envelope>
      if (parsed === null || typeof parsed !== 'object') return fallback
      if (parsed.version === ENVELOPE_VERSION) {
        return migrate === undefined
          ? (parsed.data as T)
          : migrate(parsed.data, ENVELOPE_VERSION)
      }
      return migrate === undefined
        ? (parsed.data as T)
        : migrate(parsed.data, parsed.version ?? 0)
    }
    catch {
      // A corrupt document falls back rather than taking the whole console down.
      return fallback
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    return this.enqueue(key, async () => {
      await mkdir(this.directory, { recursive: true })
      const file = this.fileFor(key)
      const tmp = `${file}.${process.pid}.tmp`
      const envelope: Envelope = { version: ENVELOPE_VERSION, data: value }
      await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    })
  }

  /** Read-modify-write without a lost-update window. */
  async update<T>(key: string, fallback: T, mutate: (current: T) => T): Promise<T> {
    return this.enqueue(key, async () => {
      const current = await this.get(key, fallback)
      const next = mutate(current)
      await this.set(key, next)
      return next
    }) as Promise<T>
  }

  async delete(key: string): Promise<void> {
    return this.enqueue(key, async () => {
      const file = this.fileFor(key)
      if (existsSync(file)) await rm(file, { force: true })
    })
  }

  async keys(): Promise<readonly string[]> {
    const { readdir } = await import('node:fs/promises')
    if (!existsSync(this.directory)) return []
    const entries = await readdir(this.directory)
    return entries
      .filter(entry => entry.endsWith('.json'))
      .map(entry => entry.slice(0, -'.json'.length))
  }

  /** Absolute path, exposed so the CLI can print where data actually lives. */
  get directoryPath(): string {
    return this.directory
  }

  private fileFor(key: string): string {
    assertSafeKey(key)
    return join(this.directory, `${key}.json`)
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const file = this.fileFor(key)
    const previous = this.queues.get(file) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(file, next.catch(() => undefined))
    return next
  }
}

function assertSafeKey(key: string): void {
  if (key.length === 0) throw new Error('opengui-plus: store key must not be empty')
  if (key.includes(sep) || key.includes('/') || key.includes('..')) {
    throw new Error(`opengui-plus: illegal store key "${key}"`)
  }
}

/** Root of the on-disk data directory. */
export class PlusStore {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly root: string
  private readonly globalScope: ScopedStore

  constructor(rootDir: string) {
    this.root = resolve(rootDir)
    this.globalScope = new ScopedStore(join(this.root, 'global'), this.queues)
  }

  /** Where the data lives; surfaced by `opengui-plus status`. */
  get rootPath(): string {
    return this.root
  }

  /** Cross-project namespace: project registry, device pool, marketplace index. */
  global(): ScopedStore {
    return this.globalScope
  }

  /** Per-project namespace; every module reads its state through this. */
  project(projectId: string): ScopedStore {
    assertSafeKey(projectId)
    return new ScopedStore(join(this.root, 'projects', projectId), this.queues)
  }

  /** Remove every document owned by a project. */
  async deleteProject(projectId: string): Promise<void> {
    assertSafeKey(projectId)
    const directory = join(this.root, 'projects', projectId)
    if (existsSync(directory)) await rm(directory, { recursive: true, force: true })
  }

  async projectIds(): Promise<readonly string[]> {
    const directory = join(this.root, 'projects')
    if (!existsSync(directory)) return []
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  /** Wait for every in-flight write; used before shutdown and in tests. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.queues.values()])
  }
}

/** Convenience for tests: an in-memory-ish store rooted in a temp directory. */
export function createStore(rootDir: string): PlusStore {
  return new PlusStore(rootDir)
}

export { dirname }
