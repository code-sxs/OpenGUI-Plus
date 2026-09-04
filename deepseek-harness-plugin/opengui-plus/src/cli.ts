#!/usr/bin/env node
/**
 * Binary entry point for `opengui-plus`.
 * Kept separate from the library so importing the package never runs a CLI.
 */

import { runCli } from './runtime/cli.js'

runCli(process.argv.slice(2))
  .then((code) => { process.exit(code) })
  .catch((error: unknown) => {
    process.stderr.write(`opengui-plus 启动失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
