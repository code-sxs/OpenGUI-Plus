/**
 * Parsers for `adb` output used by the wireless-connection module.
 * Kept separate because they are pure and carry most of the module's tests.
 */

export interface AdbDeviceRow {
  readonly serial: string
  readonly state: string
  readonly model?: string
}

/**
 * Parse `adb devices -l`.
 *
 *   List of devices attached
 *   emulator-5554    device product:sdk_gphone_x86 model:sdk_gphone device:generic transport_id:1
 *   192.168.1.23:5555  device product:aqua model:Mi_9 transport_id:2
 *   ????????????     unauthorized
 */
export function parseAdbDevices(output: string): readonly AdbDeviceRow[] {
  const rows: AdbDeviceRow[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (/^list of devices attached$/i.test(line)) continue
    if (line.startsWith('*')) continue
    const parts = line.split(/\s+/)
    const serial = parts[0]
    const state = parts[1]
    if (serial === undefined || state === undefined) continue
    const model = readField(line, 'model')
    rows.push({
      serial,
      state,
      ...(model === undefined ? {} : { model }),
    })
  }
  return rows
}

/** Pull `key:value` out of the trailing attribute list of an `adb devices -l` row. */
export function readField(line: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}:([^\\s]+)`).exec(line)
  return match?.[1]
}

/**
 * Split `host:port`. Returns `undefined` for plain USB serials so callers can
 * tell a network endpoint from a cable-attached device.
 */
export function splitEndpoint(value: string, defaultPort: number): { readonly host: string, readonly port: number } | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const index = trimmed.lastIndexOf(':')
  if (index <= 0 || index === trimmed.length - 1) return undefined
  const host = trimmed.slice(0, index)
  const port = Number.parseInt(trimmed.slice(index + 1), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return { host, port: Number.isNaN(port) ? defaultPort : port }
}

/** `adb connect` / `adb pair` success detection, tolerant of locale variants. */
export function isAdbConnectSuccess(output: string): boolean {
  return /connected to|already connected|successfully paired|paired/i.test(output)
}
