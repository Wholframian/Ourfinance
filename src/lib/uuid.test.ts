import { afterEach, describe, expect, it } from 'vitest'
import { uuid } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')

describe('uuid', () => {
  afterEach(() => {
    if (original) Object.defineProperty(crypto, 'randomUUID', original)
    else delete (crypto as { randomUUID?: unknown }).randomUUID
  })
  it('usa crypto.randomUUID si existe', () => {
    expect(uuid()).toMatch(V4)
  })
  it('funciona en móviles antiguos sin crypto.randomUUID', () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    const a = uuid()
    expect(a).toMatch(V4)
    expect(uuid()).not.toBe(a)
  })
})
