import { AlertTriangle, CheckCircle2, Lock, Pencil, Plus, Trash2, Users, XCircle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { PageHeader } from '../components/Layout'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, Input, Modal, Money, PageLoader, ProgressBar, Segmented, Select } from '../components/ui'
import { useCategories } from '../hooks/data'
import { useBudgets, useDeleteBudget, useSaveBudget, useTrips } from '../hooks/phase2'
import { formatDate, isValidISODate, todayISO } from '../lib/dates'
import { centsToInput, formatCents, parseAmountToCents, formatPercent } from '../lib/money'
import { BUDGET_PERIOD_LABEL, type Budget, type BudgetPeriod, type Visibility } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'

type Row = Budget & { spent_cents: number; period_from: string | null; period_to: string | null }

export function BudgetsPage() {
  const today = todayISO()
  const budgets = useBudgets(today)
  const categories = useCategories()
  const trips = useTrips()
  const del = useDeleteBudget()
  const { user } = useAuth()
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const catName = (id: string | null) => (id ? categories.data?.find((c) => c.id === id)?.name : null)
  const tripName = (id: string | null) => (id ? trips.data?.find((t) => t.id === id)?.name : null)

  const rows = (budgets.data ?? []) as Row[]
  const groups: [string, Row[]][] = [
    ['Mensuales', rows.filter((b) => !b.trip_id && b.period === 'monthly')],
    ['Anuales', rows.filter((b) => !b.trip_id && b.period === 'yearly')],
    ['Personalizados', rows.filter((b) => !b.trip_id && b.period === 'custom')],
    ['De viajes', rows.filter((b) => b.trip_id)],
  ]

  return (
    <>
      <PageHeader title="Presupuestos" subtitle={`Consumido a ${formatDate(today)}`} actions={<Button onClick={() => setEditing('new')}><Plus className="size-4" />Nuevo presupuesto</Button>} />
      <ErrorBox error={budgets.error} />
      {budgets.isLoading ? <PageLoader /> : !rows.length ? (
        <Card><EmptyState title="Sin presupuestos" action={<Button onClick={() => setEditing('new')}><Plus className="size-4" />Crear presupuesto</Button>}>
          Pon un límite mensual o anual, general o por categoría, personal o compartido, o para un viaje.
        </EmptyState></Card>
      ) : (
        <div className="space-y-6">
          {groups.filter(([, list]) => list.length).map(([title, list]) => (
            <Card key={title} title={title}>
              <ul className="space-y-5">
                {list.map((b) => {
                  const pct = formatPercent(b.spent_cents, b.amount_cents)
                  const over = b.spent_cents > b.amount_cents
                  const warn = !over && b.spent_cents >= b.amount_cents * 0.85
                  const scope = b.trip_id ? `Viaje: ${tripName(b.trip_id) ?? '—'}` : catName(b.category_id) ?? 'Todos los gastos'
                  return (
                    <li key={b.id}>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="font-medium">{b.name}</span>
                        <Badge tone={b.visibility === 'shared' ? 'brand' : 'slate'}>
                          {b.visibility === 'shared' ? <Users className="mr-1 size-3" /> : <Lock className="mr-1 size-3" />}
                          {b.visibility === 'shared' ? 'Compartido' : 'Personal'}
                        </Badge>
                        <span className="text-xs text-slate-500">{scope}{b.period_from ? ` · ${formatDate(b.period_from)} – ${formatDate(b.period_to)}` : ''}</span>
                        <span className="ml-auto flex">
                          {(b.visibility === 'shared' || b.owner_id === user?.id) && <>
                            <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Editar" onClick={() => setEditing(b)}><Pencil className="size-4" /></button>
                            <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar" onClick={() => setDeleting(b)}><Trash2 className="size-4" /></button>
                          </>}
                        </span>
                      </div>
                      <ProgressBar value={b.spent_cents} max={b.amount_cents} />
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-1.5">
                          {over ? <XCircle className="size-4 text-red-600" /> : warn ? <AlertTriangle className="size-4 text-amber-500" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
                          <Money cents={b.spent_cents} className="font-semibold" /> <span className="text-slate-500">de {formatCents(b.amount_cents)} · {pct} %</span>
                        </span>
                        <span className={over ? 'font-medium text-red-600' : 'text-slate-600'}>
                          {over ? `Superado en ${formatCents(b.spent_cents - b.amount_cents)}` : `Quedan ${formatCents(b.amount_cents - b.spent_cents)}`}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-slate-500">
        Un presupuesto compartido suma los gastos compartidos; uno personal, solo tus gastos personales. Los reembolsos se descuentan; las aportaciones y transferencias no cuentan.
      </p>
      {editing && <BudgetForm budget={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} title="Eliminar presupuesto" message={<p>¿Eliminar <strong>{deleting?.name}</strong>?</p>}
        loading={del.isPending} error={del.error} onCancel={() => { setDeleting(null); del.reset() }}
        onConfirm={() => deleting && del.mutateAsync(deleting.id).then(() => setDeleting(null)).catch(() => undefined)} />
    </>
  )
}

function BudgetForm({ budget, onClose }: { budget: Row | null; onClose: () => void }) {
  const categories = useCategories()
  const trips = useTrips()
  const save = useSaveBudget()
  const [kind, setKind] = useState<'period' | 'trip'>(budget?.trip_id ? 'trip' : 'period')
  const [name, setName] = useState(budget?.name ?? '')
  const [amount, setAmount] = useState(budget ? centsToInput(budget.amount_cents) : '')
  const [period, setPeriod] = useState<BudgetPeriod>(budget?.period ?? 'monthly')
  const [visibility, setVisibility] = useState<Visibility>(budget?.visibility ?? 'shared')
  const [categoryId, setCategoryId] = useState(budget?.category_id ?? '')
  const [tripId, setTripId] = useState(budget?.trip_id ?? '')
  const [start, setStart] = useState(budget?.start_date ?? todayISO().slice(0, 8) + '01')
  const [end, setEnd] = useState(budget?.end_date ?? '')
  const [error, setError] = useState<string | null>(null)

  const parents = (categories.data ?? []).filter((c) => !c.parent_id && c.kind === 'expense')
  const trip = trips.data?.find((t) => t.id === tripId)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const cents = parseAmountToCents(amount)
    if (!name.trim()) return setError('Ponle un nombre.')
    if (!cents || cents <= 0) return setError('Importe no válido.')
    if (kind === 'trip' && !tripId) return setError('Elige el viaje.')
    if (kind === 'period' && period === 'custom') {
      if (!isValidISODate(start) || !end || !isValidISODate(end) || end < start) return setError('Indica un rango de fechas válido.')
    }
    try {
      await save.mutateAsync({
        id: budget?.id, name: name.trim(), amount_cents: cents,
        period: kind === 'trip' ? 'custom' : period,
        visibility: kind === 'trip' ? trip?.visibility ?? 'shared' : visibility,
        category_id: kind === 'trip' ? null : categoryId || null,
        trip_id: kind === 'trip' ? tripId : null,
        start_date: kind === 'period' && period === 'custom' ? start : budget?.start_date ?? todayISO(),
        end_date: kind === 'period' && period === 'custom' ? end : null,
      })
      onClose()
    } catch { /* abajo */ }
  }

  return (
    <Modal open onClose={onClose} title={budget ? 'Editar presupuesto' : 'Nuevo presupuesto'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="budget-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="budget-form" className="space-y-4" onSubmit={submit} noValidate>
        <Segmented value={kind} onChange={setKind} options={[{ value: 'period', label: 'Por periodo' }, { value: 'trip', label: 'Para un viaje' }]} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" htmlFor="bname"><Input id="bname" maxLength={80} placeholder="p. ej. Súper del mes" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Límite (€)" htmlFor="bamount"><Input id="bamount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        {kind === 'trip' ? (
          <Field label="Viaje" htmlFor="btrip">
            <Select id="btrip" value={tripId} onChange={(e) => setTripId(e.target.value)}>
              <option value="">Elige viaje</option>
              {(trips.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        ) : (
          <>
            <Field label="Periodo">
              <Segmented value={period} onChange={setPeriod} options={(Object.keys(BUDGET_PERIOD_LABEL) as BudgetPeriod[]).map((k) => ({ value: k, label: BUDGET_PERIOD_LABEL[k] }))} />
            </Field>
            {period === 'custom' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Desde" htmlFor="bstart"><Input id="bstart" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
                <Field label="Hasta" htmlFor="bend"><Input id="bend" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
              </div>
            )}
            <Field label="Categoría" htmlFor="bcat">
              <Select id="bcat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Todos los gastos</option>
                {parents.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    <option value={p.id}>{p.name} (toda)</option>
                    {(categories.data ?? []).filter((c) => c.parent_id === p.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <Field label="Qué gastos cuenta" hint={visibility === 'shared' ? 'Los gastos compartidos. Lo veréis los dos.' : 'Solo tus gastos personales. Solo lo verás tú.'}>
              <Segmented value={visibility} onChange={setVisibility} options={[{ value: 'shared', label: 'Compartidos' }, { value: 'personal', label: 'Mis personales' }]} />
            </Field>
          </>
        )}
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}
