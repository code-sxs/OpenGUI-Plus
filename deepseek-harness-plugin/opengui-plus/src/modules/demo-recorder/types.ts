/**
 * Domain types for the demo recorder.
 *
 * Kept in their own file because `index.ts`, `variables.ts` and the tests all
 * need them, and a barrel that imports the module would create a cycle.
 *
 * @module modules/demo-recorder/types
 */

import type { Iso8601 } from '../../core/types.js'

/** Snapshot of what the phone was showing when a step was recorded. */
export interface DemoScreenState {
  /** Foreground activity, e.g. `com.xingin.xhs/.activity.MainActivity`. */
  activity?: string
  packageName?: string
  /** Path relative to `context.dataDir`, e.g. `demo-screenshots/demo_x/stp_y.png`. */
  screenshotPath?: string
  /** Key texts lifted from a `uiautomator dump`, for humans and for the LLM. */
  textSummary?: string
}

/** One recorded human action plus the page state it happened on. */
export interface DemoStep {
  id: string
  at: Iso8601
  /** Action verb: `tap`, `input`, `launch`, `swipe`, … */
  action: string
  params: Record<string, string | number>
  screenState?: DemoScreenState
  note?: string
}

/** A `{{placeholder}}` found inside step params, promoted to a template input. */
export interface DemoVariable {
  name: string
  label: string
  defaultValue?: string
  required: boolean
}

export type DemoStatus = 'recording' | 'ready' | 'revised'

/** One entry in the audit trail left by "修正示范". */
export interface DemoRevision {
  at: Iso8601
  note: string
  revision: number
}

/** A recorded demonstration, i.e. a reusable workflow before it is published. */
export interface DemoRecording {
  id: string
  name: string
  description?: string
  steps: DemoStep[]
  variables: DemoVariable[]
  status: DemoStatus
  /** Bumped once per `revise` call. */
  revision: number
  revisionHistory: DemoRevision[]
  createdAt: Iso8601
  updatedAt: Iso8601
}

/**
 * The neutral template JSON a recording is exported as.
 *
 * Deliberately shaped exactly like `workflow-marketplace`'s
 * `.opengui-workflow` document, but declared here from scratch: modules never
 * import each other's internals, and duplicating ~12 lines of types is cheaper
 * than coupling two modules that evolve independently.
 */
export interface DemoTemplate {
  formatVersion: number
  id: string
  name: string
  description: string
  category: string
  author: string
  version: string
  tags: string[]
  taskIntent: string
  preconditions: string[]
  steps: {
    id: string
    action: string
    params: Record<string, string | number>
    note?: string
  }[]
  parameters: {
    name: string
    label: string
    description?: string
    defaultValue?: string
    required: boolean
  }[]
  createdAt: Iso8601
  updatedAt: Iso8601
}
