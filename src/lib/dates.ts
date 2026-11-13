/**
 * Fechas. En la base de datos los movimientos usan DATE (YYYY-MM-DD) en el día
 * natural de Europe/Madrid. En pantalla se muestran como DD/MM/YYYY.
 */
export const TIMEZONE = 'Europe/Madrid'

const isoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Hoy en Madrid, como YYYY-MM-DD */
export function todayISO(now: Date = new Date()): string {
  return isoFmt.format(now)
}

/** "2026-11-05" → "05/11/2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

/** "05/11/2026" → "2026-11-05" (o null si no es válida) */
export function parseDisplayDate(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim())
  if (!m) return null
  const iso = `${m[3]}-${m[2]}-${m[1]}`
  return isValidISODate(iso) ? iso : null
}

export function isValidISODate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function toISO(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m, d))
  return dt.toISOString().slice(0, 10)
}

export function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m: m - 1, d }
}

export function startOfMonth(iso: string): string {
  const { y, m } = parts(iso)
  return toISO(y, m, 1)
}
export function endOfMonth(iso: string): string {
  const { y, m } = parts(iso)
  return toISO(y, m + 1, 0)
}
export function addMonths(iso: string, n: number): string {
  const { y, m } = parts(iso)
  return toISO(y, m + n, 1)
}
export function startOfQuarter(iso: string): string {
  const { y, m } = parts(iso)
  return toISO(y, m - (m % 3), 1)
}
export function endOfQuarter(iso: string): string {
  const { y, m } = parts(iso)
  return toISO(y, m - (m % 3) + 3, 0)
}
export function startOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`
}
export function endOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-12-31`
}

const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const monthNamesLong = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/** "2026-11-01" → "nov 26" */
export function monthShort(iso: string): string {
  const { y, m } = parts(iso)
  return `${monthNames[m]} ${String(y).slice(2)}`
}
/** "2026-11-01" → "noviembre 2026" */
export function monthLong(iso: string): string {
  const { y, m } = parts(iso)
  return `${monthNamesLong[m]} ${y}`
}

export type PeriodKind = 'month' | 'quarter' | 'year' | 'custom'
export interface Period {
  kind: PeriodKind
  from: string
  to: string
}

export function periodFor(kind: Exclude<PeriodKind, 'custom'>, anchor: string): Period {
  switch (kind) {
    case 'month':
      return { kind, from: startOfMonth(anchor), to: endOfMonth(anchor) }
    case 'quarter':
      return { kind, from: startOfQuarter(anchor), to: endOfQuarter(anchor) }
    case 'year':
      return { kind, from: startOfYear(anchor), to: endOfYear(anchor) }
  }
}

/** Mueve el periodo hacia delante o atrás manteniendo su tipo */
export function shiftPeriod(p: Period, dir: 1 | -1): Period {
  if (p.kind === 'custom') return p
  const step = p.kind === 'month' ? 1 : p.kind === 'quarter' ? 3 : 12
  return periodFor(p.kind, addMonths(p.from, dir * step))
}

export function periodLabel(p: Period): string {
  const { y, m } = parts(p.from)
  switch (p.kind) {
    case 'month':
      return monthLong(p.from)
    case 'quarter':
      return `${Math.floor(m / 3) + 1}.º trimestre ${y}`
    case 'year':
      return String(y)
    case 'custom':
      return `${formatDate(p.from)} – ${formatDate(p.to)}`
  }
}
