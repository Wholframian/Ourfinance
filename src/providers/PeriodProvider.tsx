import { createContext, useContext, useState, type ReactNode } from 'react'
import { periodFor, todayISO, type Period } from '../lib/dates'

const Ctx = createContext<{ period: Period; setPeriod: (p: Period) => void } | null>(null)

/** Periodo seleccionado (mes, trimestre, año o rango), compartido entre páginas. */
export function PeriodProvider({ children }: { children: ReactNode }) {
  const [period, setPeriod] = useState<Period>(() => periodFor('month', todayISO()))
  return <Ctx.Provider value={{ period, setPeriod }}>{children}</Ctx.Provider>
}

export function usePeriod() {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePeriod fuera de PeriodProvider')
  return v
}
