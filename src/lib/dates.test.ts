import { describe, expect, it } from 'vitest'
import { endOfMonth, formatDate, parseDisplayDate, periodFor, periodLabel, shiftPeriod, todayISO } from './dates'

describe('fechas', () => {
  it('formatea DD/MM/YYYY', () => {
    expect(formatDate('2026-11-05')).toBe('05/11/2026')
    expect(parseDisplayDate('29/02/2028')).toBe('2028-02-29')
    expect(parseDisplayDate('29/02/2027')).toBeNull()
  })
  it('usa el día de Madrid', () => {
    // 23:30 UTC del 31/12 ya es 1 de enero en Madrid
    expect(todayISO(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01')
  })
  it('periodos', () => {
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29')
    expect(periodFor('quarter', '2026-11-13')).toEqual({ kind: 'quarter', from: '2026-10-01', to: '2026-12-31' })
    expect(shiftPeriod(periodFor('month', '2026-01-15'), -1)).toEqual({ kind: 'month', from: '2025-12-01', to: '2025-12-31' })
    expect(periodLabel(periodFor('month', '2026-11-13'))).toBe('noviembre 2026')
  })
})
