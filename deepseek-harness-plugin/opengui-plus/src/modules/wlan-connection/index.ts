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

import { execFile } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { promisify } from 'node:util'

import type { AdbRunner, AdbRunResult } from '../../core/adb-runner.js'
import { PLUS_EVENTS } from '../../core/events.js'
import { createId } from '../../core/id.js'
import { defineModule, type ModuleContext, type PlusModule } from '../../core/module.js'
import type { Iso8601, Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'
import { parseAdbDevices, splitEndpoint } from './parse.js'
import type { AdbDeviceRow } from './parse.js'
import {
  MDNS_CONNECT_TYPE,
  MDNS_PAIRING_TYPE,
  findMdnsService,
  isPairSuccess,
  normalisePairingCode,
  parseMdnsServices,
  parsePairOutcome,
  parsePairingQr,
} from './pairing.js'
import type { MdnsService, PairingQrPayload } from './pairing.js'
import { encodeQr, renderQrAscii, renderQrPng } from './qrcode.js'

const execFileAsync = promisify(execFile)

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
  /**
   * Android 11+ pairing port, remembered so a later re-pair does not need the
   * phone in hand. Distinct from {@link DeviceProfile.wifi}, which is the
   * connect port.
   */
  readonly pairingPort?: number
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
/** Pairing waits on a human to read a code off the phone, so be patient. */
const PAIR_TIMEOUT_MS = 30_000
const MDNS_TIMEOUT_MS = 15_000
/** Only command-line QR decoder worth probing for; see `decodePairingQr`. */
const DEFAULT_QR_DECODER = 'zbarimg'
const PAIRING_QR_SERVICE_PREFIX = 'opengui-plus'
const QR_SCAN_TIMEOUT_MS = 60_000
const QR_SCAN_POLL_MS = 750

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Optional Android 11+ pairing port, kept next to the connect port. */
function readPairingPort(input: Record<string, unknown>): number | undefined {
  const raw = input.pairingPort
  const port = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim().length > 0
      ? Number.parseInt(raw, 10)
      : undefined
  return port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535 ? undefined : port
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

  /** Merge two failed pairing attempts into one readable error. */
  function mergeFailures(first: AdbRunResult, second: AdbRunResult): AdbRunResult {
    // Both attempts usually fail for the same reason; keep each line once.
    const output = [...new Set([first.stdout, first.stderr, second.stdout, second.stderr]
      .map(part => part.trim())
      .filter(part => part.length > 0))].join('\n')
    return { stdout: output, stderr: '', code: first.code !== 0 ? first.code : second.code }
  }

  /**
   * Run `adb pair <host:port>`.
   *
   * Older platform-tools builds prompt for the code on stdin, newer ones take
   * it as an argument. Try stdin first and fall back to the argument form, so
   * both work without probing the adb version.
   */
  async function runPair(runner: AdbRunner, target: string, code: string): Promise<AdbRunResult> {
    if (typeof runner.runWithStdin === 'function') {
      const piped = await runner.runWithStdin(['pair', target], `${code}\n`, PAIR_TIMEOUT_MS)
      if (isPairSuccess(`${piped.stdout}${piped.stderr}`)) return piped
      const asArgument = await runner.run(['pair', target, code], PAIR_TIMEOUT_MS)
      return isPairSuccess(`${asArgument.stdout}${asArgument.stderr}`)
        ? asArgument
        : mergeFailures(piped, asArgument)
    }
    return runner.run(['pair', target, code], PAIR_TIMEOUT_MS)
  }

  /** Read a pairing code, tolerating `code` / `pairingCode` and human spacing. */
  function readPairingCode(input: Record<string, unknown>): Result<string> {
    const raw = readString(input, 'code') ?? readString(input, 'pairingCode')
    if (raw === undefined) return fail('需要 "code"（Android 无线调试的 6 位配对码）')
    const code = normalisePairingCode(raw)
    if (/^\d+$/.test(code) === false) return fail(`配对码 "${raw}" 不是纯数字`)
    if (code.length < 4 || code.length > 12) return fail(`配对码长度 ${code.length} 位异常，Android 通常为 6 位数字`)
    return ok(code)
  }

  /** Generate the Android Studio-compatible QR text shown to the phone. */
  function makePairingQr(input: Record<string, unknown>): {
    readonly qrText: string
    readonly serviceName: string
    readonly pairingCode: string
    readonly ecLevel: 'M'
    readonly version: number
    readonly mask: number
    readonly ascii: string
    readonly dataUrl: string
    readonly pngBase64: string
  } {
    const requestedName = readString(input, 'serviceName') ?? readString(input, 'name')
    const serviceName = requestedName === undefined
      ? `${PAIRING_QR_SERVICE_PREFIX}-${randomBytes(4).toString('hex')}`
      : requestedName.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63)
    if (serviceName.length === 0) throw new Error('serviceName 不能为空，且只能包含 ASCII 字母、数字、点、下划线或连字符')
    const requestedCode = readString(input, 'code') ?? readString(input, 'pairingCode')
    const pairingCode = requestedCode === undefined
      ? randomInt(0, 1_000_000).toString().padStart(6, '0')
      : normalisePairingCode(requestedCode)
    if (/^\d{6}$/.test(pairingCode) === false) throw new Error('二维码配对码必须是 6 位数字')

    const qrText = `WIFI:T:ADB;S:${serviceName};P:${pairingCode};;`
    const qr = encodeQr(qrText, 'M')
    const scale = typeof input.scale === 'number' && Number.isFinite(input.scale) ? input.scale : 8
    const png = renderQrPng(qr, { scale })
    return {
      qrText,
      serviceName,
      pairingCode,
      ecLevel: 'M',
      version: qr.version,
      mask: qr.mask,
      ascii: renderQrAscii(qr),
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      pngBase64: png.toString('base64'),
    }
  }

  /** Wait until the phone advertises the service after scanning our QR. */
  async function waitForPairingService(serviceName: string, timeoutMs: number, pollMs: number): Promise<Result<MdnsService>> {
    const deadline = Date.now() + timeoutMs
    let lastSeen: readonly MdnsService[] = []
    while (Date.now() <= deadline) {
      lastSeen = await mdnsRows()
      const hit = findMdnsService(lastSeen, serviceName, MDNS_PAIRING_TYPE)
        ?? (lastSeen.filter(service => service.type.toLowerCase().includes(MDNS_PAIRING_TYPE)).length === 1
          ? lastSeen.find(service => service.type.toLowerCase().includes(MDNS_PAIRING_TYPE))
          : undefined)
      if (hit !== undefined) return ok(hit)
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs, remaining)))
    }
    const seen = lastSeen.map(service => `${service.name} ${service.type} ${service.host}:${service.port}`)
    return fail(`手机扫描二维码后仍未发现配对服务 "${serviceName}"。`
      + (seen.length === 0 ? '当前 mDNS 没有 adb 服务。' : `当前发现：${seen.join(' | ')}`)
      + '请保持手机无线调试配对页面前台，并确认电脑与手机在同一局域网。')
  }

  function isGeneratedQrInput(input: Record<string, unknown>): boolean {
    return input.generate === true || input.waitForScan === true || input.computerGenerated === true
  }

  /** Decode a QR image using an external decoder; we ship no decoder of our own. */
  async function decodeQrImage(file: string, decoder: string): Promise<Result<string>> {
    try {
      const { stdout } = await execFileAsync(decoder, ['--raw', '-q', file], {
        timeout: MDNS_TIMEOUT_MS,
        windowsHide: true,
      })
      const text = stdout.trim()
      return text.length === 0 ? fail(`${decoder} 未从图片中识别出二维码内容`) : ok(text)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/ENOENT/.test(message)) {
        return fail(`未找到二维码解码器 "${decoder}"。可安装 ZBar（Windows: scoop install zbar / choco install zbar），`
          + '或改用手机把二维码扫出来后把文本传给 qrText。')
      }
      return fail(`二维码解码失败: ${message}`)
    }
  }

  /** Reduce an input carrying a QR (raw text or image path) to a parsed payload. */
  async function resolveQrPayload(input: Record<string, unknown>): Promise<Result<PairingQrPayload>> {
    const text = readString(input, 'qr') ?? readString(input, 'qrText') ?? readString(input, 'text')
    if (text !== undefined) return parsePairingQr(text)
    const image = readString(input, 'image') ?? readString(input, 'path') ?? readString(input, 'file')
    if (image === undefined) return fail('需要 "qr"/"qrText"（二维码文本）或 "image"（二维码图片路径）')
    const decoder = readString(input, 'decoder') ?? DEFAULT_QR_DECODER
    const decoded = await decodeQrImage(image, decoder)
    if (!decoded.ok) return decoded
    return parsePairingQr(decoded.value)
  }

  /** `adb mdns services`, parsed. Empty when adb is unavailable. */
  async function mdnsRows(): Promise<readonly MdnsService[]> {
    const runner = adb()
    if (runner === null) return []
    const result = await runner.run(['mdns', 'services'], MDNS_TIMEOUT_MS)
    return parseMdnsServices(`${result.stdout}${result.stderr}`)
  }

  /** Remember the pairing port on a device we already know by host. */
  async function rememberPairingPort(host: string, port: number): Promise<void> {
    let changed = false
    devices = devices.map((device) => {
      if (device.transport !== 'wifi' || device.wifi?.host !== host || device.pairingPort === port) return device
      changed = true
      return { ...device, pairingPort: port }
    })
    if (changed) await persistDevices()
  }

  /** Create or update the WiFi profile for a freshly paired phone. */
  async function upsertWifiDevice(
    host: string,
    port: number,
    name: string,
    pairingPort?: number,
  ): Promise<DeviceProfile> {
    const now = new Date().toISOString()
    const existing = devices.find(device => device.transport === 'wifi' && device.wifi?.host === host)
    const profile: DeviceProfile = {
      id: existing?.id ?? createId('dev'),
      name: existing?.name ?? name,
      transport: 'wifi',
      wifi: { host, port },
      favorite: existing?.favorite ?? false,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      ...(pairingPort === undefined ? {} : { pairingPort }),
      ...(existing?.model === undefined ? {} : { model: existing.model }),
    }
    devices = existing === undefined ? [...devices, profile] : devices.map(device => (device.id === profile.id ? profile : device))
    await persistDevices()
    return profile
  }

  /** Run `adb pair` and fold the outcome into module state. */
  async function executePair(endpoint: WifiEndpoint, code: string): Promise<Result<{
    readonly paired: true
    readonly endpoint: WifiEndpoint
    readonly guid?: string
    readonly message: string
  }>> {
    const runner = adb()
    if (runner === null) return fail('配对需要 adb')
    const target = `${endpoint.host}:${endpoint.port}`
    setState({ state: 'connecting', message: `正在配对 ${target} …`, lastError: undefined })
    const result = await runPair(runner, target, code)
    const outcome = parsePairOutcome(`${result.stdout}${result.stderr}`)
    if (outcome.paired === false) {
      setState({ state: 'error', message: `配对 ${target} 失败`, lastError: outcome.message })
      return fail(outcome.message)
    }
    await rememberPairingPort(endpoint.host, endpoint.port)
    setState({
      state: 'disconnected',
      message: `已与 ${target} 完成配对`,
      lastError: undefined,
    })
    return ok({
      paired: true,
      endpoint: outcome.endpoint === undefined
        ? endpoint
        : { host: outcome.endpoint.host, port: outcome.endpoint.port },
      ...(outcome.guid === undefined ? {} : { guid: outcome.guid }),
      message: outcome.message,
    })
  }

  /** True when the input carries a QR (raw text or an image to decode). */
  function hasQr(input: Record<string, unknown>): boolean {
    return readString(input, 'qr') !== undefined
      || readString(input, 'qrText') !== undefined
      || readString(input, 'text') !== undefined
      || readString(input, 'image') !== undefined
      || readString(input, 'path') !== undefined
      || readString(input, 'file') !== undefined
  }

  /**
   * Decide which `host:port` to pair against.
   *
   * Priority: explicit host/port → endpoint inlined in the QR → the mDNS row
   * matching the QR's service name.
   */
  async function resolvePairingTarget(
    input: Record<string, unknown>,
    payload?: PairingQrPayload,
  ): Promise<Result<{ readonly endpoint: WifiEndpoint, readonly serviceName?: string, readonly via: string }>> {
    if (readString(input, 'host') !== undefined || input.port !== undefined) {
      const explicit = requireEndpoint(input)
      if (!explicit.ok) return explicit
      return ok({ endpoint: explicit.value, via: 'input' })
    }
    if (payload?.endpoint !== undefined) {
      const inline = payload.endpoint
      return ok({
        endpoint: { host: inline.host, port: inline.port },
        serviceName: payload.serviceName,
        via: 'qr-inline',
      })
    }
    if (payload !== undefined) {
      const services = await mdnsRows()
      const hit = findMdnsService(services, payload.serviceName, MDNS_PAIRING_TYPE)
        ?? findMdnsService(services, payload.serviceName)
      if (hit !== undefined) {
        return ok({
          endpoint: { host: hit.host, port: hit.port },
          serviceName: payload.serviceName,
          via: 'mdns',
        })
      }
      const seen = services.map(service => `${service.name} ${service.type} ${service.host}:${service.port}`)
      return fail(`二维码里的服务 "${payload.serviceName}" 没有出现在 adb mdns services 的结果中。`
        + '请确认手机停留在“使用二维码配对设备”界面且与电脑处于同一局域网；'
        + '也可以直接传 host + port（手机“使用配对码配对设备”界面上显示的地址）。'
        + (seen.length === 0 ? '当前 mDNS 未发现任何 adb 服务。' : `当前发现：${seen.join(' | ')}`))
    }
    return fail('无法确定配对地址：请传 host + port，或提供二维码内容')
  }

  /** Connect port: explicit → mDNS `_adb-tls-connect` (same host first) → 5555. */
  async function resolveConnectPort(host: string, requested: number | undefined): Promise<{ readonly port: number, readonly via: string }> {
    if (requested !== undefined) return { port: requested, via: 'input' }
    const services = await mdnsRows()
    const connect = services.filter(service => service.type.toLowerCase().includes(MDNS_CONNECT_TYPE))
    const hit = connect.find(service => service.host === host) ?? connect[0]
    return hit === undefined ? { port: DEFAULT_PORT, via: 'default' } : { port: hit.port, via: 'mdns' }
  }

  async function connectWifiEndpoint(endpoint: WifiEndpoint, name: string): Promise<Result<ConnectionStatus>> {
    const runner = adb()
    if (runner === null) return fail('wifi connection needs adb')
    const target = `${endpoint.host}:${endpoint.port}`
    const result = await runner.run(['connect', target])
    const output = `${result.stdout}${result.stderr}`
    if (/connected to|already connected/i.test(output) === false) {
      return fail(output.trim() || `adb connect ${target} 未返回成功信息`)
    }
    setState({
      state: 'connected',
      transport: 'wifi',
      endpoint,
      deviceName: name,
      serial: target,
      lastError: undefined,
      message: `已通过 WiFi 连接 ${name} (${target})`,
    })
    return ok(status)
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
          const pairingPort = readPairingPort(input) ?? existing?.pairingPort
          profile = {
            id,
            name: name ?? `${endpoint.value.host}:${endpoint.value.port}`,
            transport: 'wifi',
            wifi: endpoint.value,
            favorite: input.favorite === true,
            createdAt: existing?.createdAt ?? now,
            ...(pairingPort === undefined ? {} : { pairingPort }),
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
       * Android 11+ wireless pairing — one entry point for both flows.
       *
       * Six-digit code: `{ host, port, code }`, where `port` is the *pairing*
       * port shown on the phone, not the connect port.
       * QR code: `{ qr | qrText | image }`.
       */
      async pair(input) {
        const runner = adb()
        if (runner === null) return fail('pair needs adb')
        if (isGeneratedQrInput(input)) return module.methods.startQrPairing!(input)
        if (hasQr(input)) return module.methods.pairWithQr!(input)
        return module.methods.pairWithCode!(input)
      },

      /**
       * Generate a QR for the reverse flow: the computer displays it and the
       * phone scans it. `qrText` is intentionally returned alongside PNG/ASCII
       * so a web console can render the image while a CLI can print the text.
       */
      async generatePairingQr(input) {
        try {
          return makePairingQr(input)
        }
        catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },

      /**
       * Pair with the six-digit code from
       * Developer options > Wireless debugging > Pair device with pairing code.
       */
      async pairWithCode(input) {
        const code = readPairingCode(input)
        if (!code.ok) return code
        const endpoint = requireEndpoint(input)
        if (!endpoint.ok) return endpoint
        const paired = await executePair(endpoint.value, code.value)
        if (!paired.ok) return paired
        return {
          ...paired.value,
          hint: '配对只授权本机一次；连接要用 adb 连接端口（通常 5555），可调用 pairAndConnect 一步完成。',
        }
      },

      /**
       * Computer-generated QR flow: display the QR, wait for the phone's mDNS
       * pairing advertisement, then run adb pair and optionally connect.
       */
      async startQrPairing(input) {
        if (adb() === null) return fail('startQrPairing needs adb')
        const generated = makePairingQr(input)
        const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
          ? Math.max(1_000, Math.trunc(input.timeoutMs))
          : QR_SCAN_TIMEOUT_MS
        const pollMs = typeof input.pollMs === 'number' && Number.isFinite(input.pollMs)
          ? Math.max(100, Math.trunc(input.pollMs))
          : QR_SCAN_POLL_MS
        setState({ state: 'connecting', message: `请用手机扫描二维码，然后等待 ${generated.serviceName} 出现 …`, lastError: undefined })
        const service = await waitForPairingService(generated.serviceName, timeoutMs, pollMs)
        if (!service.ok) {
          setState({ state: 'error', message: '等待手机扫描二维码超时', lastError: service.error })
          return { ...service, qr: generated }
        }
        const paired = await executePair({ host: service.value.host, port: service.value.port }, generated.pairingCode)
        if (!paired.ok) return { ...paired, qr: generated, service: service.value }
        if (input.connect === false) return { ...paired.value, qr: generated, service: service.value, connected: false }
        const requested = typeof input.connectPort === 'number' && Number.isInteger(input.connectPort)
          ? input.connectPort
          : undefined
        const connect = await resolveConnectPort(service.value.host, requested)
        const connectEndpoint: WifiEndpoint = { host: service.value.host, port: connect.port }
        const name = readString(input, 'deviceName') ?? readString(input, 'name') ?? service.value.name
        const connected = await connectWifiEndpoint(connectEndpoint, name)
        if (!connected.ok) {
          return {
            paired: true,
            connected: false,
            pairingEndpoint: { host: service.value.host, port: service.value.port },
            connectEndpoint,
            error: connected.error,
            qr: generated,
            service: service.value,
            hint: '配对已成功，但连接失败；可稍后单独调用 connect 或传入正确的 connectPort。',
          }
        }
        let deviceId: string | undefined
        if (input.save !== false) {
          const profile = await upsertWifiDevice(service.value.host, connect.port, name, service.value.port)
          deviceId = profile.id
        }
        return {
          paired: true,
          connected: true,
          qr: generated,
          service: service.value,
          pairingEndpoint: { host: service.value.host, port: service.value.port },
          connectEndpoint,
          connectPortResolvedBy: connect.via,
          ...(deviceId === undefined ? {} : { deviceId }),
          status,
        }
      },

      /**
       * Pair by scanning the QR shown under
       * Wireless debugging > Pair device with QR code.
       *
       * The QR carries a service name, not an address, on stock Android and
       * HyperOS; the host and pairing port are resolved through
       * `adb mdns services`. Pass `host`/`port` to skip discovery.
       */
      async pairWithQr(input) {
        if (isGeneratedQrInput(input)) return module.methods.startQrPairing!(input)
        const payload = await resolveQrPayload(input)
        if (!payload.ok) return payload
        const override = readString(input, 'code') ?? readString(input, 'pairingCode')
        const code = override === undefined ? payload.value.pairingCode : normalisePairingCode(override)
        if (/^\d+$/.test(code) === false) return fail(`配对码 "${code}" 不是纯数字`)
        const target = await resolvePairingTarget(input, payload.value)
        if (!target.ok) return target
        const paired = await executePair(target.value.endpoint, code)
        if (!paired.ok) return paired
        return {
          ...paired.value,
          serviceName: payload.value.serviceName,
          pairingCode: code,
          resolvedBy: target.value.via,
        }
      },

      /**
       * Pair and connect in one call. This is what a workflow actually wants:
       * pairing alone does not give you an adb transport.
       *
       * The connect port defaults to the mDNS `_adb-tls-connect` port and
       * falls back to 5555; pass `connectPort` to pin it.
       */
      async pairAndConnect(input) {
        if (adb() === null) return fail('pairAndConnect needs adb')

        let code: string
        let endpoint: WifiEndpoint
        let serviceName: string | undefined
        let resolvedBy: string

        if (hasQr(input)) {
          const payload = await resolveQrPayload(input)
          if (!payload.ok) return payload
          const override = readString(input, 'code') ?? readString(input, 'pairingCode')
          code = override === undefined ? payload.value.pairingCode : normalisePairingCode(override)
          if (/^\d+$/.test(code) === false) return fail(`配对码 "${code}" 不是纯数字`)
          const target = await resolvePairingTarget(input, payload.value)
          if (!target.ok) return target
          endpoint = target.value.endpoint
          serviceName = payload.value.serviceName
          resolvedBy = target.value.via
        }
        else {
          const read = readPairingCode(input)
          if (!read.ok) return read
          const target = await resolvePairingTarget(input)
          if (!target.ok) return target
          code = read.value
          endpoint = target.value.endpoint
          resolvedBy = target.value.via
        }

        const paired = await executePair(endpoint, code)
        if (!paired.ok) return paired

        const requested = typeof input.connectPort === 'number' && Number.isInteger(input.connectPort)
          ? input.connectPort
          : undefined
        const connect = await resolveConnectPort(endpoint.host, requested)
        const connectEndpoint: WifiEndpoint = { host: endpoint.host, port: connect.port }
        const name = readString(input, 'name') ?? `${endpoint.host}:${connect.port}`
        const connected = await connectWifiEndpoint(connectEndpoint, name)
        if (!connected.ok) {
          return {
            paired: true,
            connected: false,
            pairingEndpoint: endpoint,
            connectEndpoint,
            error: connected.error,
            hint: '配对已成功，但连接失败：确认手机上无线调试处于开启状态、连接端口正确，且电脑与手机在同一局域网。',
          }
        }

        let deviceId: string | undefined
        if (input.save !== false) {
          const profile = await upsertWifiDevice(endpoint.host, connect.port, name, endpoint.port)
          deviceId = profile.id
        }

        return {
          paired: true,
          connected: true,
          pairingEndpoint: endpoint,
          connectEndpoint,
          connectPortResolvedBy: connect.via,
          ...(serviceName === undefined ? {} : { serviceName }),
          resolvedBy,
          ...(deviceId === undefined ? {} : { deviceId }),
          status,
          message: `已配对并连接 ${name} (${endpoint.host}:${connect.port})`,
        }
      },

      /** List what `adb mdns services` can see, split into pairing/connect. */
      async mdnsServices() {
        const services = await mdnsRows()
        const pairing = services.filter(service => service.type.toLowerCase().includes(MDNS_PAIRING_TYPE))
        const connect = services.filter(service => service.type.toLowerCase().includes(MDNS_CONNECT_TYPE))
        return {
          services,
          pairing,
          connect,
          adb: adb() !== null,
          hint: pairing.length === 0
            ? '没有发现配对服务：请打开手机“无线调试 → 使用配对码配对设备 / 使用二维码配对设备”界面并保持该页面前台。'
            : '配对端口与连接端口不同：配对用 pairing 里的端口，连接用 connect 里的端口（或默认 5555）。',
        }
      },

      /** Parse a QR payload without touching adb — useful for validating a paste. */
      async parsePairingQr(input) {
        const payload = await resolveQrPayload(input)
        return payload.ok ? payload.value : payload
      },

      /**
       * Decode a QR image with an external decoder.
       *
       * We deliberately ship no decoder: a correct QR implementation cannot be
       * written as a few dozen lines, so this shells out to `zbarimg` and says
       * so when it is missing. Pasting the decoded text into `qrText` works
       * without installing anything.
       */
      async decodePairingQr(input) {
        const image = readString(input, 'image') ?? readString(input, 'path') ?? readString(input, 'file')
        if (image === undefined) return fail('decodePairingQr needs "image"（二维码图片路径）')
        const decoder = readString(input, 'decoder') ?? DEFAULT_QR_DECODER
        const decoded = await decodeQrImage(image, decoder)
        if (!decoded.ok) return decoded
        const parsed = parsePairingQr(decoded.value)
        if (!parsed.ok) return parsed
        return { text: decoded.value, ...parsed.value }
      },

      /** Static guidance an agent can read out loud while the user looks at the phone. */
      async pairingGuide() {
        return {
          requires: 'Android 11 及以上（小米 HyperOS 同样适用）',
          entry: [
            '设置 → 我的设备 → 全部参数与信息 → 连点「OS 版本」7 次，打开开发者选项',
            '设置 → 更多设置（或系统与更新）→ 开发者选项 → 无线调试 → 打开开关',
          ],
          pairingCode: [
            '无线调试 → 使用配对码配对设备',
            '记住界面上的「IP 地址和端口」，例如 192.168.1.5:39443',
            '把 6 位配对码交给 pairWithCode 的 code 参数',
          ],
          qrCode: [
            '手机端：无线调试 → 使用二维码配对设备；用另一台手机 / 微信 / 系统扫码工具扫出文本，交给 pairWithQr 的 qrText',
            '或截图保存后交给 decodePairingQr 的 image（需要本机装有 zbarimg）',
            '电脑反向流：先调用 generatePairingQr，把返回的 dataUrl / pngBase64 显示在电脑屏幕，再让手机扫描',
            '手机扫描后会广播 _adb-tls-pairing._tcp；调用 mdnsServices 轮询，拿到服务后再调用 pairWithQr 或 pairAndConnect',
          ],
          qrFormat: 'WIFI:T:ADB;S:<服务名>;P:<6 位配对码>;;',
          ports: '配对端口 ≠ 连接端口。配对端口每次打开配对界面都会变；连接端口通常是 5555。',
          commands: {
            code: 'opengui-plus call wlan-connection.pairWithCode --json \'{"host":"192.168.1.5","port":39443,"code":"123456"}\'',
            qr: 'opengui-plus call wlan-connection.pairWithQr --json \'{"qrText":"WIFI:T:ADB;S:studio-abc123._adb-tls-pairing._tcp;P:123456;;"}\'',
            reverseQr: 'opengui-plus call wlan-connection.generatePairingQr --json \'{"serviceName":"studio-abc123","code":"123456"}\'',
            both: 'opengui-plus call wlan-connection.pairAndConnect --json \'{"host":"192.168.1.5","port":39443,"code":"123456","connectPort":5555}\'',
          },
          troubleshooting: [
            '连接被拒绝 / Connection reset：配对码或配对端口已过期，重新打开配对界面取新的',
            'mDNS 查不到服务：手机与电脑不在同一局域网，或路由器隔离了 AP / 组播',
            '配对成功但连不上：用的是配对端口去连接，改用连接端口（常见 5555）',
            'adb 版本过旧：部分平台工具不支持无线配对，请升级 platform-tools',
          ],
        }
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
      { name: 'saveDevice', summary: '保存设备', input: { transport: 'usb | wifi', serial: 'USB 序列号', host: 'WiFi 地址', port: '连接端口，默认 5555', pairingPort: '可选，记住 Android 11+ 配对端口', name: '备注名' } },
      { name: 'removeDevice', summary: '删除已保存设备', input: { id: '设备 id' } },
      { name: 'connect', summary: '按当前或指定模式连接', input: { mode: '可选覆盖', id: '可选指定设备' } },
      { name: 'disconnect', summary: '断开当前连接' },
      { name: 'pair', summary: 'Android 11+ 无线配对（自动识别配对码 / 二维码）', input: { host: '配对地址', port: '配对端口', code: '6 位配对码', qr: '或二维码文本', image: '或二维码图片路径' } },
      { name: 'generatePairingQr', summary: '电脑生成二维码，供手机扫描配对', input: { serviceName: '可选服务名', code: '可选 6 位配对码', scale: 'PNG 缩放倍数' } },
      { name: 'startQrPairing', summary: '显示电脑二维码并等待手机扫描后自动配对', input: { serviceName: '可选服务名', code: '可选 6 位配对码', timeoutMs: '等待扫描超时', pollMs: 'mDNS 轮询间隔', connect: '是否继续连接', connectPort: '可选连接端口', save: '是否记住设备' } },
      { name: 'pairWithCode', summary: '六位配对码配对', input: { host: '配对地址', port: '配对端口（不是 5555）', code: '6 位配对码' } },
      { name: 'pairWithQr', summary: '二维码配对', input: { qr: '二维码文本', qrText: '同 qr', image: '二维码图片路径（需 zbarimg）', host: '可选，跳过 mDNS 发现', port: '可选配对端口', code: '可选覆盖二维码里的配对码' } },
      { name: 'pairAndConnect', summary: '配对后直接连接（推荐）', input: { host: '配对地址', port: '配对端口', code: '6 位配对码', qr: '或二维码文本', image: '或二维码图片路径', connectPort: '连接端口，默认 mDNS 或 5555', save: '是否记住设备，默认 true', name: '备注名' } },
      { name: 'mdnsServices', summary: '列出 adb mDNS 服务（区分配对端口与连接端口）' },
      { name: 'parsePairingQr', summary: '解析二维码文本，不做连接' , input: { qr: '二维码文本', image: '二维码图片路径' } },
      { name: 'decodePairingQr', summary: '用外部解码器识别二维码图片', input: { image: '图片路径', decoder: '默认 zbarimg' } },
      { name: 'pairingGuide', summary: '配对操作指引与排障清单（供 AI 朗读给用户）' },
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
  // The endpoint lives under `wifi`, not at the top level; read both so legacy
  // rows written with a flat host/port still load.
  const wifi = isJsonRecord(row.wifi) ? requireEndpoint(row.wifi) : requireEndpoint(row)
  if (!wifi.ok) return null
  const pairingPort = readPairingPort(row)
  return { ...base, wifi: wifi.value, ...(pairingPort === undefined ? {} : { pairingPort }) }
}

export { DEFAULT_PORT as DEFAULT_ADB_PORT }
export type { AdbDeviceRow }
