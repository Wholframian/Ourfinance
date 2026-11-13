import { describe, expect, it } from 'vitest'
import { centsToInput, formatCents, parseAmountToCents, percent } from './money'

describe('parseAmountToCents', () => {
  it.each([
    ['12', 1200],
    ['12,5', 1250],
    ['12,50', 1250],
    ['12.50', 1250],
    ['0,01', 1],
    [',99', 99],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['1.234', 123400],
    ['1 234,56 €', 123456],
    ['1.234.567,89', 123456789],
    ['-5,10', -510],
  ])('%s → %i', (input, cents) => {
    expect(parseAmountToCents(input)).toBe(cents)
  })

  it.each(['', 'abc', '12,345', '1,2,3', '12.3.4', '1.23,4.5', '€'])('rechaza %s', (input) => {
    expect(parseAmountToCents(input)).toBeNull()
  })

  it('no pierde céntimos con coma flotante', () => {
    expect(parseAmountToCents('0,1')! + parseAmountToCents('0,2')!).toBe(30)
    expect(parseAmountToCents('19,99')).toBe(1999)
  })
})

describe('formato', () => {
  it('formatea en euros con dos decimales', () => {
    expect(formatCents(123456).replace(/ /g, ' ')).toBe('1.234,56 €')
    expect(formatCents(5).replace(/ /g, ' ')).toBe('0,05 €')
  })
  it('centsToInput', () => {
    expect(centsToInput(1250)).toBe('12,50')
    expect(centsToInput(7)).toBe('0,07')
  })
  it('percent', () => {
    expect(percent(600, 1000)).toBe(60)
    expect(percent(1, 3)).toBe(33.3)
    expect(percent(1, 0)).toBe(0)
  })
})
