import { ArrowLeft, ChevronRight, Lock, Plus, Trash2, TrendingUp, Users, Wallet } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MonthlyBars, SERIES } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionList } from '../components/TransactionList'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, Input, Modal, Money, PageLoader, StatCard } from '../components/ui'
import { useAccountFlows, useAccounts, useTransactions, type AccountWithBalance } from '../hooks/data'
import { useAccountValuations, useAccountValues, useDeleteAccountValuation, useSetAccountValuation } from '../hooks/phase3'
import { addMonths, endOfMonth, formatDate, isValidISODate, periodLabel, startOfMonth, todayISO } from '../lib/dates'
import { formatCents, formatSignedPercent, parseAmountToCents } from '../lib/money'
import type { AccountValuation, Transaction } from '../lib/types'
import { ACCOUNT_KIND_LABEL } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'

/** Cuentas de dinero (no de inversión) visibles: las archivadas solo si aún tienen saldo */
function cashAccounts(accounts: AccountWithBalance[]) {
  return accounts.filter((a) => a.kind !== 'investment' && (!a.is_archived || a.balance_cents !== 0))
}

// =============================================================== Lista
export function AccountsPage() {
  const { user } = useAuth()
  const accounts = useAccounts()
  const list = cashAccounts(accounts.data ?? [])
  const mine = list.filter((a) => a.visibility === 'personal' && a.owner_id === user?.id)
  const shared = list.filter((a) => a.visibility === 'shared')
  const sum = (xs: AccountWithBalance[]) => xs.reduce((s, a) => s + a.balance_cents, 0)

  return (
    <>
      <Link to="/" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" />Inicio</Link>
      <PageHeader title="Cuentas" subtitle="Saldo de cada cuenta y sus movimientos" />
      <ErrorBox error={accounts.error} onRetry={() => accounts.refetch()} />

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Mis cuentas" icon={<Lock className="size-3.5" />} cents={accounts.data ? sum(mine) : undefined}
          hint={`${mine.length} ${mine.length === 1 ? 'cuenta personal' : 'cuentas personales'}`} />
        <StatCard label="Compartidas" icon={<Users className="size-3.5" />} cents={accounts.data ? sum(shared) : undefined}
          hint={`${shared.length} ${shared.length === 1 ? 'cuenta' : 'cuentas'}`} />
      </div>

      {accounts.isLoading ? <PageLoader /> : (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title="Mis cuentas">
            {mine.length ? <AccountRows rows={mine} /> : (
              <EmptyState title="Sin cuentas personales">
                Crea tus cuentas en <Link to="/ajustes" className="underline">Ajustes</Link>.
              </EmptyState>
            )}
          </Card>
          <Card title="Cuentas compartidas">
            {shared.length ? <AccountRows rows={shared} /> : <p className="text-sm text-slate-500">No hay cuentas compartidas.</p>}
          </Card>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">
        Las cuentas de inversión están en <Link to="/inversiones" className="underline">Inversiones</Link>.
      </p>
    </>
  )
}

function AccountRows({ rows }: { rows: AccountWithBalance[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((a) => (
        <li key={a.id}>
          <Link to={`/cuentas/${a.id}`} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-slate-50">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: a.color }} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{a.name}</p>
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                {a.institution ?? ACCOUNT_KIND_LABEL[a.kind]}
                {a.is_archived && <Badge>Archivada</Badge>}
              </p>
            </div>
            <Money cents={a.balance_cents} className="font-semibold" />
            <ChevronRight className="size-4 shrink-0 text-slate-300" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

// =============================================================== Detalle
export function AccountDetailPage() {
  const { id } = useParams()
  const { period } = usePeriod()
  const { profileById } = useHousehold()
  const accounts = useAccounts()
  const flows = useAccountFlows(period.from, period.to)
  const tx = useTransactions({ from: period.from, to: period.to, accountId: id, sort: 'date_desc' }, 0, 200)

  const acc = accounts.data?.find((a) => a.id === id)
  if (accounts.isLoading) return <PageLoader />
  if (acc?.kind === 'investment') return <InvestmentAccountDetail acc={acc} />
  if (!acc) {
    return (
      <Card><EmptyState title="Cuenta no encontrada" action={<Link to="/cuentas" className="underline">Volver a cuentas</Link>}>
        Puede que se haya eliminado o que sea personal de otro miembro.
      </EmptyState></Card>
    )
  }
  const flow = flows.data?.find((f) => f.account_id === acc.id)
  const owner = profileById(acc.owner_id)?.full_name
  const kind = acc.institution ? `${ACCOUNT_KIND_LABEL[acc.kind]} · ${acc.institution}` : ACCOUNT_KIND_LABEL[acc.kind]

  return (
    <>
      <Link to="/cuentas" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" />Cuentas</Link>
      <PageHeader title={acc.name}
        subtitle={`${kind} · ${acc.visibility === 'shared' ? 'Compartida' : `Personal${owner ? ` de ${owner}` : ''}`}`}
        actions={<PeriodFilter />} />
      <ErrorBox error={flows.error ?? tx.error} onRetry={() => { flows.refetch(); tx.refetch() }} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="col-span-2 lg:col-span-1">
          <StatCard tone="brand" label="Saldo actual" icon={<Wallet className="size-3.5" />} cents={acc.balance_cents} />
        </div>
        <StatCard label="Ingresos del periodo" tone="positive" cents={flows.data ? flow?.income_cents ?? 0 : undefined} hint={periodLabel(period)} />
        <StatCard label="Gastos del periodo" cents={flows.data ? flow?.expense_cents ?? 0 : undefined} hint={periodLabel(period)} />
      </div>

      {acc.kind === 'common' && (
        <p className="mt-3 text-sm"><Link to="/cuenta-comun" className="underline">Ver aportaciones y reparto de la cuenta común</Link></p>
      )}

      <Card className="mt-6" title="Movimientos del periodo"
        action={<Link to={`/movimientos?cuenta=${acc.id}`} className="text-sm font-medium text-slate-500 hover:text-slate-900">Buscar y filtrar</Link>}>
        {tx.isLoading ? <PageLoader /> : <TransactionList rows={tx.data?.rows ?? []} emptyText="No hay movimientos en este periodo." />}
      </Card>
    </>
  )
}

// =============================================================== Cuenta de inversión
/** Lo que entra (+) o sale (−) de esta cuenta en un movimiento */
function effectOn(tx: Transaction, accountId: string) {
  if (tx.to_account_id === accountId) return tx.amount_cents
  if (tx.account_id === accountId) return tx.type === 'income' || tx.type === 'refund' ? tx.amount_cents : -tx.amount_cents
  return 0
}

function InvestmentAccountDetail({ acc }: { acc: AccountWithBalance }) {
  const { profileById } = useHousehold()
  const values = useAccountValues()
  const valuations = useAccountValuations(acc.id)
  const del = useDeleteAccountValuation()
  const [updating, setUpdating] = useState(false)
  const [deleting, setDeleting] = useState<AccountValuation | null>(null)
  const today = todayISO()
  const from = addMonths(startOfMonth(today), -11)
  const tx = useTransactions({ from, to: endOfMonth(today), accountId: acc.id, sort: 'date_desc' }, 0, 1000)

  const v = values.data?.get(acc.id)
  const value = v?.value_cents ?? acc.balance_cents
  const ret = value - acc.balance_cents
  const owner = profileById(acc.owner_id)?.full_name

  // Aportado neto por mes (últimos 12 meses)
  const months = Array.from({ length: 12 }, (_, i) => addMonths(from, i))
  const perMonth = new Map(months.map((m) => [m, 0]))
  for (const t of tx.data?.rows ?? []) {
    const m = startOfMonth(t.occurred_on)
    if (perMonth.has(m)) perMonth.set(m, perMonth.get(m)! + effectOn(t, acc.id))
  }
  const bars = months.map((m) => ({ month: m, contributed_cents: perMonth.get(m) ?? 0 }))
  const thisMonth = perMonth.get(startOfMonth(today)) ?? 0

  return (
    <>
      <Link to="/inversiones" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" />Inversiones</Link>
      <PageHeader title={acc.name}
        subtitle={`Cuenta de inversión${acc.institution ? ` · ${acc.institution}` : ''} · ${acc.visibility === 'shared' ? 'Compartida' : `Personal${owner ? ` de ${owner}` : ''}`}`}
        actions={<Button onClick={() => setUpdating(true)}><Plus className="size-4" />Actualizar valor</Button>} />
      <ErrorBox error={values.error ?? valuations.error ?? tx.error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1">
          <StatCard tone="brand" label="Valor actual" icon={<TrendingUp className="size-3.5" />} cents={values.data ? value : undefined}
            hint={v?.valued_on ? `Actualizado el ${formatDate(v.valued_on)}${value !== (valuations.data?.[0]?.value_cents ?? value) ? ' + aportaciones posteriores' : ''}` : 'Sin actualizar: igual a lo aportado'} />
        </div>
        <StatCard label="Aportado neto" icon={<Wallet className="size-3.5" />} cents={acc.balance_cents} hint="Lo que has metido − lo que has sacado" />
        <StatCard label="Rentabilidad" cents={values.data ? ret : undefined} tone={ret >= 0 ? 'positive' : 'negative'}
          hint={acc.balance_cents > 0 ? `${formatSignedPercent(ret, acc.balance_cents)} sobre lo aportado` : undefined} />
        <StatCard label="Aportado este mes" cents={tx.data ? thisMonth : undefined} hint="No cuenta como gasto" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Aportado cada mes">
          {tx.isLoading ? <PageLoader /> : <MonthlyBars data={bars} series={[{ key: 'contributed_cents', label: 'Aportado', color: SERIES[3] }]} />}
        </Card>
        <Card title="Actualizaciones de valor">
          {valuations.isLoading ? <PageLoader /> : !valuations.data?.length ? (
            <EmptyState title="Sin actualizaciones" action={<Button onClick={() => setUpdating(true)}><Plus className="size-4" />Actualizar valor</Button>}>
              Cuando quieras (por ejemplo, una vez al mes), apunta cuánto vale la cuenta según tu banco o bróker. La rentabilidad se calcula sobre ese valor.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {valuations.data.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="w-20 shrink-0 text-xs text-slate-500 tabular">{formatDate(x.valued_on)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{x.notes}</span>
                  <Money cents={x.value_cents} className="font-medium" />
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar actualización" onClick={() => setDeleting(x)}>
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-6" title="Movimientos de los últimos 12 meses"
        action={<Link to={`/movimientos?cuenta=${acc.id}`} className="text-sm font-medium text-slate-500 hover:text-slate-900">Buscar y filtrar</Link>}>
        {tx.isLoading ? <PageLoader /> : <TransactionList rows={(tx.data?.rows ?? []).slice(0, 50)} emptyText="Todavía no hay aportaciones. Haz un movimiento de tipo «Inversión» hacia esta cuenta." />}
      </Card>
      <p className="mt-3 text-xs text-slate-500">
        Rentabilidad = valor actual − aportado neto. Si aportas después de actualizar el valor, esa aportación se suma al valor hasta la siguiente actualización.
      </p>

      {updating && <ValuationForm accountId={acc.id} current={value} onClose={() => setUpdating(false)} />}
      <ConfirmDialog open={!!deleting} title="Eliminar actualización"
        message={<p>¿Eliminar el valor de {deleting && formatCents(deleting.value_cents)} del {deleting && formatDate(deleting.valued_on)}?</p>}
        loading={del.isPending} error={del.error} onCancel={() => { setDeleting(null); del.reset() }}
        onConfirm={() => deleting && del.mutateAsync(deleting.id).then(() => setDeleting(null)).catch(() => undefined)} />
    </>
  )
}

function ValuationForm({ accountId, current, onClose }: { accountId: string; current: number; onClose: () => void }) {
  const save = useSetAccountValuation()
  const [date, setDate] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!isValidISODate(date)) return setError('Fecha no válida.')
    const cents = parseAmountToCents(amount)
    if (cents === null || cents < 0) return setError('Valor no válido.')
    try {
      await save.mutateAsync({ accountId, on: date, valueCents: cents, notes: notes.trim() || null })
      onClose()
    } catch { /* abajo */ }
  }

  return (
    <Modal open onClose={onClose} title="Actualizar valor"
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="val-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="val-form" className="space-y-4" onSubmit={submit} noValidate>
        <p className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
          Pon cuánto vale ahora la cuenta según tu banco o bróker. No mueve dinero: solo actualiza el valor y la rentabilidad. Si ya había un valor ese día, se sustituye.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Valor total (€)" htmlFor="val-amount" hint={`Ahora: ${formatCents(current)}`}>
            <Input id="val-amount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <Field label="Fecha" htmlFor="val-date" hint={formatDate(date)}><Input id="val-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Notas (opcional)" htmlFor="val-notes"><Input id="val-notes" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}
