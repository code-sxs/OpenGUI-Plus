/**
 * Zero-dependency console server.
 *
 * Serves the single-page console, exposes every module method over
 * `POST /api/call`, and pushes module events to the browser with SSE.
 *
 * No Express, no ws, no socket.io: the whole point of OpenGUI-Plus is that it
 * runs anywhere Node runs, including a laptop that has never seen npm install
 * succeed.
 *
 * @module runtime/server
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUS_EVENTS } from '../core/events.js'
import type { PlusHost } from '../host.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
}

export interface ConsoleServerOptions {
  readonly plusHost: PlusHost
  readonly host?: string
  readonly port?: number
  /** Directory holding the built console; defaults to the packaged `web/`. */
  readonly webRoot?: string
}

export interface ConsoleServer {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

interface SseClient {
  readonly id: number
  write(chunk: string): void
  end(): void
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text) as unknown
}

/** Resolve a path inside `root`, refusing anything that escapes it. */
function safeJoin(root: string, requested: string): string | null {
  const target = resolve(join(root, normalize(requested)))
  const base = resolve(root)
  if (target !== base && target.startsWith(`${base}${sep}`) === false) return null
  return target
}

function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Locate the packaged `web/` directory.
 * Works both from `lib/runtime/server.js` (built) and from a tsx/vitest run
 * under `src/runtime/`, so the console never 404s in development.
 */
function findWebRoot(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  for (const candidate of [resolve(here, '../../web'), resolve(here, '../web')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return resolve(here, '../../web')
}

/** Start the console server. Resolves once the socket is listening. */
export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  const plusHost = options.plusHost
  const webRoot = options.webRoot ?? findWebRoot()

  const clients = new Set<SseClient>()
  let nextClientId = 1

  function broadcast(type: string, payload: unknown): void {
    if (clients.size === 0) return
    const frame = `event: plus\ndata: ${JSON.stringify({ type, payload, at: new Date().toISOString() })}\n\n`
    for (const client of [...clients]) {
      try {
        client.write(frame)
      }
      catch {
        clients.delete(client)
      }
    }
  }

  // One subscription per documented event type; `onAny` matches any source.
  const unsubscribers = Object.values(PLUS_EVENTS).map(type => plusHost.events.onAny(type, payload => broadcast(type, payload)))

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const path = url.pathname

    try {
      if (request.method === 'GET' && path === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        const client: SseClient = {
          id: nextClientId++,
          write: chunk => response.write(chunk),
          end: () => response.end(),
        }
        clients.add(client)
        response.write(`retry: 3000\n\n`)
        response.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
        request.on('close', () => { clients.delete(client) })
        return
      }

      if (request.method === 'GET' && path === '/api/status') {
        sendJson(response, 200, await plusHost.status())
        return
      }

      if (request.method === 'GET' && path === '/api/modules') {
        sendJson(response, 200, { modules: await plusHost.registry.status() })
        return
      }

      if (request.method === 'GET' && path === '/api/events/recent') {
        sendJson(response, 200, { events: plusHost.events.recent(50) })
        return
      }

      if (request.method === 'POST' && path === '/api/call') {
        const body = await readBody(request)
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          sendJson(response, 400, { ok: false, error: 'body must be a JSON object' })
          return
        }
        const record = body as Record<string, unknown>
        const target = record.target
        if (typeof target !== 'string') {
          sendJson(response, 400, { ok: false, error: '"target" is required, e.g. "wlan-connection.status"' })
          return
        }
        const input = (typeof record.input === 'object' && record.input !== null && !Array.isArray(record.input))
          ? record.input as Record<string, unknown>
          : {}
        const result = await plusHost.call(target, input)
        sendJson(response, result.ok ? 200 : 400, result)
        return
      }

      // Static assets produced by modules (screenshots, replay frames, exports).
      if (request.method === 'GET' && path.startsWith('/files/')) {
        const target = safeJoin(plusHost.dataDir, decodeURIComponent(path.slice('/files/'.length)))
        if (target === null || !existsSync(target) || statSync(target).isDirectory()) {
          response.writeHead(404).end('not found')
          return
        }
        response.writeHead(200, {
          'content-type': contentTypeFor(target),
          'cache-control': 'no-store',
        })
        createReadStream(target).pipe(response)
        return
      }

      if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
        const indexPath = join(webRoot, 'index.html')
        if (!existsSync(indexPath)) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<h1>OpenGUI-Plus</h1><p>控制台文件缺失，请先执行 <code>npm run build</code>。</p>')
          return
        }
        const html = await readFile(indexPath, 'utf8')
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(html)
        return
      }

      if (request.method === 'GET') {
        const target = safeJoin(webRoot, decodeURIComponent(path))
        if (target === null || !existsSync(target) || statSync(target).isDirectory()) {
          response.writeHead(404).end('not found')
          return
        }
        const content = await readFile(target)
        response.writeHead(200, { 'content-type': contentTypeFor(target), 'cache-control': 'no-store' })
        response.end(content)
        return
      }

      sendJson(response, 404, { ok: false, error: `no route for ${request.method ?? 'GET'} ${path}` })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 500, { ok: false, error: message })
    }
  }

  // Heartbeat keeps proxies from closing an idle SSE stream.
  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      try {
        client.write(`: ping ${Date.now()}\n\n`)
      }
      catch {
        clients.delete(client)
      }
    }
  }, 15_000)

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => resolveListen())
  })

  const address = server.address() as AddressInfo | null
  const port = address?.port ?? options.port ?? 8787
  const host = options.host ?? '127.0.0.1'

  return {
    url: `http://${host}:${port}/`,
    port,
    async close() {
      clearInterval(heartbeat)
      for (const off of unsubscribers) off()
      for (const client of clients) client.end()
      clients.clear()
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    },
  }
}
