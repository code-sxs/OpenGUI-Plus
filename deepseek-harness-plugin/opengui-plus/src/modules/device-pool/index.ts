/**
 * Module 9 — Multi-device pool and cooperative scheduling.
 *
 * A phone is a scarce, slow, flaky resource, so the pool treats one as a
 * worker with a concurrency budget rather than as a connection. Tasks queue up,
 * `assign` hands them to whichever device has room (highest priority first,
 * then least loaded), and `complete` frees the slot — or re-queues the task
 * when it failed and retries remain.
 *
 * Two rules keep the pool honest:
 *   - a device is never a candidate while `status === 'offline'`, even if it
 *     still holds stale running tasks from a previous session;
 *   - `unregister` refuses to drop a device with work in flight, because
 *     forgetting the worker would orphan those tasks forever.
 *
 * `refresh` is the only place that talks to another module, and it degrades to
 * "everything offline" rather than propagating a failure.
 *
 * @module modules/device-pool
 */

import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import { fail, ok } from '../../core/types.js'

const DEVICES_KEY = 'pool-devices'
const TASKS_KEY = 'pool-tasks'

export type DeviceTransport = 'usb' | 'wifi'
export type DeviceStatus = 'idle' | 'busy' | 'offline'
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed'

export interface PoolDevice {
  readonly id: string
  readonly name: string
  readonly serial?: string
  readonly transport: DeviceTransport
  readonly groups: readonly string[]
  readonly status: DeviceStatus
  readonly maxConcurrency: number
  readonly runningTaskIds: readonly string[]
  readonly priority: number
  readonly lastSeenAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PoolTask {
  readonly id: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly priority: number
  readonly groupFilter?: string
  readonly status: TaskStatus
  readonly assignedDeviceId?: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly error?: string
  readonly createdAt: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

/** Summary row returned by `listGroups`. */
export interface PoolGroup {
  readonly name: string
  readonly devices: number
  readonly idle: number
  readonly busy: number
  readonly offline: number
}

export const UNGROUPED = '未分组'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function readGroups(source: Record<string, unknown>): string[] | undefined {
  const raw = source.groups
  if (raw === undefined) return undefined
  if (typeof raw === 'string') {
    return raw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  }
  if (!Array.isArray(raw)) return undefined
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function readInt(source: Record<string, unknown>, key: string, fallback: number, min: number): number {
  const raw = source[key]
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(value) && value >= min ? value : fallback
}

export function createDevicePoolModule(): PlusModule {
  let context: ModuleContext | null = null
  let devices: PoolDevice[] = []
  let tasks: PoolTask[] = []

  async function persist(): Promise<void> {
    if (context === null) return
    await context.global.set(DEVICES_KEY, devices)
    await context.global.set(TASKS_KEY, tasks)
  }

  function announce(reason: string): void {
    context?.events.publish('device-pool', PLUS_EVENTS.devicePoolChanged, {
      reason,
      devices: devices.length,
      queued: tasks.filter(task => task.status === 'queued').length,
      running: tasks.filter(task => task.status === 'running').length,
    })
  }

  async function commit(reason: string): Promise<void> {
    await persist()
    announce(reason)
  }

  function findDevice(id: string): PoolDevice | undefined {
    return devices.find(device => device.id === id)
  }

  function findTask(id: string): PoolTask | undefined {
    return tasks.find(task => task.id === id)
  }

  function updateDevice(id: string, mutate: (device: PoolDevice) => PoolDevice): void {
    devices = devices.map(device => (device.id === id ? mutate(device) : device))
  }

  /**
   * Devices able to take one more task, best first.
   *
   * Order: priority descending (an operator-designated primary device wins),
   * then fewest running tasks (spread the load), then id ascending so the
   * choice is reproducible across restarts and in tests.
   */
  function candidates(groupFilter: string | undefined): PoolDevice[] {
    return devices
      .filter(device => device.status !== 'offline')
      .filter(device => groupFilter === undefined || device.groups.includes(groupFilter))
      .filter(device => device.runningTaskIds.length < device.maxConcurrency)
      .toSorted((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority
        if (a.runningTaskIds.length !== b.runningTaskIds.length) {
          return a.runningTaskIds.length - b.runningTaskIds.length
        }
        return a.id.localeCompare(b.id)
      })
  }

  /** Next queued task: highest priority, then earliest enqueued. */
  function nextQueued(): PoolTask | undefined {
    return tasks
      .filter(task => task.status === 'queued')
      .toSorted((a, b) => (b.priority - a.priority) || a.createdAt.localeCompare(b.createdAt))[0]
  }

  function bind(task: PoolTask, device: PoolDevice): void {
    const at = new Date().toISOString()
    updateDevice(device.id, current => ({
      ...current,
      status: 'busy',
      runningTaskIds: current.runningTaskIds.includes(task.id)
        ? current.runningTaskIds
        : [...current.runningTaskIds, task.id],
      updatedAt: at,
    }))
    tasks = tasks.map((row) => {
      if (row.id !== task.id) return row
      return { ...row, status: 'running', assignedDeviceId: device.id, startedAt: at, error: undefined }
    })
  }

  const module = defineModule({
    id: 'device-pool',
    name: '多机协同与设备池',
    version: '0.1.0',
    summary: '把多台手机当作可并发调度的工人：注册、分组、探测在线状态，按优先级与并发上限分发任务并支持失败重试。',

    methods: {
      /** Register a device; an existing serial is updated rather than duplicated. */
      async register(input) {
        const name = readString(input, 'name')
        if (name === undefined) return fail('register needs "name"')
        const serial = readString(input, 'serial')
        const transport: DeviceTransport = readString(input, 'transport') === 'wifi' ? 'wifi' : 'usb'
        const groups = readGroups(input) ?? []
        const maxConcurrency = readInt(input, 'maxConcurrency', 1, 1)
        const priority = readInt(input, 'priority', 0, -1_000_000)
        const at = new Date().toISOString()

        const existing = serial === undefined ? undefined : devices.find(device => device.serial === serial)
        if (existing !== undefined) {
          const updated: PoolDevice = {
            ...existing,
            name,
            transport,
            groups,
            maxConcurrency,
            priority,
            updatedAt: at,
            // Lowering the budget below the current load must not corrupt state:
            // in-flight tasks keep running, the device simply takes no more.
            status: existing.status === 'offline' ? existing.status : existing.runningTaskIds.length > 0 ? 'busy' : 'idle',
          }
          devices = devices.map(device => (device.id === existing.id ? updated : device))
          await commit('register')
          return { device: updated, updated: true, total: devices.length }
        }

        const device: PoolDevice = {
          id: createId('dev'),
          name,
          transport,
          groups,
          status: 'idle',
          maxConcurrency,
          priority,
          runningTaskIds: [],
          createdAt: at,
          updatedAt: at,
          ...(serial === undefined ? {} : { serial }),
        }
        devices = [...devices, device]
        await commit('register')
        return { device, updated: false, total: devices.length }
      },

      async unregister(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('unregister needs "id"')
        const device = findDevice(id)
        if (device === undefined) return fail(`unknown device "${id}"`)
        if (device.runningTaskIds.length > 0) {
          return fail(`设备「${device.name}」仍有 ${device.runningTaskIds.length} 个运行中任务，请先完成或等待结束`)
        }
        devices = devices.filter(row => row.id !== id)
        await commit('unregister')
        return { removed: id, total: devices.length }
      },

      async list() {
        return {
          devices: [...devices].toSorted((a, b) => (b.priority - a.priority) || a.name.localeCompare(b.name, 'zh-Hans-CN')),
          total: devices.length,
        }
      },

      async listGroups() {
        const names = new Set<string>()
        for (const device of devices) {
          if (device.groups.length === 0) {
            names.add(UNGROUPED)
            continue
          }
          for (const group of device.groups) names.add(group)
        }
        const groups: PoolGroup[] = [...names].toSorted((a, b) => {
          if (a === UNGROUPED) return 1
          if (b === UNGROUPED) return -1
          return a.localeCompare(b, 'zh-Hans-CN')
        }).map((name) => {
          const rows = devices.filter(device => (device.groups.length === 0 ? UNGROUPED === name : device.groups.includes(name)))
          return {
            name,
            devices: rows.length,
            idle: rows.filter(device => device.status === 'idle').length,
            busy: rows.filter(device => device.status === 'busy').length,
            offline: rows.filter(device => device.status === 'offline').length,
          }
        })
        return { groups, total: groups.length }
      },

      /** Replace the group list wholesale; an empty array means ungrouped. */
      async tag(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('tag needs "id"')
        const device = findDevice(id)
        if (device === undefined) return fail(`unknown device "${id}"`)
        const groups = readGroups(input)
        if (groups === undefined) return fail('tag needs "groups" (string array or comma-separated string)')
        updateDevice(id, current => ({ ...current, groups, updatedAt: new Date().toISOString() }))
        await commit('tag')
        return { device: findDevice(id)!, groups }
      },

      async setConcurrency(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('setConcurrency needs "id"')
        const device = findDevice(id)
        if (device === undefined) return fail(`unknown device "${id}"`)
        const raw = input.maxConcurrency
        const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
        if (!Number.isInteger(value) || value < 1) return fail('maxConcurrency 必须是不小于 1 的整数')
        updateDevice(id, current => ({ ...current, maxConcurrency: value, updatedAt: new Date().toISOString() }))
        await commit('setConcurrency')
        return { device: findDevice(id)!, maxConcurrency: value }
      },

      /**
       * Mark devices online/offline from a live `adb devices` probe.
       *
       * `wlan-connection.discover` is the single source of truth for what is
       * attached. If that module is missing or adb is gone, every device is
       * marked offline rather than left in a stale "idle" state that `assign`
       * would happily hand work to.
       */
      async refresh() {
        const seen = new Set<string>()
        let reason = 'ok'
        try {
          const result = context === null ? null : await context.call('wlan-connection.discover', {})
          if (result === null || !result.ok) {
            reason = result === null ? '模块未启动' : result.error
          }
          else if (isRecord(result.value) && Array.isArray(result.value.devices)) {
            for (const row of result.value.devices) {
              if (!isRecord(row)) continue
              const serial = readString(row, 'serial')
              if (serial === undefined) continue
              seen.add(serial)
            }
          }
          else {
            reason = 'discover 返回格式无法识别'
          }
        }
        catch (error) {
          reason = `wlan-connection.discover 调用失败: ${error instanceof Error ? error.message : String(error)}`
        }

        const degraded = seen.size === 0
        const at = new Date().toISOString()
        devices = devices.map((device) => {
          const online = degraded === false && device.serial !== undefined && seen.has(device.serial)
          if (online) {
            return {
              ...device,
              // A device carrying work stays busy; an empty one becomes idle.
              status: device.runningTaskIds.length > 0 ? 'busy' : 'idle',
              lastSeenAt: at,
              updatedAt: at,
            }
          }
          return { ...device, status: 'offline', updatedAt: at }
        })
        await commit('refresh')
        return {
          refreshed: true,
          degraded,
          online: degraded ? 0 : devices.filter(device => device.status !== 'offline').length,
          offline: devices.filter(device => device.status === 'offline').length,
          ...(degraded ? { reason: `未探测到在线设备（${reason}），已全部标记为 offline` } : { reason }),
        }
      },

      async enqueue(input) {
        const payload = input.payload
        if (!isRecord(payload)) return fail('enqueue needs an object "payload"')
        const groupFilter = readString(input, 'groupFilter')
        const task: PoolTask = {
          id: createId('task'),
          payload: { ...payload },
          priority: readInt(input, 'priority', 0, -1_000_000),
          maxAttempts: readInt(input, 'maxAttempts', 1, 1),
          status: 'queued',
          attempts: 0,
          createdAt: new Date().toISOString(),
          ...(groupFilter === undefined ? {} : { groupFilter }),
        }
        tasks = [...tasks, task]
        await commit('enqueue')
        return { task, queued: tasks.filter(row => row.status === 'queued').length }
      },

      async dequeue(input) {
        const id = readString(input, 'id') ?? readString(input, 'taskId')
        if (id === undefined) return fail('dequeue needs "id"')
        const task = findTask(id)
        if (task === undefined) return fail(`unknown task "${id}"`)
        if (task.status !== 'queued') return fail(`任务 "${id}" 已处于 ${task.status} 状态，无法移除`)
        tasks = tasks.filter(row => row.id !== id)
        await commit('dequeue')
        return { removed: id, queued: tasks.filter(row => row.status === 'queued').length }
      },

      /**
       * Hand one task to one device.
       *
       * "No device available" is a normal outcome of a busy farm, not an
       * error, so it comes back as `ok({ assigned: false })` and callers can
       * simply retry later.
       */
      async assign(input) {
        const taskId = readString(input, 'taskId') ?? readString(input, 'id')
        const deviceId = readString(input, 'deviceId')

        const task = taskId === undefined ? nextQueued() : findTask(taskId)
        if (task === undefined) {
          return fail(taskId === undefined ? '队列为空，没有待分配任务' : `unknown task "${taskId}"`)
        }
        if (task.status !== 'queued') return fail(`任务 "${task.id}" 已处于 ${task.status} 状态`)

        if (deviceId !== undefined) {
          const device = findDevice(deviceId)
          if (device === undefined) return fail(`unknown device "${deviceId}"`)
          if (device.status === 'offline') return fail(`设备「${device.name}」离线`)
          if (task.groupFilter !== undefined && !device.groups.includes(task.groupFilter)) {
            return fail(`设备「${device.name}」不属于分组 ${task.groupFilter}`)
          }
          if (device.runningTaskIds.length >= device.maxConcurrency) {
            return fail(`设备「${device.name}」并发已满（${device.runningTaskIds.length}/${device.maxConcurrency}）`)
          }
          bind(task, device)
          await commit('assign')
          return { assigned: true, task: findTask(task.id)!, device: findDevice(deviceId)! }
        }

        const pool = candidates(task.groupFilter)
        const device = pool[0]
        if (device === undefined) {
          return ok({
            assigned: false,
            reason: '所有设备均忙碌或离线',
            taskId: task.id,
            groupFilter: task.groupFilter,
          })
        }
        bind(task, device)
        await commit('assign')
        return { assigned: true, task: findTask(task.id)!, device: findDevice(device.id)! }
      },

      async complete(input) {
        const taskId = readString(input, 'taskId') ?? readString(input, 'id')
        if (taskId === undefined) return fail('complete needs "taskId"')
        const task = findTask(taskId)
        if (task === undefined) return fail(`unknown task "${taskId}"`)
        if (task.status !== 'running') return fail(`任务 "${taskId}" 不在运行中（当前 ${task.status}）`)
        const succeeded = input.ok !== false
        const error = succeeded ? undefined : readString(input, 'error') ?? '未给出失败原因'
        const at = new Date().toISOString()

        if (task.assignedDeviceId !== undefined) {
          const device = findDevice(task.assignedDeviceId)
          if (device !== undefined) {
            const remaining = device.runningTaskIds.filter(id => id !== taskId)
            updateDevice(device.id, current => ({
              ...current,
              runningTaskIds: remaining,
              status: remaining.length > 0 ? 'busy' : current.status === 'offline' ? 'offline' : 'idle',
              updatedAt: at,
            }))
          }
        }

        const attempts = task.attempts + 1
        const retry = succeeded === false && attempts < task.maxAttempts
        tasks = tasks.map((row) => {
          if (row.id !== taskId) return row
          if (retry) {
            // Back to the queue with a bumped attempt counter; `startedAt` is
            // cleared so the next attempt measures its own duration.
            return {
              ...row,
              status: 'queued',
              attempts,
              assignedDeviceId: undefined,
              startedAt: undefined,
              ...(error === undefined ? {} : { error }),
            }
          }
          return {
            ...row,
            status: succeeded ? 'done' : 'failed',
            attempts,
            finishedAt: at,
            ...(error === undefined ? {} : { error }),
          }
        })
        await commit('complete')
        return { task: findTask(taskId)!, retried: retry }
      },

      async status() {
        const count = (status: TaskStatus): number => tasks.filter(task => task.status === status).length
        return {
          devices: {
            total: devices.length,
            idle: devices.filter(device => device.status === 'idle').length,
            busy: devices.filter(device => device.status === 'busy').length,
            offline: devices.filter(device => device.status === 'offline').length,
          },
          tasks: {
            queued: count('queued'),
            running: count('running'),
            done: count('done'),
            failed: count('failed'),
          },
          queue: tasks
            .filter(task => task.status === 'queued')
            .toSorted((a, b) => (b.priority - a.priority) || a.createdAt.localeCompare(b.createdAt))
            .slice(0, 20)
            .map(task => ({
              id: task.id,
              priority: task.priority,
              attempts: task.attempts,
              maxAttempts: task.maxAttempts,
              createdAt: task.createdAt,
              ...(task.groupFilter === undefined ? {} : { groupFilter: task.groupFilter }),
            })),
        }
      },

      /**
       * Drain as much of the queue as the farm can take right now.
       * Stops on the first refusal so a partially assigned round is reported
       * honestly instead of looping over a saturated pool.
       */
      async autoAssign() {
        const assigned: { readonly taskId: string, readonly deviceId: string }[] = []
        for (;;) {
          const result = await module.methods.assign!({})
          if (!isRecord(result) || result.assigned !== true) break
          const task = result.task
          const device = result.device
          if (!isRecord(task) || !isRecord(device)) break
          const taskId = readString(task, 'id')
          const deviceId = readString(device, 'id')
          if (taskId === undefined || deviceId === undefined) break
          assigned.push({ taskId, deviceId })
        }
        return {
          assigned,
          remaining: tasks.filter(task => task.status === 'queued').length,
        }
      },
    },

    methodSpecs: [
      { name: 'register', summary: '注册或更新一台设备', input: { name: '设备名', serial: 'adb 序列号，已存在则更新', transport: 'usb | wifi', groups: '分组数组', maxConcurrency: '并发上限，默认 1', priority: '优先级，默认 0' } },
      { name: 'unregister', summary: '注销设备（有运行中任务时拒绝）', input: { id: '设备 id' } },
      { name: 'list', summary: '列出设备池' },
      { name: 'listGroups', summary: '列出分组及每组设备/空闲数' },
      { name: 'tag', summary: '全量替换设备分组', input: { id: '设备 id', groups: '分组数组' } },
      { name: 'setConcurrency', summary: '设置设备并发上限', input: { id: '设备 id', maxConcurrency: '不小于 1 的整数' } },
      { name: 'refresh', summary: '按 adb 探测结果刷新在线状态' },
      { name: 'enqueue', summary: '入队一个任务', input: { payload: '任务数据对象', priority: '优先级，默认 0', groupFilter: '限定分组', maxAttempts: '最大尝试次数，默认 1' } },
      { name: 'dequeue', summary: '移除一个排队中的任务', input: { id: '任务 id' } },
      { name: 'assign', summary: '把一个任务分配给设备', input: { taskId: '可选，默认取队首', deviceId: '可选，指定设备' } },
      { name: 'complete', summary: '结束任务并释放设备槽位', input: { taskId: '任务 id', ok: '是否成功', error: '失败原因' } },
      { name: 'status', summary: '设备池与任务队列概览' },
      { name: 'autoAssign', summary: '尽可能把队列任务分配出去' },
    ],

    async start(ctx) {
      context = ctx
      devices = await loadDevices(ctx)
      tasks = await loadTasks(ctx)
    },

    async reseat(ctx) {
      // The farm is shared across projects: only the context is re-pointed.
      context = ctx
    },

    async stop() {
      context = null
    },

    async health() {
      const online = devices.filter(device => device.status !== 'offline').length
      return {
        healthy: devices.length === 0 || online > 0,
        detail: `${devices.length} 台设备（${online} 在线），${tasks.filter(task => task.status === 'queued').length} 个任务排队`,
      }
    },
  })

  return module
}

async function loadDevices(ctx: ModuleContext): Promise<PoolDevice[]> {
  const stored = await ctx.global.get(DEVICES_KEY, [] as readonly PoolDevice[])
  if (!Array.isArray(stored)) return []
  return stored.filter(isRecord).map(normaliseDevice).filter((row): row is PoolDevice => row !== null)
}

async function loadTasks(ctx: ModuleContext): Promise<PoolTask[]> {
  const stored = await ctx.global.get(TASKS_KEY, [] as readonly PoolTask[])
  if (!Array.isArray(stored)) return []
  return stored.filter(isRecord).map(normaliseTask).filter((row): row is PoolTask => row !== null)
}

export function normaliseDevice(row: Record<string, unknown>): PoolDevice | null {
  const id = readString(row, 'id')
  const name = readString(row, 'name')
  if (id === undefined || name === undefined) return null
  const status = row.status
  const runningTaskIds = Array.isArray(row.runningTaskIds)
    ? row.runningTaskIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  const maxConcurrency = readInt(row, 'maxConcurrency', 1, 1)
  return {
    id,
    name,
    transport: readString(row, 'transport') === 'wifi' ? 'wifi' : 'usb',
    groups: readGroups(row) ?? [],
    status: status === 'busy' || status === 'offline' ? status : 'idle',
    maxConcurrency,
    runningTaskIds,
    priority: readInt(row, 'priority', 0, -1_000_000),
    createdAt: readString(row, 'createdAt') ?? new Date(0).toISOString(),
    updatedAt: readString(row, 'updatedAt') ?? new Date(0).toISOString(),
    ...(readString(row, 'serial') === undefined ? {} : { serial: readString(row, 'serial')! }),
    ...(readString(row, 'lastSeenAt') === undefined ? {} : { lastSeenAt: readString(row, 'lastSeenAt')! }),
  }
}

export function normaliseTask(row: Record<string, unknown>): PoolTask | null {
  const id = readString(row, 'id')
  if (id === undefined) return null
  const status = row.status
  return {
    id,
    payload: isRecord(row.payload) ? { ...row.payload } : {},
    priority: readInt(row, 'priority', 0, -1_000_000),
    status: status === 'running' || status === 'done' || status === 'failed' ? status : 'queued',
    attempts: readInt(row, 'attempts', 0, 0),
    maxAttempts: readInt(row, 'maxAttempts', 1, 1),
    createdAt: readString(row, 'createdAt') ?? new Date(0).toISOString(),
    ...(readString(row, 'groupFilter') === undefined ? {} : { groupFilter: readString(row, 'groupFilter')! }),
    ...(readString(row, 'assignedDeviceId') === undefined ? {} : { assignedDeviceId: readString(row, 'assignedDeviceId')! }),
    ...(readString(row, 'error') === undefined ? {} : { error: readString(row, 'error')! }),
    ...(readString(row, 'startedAt') === undefined ? {} : { startedAt: readString(row, 'startedAt')! }),
    ...(readString(row, 'finishedAt') === undefined ? {} : { finishedAt: readString(row, 'finishedAt')! }),
  }
}

export { UNGROUPED as DEVICE_POOL_UNGROUPED }
export type { DeviceStatus as PoolDeviceStatus, TaskStatus as PoolTaskStatus }
