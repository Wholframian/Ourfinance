import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { isValidISODate, periodFor, periodLabel, shiftPeriod, todayISO, type PeriodKind } from '../lib/dates'
import { usePeriod } from '../providers/PeriodProvider'
import { Input, Segmented } from './ui'

/** Filtro de periodo: mes, trimestre, año o rango personalizado. */
export function PeriodFilter() {
  const { period, setPeriod } = usePeriod()
  const [from, setFrom] = useState(period.from)
  const [to, setTo] = useState(period.to)

  const changeKind = (kind: PeriodKind) => {
    if (kind === 'custom') {
      setFrom(period.from)
      setTo(period.to)
      setPeriod({ kind, from: period.from, to: period.to })
    } else {
      setPeriod(periodFor(kind, period.kind === 'custom' ? todayISO() : period.from))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        value={period.kind}
        onChange={changeKind}
        options={[
          { value: 'month', label: 'Mes' },
          { value: 'quarter', label: 'Trimestre' },
          { value: 'year', label: 'Año' },
          { value: 'custom', label: 'Rango' },
        ]}
      />
      {period.kind === 'custom' ? (
        <div className="flex items-center gap-2">
          <Input type="date" aria-label="Desde" value={from} className="h-9 w-auto py-1.5"
            onChange={(e) => {
              setFrom(e.target.value)
              if (isValidISODate(e.target.value) && e.target.value <= to) setPeriod({ kind: 'custom', from: e.target.value, to })
            }} />
          <span className="text-slate-400">–</span>
          <Input type="date" aria-label="Hasta" value={to} className="h-9 w-auto py-1.5"
            onChange={(e) => {
              setTo(e.target.value)
              if (isValidISODate(e.target.value) && from <= e.target.value) setPeriod({ kind: 'custom', from, to: e.target.value })
            }} />
        </div>
      ) : (
        <div className="flex items-center rounded-xl bg-white ring-1 ring-slate-200">
          <button className="p-2 text-slate-500 hover:text-slate-900" onClick={() => setPeriod(shiftPeriod(period, -1))} aria-label="Periodo anterior">
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-36 text-center text-sm font-medium capitalize">{periodLabel(period)}</span>
          <button className="p-2 text-slate-500 hover:text-slate-900" onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label="Periodo siguiente">
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}
