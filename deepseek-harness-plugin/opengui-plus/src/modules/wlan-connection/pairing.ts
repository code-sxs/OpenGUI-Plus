/**
 * Android 11+ wireless pairing helpers.
 *
 * Developer options > Wireless debugging offers exactly two ways to authorise
 * a computer, and both are handled here:
 *
 *   1. Pair device with pairing code — the phone shows `host:pairingPort` plus
 *      a six-digit code.
 *   2. Pair device with QR code — the phone shows a QR whose payload is
 *      `WIFI:T:ADB;S:<serviceName>;P:<code>;;`. The service name is an mDNS
 *      name on stock Android / HyperOS, which is why {@link parseMdnsServices}
 *      exists: the host and pairing port have to be resolved through
 *      `adb mdns services` before `adb pair` can run.
 *
 * Everything in this file is pure. That is deliberate: the pairing flows must
 * be testable on a machine with no phone, no adb and no camera.
 *
 * @module modules/wlan-connection/pairing
 */

import type { Result } from '../../core/types.js'
import { fail, ok } from '../../core/types.js'
import { splitEndpoint } from './parse.js'

/** `adb mdns services` type advertised while the pairing dialog is open. */
export const MDNS_PAIRING_TYPE = '_adb-tls-pairing._tcp'
/** `adb mdns services` type advertised once wireless debugging is enabled. */
export const MDNS_CONNECT_TYPE = '_adb-tls-connect._tcp'

/** Split endpoint fallback; only reached when a QR encodes `host:` with no port. */
const FALLBACK_PORT = 5555

/** Android pairing codes are six digits; vendor ROMs may use 4-12. */
const MIN_CODE_LENGTH = 4
const MAX_CODE_LENGTH = 12

export interface WifiEndpointLike {
  readonly host: string
  readonly port: number
}

/** What a wireless-debugging QR code carries. */
export interface PairingQrPayload {
  /** mDNS service name on stock Android, or `host:port` on ROMs that inline it. */
  readonly serviceName: string
  /** Digits only; spaces and dashes typed by a human are stripped. */
  readonly pairingCode: string
  /** Present only when the QR inlined the endpoint instead of a service name. */
  readonly endpoint?: WifiEndpointLike
}

/** One row of `adb mdns services`. */
export interface MdnsService {
  readonly name: string
  readonly type: string
  readonly host: string
  readonly port: number
}

/** Interpretation of `adb pair` output. */
export interface PairOutcome {
  readonly paired: boolean
  readonly message: string
  /** `guid=adb-…` reported by adb on success. */
  readonly guid?: string
  /** The endpoint adb says it paired with. */
  readonly endpoint?: WifiEndpointLike
}

const QR_HEADER = /^WIFI:\s*T:\s*ADB\s*;/i

/** Strip the separators humans paste along with a pairing code ("123 456"). */
export function normalisePairingCode(raw: string): string {
  return raw.replace(/[\s-]/g, '')
}

/** True for a canonical six-digit Android pairing code. */
export function isPairingCode(value: string): boolean {
  return /^\d{6}$/.test(normalisePairingCode(value))
}

/** Read one `X:value` field out of a `WIFI:T:ADB;S:…;P:…;;` payload. */
function qrField(text: string, key: 'S' | 'P'): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([^;]*)`, 'i').exec(text)
  const value = match?.[1]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Parse an Android wireless-debugging QR payload.
 *
 * Accepts the AOSP form (`WIFI:T:ADB;S:adb-XXXX._adb-tls-pairing._tcp;P:123456;;`)
 * and the vendor variant that inlines the address
 * (`WIFI:T:ADB;S:192.168.1.5:39443;P:123456;;`).
 *
 * @param text Raw QR text, exactly as decoded from the image.
 */
export function parsePairingQr(text: string): Result<PairingQrPayload> {
  const raw = text.trim()
  if (raw.length === 0) return fail('二维码内容为空')
  if (QR_HEADER.test(raw) === false) {
    return fail('不是 Android 无线调试配对二维码：内容必须以 "WIFI:T:ADB;" 开头')
  }
  const serviceName = qrField(raw, 'S')
  if (serviceName === undefined) {
    return fail('二维码缺少 S 字段（服务名或 host:port）')
  }
  const rawCode = qrField(raw, 'P')
  if (rawCode === undefined) {
    return fail('二维码缺少 P 字段（配对码）')
  }
  const pairingCode = normalisePairingCode(rawCode)
  if (/^\d+$/.test(pairingCode) === false) {
    return fail(`配对码 "${rawCode}" 不是纯数字，Android 配对码应为 6 位数字`)
  }
  if (pairingCode.length < MIN_CODE_LENGTH || pairingCode.length > MAX_CODE_LENGTH) {
    return fail(`配对码长度为 ${pairingCode.length} 位，超出 Android 常见的 ${MIN_CODE_LENGTH}-${MAX_CODE_LENGTH} 位范围`)
  }
  const endpoint = splitEndpoint(serviceName, FALLBACK_PORT)
  return ok({
    serviceName,
    pairingCode,
    ...(endpoint === undefined ? {} : { endpoint }),
  })
}

/**
 * Parse `adb mdns services`.
 *
 *   List of discovered mdns services
 *   studio-abc123	_adb-tls-pairing._tcp	192.168.1.5:39443
 *   adb-abc123	_adb-tls-connect._tcp	192.168.1.5:5555
 *
 * Rows that are not `_adb*` services are ignored so the function stays useful
 * if the device also advertises unrelated mDNS entries.
 */
export function parseMdnsServices(output: string): readonly MdnsService[] {
  const services: MdnsService[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (/^list of discovered mdns services$/i.test(line)) continue
    const parts = line.split(/\s+/)
    const name = parts[0]
    const type = parts[1]
    const address = parts[2]
    if (name === undefined || type === undefined || address === undefined) continue
    if (type.toLowerCase().includes('_adb') === false) continue
    const endpoint = splitEndpoint(address, FALLBACK_PORT)
    if (endpoint === undefined) continue
    services.push({ name, type, host: endpoint.host, port: endpoint.port })
  }
  return services
}

/**
 * Find the mDNS row for a QR's service name.
 *
 * Exact match first, then a bidirectional substring match: some builds report
 * the name without its `._adb-tls-pairing._tcp` suffix, and some QR payloads
 * carry only the `studio-XXXXXX` prefix.
 */
export function findMdnsService(
  services: readonly MdnsService[],
  name: string,
  type?: string,
): MdnsService | undefined {
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  const pool = type === undefined
    ? services
    : services.filter(service => service.type.toLowerCase().includes(type.toLowerCase()))
  const exact = pool.find(service => service.name.toLowerCase() === wanted)
  if (exact !== undefined) return exact
  return pool.find(service => service.name.toLowerCase().includes(wanted)
    || wanted.includes(service.name.toLowerCase()))
}

/** True when adb reports a successful pairing. */
export function isPairSuccess(output: string): boolean {
  return /successfully paired|already paired|pairing complete/i.test(output)
}

/**
 * Interpret `adb pair` output.
 *
 *   Successfully paired to 192.168.1.5:39443 [guid=adb-3f2a…]
 *   Failed to pair to 192.168.1.5:39443: Connection reset by peer
 */
export function parsePairOutcome(output: string): PairOutcome {
  const text = output.trim()
  const guid = /\[guid=([^\]]+)\]/i.exec(text)?.[1]
  const endpointMatch = /paired\s+to\s+([^\s[\]]+)/i.exec(text)
  const endpointText = endpointMatch?.[1]
  const endpoint = endpointText === undefined ? undefined : splitEndpoint(endpointText, FALLBACK_PORT)

  if (isPairSuccess(text)) {
    return {
      paired: true,
      message: text.length > 0 ? text : '配对成功',
      ...(guid === undefined ? {} : { guid }),
      ...(endpoint === undefined ? {} : { endpoint }),
    }
  }
  return {
    paired: false,
    message: text.length > 0 ? text.slice(0, 300) : 'adb pair 没有任何输出，无法确认配对结果',
    ...(guid === undefined ? {} : { guid }),
    ...(endpoint === undefined ? {} : { endpoint }),
  }
}
