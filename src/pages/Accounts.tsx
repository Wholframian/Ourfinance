import { ArrowLeft, ChevronRight, Lock, Users, Wallet } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionList } from '../components/TransactionList'
import { Badge, Card, EmptyState, ErrorBox, Money, PageLoader, StatCard } from '../components/ui'
import { useAccountFlows, useAccounts, useTransactions, type AccountWithBalance } from '../hooks/data'
import { periodLabel } from '../lib/dates'
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
