/**
 * Minimal typed event bus.
 *
 * The console streams these events over WebSocket, the scheduler reacts to
 * them, and the feedback loop records them. Keeping one bus means a module can
 * publish without knowing who listens.
 */

import type { Iso8601 } from './types.js'

export type EventListener<T> = (payload: T) => void

/** Envelope every published event is wrapped in. */
export interface PlusEvent<T = unknown> {
  readonly source: string
  readonly type: string
  readonly payload: T
  readonly at: Iso8601
}

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener<never>>>()
  private readonly history: PlusEvent[] = []
  private readonly historyLimit: number

  constructor(options: { readonly historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 200
  }

  /** Returns an unsubscribe function. */
  on<T>(source: string, type: string, listener: EventListener<T>): () => void {
    const key = this.key(source, type)
    const bucket = this.listeners.get(key) ?? new Set()
    bucket.add(listener as EventListener<never>)
    this.listeners.set(key, bucket)
    return () => {
      bucket.delete(listener as EventListener<never>)
      if (bucket.size === 0) this.listeners.delete(key)
    }
  }

  /** Subscribe to a type regardless of the publishing module. */
  onAny<T>(type: string, listener: EventListener<T>): () => void {
    return this.on<T>('*', type, listener)
  }

  publish<T>(source: string, type: string, payload: T): PlusEvent<T> {
    const event: PlusEvent<T> = { source, type, payload, at: new Date().toISOString() }
    this.history.push(event as PlusEvent)
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit)
    }
    for (const key of [this.key(source, type), this.key('*', type)]) {
      const bucket = this.listeners.get(key)
      if (bucket === undefined) continue
      for (const listener of [...bucket]) {
        try {
          ;(listener as EventListener<T>)(payload)
        }
        catch {
          // A misbehaving listener must never break the publisher.
        }
      }
    }
    return event
  }

  /** Recent events, newest last; used to prime a freshly connected console. */
  recent(limit = 50): readonly PlusEvent[] {
    return this.history.slice(-limit)
  }

  private key(source: string, type: string): string {
    return `${source}::${type}`
  }
}

/** Event type constants shared by publishers and the console. */
export const PLUS_EVENTS = {
  connectionStateChanged: 'connection.state-changed',
  devicePoolChanged: 'device-pool.changed',
  templateExecuted: 'action-template.executed',
  scheduleFired: 'scheduler.fired',
  projectSwitched: 'project-group.switched',
  recordingFinished: 'demo-recorder.finished',
  feedbackRecorded: 'feedback-rl.recorded',
  replayReady: 'replay.ready',
  marketplaceInstalled: 'marketplace.installed',
} as const
