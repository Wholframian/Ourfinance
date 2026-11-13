/**
 * Utilidades de dinero. Todo se maneja en céntimos enteros para evitar errores
 * de coma flotante; solo se formatea a euros al mostrarlo.
 */

const eur = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always',
})

const eurCompact = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatCents(cents: number | null | undefined): string {
  return eur.format((cents ?? 0) / 100)
}

export function formatCentsCompact(cents: number): string {
  return eurCompact.format(cents / 100)
}

/** Formato para rellenar un input: 1234,5 → "1234,50" */
export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}

/**
 * Convierte lo que escribe el usuario a céntimos. Acepta "12", "12,5", "12.50",
 * "1.234,56", "1,234.56", "1 234,56 €". Devuelve null si no es un importe válido
 * o tiene más de dos decimales.
 */
export function parseAmountToCents(input: string): number | null {
  let s = input.replace(/[\s€ ]/g, '')
  if (s === '') return null
  let negative = false
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  if (!/^[\d.,]+$/.test(s)) return null

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  let intPart: string
  let decPart = ''

  if (lastComma >= 0 && lastDot >= 0) {
    const decSep = lastComma > lastDot ? ',' : '.'
    const thouSep = decSep === ',' ? '.' : ','
    const [i, d, ...rest] = s.split(decSep)
    if (rest.length) return null
    if (!/^\d{1,3}([.,]\d{3})*$/.test(i) || i.includes(decSep)) return null
    intPart = i.split(thouSep).join('')
    decPart = d
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.'
    const parts = s.split(sep)
    if (parts.length === 2 && parts[1].length <= 2) {
      intPart = parts[0]
      decPart = parts[1]
    } else if (sep === '.' && /^\d{1,3}(\.\d{3})+$/.test(s)) {
      // En español la coma es siempre decimal; el punto solo puede ser de miles
      intPart = parts.join('')
    } else {
      return null
    }
  } else {
    intPart = s
  }

  if (intPart === '') intPart = '0'
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(decPart)) return null
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

/** Porcentaje entero seguro (evita divisiones por cero). */
export function percent(part: number, total: number): number {
  if (!total) return 0
  return Math.round((part / total) * 1000) / 10
}
