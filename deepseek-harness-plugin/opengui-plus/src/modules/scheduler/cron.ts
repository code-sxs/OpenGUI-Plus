/**
 * A five-field cron parser, hand-rolled.
 *
 * The scheduler must not pull in `cron-parser` or friends: the DSH SDK cannot
 * be installed in this repo, and a transitive tree over a ~120 line parser is
 * worse than the parser. Supported syntax covers everything the console's
 * schedule picker emits: star, star-with-step, ranges, comma lists and plain
 * numbers.
 *
 * Fields: minute hour day-of-month month day-of-week
 * (`0` and `7` are both Sunday).
 */

const FIELDS = 5

/** Ranges are inclusive on both ends, following cron convention. */
interface FieldSpec {
  readonly min: number
  readonly max: number
  readonly names?: Readonly<Record<string, number>>
}

const MINUTE: FieldSpec = { min: 0, max: 59 }
const HOUR: FieldSpec = { min: 0, max: 23 }
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31 }
const MONTH: FieldSpec = { min: 1, max: 12 }
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 7 }

/**
 * Expand one cron field into the set of values it matches.
 * Throws on anything else so callers can turn it into a user-facing error.
 */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  const text = field.trim()
  if (text.length === 0) throw new Error('cron 字段不能为空')
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (piece.length === 0) throw new Error(`cron 字段 "${field}" 含空片段`)

    if (piece === '*') {
      for (let value = min; value <= max; value += 1) values.add(value)
      continue
    }

    const [left, right] = piece.split('/')
    const rangePart = (left ?? '').trim()
    const stepPart = right === undefined ? undefined : right.trim()
    const step = stepPart === undefined ? 1 : parseNumber(stepPart, field)
    if (step < 1) throw new Error(`cron 字段 "${field}" 的步长必须 >= 1`)

    let from: number
    let to: number
    if (rangePart === '*' || rangePart.length === 0) {
      from = min
      to = max
    }
    else if (rangePart.includes('-')) {
      const [startText, endText] = rangePart.split('-')
      if (endText === undefined) throw new Error(`cron 字段 "${field}" 区间写法错误`)
      from = parseNumber((startText ?? '').trim(), field)
      to = parseNumber(endText.trim(), field)
      if (from > to) throw new Error(`cron 字段 "${field}" 区间起点大于终点`)
    }
    else {
      from = parseNumber(rangePart, field)
      to = stepPart === undefined ? from : max
    }

    if (from < min || to > max) {
      throw new Error(`cron 字段 "${field}" 超出取值范围 ${min}-${max}`)
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`cron 字段 "${field}" 没有匹配任何值`)
  return values
}

function parseNumber(text: string, field: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`cron 字段 "${field}" 含非法数字 "${text}"`)
  return Number.parseInt(text, 10)
}

interface CronExpression {
  readonly minutes: Set<number>
  readonly hours: Set<number>
  readonly daysOfMonth: Set<number>
  readonly months: Set<number>
  readonly daysOfWeek: Set<number>
}

function splitExpression(expression: string): readonly string[] {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== FIELDS) {
    throw new Error(`cron 表达式必须是 ${FIELDS} 段（分 时 日 月 周），收到 ${parts.length} 段`)
  }
  return parts
}

/** Parse and cache-expand an expression; throws on invalid input. */
export function parseCron(expression: string): CronExpression {
  const parts = splitExpression(expression)
  const daysOfWeek = parseCronField(parts[4]!, DAY_OF_WEEK.min, DAY_OF_WEEK.max)
  // Sunday is both 0 and 7 in cron; normalise so matching needs one lookup.
  if (daysOfWeek.has(7)) daysOfWeek.add(0)
  if (daysOfWeek.has(0)) daysOfWeek.add(7)
  return {
    minutes: parseCronField(parts[0]!, MINUTE.min, MINUTE.max),
    hours: parseCronField(parts[1]!, HOUR.min, HOUR.max),
    daysOfMonth: parseCronField(parts[2]!, DAY_OF_MONTH.min, DAY_OF_MONTH.max),
    months: parseCronField(parts[3]!, MONTH.min, MONTH.max),
    daysOfWeek,
  }
}

/**
 * True when `date` (whole minutes only) satisfies the expression.
 *
 * Cron's classic quirk is kept: when both day-of-month and day-of-week are
 * restricted, the date matches if *either* field matches.
 */
export function cronMatches(expression: string, date: Date): boolean {
  const cron = parseCron(expression)
  // Cron snaps to whole minutes, so seconds never participate.
  return matchesParsed(cron, date)
}

/**
 * First whole minute at or after `from` that matches, searching up to
 * `limitDays` days ahead. Returns `null` when nothing matches (e.g. 30 February).
 */
export function nextCronRun(expression: string, from: Date, limitDays = 366): Date | null {
  const cron = parseCron(expression)
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const deadline = from.getTime() + limitDays * 24 * 60 * 60 * 1000

  while (cursor.getTime() <= deadline) {
    if (matchesParsed(cron, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

function matchesParsed(cron: CronExpression, date: Date): boolean {
  if (!cron.minutes.has(date.getMinutes())) return false
  if (!cron.hours.has(date.getHours())) return false
  if (!cron.months.has(date.getMonth() + 1)) return false

  const dayOfMonthRestricted = cron.daysOfMonth.size < (DAY_OF_MONTH.max - DAY_OF_MONTH.min + 1)
  const dayOfWeekRestricted = cron.daysOfWeek.size <= 7
  const dayOfMonthHit = cron.daysOfMonth.has(date.getDate())
  const dayOfWeekHit = cron.daysOfWeek.has(date.getDay())

  if (dayOfMonthRestricted && dayOfWeekRestricted) return dayOfMonthHit || dayOfWeekHit
  if (dayOfMonthRestricted) return dayOfMonthHit
  if (dayOfWeekRestricted) return dayOfWeekHit
  return true
}
