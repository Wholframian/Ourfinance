import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DonutWithTable, MonthlyBars, NEUTRAL, SERIES } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { RecurringForm } from '../components/RecurringForm'
import { TransactionList, useTxLookups } from '../components/TransactionList'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Money, PageLoader, StatCard } from '../components/ui'
import { useCategories, useCategoryBreakdown, useMonthlyFlows, useTransactions } from '../hooks/data'
import { useDeleteRecurring, useRecurring, useRegisterRecurring, useSaveRecurring } from '../hooks/phase2'
import { addMonths, endOfMonth, formatDate, periodLabel, startOfMonth, todayISO } from '../lib/dates'
import { FREQUENCY_LABEL, FREQUENCY_MONTHS, type RecurringTransaction } from '../lib/types'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** Busca la categoría principal de un grupo (housing, food...). */
export function useGroupCategory(groupKey: string) {
  const categories = useCategories()
  const parent = (categories.data ?? []).find((c) => !c.parent_id && c.kind === 'expense' && c.group_key === groupKey)
  return { parent, categories }
}

export function HousePage() {
  const { period } = usePeriod()
  const { parent: housing, categories } = useGroupCategory('housing')
  const hid = housing?.id
  const today = todayISO()
  const year = Number(period.to.slice(0, 4))

  const last12 = { from: addMonths(startOfMonth(today), -11), to: endOfMonth(today) }
  const periodFlows = useMonthlyFlows(period.from, period.to, hid ?? '00000000-0000-0000-0000-000000000000')
  const flows12 = useMonthlyFlows(last12.from, last12.to, hid ?? '00000000-0000-0000-0000-000000000000')
  const cur = useMonthlyFlows(`${year}-01-01`, `${year}-12-31`, hid ?? '00000000-0000-0000-0000-000000000000')
  const prev = useMonthlyFlows(`${year - 1}-01-01`, `${year - 1}-12-31`, hid ?? '00000000-0000-0000-0000-000000000000')
  const breakdown = useCategoryBreakdown(period.from, period.to, null, hid ?? '00000000-0000-0000-0000-000000000000')
  const expenses = useTransactions({ from: period.from, to: period.to, categoryId: hid, types: ['expense', 'refund'] }, 0, 100)
  const recurring = useRecurring()

  const sum = (rows?: { expense_cents: number }[]) => (rows ?? []).reduce((s, r) => s + r.expense_cents, 0)
  const periodTotal = sum(periodFlows.data)
  const total12 = sum(flows12.data)
  // Media sobre los meses desde el primer gasto de vivienda (máx. 12), para no diluirla al empezar
  const firstIdx = (flows12.data ?? []).findIndex((r) => r.expense_cents !== 0)
  const monthsWithHistory = firstIdx < 0 ? 1 : (flows12.data!.length - firstIdx)

  const housingRecurring = (recurring.data ?? []).filter((r) => r.category_id === hid)
  const fixedMonthly = housingRecurring.filter((r) => r.is_active)
    .reduce((s, r) => s + Math.round(r.amount_cents / FREQUENCY_MONTHS[r.frequency]), 0)

  const comparison = MONTHS.map((m, i) => ({
    month: m,
    prev: prev.data?.[i]?.expense_cents ?? 0,
    cur: cur.data?.[i]?.expense_cents ?? 0,
  }))

  if (categories.isLoading) return <PageLoader />
  if (!housing) return <Card><EmptyState title="No existe la categoría Vivienda">Créala en Ajustes → Categorías.</EmptyState></Card>

  return (
    <>
      <PageHeader title="Casa" subtitle={`Gastos de la vivienda · ${periodLabel(period)}`} actions={<PeriodFilter />} />
      <ErrorBox error={periodFlows.error ?? recurring.error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1"><StatCard tone="brand" label="Gasto en el periodo" cents={periodFlows.data ? periodTotal : undefined} /></div>
        <StatCard label="Coste mensual medio" cents={flows12.data ? Math.round(total12 / monthsWithHistory) : undefined} hint={monthsWithHistory < 12 ? (monthsWithHistory === 1 ? 'Último mes con datos' : `Últimos ${monthsWithHistory} meses con datos`) : 'Últimos 12 meses'} />
        <StatCard label="Coste anual" cents={flows12.data ? total12 : undefined} hint="Últimos 12 meses" />
        <StatCard label="Gastos fijos al mes" cents={recurring.data ? fixedMonthly : undefined} hint={`${housingRecurring.filter((r) => r.is_active).length} recurrentes activos`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title={`Comparativa ${year - 1} / ${year}`}>
          {cur.isLoading || prev.isLoading ? <PageLoader /> : (
            <MonthlyBars data={comparison} xFormat={(v) => v} series={[
              { key: 'prev', label: String(year - 1), color: SERIES[6] },
              { key: 'cur', label: String(year), color: SERIES[0] },
            ]} />
          )}
          <p className="mt-2 text-xs text-slate-500">
            Total {year - 1}: <Money cents={sum(prev.data)} /> · Total {year}: <Money cents={sum(cur.data)} />
          </p>
        </Card>
        <Card title="En qué se va">
          {breakdown.isLoading ? <PageLoader /> : (
            <DonutWithTable slices={(breakdown.data ?? []).map((c, i) => ({ name: c.name, value: c.expense_cents, color: c.category_id ? SERIES[i % SERIES.length] : NEUTRAL }))} />
          )}
        </Card>
      </div>

      <RecurringCard items={housingRecurring} defaultCategoryId={hid} loading={recurring.isLoading} />

      <Card className="mt-6" title="Gastos de la vivienda en el periodo">
        {expenses.isLoading ? <PageLoader /> : <TransactionList rows={expenses.data?.rows ?? []} emptyText="No hay gastos de vivienda en este periodo." />}
        <p className="mt-3 text-xs text-slate-500">El avatar indica quién lo registró; la cuenta indica desde dónde se pagó (tu cuenta o la cuenta común).</p>
      </Card>
    </>
  )
}

/** Lista de recurrentes con registrar cuota, pausar, editar y borrar. */
export function RecurringCard({ items, defaultCategoryId, loading, title = 'Gastos recurrentes' }: {
  items: RecurringTransaction[]; defaultCategoryId?: string; loading: boolean; title?: string
}) {
  const { profileById } = useHousehold()
  const { accountName, category } = useTxLookups()
  const register = useRegisterRecurring()
  const save = useSaveRecurring()
  const del = useDeleteRecurring()
  const [editing, setEditing] = useState<RecurringTransaction | 'new' | null>(null)
  const [deleting, setDeleting] = useState<RecurringTransaction | null>(null)
  const today = todayISO()
  const sorted = useMemo(() => [...items].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.next_due_on.localeCompare(b.next_due_on)), [items])

  return (
    <Card className="mt-6" title={title} action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Nuevo</Button>}>
      {loading ? <PageLoader /> : !sorted.length ? (
        <EmptyState title="Sin gastos recurrentes">Añade el alquiler o la hipoteca, la luz, el agua, internet o los seguros para saber vuestro coste fijo y registrar cada cuota con un toque.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {sorted.map((r) => {
            const due = r.is_active && r.next_due_on <= today
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                <CalendarClock className="size-5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {r.description}
                    <Badge>{FREQUENCY_LABEL[r.frequency]}</Badge>
                    {!r.is_active && <Badge>Pausado</Badge>}
                    {due && <Badge tone="amber">Pendiente</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {r.is_active ? `Próxima: ${formatDate(r.next_due_on)}` : 'Sin próximas cuotas'} · {category(r.subcategory_id)?.name ?? category(r.category_id)?.name ?? 'Sin categoría'} · {accountName(r.account_id)} · {profileById(r.created_by)?.full_name?.split(' ')[0]}
                  </p>
                </div>
                <Money cents={r.amount_cents} className="text-sm font-semibold" />
                <div className="flex items-center gap-1">
                  {r.is_active && (
                    <Button size="sm" variant={due ? 'primary' : 'secondary'} loading={register.isPending && register.variables === r.id}
                      onClick={() => register.mutate(r.id)} title={`Registra la cuota del ${formatDate(r.next_due_on)} como movimiento`}>
                      Registrar cuota
                    </Button>
                  )}
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={r.is_active ? 'Pausar' : 'Reanudar'}
                    onClick={() => save.mutate({ ...r, is_active: !r.is_active })}>
                    {r.is_active ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Editar" onClick={() => setEditing(r)}><Pencil className="size-4" /></button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar" onClick={() => setDeleting(r)}><Trash2 className="size-4" /></button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <ErrorBox error={register.error ?? save.error} />
      {editing && <RecurringForm editing={editing === 'new' ? null : editing} defaultCategoryId={defaultCategoryId} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title="Eliminar recurrente"
        message={<p>¿Eliminar <strong>{deleting?.description}</strong>? Los movimientos ya registrados se conservan.</p>}
        loading={del.isPending}
        error={del.error}
        onCancel={() => { setDeleting(null); del.reset() }}
        onConfirm={() => deleting && del.mutateAsync(deleting.id).then(() => setDeleting(null)).catch(() => undefined)}
      />
    </Card>
  )
}
