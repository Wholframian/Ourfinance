import { useMemo } from 'react'
import { DonutWithTable, NEUTRAL, SERIES, ShareBar, StackedMonthlyBars } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionList } from '../components/TransactionList'
import { Card, EmptyState, ErrorBox, PageLoader, StatCard } from '../components/ui'
import { useCategoryBreakdown, useTransactions } from '../hooks/data'
import { addMonths, endOfMonth, periodLabel, startOfMonth } from '../lib/dates'
import { usePeriod } from '../providers/PeriodProvider'
import { useGroupCategory } from './House'

/** Subcategorías que cuentan como "restauración" (comer fuera) */
const DINING = ['Restaurantes', 'Bares', 'Cafeterías', 'Comida a domicilio', 'Comidas de trabajo']
const GROCERIES = ['Supermercado']

export function FoodPage() {
  const { period } = usePeriod()
  const { parent: food, categories } = useGroupCategory('food')
  const fid = food?.id
  const win = { from: addMonths(startOfMonth(period.to), -11), to: endOfMonth(period.to) }
  const windowFrom = win.from < period.from ? win.from : period.from

  const tx = useTransactions({ from: windowFrom, to: win.to, categoryId: fid, types: ['expense', 'refund'] }, 0, 5000)
  const breakdown = useCategoryBreakdown(period.from, period.to, null, fid ?? '00000000-0000-0000-0000-000000000000')
  const latest = useTransactions({ from: period.from, to: period.to, categoryId: fid, types: ['expense', 'refund'] }, 0, 20)

  const subName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data])
  const kindOf = (subId: string | null) => {
    const n = subId ? subName.get(subId) ?? '' : ''
    return GROCERIES.includes(n) ? 'groceries' : DINING.includes(n) ? 'dining' : 'other'
  }

  const { monthly, periodTotals } = useMemo(() => {
    const months = new Map<string, Record<string, number | string>>()
    for (let m = win.from; m <= win.to; m = addMonths(m, 1)) months.set(m, { month: m, groceries: 0, dining: 0, other: 0 })
    const totals = { groceries: 0, dining: 0, other: 0 }
    for (const t of tx.data?.rows ?? []) {
      const v = t.type === 'expense' ? t.amount_cents : -t.amount_cents
      const k = kindOf(t.subcategory_id)
      const row = months.get(startOfMonth(t.occurred_on))
      if (row) row[k] = (row[k] as number) + v
      if (t.occurred_on >= period.from && t.occurred_on <= period.to) totals[k] += v
    }
    return { monthly: [...months.values()], periodTotals: totals }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.data, subName, win.from, win.to, period.from, period.to])

  const total = periodTotals.groceries + periodTotals.dining + periodTotals.other
  const monthTotals = monthly.map((m) => (m.groceries as number) + (m.dining as number) + (m.other as number))
  const months12 = monthTotals.reduce((a, b) => a + b, 0)
  const firstIdx = monthTotals.findIndex((v) => v !== 0)
  const monthsWithHistory = firstIdx < 0 ? 1 : monthTotals.length - firstIdx

  if (categories.isLoading) return <PageLoader />
  if (!food) return <Card><EmptyState title="No existe la categoría Alimentación">Créala en Ajustes → Categorías.</EmptyState></Card>

  return (
    <>
      <PageHeader title="Comidas y restaurantes" subtitle={`Alimentación y restauración · ${periodLabel(period)}`} actions={<PeriodFilter />} />
      <ErrorBox error={tx.error ?? breakdown.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1"><StatCard tone="brand" label="Alimentación total" cents={tx.data ? total : undefined} /></div>
        <StatCard label="Supermercado" cents={tx.data ? periodTotals.groceries : undefined} />
        <StatCard label="Comer fuera" cents={tx.data ? periodTotals.dining : undefined} hint="Restaurantes, bares, cafeterías, a domicilio y de trabajo" />
        <StatCard label="Media mensual" cents={tx.data ? Math.round(months12 / monthsWithHistory) : undefined} hint={monthsWithHistory < 12 ? (monthsWithHistory === 1 ? 'Último mes con datos' : `Últimos ${monthsWithHistory} meses con datos`) : 'Últimos 12 meses'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Cada mes: súper frente a comer fuera">
          {tx.isLoading ? <PageLoader /> : (
            <StackedMonthlyBars data={monthly} series={[
              { key: 'groceries', label: 'Supermercado', color: SERIES[2] },
              { key: 'dining', label: 'Comer fuera', color: SERIES[1] },
              { key: 'other', label: 'Otros', color: SERIES[6] },
            ]} />
          )}
        </Card>
        <Card title="Por tipo">
          {breakdown.isLoading ? <PageLoader /> : (
            <DonutWithTable slices={(breakdown.data ?? []).map((c, i) => ({ name: c.name, value: c.expense_cents, color: c.category_id ? SERIES[i % SERIES.length] : NEUTRAL }))} />
          )}
        </Card>
      </div>

      {total > 0 && (
        <Card className="mt-6" title="Reparto del periodo">
          <ShareBar parts={[
            { label: 'Supermercado', value: periodTotals.groceries, color: SERIES[2] },
            { label: 'Comer fuera', value: periodTotals.dining, color: SERIES[1] },
            { label: 'Otros', value: periodTotals.other, color: SERIES[6] },
          ]} />
        </Card>
      )}

      <Card className="mt-6" title="Últimos gastos de alimentación">
        {latest.isLoading ? <PageLoader /> : <TransactionList rows={latest.data?.rows ?? []} emptyText="No hay gastos de alimentación en este periodo." />}
      </Card>
    </>
  )
}
