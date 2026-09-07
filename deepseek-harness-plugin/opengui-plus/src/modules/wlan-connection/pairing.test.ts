import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AdbRunResult, AdbRunner } from '../../core/adb-runner.js'
import { createFakeAdbRunner, type FakeAdbRunner } from '../../core/adb-runner.js'
import { EventBus } from '../../core/events.js'
import { silentLogger } from '../../core/logger.js'
import type { ModuleContext } from '../../core/module.js'
import { PlusStore } from '../../core/store.js'
import { createWirelessConnectionModule } from './index.js'
import {
  findMdnsService,
  isPairSuccess,
  normalisePairingCode,
  parseMdnsServices,
  parsePairOutcome,
  parsePairingQr,
} from './pairing.js'

interface Harness {
  call(method: string, input?: Record<string, unknown>): Promise<any>
  readonly adb: FakeAdbRunner
}

const dirs: string[] = []

/** AOSP form: the QR carries an mDNS service name, not an address. */
const AOSP_QR = 'WIFI:T:ADB;S:studio-abc123._adb-tls-pairing._tcp;P:123456;;'
/** Vendor form: some ROMs inline host:port. */
const INLINE_QR = 'WIFI:T:ADB;S:192.168.1.5:39443;P:123456;;'

const MDNS_OUTPUT = [
  'List of discovered mdns services',
  'studio-abc123\t_adb-tls-pairing._tcp\t192.168.1.5:39443',
  'adb-abc123\t_adb-tls-connect._tcp\t192.168.1.5:5555',
].join('\n')

function makeHarness(script: Record<string, AdbRunResult | string> = {}, runner?: AdbRunner): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'plus-wlan-'))
  dirs.push(dir)
  const store = new PlusStore(dir)
  const adb = runner === undefined ? createFakeAdbRunner(script) : (runner as FakeAdbRunner)
  const context: ModuleContext = {
    store: store.project('p1'),
    global: store.global(),
    events: new EventBus(),
    logger: silentLogger(),
    projectId: 'p1',
    dataDir: dir,
    // Left false so `start` does not kick off an unawaited auto-connect.
    capabilities: { adb: false, dsh: false, screenRecording: false },
    adb,
    call: async () => ({ ok: false, error: 'not wired in this test' }),
  }
  const module = createWirelessConnectionModule()
  return {
    adb: adb as FakeAdbRunner,
    async call(method, input = {}) {
      // start() is async and the module reads persisted profiles there.
      if (module.methods[method] === undefined) throw new Error(`missing method ${method}`)
      await module.start(context)
      return module.methods[method]!(input)
    },
  }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    }
    catch { /* best effort temp cleanup */ }
  }
})

describe('pairing: QR payload parsing', () => {
  it('parses the AOSP service-name form', () => {
    const parsed = parsePairingQr(AOSP_QR)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.serviceName).toBe('studio-abc123._adb-tls-pairing._tcp')
    expect(parsed.value.pairingCode).toBe('123456')
    expect(parsed.value.endpoint).toBeUndefined()
  })

  it('parses the vendor form that inlines host:port', () => {
    const parsed = parsePairingQr(INLINE_QR)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.endpoint).toEqual({ host: '192.168.1.5', port: 39443 })
  })

  it('normalises codes a human types with spaces', () => {
    expect(normalisePairingCode('123 456')).toBe('123456')
    expect(normalisePairingCode('12-34-56')).toBe('123456')
  })

  it('rejects payloads that are not Android pairing QRs', () => {
    expect(parsePairingQr('https://example.com').ok).toBe(false)
    expect(parsePairingQr('').ok).toBe(false)
    expect(parsePairingQr('WIFI:T:ADB;S:studio-abc;;').ok).toBe(false)
  })

  it('rejects a non-numeric pairing code', () => {
    expect(parsePairingQr('WIFI:T:ADB;S:studio-abc;P:abcdef;;').ok).toBe(false)
  })
})

describe('pairing: mDNS discovery', () => {
  it('parses adb mdns services output', () => {
    const services = parseMdnsServices(MDNS_OUTPUT)
    expect(services).toHaveLength(2)
    expect(services[0]).toEqual({ name: 'studio-abc123', type: '_adb-tls-pairing._tcp', host: '192.168.1.5', port: 39443 })
    expect(services[1]).toEqual({ name: 'adb-abc123', type: '_adb-tls-connect._tcp', host: '192.168.1.5', port: 5555 })
  })

  it('ignores non-adb services and header lines', () => {
    const services = parseMdnsServices('List of discovered mdns services\nprinter\t_ipp._tcp\t192.168.1.9:631')
    expect(services).toHaveLength(0)
  })

  it('finds a service by exact name and by prefix', () => {
    const services = parseMdnsServices(MDNS_OUTPUT)
    expect(findMdnsService(services, 'studio-abc123._adb-tls-pairing._tcp', '_adb-tls-pairing._tcp')?.port).toBe(39443)
    expect(findMdnsService(services, 'studio-abc123')?.port).toBe(39443)
    expect(findMdnsService(services, 'nope')).toBeUndefined()
  })
})

describe('pairing: adb pair output', () => {
  it('reads a successful pairing including guid and endpoint', () => {
    const outcome = parsePairOutcome('Successfully paired to 192.168.1.5:39443 [guid=adb-3f2a]')
    expect(outcome.paired).toBe(true)
    expect(outcome.guid).toBe('adb-3f2a')
    expect(outcome.endpoint).toEqual({ host: '192.168.1.5', port: 39443 })
    expect(isPairSuccess('Successfully paired to 192.168.1.5:39443')).toBe(true)
  })

  it('reports a failed pairing with adb\'s own message', () => {
    const outcome = parsePairOutcome('Failed to pair to 192.168.1.5:39443: Connection reset by peer')
    expect(outcome.paired).toBe(false)
    expect(outcome.message).toContain('Connection reset by peer')
  })

  it('does not treat empty output as success', () => {
    const outcome = parsePairOutcome('')
    expect(outcome.paired).toBe(false)
    expect(outcome.message).toContain('无法确认')
  })
})

describe('pairing: pairWithCode', () => {
  it('pairs with a six-digit code and pipes it to adb', async () => {
    const harness = makeHarness({
      'pair 192.168.1.5:39443': { stdout: 'Successfully paired to 192.168.1.5:39443 [guid=adb-ok]', stderr: '', code: 0 },
    })
    const result = await harness.call('pairWithCode', { host: '192.168.1.5', port: 39443, code: '123456' })
    expect(result.paired).toBe(true)
    expect(result.guid).toBe('adb-ok')
    expect(result.endpoint).toEqual({ host: '192.168.1.5', port: 39443 })
    expect(harness.adb.calls.some(call => call.includes('(stdin: 123456)'))).toBe(true)
  })

  it('accepts a code typed with spaces', async () => {
    const harness = makeHarness({
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
    })
    const result = await harness.call('pairWithCode', { host: '192.168.1.5', port: 39443, code: '123 456' })
    expect(result.paired).toBe(true)
    expect(harness.adb.calls.some(call => call.includes('(stdin: 123456)'))).toBe(true)
  })

  it('falls back to passing the code as an argument when stdin pairing fails', async () => {
    const harness = makeHarness({
      'pair 10.0.0.7:41000': { stdout: 'adb: stdin is not a tty', stderr: '', code: 1 },
      'pair 10.0.0.7:41000 654321': 'Successfully paired to 10.0.0.7:41000',
    })
    const result = await harness.call('pairWithCode', { host: '10.0.0.7', port: 41000, code: '654321' })
    expect(result.paired).toBe(true)
    expect(harness.adb.calls).toContain('pair 10.0.0.7:41000 654321')
  })

  it('works with a runner that has no stdin support at all', async () => {
    const legacy: AdbRunner = {
      binary: 'adb-legacy',
      async run(args) {
        return args.includes('777777')
          ? { stdout: 'Successfully paired to 10.0.0.9:41001', stderr: '', code: 0 }
          : { stdout: '', stderr: 'missing code', code: 1 }
      },
    }
    const harness = makeHarness({}, legacy)
    const result = await harness.call('pairWithCode', { host: '10.0.0.9', port: 41001, code: '777777' })
    expect(result.paired).toBe(true)
  })

  it('rejects a non-numeric or missing code', async () => {
    const harness = makeHarness()
    expect((await harness.call('pairWithCode', { host: '192.168.1.5', port: 39443, code: 'abcdef' })).ok).toBe(false)
    expect((await harness.call('pairWithCode', { host: '192.168.1.5', port: 39443 })).ok).toBe(false)
  })

  it('surfaces adb\'s failure instead of pretending it worked', async () => {
    const harness = makeHarness({
      'pair 192.168.1.5:39443': { stdout: '', stderr: 'failed to authenticate', code: 1 },
    })
    const result = await harness.call('pairWithCode', { host: '192.168.1.5', port: 39443, code: '000000' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('failed to authenticate')
  })

  it('needs a host before it will run adb', async () => {
    const harness = makeHarness()
    const result = await harness.call('pairWithCode', { code: '123456' })
    expect(result.ok).toBe(false)
    expect(harness.adb.calls ?? []).toHaveLength(0)
  })
})

describe('pairing: pairWithQr', () => {
  it('resolves the endpoint through mDNS when the QR only carries a service name', async () => {
    const harness = makeHarness({
      'mdns services': MDNS_OUTPUT,
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
    })
    const result = await harness.call('pairWithQr', { qr: AOSP_QR })
    expect(result.paired).toBe(true)
    expect(result.serviceName).toBe('studio-abc123._adb-tls-pairing._tcp')
    expect(result.resolvedBy).toBe('mdns')
    expect(result.endpoint).toEqual({ host: '192.168.1.5', port: 39443 })
  })

  it('uses an inlined endpoint without asking mDNS', async () => {
    const harness = makeHarness({
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
    })
    const result = await harness.call('pairWithQr', { qrText: INLINE_QR })
    expect(result.paired).toBe(true)
    expect(result.resolvedBy).toBe('qr-inline')
    expect(harness.adb.calls).not.toContain('mdns services')
  })

  it('explains itself when the service is not discoverable', async () => {
    const harness = makeHarness({ 'mdns services': 'List of discovered mdns services' })
    const result = await harness.call('pairWithQr', { qr: AOSP_QR })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('studio-abc123')
    expect(result.error).toContain('mDNS 未发现任何 adb 服务')
  })

  it('honours an explicit host/port over discovery', async () => {
    const harness = makeHarness({
      'pair 10.0.0.5:40000': 'Successfully paired to 10.0.0.5:40000',
    })
    const result = await harness.call('pairWithQr', { qr: AOSP_QR, host: '10.0.0.5', port: 40000 })
    expect(result.resolvedBy).toBe('input')
    expect(harness.adb.calls).not.toContain('mdns services')
  })

  it('rejects a QR that is not a pairing code', async () => {
    const harness = makeHarness()
    const result = await harness.call('pairWithQr', { qrText: 'https://example.com' })
    expect(result.ok).toBe(false)
  })
})

describe('pairing: pairAndConnect', () => {
  it('pairs, connects on the mDNS connect port and remembers the device', async () => {
    const harness = makeHarness({
      'mdns services': MDNS_OUTPUT,
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
      'connect 192.168.1.5:5555': 'connected to 192.168.1.5:5555',
    })
    const result = await harness.call('pairAndConnect', { qr: AOSP_QR, name: '小米14' })
    expect(result.paired).toBe(true)
    expect(result.connected).toBe(true)
    expect(result.connectEndpoint).toEqual({ host: '192.168.1.5', port: 5555 })
    expect(result.connectPortResolvedBy).toBe('mdns')

    const listed = await harness.call('listDevices')
    const saved = listed.devices.find((device: any) => device.name === '小米14')
    expect(saved).toBeDefined()
    expect(saved.wifi).toEqual({ host: '192.168.1.5', port: 5555 })
    expect(saved.pairingPort).toBe(39443)
  })

  it('pairs, connects and falls back to port 5555 when mDNS is silent', async () => {
    const harness = makeHarness({
      'mdns services': 'List of discovered mdns services',
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
      'connect 192.168.1.5:5555': 'connected to 192.168.1.5:5555',
    })
    const result = await harness.call('pairAndConnect', {
      host: '192.168.1.5', port: 39443, code: '123456', save: false,
    })
    expect(result.connected).toBe(true)
    expect(result.connectPortResolvedBy).toBe('default')
    const listed = await harness.call('listDevices')
    expect(listed.devices).toHaveLength(0)
  })

  it('honours an explicit connectPort', async () => {
    const harness = makeHarness({
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
      'connect 192.168.1.5:6666': 'connected to 192.168.1.5:6666',
    })
    const result = await harness.call('pairAndConnect', {
      host: '192.168.1.5', port: 39443, code: '123456', connectPort: 6666, save: false,
    })
    expect(result.connectEndpoint.port).toBe(6666)
    expect(result.connectPortResolvedBy).toBe('input')
  })

  it('reports pairing success separately when the connect step fails', async () => {
    const harness = makeHarness({
      'mdns services': MDNS_OUTPUT,
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
      'connect 192.168.1.5:5555': { stdout: 'cannot connect to 192.168.1.5:5555', stderr: '', code: 1 },
    })
    const result = await harness.call('pairAndConnect', { qr: AOSP_QR, save: false })
    expect(result.paired).toBe(true)
    expect(result.connected).toBe(false)
    expect(result.error).toContain('cannot connect')
    expect(result.hint).toContain('配对已成功')
  })
})

describe('pairing: supporting methods', () => {
  it('waits for the phone mDNS advertisement in the reverse QR flow', async () => {
    const harness = makeHarness({
      'mdns services': MDNS_OUTPUT,
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
      'connect 192.168.1.5:5555': 'connected to 192.168.1.5:5555',
    })
    const result = await harness.call('startQrPairing', {
      serviceName: 'studio-test', code: '123456', timeoutMs: 1_000, pollMs: 100,
    })
    expect(result.paired).toBe(true)
    expect(result.connected).toBe(true)
    expect(result.qr.qrText).toBe('WIFI:T:ADB;S:studio-test;P:123456;;')
    expect(result.service.port).toBe(39443)
    expect(result.connectEndpoint).toEqual({ host: '192.168.1.5', port: 5555 })
  })

  it('returns the QR payload when the phone does not scan in time', async () => {
    const harness = makeHarness({ 'mdns services': 'List of discovered mdns services' })
    const result = await harness.call('startQrPairing', {
      serviceName: 'studio-timeout', code: '123456', timeoutMs: 1_000, pollMs: 100,
    })
    expect(result.ok).toBe(false)
    expect(result.qr.qrText).toBe('WIFI:T:ADB;S:studio-timeout;P:123456;;')
    expect(result.error).toContain('未发现配对服务')
  })

  it('generates a scannable reverse-flow QR payload and image', async () => {
    const harness = makeHarness()
    const result = await harness.call('generatePairingQr', { serviceName: 'studio-test', code: '123456', scale: 4 })
    expect(result.qrText).toBe('WIFI:T:ADB;S:studio-test;P:123456;;')
    expect(result.serviceName).toBe('studio-test')
    expect(result.pairingCode).toBe('123456')
    expect(result.version).toBeGreaterThanOrEqual(1)
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/) 
    expect(result.pngBase64.length).toBeGreaterThan(100)
    expect(result.ascii).toContain('█')

    const parsed = parsePairingQr(result.qrText)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.pairingCode).toBe('123456')
  })

  it('rejects malformed reverse-flow QR input instead of generating a misleading code', async () => {
    const harness = makeHarness()
    const result = await harness.call('generatePairingQr', { serviceName: '米-14', code: '12ab56' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('6 位数字')
  })

  it('pair dispatches to the right flow', async () => {
    const qrHarness = makeHarness({
      'mdns services': MDNS_OUTPUT,
      'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443',
    })
    expect((await qrHarness.call('pair', { qr: AOSP_QR })).paired).toBe(true)

    const codeHarness = makeHarness({ 'pair 192.168.1.5:39443': 'Successfully paired to 192.168.1.5:39443' })
    expect((await codeHarness.call('pair', { host: '192.168.1.5', port: 39443, code: '123456' })).paired).toBe(true)
  })

  it('mdnsServices separates pairing and connect endpoints', async () => {
    const harness = makeHarness({ 'mdns services': MDNS_OUTPUT })
    const result = await harness.call('mdnsServices')
    expect(result.pairing).toHaveLength(1)
    expect(result.connect).toHaveLength(1)
    expect(result.pairing[0].port).toBe(39443)
    expect(result.connect[0].port).toBe(5555)
  })

  it('parsePairingQr validates a paste without touching adb', async () => {
    const harness = makeHarness()
    const result = await harness.call('parsePairingQr', { qr: AOSP_QR })
    expect(result.pairingCode).toBe('123456')
    expect(harness.adb.calls ?? []).toHaveLength(0)
  })

  it('decodePairingQr fails loudly when no decoder is installed', async () => {
    const harness = makeHarness()
    const result = await harness.call('decodePairingQr', { image: join(tmpdir(), 'nope.png') })
    expect(result.ok).toBe(false)
    // Either the decoder is missing or the file is; both must be an error, not a crash.
    expect(typeof result.error).toBe('string')
  })

  it('pairingGuide explains both flows', async () => {
    const harness = makeHarness()
    const guide = await harness.call('pairingGuide')
    expect(guide.pairingCode.join(' ')).toContain('配对码')
    expect(guide.qrCode.join(' ')).toContain('二维码')
    expect(guide.ports).toContain('配对端口')
    expect(guide.troubleshooting.length).toBeGreaterThan(0)
  })
})
