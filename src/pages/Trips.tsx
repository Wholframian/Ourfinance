import { ArrowLeft, MapPin, Pencil, Plane, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DonutWithTable, MonthlyBars, SERIES, ShareBar } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { TransactionForm } from '../components/TransactionForm'
import { TransactionList } from '../components/TransactionList'
import {
  Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, Input, Modal, Money, PageLoader, ProgressBar,
  Segmented, Select, StatCard, Textarea,
} from '../components/ui'
import { useDeleteTrip, useSaveTrip, useTripExpenses, useTrips, useTripSummaries } from '../hooks/phase2'
import { formatDate, isValidISODate } from '../lib/dates'
import { memberSeriesColor } from '../lib/members'
import { centsToInput, formatCents, parseAmountToCents, formatPercent } from '../lib/money'
import { TRIP_CATEGORY_LABEL, TRIP_STATUS_LABEL, type Trip, type TripExpenseCategory, type TripStatus, type Visibility } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'

function tripDates(t: Trip) {
  if (!t.start_date) return 'Sin fechas'
  return t.end_date && t.end_date !== t.start_date ? `${formatDate(t.start_date)} – ${formatDate(t.end_date)}` : formatDate(t.start_date)
}

const statusTone: Record<TripStatus, 'brand' | 'amber' | 'slate' | 'violet'> = { planned: 'violet', ongoing: 'amber', finished: 'brand', cancelled: 'slate' }

export function TripsPage() {
  const trips = useTrips()
  const summaries = useTripSummaries()
  const [editing, setEditing] = useState<Trip | 'new' | null>(null)
  const list = trips.data ?? []
  const spent = (id: string) => summaries.data?.get(id)?.spent ?? 0
  const compare = [...list].filter((t) => t.status !== 'cancelled').reverse()
    .map((t) => ({ month: t.name, spent: spent(t.id), budget: t.budget_cents ?? 0 }))

  return (
    <>
      <PageHeader title="Viajes" subtitle="Presupuesto, gasto real e histórico"
        actions={<Button onClick={() => setEditing('new')}><Plus className="size-4" />Nuevo viaje</Button>} />
      <ErrorBox error={trips.error ?? summaries.error} />
      {trips.isLoading ? <PageLoader /> : !list.length ? (
        <Card><EmptyState title="Todavía no hay viajes" action={<Button onClick={() => setEditing('new')}><Plus className="size-4" />Crear el primero</Button>}>
          Crea un viaje y asígnale gastos al registrarlos (vuelos, hotel, restaurantes...). Verás el presupuesto frente al gasto real.
        </EmptyState></Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((t) => {
              const s = spent(t.id)
              return (
                <Link key={t.id} to={`/viajes/${t.id}`} className="block rounded-2xl bg-white p-5 ring-1 ring-slate-200/70 transition hover:ring-slate-300">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700"><Plane className="size-5" /></div>
                    <Badge tone={statusTone[t.status]}>{TRIP_STATUS_LABEL[t.status]}</Badge>
                  </div>
                  <h3 className="mt-3 font-semibold">{t.name}</h3>
                  <p className="flex items-center gap-1 text-xs text-slate-500"><MapPin className="size-3" />{t.destination || '—'} · {tripDates(t)}</p>
                  <div className="mt-4 flex items-baseline justify-between text-sm">
                    <Money cents={s} className="font-semibold" />
                    {t.budget_cents ? <span className="text-xs text-slate-500">de {formatCents(t.budget_cents)}</span> : <span className="text-xs text-slate-400">sin presupuesto</span>}
                  </div>
                  {!!t.budget_cents && <div className="mt-2"><ProgressBar value={s} max={t.budget_cents} /></div>}
                </Link>
              )
            })}
          </div>
          {compare.length > 1 && (
            <Card className="mt-6" title="Comparativa entre viajes">
              <MonthlyBars data={compare} xFormat={(v) => v} series={[
                { key: 'budget', label: 'Presupuesto', color: SERIES[6] },
                { key: 'spent', label: 'Gasto real', color: SERIES[0] },
              ]} />
            </Card>
          )}
        </>
      )}
      {editing && <TripForm trip={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

export function TripDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { members } = useHousehold()
  const trips = useTrips()
  const expenses = useTripExpenses(id)
  const del = useDeleteTrip()
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const trip = trips.data?.find((t) => t.id === id)

  if (trips.isLoading) return <PageLoader />
  if (!trip) return <Card><EmptyState title="Viaje no encontrado" action={<Link to="/viajes" className="underline">Volver a viajes</Link>} /></Card>

  const rows = expenses.data ?? []
  const value = (r: (typeof rows)[number]) => (r.transactions.type === 'refund' ? -r.transactions.amount_cents : r.transactions.amount_cents)
  const total = rows.reduce((s, r) => s + value(r), 0)
  const byCat = new Map<TripExpenseCategory, number>()
  for (const r of rows) byCat.set(r.trip_category, (byCat.get(r.trip_category) ?? 0) + value(r))
  const catOrder = Object.keys(TRIP_CATEGORY_LABEL) as TripExpenseCategory[]
  const byPerson = members.map((m, i) => ({
    label: m.profile?.full_name ?? 'Miembro',
    value: rows.filter((r) => (r.transactions.paid_by ?? r.transactions.created_by) === m.user_id).reduce((s, r) => s + value(r), 0),
    color: memberSeriesColor(i),
  }))
  const participants = (trip.trip_participants ?? []).map((p) => members.find((m) => m.user_id === p.user_id)).filter(Boolean)
  const days = trip.start_date && trip.end_date ? Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 86_400_000) + 1 : null

  return (
    <>
      <Link to="/viajes" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" />Viajes</Link>
      <PageHeader
        title={trip.name}
        subtitle={`${trip.destination ? trip.destination + ' · ' : ''}${tripDates(trip)} · ${TRIP_STATUS_LABEL[trip.status]}`}
        actions={<>
          <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" />Editar</Button>
          <Button variant="ghost" className="text-red-600" onClick={() => setDeleting(true)} aria-label="Eliminar viaje"><Trash2 className="size-4" /></Button>
          <Button onClick={() => setAdding(true)}><Plus className="size-4" />Añadir gasto</Button>
        </>}
      />
      <ErrorBox error={expenses.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1"><StatCard tone="brand" label="Coste total" cents={expenses.data ? total : undefined} hint={days ? `${days} días · ${formatCents(Math.round(total / days))}/día` : undefined} /></div>
        <StatCard label="Presupuesto" cents={trip.budget_cents ?? 0} hint={trip.budget_cents ? `${formatPercent(total, trip.budget_cents)} % consumido` : 'Sin presupuesto'} />
        <StatCard label={total > (trip.budget_cents ?? 0) && trip.budget_cents ? 'Exceso' : 'Restante'} cents={trip.budget_cents ? Math.abs(trip.budget_cents - total) : 0} />
        <StatCard label="Gasto por participante" cents={expenses.data ? Math.round(total / Math.max(1, participants.length || 1)) : undefined} hint={`${rows.length} gastos · ${participants.length || 1} participantes`} />
      </div>
      {!!trip.budget_cents && <div className="mt-4"><ProgressBar value={total} max={trip.budget_cents} /></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Gasto por categoría">
          <DonutWithTable slices={catOrder.filter((k) => byCat.get(k)).map((k, i) => ({ name: TRIP_CATEGORY_LABEL[k], value: byCat.get(k)!, color: SERIES[i % SERIES.length] }))} />
        </Card>
        <Card title="Gasto por persona">
          {total ? <ShareBar parts={byPerson} /> : <EmptyState title="Sin gastos todavía" />}
          {participants.length > 0 && (
            <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
              Participantes: {participants.map((m) => <span key={m!.user_id} className="inline-flex items-center gap-1"><Avatar name={m!.profile?.full_name} color={m!.profile?.color} />{m!.profile?.full_name?.split(' ')[0]}</span>)}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">Según quién pagó cada gasto. Los pagados desde la cuenta común cuentan para quien los registró.</p>
        </Card>
      </div>

      <Card className="mt-6" title="Gastos del viaje">
        {expenses.isLoading ? <PageLoader /> : <TransactionList rows={rows.map((r) => r.transactions)} emptyText="Añade gastos al viaje desde aquí o eligiendo el viaje al registrar un gasto." />}
      </Card>

      {editing && <TripForm trip={trip} onClose={() => setEditing(false)} />}
      <TransactionForm open={adding} onClose={() => setAdding(false)} presetTripId={trip.id} />
      <ConfirmDialog
        open={deleting}
        title="Eliminar viaje"
        message={<p>¿Eliminar <strong>{trip.name}</strong>? Los gastos no se borran: siguen en Movimientos, solo dejan de estar asignados al viaje.</p>}
        loading={del.isPending}
        error={del.error}
        onCancel={() => setDeleting(false)}
        onConfirm={() => del.mutateAsync(trip.id).then(() => navigate('/viajes')).catch(() => undefined)}
      />
    </>
  )
}

function TripForm({ trip, onClose }: { trip: Trip | null; onClose: () => void }) {
  const { members } = useHousehold()
  const { user } = useAuth()
  const save = useSaveTrip()
  const navigate = useNavigate()
  const [name, setName] = useState(trip?.name ?? '')
  const [destination, setDestination] = useState(trip?.destination ?? '')
  const [start, setStart] = useState(trip?.start_date ?? '')
  const [end, setEnd] = useState(trip?.end_date ?? '')
  const [budget, setBudget] = useState(trip?.budget_cents ? centsToInput(trip.budget_cents) : '')
  const [status, setStatus] = useState<TripStatus>(trip?.status ?? 'planned')
  const [visibility, setVisibility] = useState<Visibility>(trip?.visibility ?? 'shared')
  const [notes, setNotes] = useState(trip?.notes ?? '')
  const [participants, setParticipants] = useState<string[]>(trip?.trip_participants?.map((p) => p.user_id) ?? members.map((m) => m.user_id))
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Ponle un nombre al viaje.')
    if (start && !isValidISODate(start)) return setError('Fecha de inicio no válida.')
    if (end && (!isValidISODate(end) || (start && end < start))) return setError('La fecha de fin debe ser igual o posterior al inicio.')
    let budgetCents: number | null = null
    if (budget.trim()) {
      budgetCents = parseAmountToCents(budget)
      if (budgetCents === null || budgetCents < 0) return setError('Presupuesto no válido.')
    }
    const parts = visibility === 'personal' ? [user!.id] : participants
    try {
      const id = await save.mutateAsync({
        id: trip?.id, name: name.trim(), destination: destination.trim() || null, start_date: start || null, end_date: end || null,
        budget_cents: budgetCents, status, visibility, notes: notes.trim() || null, participants: parts,
      })
      onClose()
      if (!trip) navigate(`/viajes/${id}`)
    } catch { /* abajo */ }
  }

  return (
    <Modal open onClose={onClose} title={trip ? 'Editar viaje' : 'Nuevo viaje'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="trip-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="trip-form" className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" htmlFor="tname"><Input id="tname" maxLength={80} placeholder="p. ej. Roma 2026" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Destino" htmlFor="tdest"><Input id="tdest" maxLength={120} value={destination} onChange={(e) => setDestination(e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Inicio" htmlFor="tstart"><Input id="tstart" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Fin" htmlFor="tend"><Input id="tend" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Presupuesto (€)" htmlFor="tbudget"><Input id="tbudget" inputMode="decimal" placeholder="Opcional" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
          <Field label="Estado" htmlFor="tstatus">
            <Select id="tstatus" value={status} onChange={(e) => setStatus(e.target.value as TripStatus)}>
              {Object.entries(TRIP_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Visibilidad" hint={visibility === 'shared' ? 'Lo veréis los dos; sus gastos serán compartidos.' : 'Solo lo verás tú.'}>
          <Segmented value={visibility} onChange={setVisibility} options={[{ value: 'shared', label: 'Compartido' }, { value: 'personal', label: 'Personal', disabled: !!trip && trip.visibility === 'shared' }]} />
        </Field>
        {visibility === 'shared' && (
          <Field label="Participantes">
            <div className="flex flex-wrap gap-2">
              {members.map((m) => {
                const on = participants.includes(m.user_id)
                return (
                  <button key={m.user_id} type="button" onClick={() => setParticipants((p) => (on ? p.filter((x) => x !== m.user_id) : [...p, m.user_id]))}
                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm ring-1 ${on ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white ring-slate-200'}`}>
                    <Avatar name={m.profile?.full_name} color={m.profile?.color} />{m.profile?.full_name}
                  </button>
                )
              })}
            </div>
          </Field>
        )}
        <Field label="Notas" htmlFor="tnotes"><Textarea id="tnotes" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}
