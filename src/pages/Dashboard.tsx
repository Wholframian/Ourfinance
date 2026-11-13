import { Landmark, PiggyBank, TrendingUp, User, Users, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DonutWithTable, GROUP_COLOR, MonthlyBars, NEUTRAL, SERIES, ShareBar, TrendArea } from '../components/charts'
import { MODULES, PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionList } from '../components/TransactionList'
import { Card, ErrorBox, PageLoader, StatCard } from '../components/ui'
import {
  useAccountFlows, useAccounts, useCategoryBreakdown, useMonthlyFlows, useNetWorthSeries, usePeriodSummary, useTransactions,
} from '../hooks/data'
import { useHouseholdNetWorth, useInvestments, usePositions } from '../hooks/phase3'
import { addMonths, endOfMonth, periodLabel, startOfMonth } from '../lib/dates'
import { formatCents } from '../lib/money'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'

/** Ventana de 12 meses que termina en el último mes del periodo elegido */
export function trendWindow(to: string, from: string) {
  const end = endOfMonth(to)
  const twelveBack = addMonths(startOfMonth(to), -11)
  return { from: from < twelveBack ? startOfMonth(from) : twelveBack, to: end }
}

export function DashboardPage() {
  const { user } = useAuth()
  const { household, profileById } = useHousehold()
  const { period } = usePeriod()
  const win = trendWindow(period.to, period.from)

  const accounts = useAccounts()
  const summary = usePeriodSummary(period.from, period.to)
  const flows = useMonthlyFlows(win.from, win.to)
  const netWorth = useNetWorthSeries(win.from, win.to)
  const cats = useCategoryBreakdown(period.from, period.to)
  const accFlows = useAccountFlows(period.from, period.to)
  const latest = useTransactions({}, 0, 8)
  const positions = usePositions()
  const investments = useInvestments()
  const joint = useHouseholdNetWorth()

  const list = (accounts.data ?? []).filter((a) => !a.is_archived || a.balance_cents !== 0)
  const portfolio = (positions.data ?? []).reduce((s, p) => s + p.value_cents, 0)
  const total = list.reduce((s, a) => s + a.balance_cents, 0) + portfolio
  const ready = !!accounts.data && !!positions.data && !!investments.data
  const jointRows = joint.data ?? []
  const allSharing = jointRows.length > 0 && jointRows.every((r) => r.is_sharing)
  const jointTotal = jointRows.reduce((s, r) => s + (r.net_worth_cents ?? 0), 0)
  const mine = list.filter((a) => a.visibility === 'personal' && a.owner_id === user?.id)
  const shared = list.filter((a) => a.visibility === 'shared')
  const mineCash = mine.filter((a) => a.kind !== 'investment')
  const mineInv = mine.filter((a) => a.kind === 'investment')
  const sharedCash = shared.filter((a) => a.kind !== 'investment')
  const sharedInv = shared.filter((a) => a.kind === 'investment')
  const visOf = new Map((investments.data ?? []).map((i) => [i.id, i.visibility]))
  const portfolioOf = (v: 'personal' | 'shared') => (positions.data ?? []).filter((p) => visOf.get(p.investment_id) === v).reduce((t, p) => t + p.value_cents, 0)
  const flowById = new Map((accFlows.data ?? []).map((f) => [f.account_id, f]))
  const flowsReady = !!accFlows.data && !!accounts.data
  const flowSum = (xs: typeof list, k: 'income_cents' | 'expense_cents') => xs.reduce((t, a) => t + (flowById.get(a.id)?.[k] ?? 0), 0)
  const sum = (xs: typeof list) => xs.reduce((s, a) => s + a.balance_cents, 0)
  const s = summary.data

  const me = profileById(user?.id)

  return (
    <>
      <PageHeader
        title={`Hola, ${me?.full_name?.split(' ')[0] ?? ''}`}
        subtitle={`${household?.name} · ${periodLabel(period)}`}
        actions={<PeriodFilter />}
      />
      <ErrorBox error={accounts.error ?? summary.error} onRetry={() => { accounts.refetch(); summary.refetch() }} />

      <nav aria-label="Módulos" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
        {MODULES.map(({ to, label, icon: Icon, color }) => (
          <Link key={to} to={to} className="flex shrink-0 items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-medium ring-1 ring-slate-200/70">
            <Icon className="size-4" style={{ color }} />{label}
          </Link>
        ))}
      </nav>

      <StatCard tone="brand" label="Patrimonio total" icon={<Landmark className="size-3.5" />} cents={ready ? total : undefined}
        hint={<>
          {allSharing ? <>Conjunto: <strong className="tabular">{formatCents(jointTotal)}</strong> · </> : 'Tus cuentas, las compartidas y la cartera · '}
          Ahorro del periodo: <strong className="tabular">{s ? formatCents(s.savings_cents) : '…'}</strong>
        </>} />

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <SidePanel title="Lo mío" icon={<User className="size-4" />}>
          <StatCard label="Mis cuentas" icon={<Wallet className="size-3.5" />} cents={accounts.data ? sum(mineCash) : undefined}
            hint={`${mineCash.length} ${mineCash.length === 1 ? 'cuenta personal' : 'cuentas personales'}`} />
          <StatCard label="Mis inversiones" icon={<TrendingUp className="size-3.5" />} cents={ready ? sum(mineInv) + portfolioOf('personal') : undefined}
            hint={<Link to="/inversiones" className="underline">Ver cartera</Link>} />
          <StatCard label="Mis ingresos" cents={flowsReady ? flowSum(mineCash, 'income_cents') : undefined} tone="positive" hint="En mis cuentas personales" />
          <StatCard label="Mis gastos" cents={flowsReady ? flowSum(mineCash, 'expense_cents') : undefined} hint="Pagados con mis cuentas" />
        </SidePanel>
        <SidePanel title="Común" icon={<Users className="size-4" />}>
          <StatCard label="Cuenta común" icon={<Wallet className="size-3.5" />} cents={accounts.data ? sum(sharedCash) : undefined}
            hint={<Link to="/cuenta-comun" className="underline">Ver detalle</Link>} />
          <StatCard label="Inversiones comunes" icon={<TrendingUp className="size-3.5" />} cents={ready ? sum(sharedInv) + portfolioOf('shared') : undefined}
            hint={<Link to="/inversiones" className="underline">Ver cartera</Link>} />
          <StatCard label="Ingresos comunes" cents={flowsReady ? flowSum(sharedCash, 'income_cents') : undefined} tone="positive"
            hint={<span className="inline-flex items-center gap-1"><PiggyBank className="size-3.5" />Aportaciones: {s ? formatCents(s.contribution_cents) : '…'}</span>} />
          <StatCard label="Gastos comunes" cents={flowsReady ? flowSum(sharedCash, 'expense_cents') : undefined} hint="Pagados con la cuenta común" />
        </SidePanel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Evolución del patrimonio">
          {netWorth.isLoading ? <PageLoader /> : <TrendArea data={netWorth.data ?? []} dataKey="net_worth_cents" label="Patrimonio" />}
        </Card>
        <Card title="Ingresos y gastos por mes">
          {flows.isLoading ? <PageLoader /> : (
            <MonthlyBars data={(flows.data ?? []) as never} series={[
              { key: 'income_cents', label: 'Ingresos', color: SERIES[0] },
              { key: 'expense_cents', label: 'Gastos', color: SERIES[1] },
            ]} />
          )}
        </Card>
        <Card title="Gastos por categoría">
          {cats.isLoading ? <PageLoader /> : (
            <DonutWithTable slices={(cats.data ?? []).map((c) => ({ name: c.name, value: c.expense_cents, color: c.category_id ? GROUP_COLOR[c.group_key] ?? NEUTRAL : NEUTRAL }))} />
          )}
        </Card>
        <Card title="Personales frente a compartidos">
          {summary.isLoading ? <PageLoader /> : (
            <ShareBar parts={[
              { label: 'Mis gastos personales', value: s?.personal_expense_cents ?? 0, color: SERIES[2] },
              { label: 'Gastos compartidos', value: s?.shared_expense_cents ?? 0, color: SERIES[0] },
            ]} />
          )}
          <p className="mt-4 text-xs text-slate-500">
            Los compartidos incluyen los que paga cualquiera de los dos y los de la cuenta común. Tus gastos personales solo los ves tú.
          </p>
        </Card>
      </div>

      <Card className="mt-6" title="Últimos movimientos" action={<Link to="/movimientos" className="text-sm font-medium text-slate-500 hover:text-slate-900">Ver todos</Link>}>
        {latest.isLoading ? <PageLoader /> : <TransactionList rows={latest.data?.rows ?? []} emptyText="Todavía no hay movimientos. Pulsa + para añadir el primero." />}
      </Card>
    </>
  )
}


function SidePanel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-slate-100/70 p-3 ring-1 ring-slate-200/60">
      <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-slate-700">{icon}{title}</h2>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  )
}
