/** Small levelled logger; the console server mirrors `child` output to the log panel. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  readonly level: LogLevel
  readonly scope: string
  readonly message: string
  readonly at: string
}

const ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

export class Logger {
  private readonly records: LogRecord[] = []

  constructor(
    private threshold: LogLevel = 'info',
    private readonly sink: (record: LogRecord) => void = defaultSink,
    private readonly limit = 500,
  ) {}

  child(scope: string): Logger {
    const parent = this
    return new Logger(this.threshold, (record) => {
      parent.write({ ...record, scope })
    }, this.limit)
  }

  setThreshold(level: LogLevel): void {
    this.threshold = level
  }

  debug(message: string): void {
    this.write({ level: 'debug', scope: 'plus', message, at: new Date().toISOString() })
  }

  info(message: string): void {
    this.write({ level: 'info', scope: 'plus', message, at: new Date().toISOString() })
  }

  warn(message: string): void {
    this.write({ level: 'warn', scope: 'plus', message, at: new Date().toISOString() })
  }

  error(message: string): void {
    this.write({ level: 'error', scope: 'plus', message, at: new Date().toISOString() })
  }

  recent(limit = 100): readonly LogRecord[] {
    return this.records.slice(-limit)
  }

  private write(record: LogRecord): void {
    this.records.push(record)
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit)
    }
    if (ORDER.indexOf(record.level) < ORDER.indexOf(this.threshold)) return
    this.sink(record)
  }
}

function defaultSink(record: LogRecord): void {
  const prefix = `[${record.at.slice(11, 19)}] ${record.level.toUpperCase().padEnd(5)} ${record.scope}:`
  const stream = record.level === 'error' || record.level === 'warn' ? process.stderr : process.stdout
  stream.write(`${prefix} ${record.message}\n`)
}

/** A logger that keeps everything in memory; used by tests. */
export function silentLogger(): Logger {
  return new Logger('error', () => {})
}
