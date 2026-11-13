import { describe, expect, it } from 'vitest'
import { euros, toCsv } from './export'
import { formatQuantity, formatSignedPercent, parseDecimal } from './money'

describe('toCsv', () => {
  it('usa ; como separador, coma decimal, fechas DD/MM/YYYY y BOM', () => {
    const csv = toCsv([{ d: '2026-11-05', a: 12034, t: 'Mercadona; súper' }], [
      { header: 'Fecha', value: (r) => r.d, date: true },
      { header: 'Importe', value: (r) => euros(r.a), money: true },
      { header: 'Texto', value: (r) => r.t },
    ])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('Fecha;Importe;Texto')
    expect(csv).toContain('05/11/2026;120,34;"Mercadona; súper"')
  })
  it('neutraliza fórmulas (inyección CSV) y escapa comillas', () => {
    const csv = toCsv([{ t: '=HYPERLINK("x")' }], [{ header: 'T', value: (r) => r.t }])
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
  })
  it('importes negativos como número', () => {
    expect(toCsv([{ a: -4599 }], [{ header: 'A', value: (r) => euros(r.a), money: true }])).toContain('-45,99')
  })
})

describe('parseDecimal', () => {
  it('acepta coma o punto decimal', () => {
    expect(parseDecimal('0,0125')).toBe('0.0125')
    expect(parseDecimal('12.5')).toBe('12.5')
    expect(parseDecimal('100')).toBe('100')
    expect(parseDecimal('1.234,5678')).toBe('1234.5678')
    expect(parseDecimal('3,10')).toBe('3.1')
  })
  it('rechaza valores no válidos', () => {
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal('-3')).toBeNull()
    expect(parseDecimal('1,123456789', 8)).toBeNull()
  })
})

describe('formatos', () => {
  it('unidades y rentabilidad', () => {
    expect(formatQuantity(0.0125)).toBe('0,0125')
    expect(formatSignedPercent(13497, 50002)).toBe('+27 %')
    expect(formatSignedPercent(-500, 10000)).toBe('−5 %')
  })
})
