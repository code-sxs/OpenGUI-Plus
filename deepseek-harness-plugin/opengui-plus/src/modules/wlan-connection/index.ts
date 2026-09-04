/**
 * Module 1 — Wireless debugging connection.
 *
 * Upstream OpenGUI is USB-first: it discovers whatever `adb devices` reports.
 * This module adds the two things that workflow needs but USB-only lacks:
 * a remembered set of WiFi endpoints, and a strategy (`usb` / `wifi` / `auto`)
 * that decides which one to use when the phone is not plugged in.
 *
 * Everything here talks to ADB through the injected `AdbRunner`, so the whole
 * module is testable without a phone attached.
 *
 * @module modules/wlan-connection
 */

import type { AdbRunner } from '../../core/adb-runner.js'
import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import type { Iso8601, Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'
import { parseAdbDevices, splitEndpoint } from './parse.js'
import type { AdbDeviceRow } from './parse.js'

export type ConnectionMode = 'usb' | 'wifi' | 'auto'
export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error'
export type Transport = 'usb' | 'wifi'

export interface WifiEndpoint {
  readonly host: string
  readonly port: number
}

/** A remembered device. A USB device carries a serial, a WiFi device an endpoint. */
export interface DeviceProfile {
  readonly id: string
  readonly name: string
  readonly transport: Transport
  /** Present for USB devices. */
  readonly serial?: string
  /** Present for WiFi devices. */
  readonly wifi?: WifiEndpoint
  readonly model?: string
  readonly favorite: boolean
  readonly lastUsedAt?: Iso8601
  readonly createdAt: Iso8601
}

export interface ConnectionStatus {
  readonly mode: ConnectionMode
  readonly state: ConnectionState
  readonly transport?: Transport
  readonly deviceId?: string
  readonly deviceName?: string
  readonly serial?: string
  readonly endpoint?: WifiEndpoint
  readonly message: string
  readonly lastError?: string
  readonly autoConnect: boolean
  readonly checkedAt: Iso8601
}

interface ConnectionPreference {
  readonly mode: ConnectionMode
  readonly defaultDeviceId?: string
  readonly autoConnect: boolean
}

/** On-device rows plus the remembered profiles that produced them. */
export interface DiscoveredDevice {
  readonly serial: string
  readonly state: string
  readonly model?: string
  readonly transport: Transport
  readonly known: boolean
  readonly deviceId?: string
  readonly name?: string
}

const DEFAULT_PORT = 5555
const PREF_KEY = 'wlan-connection'
const DEVICES_KEY = 'wlan-devices'
const DEFAULT_PREFERENCE: ConnectionPreference = { mode: 'auto', autoConnect: true }

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requireEndpoint(input: Record<string, unknown>): Result<WifiEndpoint> {
  const host = readString(input, 'host')
  if (host === undefined) {
    const combined = readString(input, 'endpoint') ?? readString(input, 'address')
    if (combined !== undefined) {
      const parsed = splitEndpoint(combined, DEFAULT_PORT)
      if (parsed === undefined) return fail(`illegal endpoint "${combined}"`)
      return ok(parsed)
    }
    return fail('wifi device needs "host" (or "endpoint" as host:port)')
  }
  const rawPort = input.port
  const port = typeof rawPort === 'number'
    ? rawPort
    : typeof rawPort === 'string' && rawPort.trim().length > 0
      ? Number.parseInt(rawPort, 10)
      : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return fail(`illegal port "${String(rawPort)}"; expected 1-65535`)
  }
  return ok({ host, port })
}

/** Build the module. Exported as a factory so tests can inject a fake adb. */
export function createWirelessConnectionModule(): PlusModule {
  let context: ModuleContext | null = null
  let preference: ConnectionPreference = DEFAULT_PREFERENCE
  let devices: DeviceProfile[] = []
  let status: ConnectionStatus = {
    mode: 'auto',
    state: 'disconnected',
    message: '尚未连接',
    autoConnect: true,
    checkedAt: new Date().toISOString(),
  }

  function adb(): AdbRunner | null {
    return context?.adb ?? null
  }

  function publish(): void {
    if (context === null) return
    status = { ...status, checkedAt: new Date().toISOString() }
    context.events.publish('wlan-connection', PLUS_EVENTS.connectionStateChanged, status)
  }

  function setState(next: Partial<ConnectionStatus>): void {
    status = { ...status, ...next, checkedAt: new Date().toISOString() }
    publish()
  }

  async function persistPreference(): Promise<void> {
    if (context === null) return
    await context.store.set(PREF_KEY, preference)
  }

  async function persistDevices(): Promise<void> {
    if (context === null) return
    await context.global.set(DEVICES_KEY, devices)
  }

  async function rows(): Promise<readonly AdbDeviceRow[]> {
    const runner = adb()
    if (runner === null) return []
    const result = await runner.run(['devices', '-l'])
    return parseAdbDevices(result.stdout)
  }

  function matchProfile(row: AdbDeviceRow): DeviceProfile | undefined {
    const serial = row.serial
    const endpoint = splitEndpoint(serial, DEFAULT_PORT)
    return devices.find((device) => {
      if (device.transport === 'usb') return device.serial === serial
      return endpoint !== undefined
        && device.wifi?.host === endpoint.host
        && device.wifi?.port === endpoint.port
    })
  }

  function candidates(): readonly DeviceProfile[] {
    return devices
      .filter(device => device.transport === 'wifi' && device.wifi !== undefined)
      .toSorted((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
        return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')
      })
  }

  async function touch(deviceId: string): Promise<void> {
    const at = new Date().toISOString()
    devices = devices.map(device => (device.id === deviceId ? { ...device, lastUsedAt: at } : device))
    await persistDevices()
  }

  /** Connect over USB: accept the first authorized row that is not a network endpoint. */
  async function connectUsb(): Promise<Result<ConnectionStatus>> {
    const online = (await rows()).filter(row => row.state === 'device' && splitEndpoint(row.serial, DEFAULT_PORT) === undefined)
    if (online.length === 0) return fail('no authorized USB device found')
    const row = online[0]!
    const profile = matchProfile(row)
    if (profile !== undefined) await touch(profile.id)
    setState({
      state: 'connected',
      transport: 'usb',
      serial: row.serial,
      deviceId: profile?.id,
      deviceName: profile?.name ?? row.model ?? row.serial,
      endpoint: undefined,
      lastError: undefined,
      message: `已通过 USB 连接 ${row.model ?? row.serial}`,
    })
    return ok(status)
  }

  async function connectWifi(device: DeviceProfile): Promise<Result<ConnectionStatus>> {
    const runner = adb()
    const endpoint = device.wifi
    if (runner === null || endpoint === undefined) return fail('wifi connection needs adb and an endpoint')
    const target = `${endpoint.host}:${endpoint.port}`
    setState({ state: 'connecting', message: `正在连接 ${target} …`, lastError: undefined })
    const result = await runner.run(['connect', target])
    const output = `${result.stdout}${result.stderr}`
    if (/connected to|already connected/i.test(output) === false) {
      const message = output.trim() || `adb connect ${target} 未返回成功信息`
      setState({ state: 'error', message: `连接 ${target} 失败`, lastError: message })
      return fail(message)
    }
    await touch(device.id)
    setState({
      state: 'connected',
      transport: 'wifi',
      endpoint,
      deviceId: device.id,
      deviceName: device.name,
      serial: target,
      lastError: undefined,
      message: `已通过 WiFi 连接 ${device.name} (${target})`,
    })
    return ok(status)
  }

  async function connectAuto(): Promise<Result<ConnectionStatus>> {
    const usb = await connectUsb()
    if (usb.ok) return usb
    const ordered = candidates()
    if (ordered.length === 0) {
      setState({
        state: 'disconnected',
        message: 'USB 未连接，且没有可用的 WiFi 设备',
        lastError: usb.error,
      })
      return fail('no USB device and no saved WiFi device')
    }
    const errors: string[] = [usb.error]
    for (const device of ordered) {
      const attempt = await connectWifi(device)
      if (attempt.ok) return attempt
      errors.push(attempt.error)
    }
    setState({ state: 'error', message: '自动连接失败', lastError: errors.join('; ') })
    return fail(errors.join('; '))
  }

  const module = defineModule({
    id: 'wlan-connection',
    name: '无线调试连接',
    version: '0.1.0',
    summary: 'USB / WiFi / 自动三种连接模式，记住最近设备并在界面实时反馈连接状态。',

    methods: {
      async status() {
        await refresh()
        return status
      },

      async setMode(input) {
        const mode = readString(input, 'mode')
        if (mode !== 'usb' && mode !== 'wifi' && mode !== 'auto') {
          return fail('mode must be one of usb | wifi | auto')
        }
        const autoConnect = input.autoConnect === undefined
          ? preference.autoConnect
          : input.autoConnect === true
        preference = { ...preference, mode, autoConnect }
        await persistPreference()
        setState({ mode, autoConnect, message: `连接模式已切换为 ${mode}` })
        return status
      },

      /** Probe adb and report every row, marked with whether we remember it. */
      async discover() {
        const online = await rows()
        const found: DiscoveredDevice[] = online.map((row) => {
          const profile = matchProfile(row)
          return {
            serial: row.serial,
            state: row.state,
            transport: splitEndpoint(row.serial, DEFAULT_PORT) === undefined ? 'usb' : 'wifi',
            known: profile !== undefined,
            ...(row.model === undefined ? {} : { model: row.model }),
            ...(profile === undefined ? {} : { deviceId: profile.id, name: profile.name }),
          }
        })
        return { devices: found, mode: preference.mode }
      },

      async listDevices() {
        return { devices, mode: preference.mode, defaultDeviceId: preference.defaultDeviceId }
      },

      async saveDevice(input) {
        const name = readString(input, 'name')
        const transport = readString(input, 'transport') === 'usb' ? 'usb' : 'wifi'
        const id = readString(input, 'id') ?? createId('dev')
        const now = new Date().toISOString()
        let profile: DeviceProfile

        if (transport === 'usb') {
          const serial = readString(input, 'serial')
          if (serial === undefined) return fail('usb device needs "serial"')
          const existing = devices.find(device => device.id === id)
          profile = {
            id,
            name: name ?? serial,
            transport: 'usb',
            serial,
            favorite: input.favorite === true,
            createdAt: existing?.createdAt ?? now,
            ...(readString(input, 'model') === undefined
              ? (existing?.model === undefined ? {} : { model: existing.model })
              : { model: readString(input, 'model')! }),
            ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
          }
        }
        else {
          const endpoint = requireEndpoint(input)
          if (!endpoint.ok) return endpoint
          const existing = devices.find(device => device.id === id)
          profile = {
            id,
            name: name ?? `${endpoint.value.host}:${endpoint.value.port}`,
            transport: 'wifi',
            wifi: endpoint.value,
            favorite: input.favorite === true,
            createdAt: existing?.createdAt ?? now,
            ...(readString(input, 'model') === undefined
              ? (existing?.model === undefined ? {} : { model: existing.model })
              : { model: readString(input, 'model')! }),
            ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
          }
        }

        devices = devices.some(device => device.id === profile.id)
          ? devices.map(device => (device.id === profile.id ? profile : device))
          : [...devices, profile]
        await persistDevices()
        return { device: profile, devices }
      },

      async removeDevice(input) {
        const id = readString(input, 'id')
        if (id === undefined) return fail('removeDevice needs "id"')
        const before = devices.length
        devices = devices.filter(device => device.id !== id)
        if (devices.length === before) return fail(`unknown device "${id}"`)
        if (preference.defaultDeviceId === id) {
          preference = { ...preference, defaultDeviceId: undefined }
          await persistPreference()
        }
        await persistDevices()
        return { removed: id, devices }
      },

      async connect(input) {
        const mode = readString(input, 'mode') ?? preference.mode
        const deviceId = readString(input, 'id') ?? readString(input, 'deviceId') ?? preference.defaultDeviceId

        if (mode === 'usb') return connectUsb()
        if (mode === 'wifi') {
          const device = deviceId === undefined
            ? candidates()[0]
            : devices.find(candidate => candidate.id === deviceId)
          if (device === undefined) return fail('no WiFi device saved; call saveDevice first')
          return connectWifi(device)
        }
        return connectAuto()
      },

      async disconnect(input) {
        const runner = adb()
        const target = readString(input, 'endpoint')
          ?? (status.endpoint === undefined ? undefined : `${status.endpoint.host}:${status.endpoint.port}`)
        if (runner !== null && target !== undefined) await runner.run(['disconnect', target])
        setState({
          state: 'disconnected',
          transport: undefined,
          serial: undefined,
          endpoint: undefined,
          deviceId: undefined,
          deviceName: undefined,
          message: target === undefined ? '已断开' : `已断开 ${target}`,
        })
        return status
      },

      /**
       * Android 11+ wireless pairing. The pairing code and port come from
       * Developer options > Wireless debugging > Pair device with pairing code.
       */
      async pair(input) {
        const runner = adb()
        if (runner === null) return fail('pair needs adb')
        const endpoint = requireEndpoint(input)
        if (!endpoint.ok) return endpoint
        const code = readString(input, 'code')
        if (code === undefined) return fail('pair needs "code"')
        const target = `${endpoint.value.host}:${endpoint.value.port}`
        const result = await runner.run(['pair', target, code])
        const output = `${result.stdout}${result.stderr}`
        if (/successfully paired|paired/i.test(output) === false) {
          return fail(output.trim() || `adb pair ${target} failed`)
        }
        return { paired: true, endpoint: endpoint.value }
      },

      /**
       * Switch a USB-attached phone to TCP/IP so it can be unplugged.
       * Must be called while the cable is still connected.
       */
      async enableTcpip(input) {
        const runner = adb()
        if (runner === null) return fail('enableTcpip needs adb')
        const rawPort = input.port
        const port = typeof rawPort === 'number' && Number.isInteger(rawPort) ? rawPort : DEFAULT_PORT
        const serial = readString(input, 'serial')
        const prefix = serial === undefined ? [] : ['-s', serial]
        const result = await runner.run([...prefix, 'tcpip', String(port)])
        const output = `${result.stdout}${result.stderr}`
        if (/restarting in tcp mode|restarting/i.test(output) === false) {
          return fail(output.trim() || `adb tcpip ${port} failed`)
        }
        return { port, message: `设备已切换到 TCP/IP 端口 ${port}，可拔掉数据线后用 WiFi 连接` }
      },

      /** Called on boot when `autoConnect` is on. */
      async autoConnect() {
        if (preference.autoConnect === false) return { skipped: true, status }
        const result = await connectAuto()
        return { skipped: false, ok: result.ok, status }
      },
    },

    methodSpecs: [
      { name: 'status', summary: '刷新并返回当前连接状态' },
      { name: 'setMode', summary: '设置连接模式', input: { mode: 'usb | wifi | auto', autoConnect: '启动时是否自动连接' } },
      { name: 'discover', summary: '探测 adb 当前可见的设备' },
      { name: 'listDevices', summary: '列出已保存的设备' },
      { name: 'saveDevice', summary: '保存设备', input: { transport: 'usb | wifi', serial: 'USB 序列号', host: 'WiFi 地址', port: '端口，默认 5555', name: '备注名' } },
      { name: 'removeDevice', summary: '删除已保存设备', input: { id: '设备 id' } },
      { name: 'connect', summary: '按当前或指定模式连接', input: { mode: '可选覆盖', id: '可选指定设备' } },
      { name: 'disconnect', summary: '断开当前连接' },
      { name: 'pair', summary: 'Android 11+ 无线配对', input: { host: '配对地址', port: '配对端口', code: '配对码' } },
      { name: 'enableTcpip', summary: '将 USB 设备切换到 TCP/IP', input: { serial: '可选序列号', port: '端口，默认 5555' } },
      { name: 'autoConnect', summary: '启动时自动连接（内部调用）' },
    ],

    async start(ctx) {
      context = ctx
      const storedDevices = await ctx.global.get(DEVICES_KEY, [] as readonly DeviceProfile[])
      if (Array.isArray(storedDevices)) {
        devices = storedDevices.filter(isJsonRecord).map(row => normaliseProfile(row)).filter((row): row is DeviceProfile => row !== null)
      }
      const storedPreference = await ctx.store.get(PREF_KEY, DEFAULT_PREFERENCE)
      if (isJsonRecord(storedPreference)) {
        const mode = readString(storedPreference, 'mode')
        preference = {
          mode: mode === 'usb' || mode === 'wifi' || mode === 'auto' ? mode : 'auto',
          autoConnect: storedPreference.autoConnect !== false,
          ...(readString(storedPreference, 'defaultDeviceId') === undefined
            ? {}
            : { defaultDeviceId: readString(storedPreference, 'defaultDeviceId')! }),
        }
      }
      setState({ mode: preference.mode, autoConnect: preference.autoConnect, message: '配置已加载' })
      if (preference.autoConnect && ctx.capabilities.adb) {
        // Deliberately not awaited: startup must not block on a phone that
        // is not there yet. The console picks up the state change event.
        void module.methods.autoConnect!({})
      }
    },

    async reseat(ctx) {
      context = ctx
      const storedPreference = await ctx.store.get(PREF_KEY, DEFAULT_PREFERENCE)
      if (isJsonRecord(storedPreference)) {
        const mode = readString(storedPreference, 'mode')
        preference = {
          mode: mode === 'usb' || mode === 'wifi' || mode === 'auto' ? mode : 'auto',
          autoConnect: storedPreference.autoConnect !== false,
          ...(readString(storedPreference, 'defaultDeviceId') === undefined
            ? {}
            : { defaultDeviceId: readString(storedPreference, 'defaultDeviceId')! }),
        }
      }
      setState({ mode: preference.mode, autoConnect: preference.autoConnect, message: '已切换到新项目的连接配置' })
    },

    async stop() {
      context = null
    },

    async health() {
      return {
        healthy: adb() !== null,
        detail: adb() === null ? 'adb 不可用，仅可管理配置' : `adb: ${adb()!.binary}`,
      }
    },
  })

  async function refresh(): Promise<void> {
    const runner = adb()
    if (runner === null || status.state === 'connected') return
    const online = await rows()
    const hit = online.find(row => row.state === 'device'
      && (row.serial === status.serial || (status.endpoint !== undefined && row.serial === `${status.endpoint.host}:${status.endpoint.port}`)))
    if (hit === undefined) return
    setState({ state: 'connected', message: `已连接 ${hit.model ?? hit.serial}` })
  }

  return module
}

/** Coerce a stored JSON row into a DeviceProfile, dropping malformed entries. */
function normaliseProfile(row: Record<string, unknown>): DeviceProfile | null {
  const id = readString(row, 'id')
  const transport: Transport = row.transport === 'usb' ? 'usb' : 'wifi'
  if (id === undefined) return null
  const base = {
    id,
    name: readString(row, 'name') ?? id,
    transport,
    favorite: row.favorite === true,
    createdAt: readString(row, 'createdAt') ?? new Date(0).toISOString(),
    ...(readString(row, 'model') === undefined ? {} : { model: readString(row, 'model')! }),
    ...(readString(row, 'lastUsedAt') === undefined ? {} : { lastUsedAt: readString(row, 'lastUsedAt')! }),
  }
  if (transport === 'usb') {
    const serial = readString(row, 'serial')
    return serial === undefined ? null : { ...base, serial }
  }
  const wifi = requireEndpoint(row)
  return wifi.ok ? { ...base, wifi: wifi.value } : null
}

export { DEFAULT_PORT as DEFAULT_ADB_PORT }
export type { AdbDeviceRow }
