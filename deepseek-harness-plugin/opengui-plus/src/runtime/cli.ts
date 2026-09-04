/**
 * Standalone CLI for OpenGUI-Plus.
 *
 * Exists for three reasons: it lets you drive every module without a DSH host,
 * it is the fastest way to verify an installation (`status`), and it is how the
 * console server is launched (`serve`).
 *
 * @module runtime/cli
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAdbRunner } from '../core/adb-runner.js'
import { Logger } from '../core/logger.js'
import { PlusHost } from '../host.js'
import type { Result } from '../core/types.js'
import { startConsoleServer } from './server.js'

const DEFAULT_DATA_DIR = join(homedir(), '.opengui-plus')

export interface ParsedArgs {
  readonly command: string
  readonly positional: readonly string[]
  readonly flags: Readonly<Record<string, string | boolean>>
}

/** Minimal `--flag value` / `--flag=value` / `--flag` parser. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[index + 1]
      if (next !== undefined && next.startsWith('--') === false) {
        flags[body] = next
        index += 1
      }
      else {
        flags[body] = true
      }
      continue
    }
    positional.push(token)
  }
  return {
    command: positional[0] ?? 'help',
    positional: positional.slice(1),
    flags,
  }
}

function flagString(flags: ParsedArgs['flags'], key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function flagNumber(flags: ParsedArgs['flags'], key: string): number | undefined {
  const raw = flagString(flags, key)
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function printResult(result: Result<unknown>): void {
  if (result.ok) {
    process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
    return
  }
  process.stderr.write(`错误: ${result.error}\n`)
  process.exitCode = 1
}

/** Turn `k=v` pairs and/or a raw JSON blob into one input object. */
function buildInput(flags: ParsedArgs['flags']): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const json = flagString(flags, 'json')
  if (json !== undefined) {
    try {
      const parsed = JSON.parse(json) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        Object.assign(input, parsed as Record<string, unknown>)
      }
      else {
        throw new Error('--json must be an object')
      }
    }
    catch (error) {
      process.stderr.write(`--json 解析失败: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
  for (const [key, value] of Object.entries(flags)) {
    if (key === 'json') continue
    if (typeof value === 'boolean') {
      input[key] = value
      continue
    }
    if (value === 'true' || value === 'false') {
      input[key] = value === 'true'
      continue
    }
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      input[key] = Number(value)
      continue
    }
    input[key] = value
  }
  return input
}

const HELP = `OpenGUI-Plus 命令行

用法:
  opengui-plus serve [--port 8787] [--host 127.0.0.1] [--data-dir <dir>]
  opengui-plus status
  opengui-plus modules
  opengui-plus call <module.method> [--json '{...}'] [--key value ...]
  opengui-plus connect --mode usb|wifi|auto [--host <ip>] [--port 5555]
  opengui-plus run <templateId> [--package com.example.app ...]
  opengui-plus help

示例:
  opengui-plus serve --port 8787
  opengui-plus call wlan-connection.discover
  opengui-plus call wlan-connection.saveDevice --transport wifi --host 192.168.1.23 --port 5555 --name 小米9
  opengui-plus connect --mode wifi
  opengui-plus call snippet-library.complete --prefix sc
  opengui-plus call action-template.list
  opengui-plus call project-group.create --name 抖音项目

数据目录默认: ${DEFAULT_DATA_DIR}
可用 --data-dir 覆盖，也可用环境变量 OPENGUI_PLUS_DATA_DIR。
`

/** Entry point; returns the process exit code so tests can drive it. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    process.stdout.write(HELP)
    return 0
  }

  const dataDir = resolve(flagString(args.flags, 'data-dir')
    ?? process.env.OPENGUI_PLUS_DATA_DIR
    ?? DEFAULT_DATA_DIR)

  if (args.command === 'serve') {
    const host = await PlusHost.create({
      dataDir,
      logger: new Logger(flagString(args.flags, 'log-level') === 'debug' ? 'debug' : 'info'),
    })
    const server = await startConsoleServer({
      host: flagString(args.flags, 'host') ?? '127.0.0.1',
      port: flagNumber(args.flags, 'port') ?? 8787,
      plusHost: host,
    })
    process.stdout.write(`OpenGUI-Plus 控制台已启动: ${server.url}\n`)
    process.stdout.write(`数据目录: ${dataDir}\n`)
    process.stdout.write(`按 Ctrl+C 停止\n`)
    return new Promise<number>((resolveExit) => {
      const shutdown = (): void => {
        void server.close().then(async () => {
          await host.stop()
          resolveExit(0)
        })
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
  }

  const plusHost = await PlusHost.create({
    dataDir,
    logger: new Logger(flagString(args.flags, 'log-level') === 'debug' ? 'debug' : 'info'),
    adb: createAdbRunner(),
  })

  try {
    switch (args.command) {
      case 'status': {
        printResult({ ok: true as const, value: await plusHost.status() })
        break
      }
      case 'modules': {
        const status = await plusHost.registry.status()
        for (const module of status) {
          process.stdout.write(`${module.id.padEnd(22)} ${module.started ? '已启动' : '未启动'}  ${module.name}\n`)
          process.stdout.write(`  ${module.summary}\n`)
          process.stdout.write(`  方法: ${module.methods.join(', ')}\n\n`)
        }
        break
      }
      case 'call': {
        const target = args.positional[0]
        if (target === undefined) {
          process.stderr.write('call 需要 <module.method> 参数\n')
          return 1
        }
        printResult(await plusHost.call(target, buildInput(args.flags)))
        break
      }
      case 'connect': {
        const mode = flagString(args.flags, 'mode') ?? 'auto'
        const input: Record<string, unknown> = { mode }
        const host = flagString(args.flags, 'host')
        const port = flagNumber(args.flags, 'port')
        if (host !== undefined) {
          await plusHost.call('wlan-connection.saveDevice', {
            transport: 'wifi',
            host,
            ...(port === undefined ? {} : { port }),
            name: host,
          })
        }
        if (port !== undefined) input.port = port
        printResult(await plusHost.call('wlan-connection.connect', input))
        break
      }
      case 'run': {
        const templateId = args.positional[0]
        if (templateId === undefined) {
          process.stderr.write('run 需要 <templateId> 参数\n')
          return 1
        }
        const variables = buildInput(args.flags)
        printResult(await plusHost.call('action-template.execute', { id: templateId, variables }))
        break
      }
      default: {
        process.stderr.write(`未知命令: ${args.command}\n\n`)
        process.stdout.write(HELP)
        return 1
      }
    }
    return Number(process.exitCode ?? 0)
  }
  finally {
    await plusHost.stop()
  }
}
