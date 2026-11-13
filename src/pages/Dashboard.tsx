import { Landmark, PiggyBank, TrendingUp, User, Users, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DonutWithTable, GROUP_COLOR, MonthlyBars, NEUTRAL, SERIES, ShareBar, TrendArea } from '../components/charts'
import { MODULES, PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionList } from '../components/TransactionList'
import { Card, ErrorBox, Money, PageLoader, StatCard } from '../components/ui'
import {
  useAccountFlows, useAccounts, useCategoryBreakdown, useMonthlyFlows, useNetWorthSeries, usePeriodSummary, useTransactions,
} from '../hooks/data'
import { useHouseholdNetWorth, usePositions } from '../hooks/phase3'
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
  const joint = useHouseholdNetWorth()

  const list = (accounts.data ?? []).filter((a) => !a.is_archived || a.balance_cents !== 0)
  const portfolio = (positions.data ?? []).reduce((s, p) => s + p.value_cents, 0)
  const total = list.reduce((s, a) => s + a.balance_cents, 0) + portfolio
  const ready = !!accounts.data && !!positions.data
  const jointRows = joint.data ?? []
  const allSharing = jointRows.length > 0 && jointRows.every((r) => r.is_sharing)
  const jointTotal = jointRows.reduce((s, r) => s + (r.net_worth_cents ?? 0), 0)
  const personal = list.filter((a) => a.visibility === 'personal' && a.owner_id === user?.id && a.kind !== 'investment')
  const common = list.filter((a) => a.kind === 'common')
  const investment = list.filter((a) => a.kind === 'investment')
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1">
          <StatCard tone="brand" label="Patrimonio total" icon={<Landmark className="size-3.5" />} cents={ready ? total : undefined}
            hint={allSharing ? <>Conjunto: <strong className="tabular">{formatCents(jointTotal)}</strong></> : 'Tus cuentas, las compartidas y la cartera'} />
        </div>
        <StatCard label="Mis cuentas" icon={<User className="size-3.5" />} cents={accounts.data ? sum(personal) : undefined} hint={`${personal.length} ${personal.length === 1 ? 'cuenta personal' : 'cuentas personales'}`} />
        <StatCard label="Cuenta común" icon={<Users className="size-3.5" />} cents={accounts.data ? sum(common) : undefined} hint={<Link to="/cuenta-comun" className="underline">Ver detalle</Link>} />
        <StatCard label="Inversiones" icon={<TrendingUp className="size-3.5" />} cents={ready ? sum(investment) + portfolio : undefined}
          hint={<Link to="/inversiones" className="underline">{positions.data?.length ? `Cartera ${formatCents(portfolio)}` : 'Ver cartera'}</Link>} />
        <StatCard label="Ingresos" icon={<Wallet className="size-3.5" />} cents={s?.income_cents} tone="positive" loading={summary.isLoading} />
        <StatCard label="Gastos" cents={s?.expense_cents} loading={summary.isLoading}
          hint={s ? `${s.refund_cents ? 'Ya descontados reembolsos' : 'Sin transferencias ni aportaciones'}` : undefined} />
        <StatCard label="Aportaciones a común" icon={<PiggyBank className="size-3.5" />} cents={s?.contribution_cents} loading={summary.isLoading} hint="Transferencias, no gasto" />
        <StatCard label="Ahorro" cents={s?.savings_cents} tone={s && s.savings_cents >= 0 ? 'positive' : 'default'} loading={summary.isLoading} hint="Ingresos − gastos" />
      </div>

      <AccountFlowsCard
        loading={accFlows.isLoading || !accounts.data}
        flows={accFlows.data ?? []}
        groups={[
          { label: 'Mis cuentas', accounts: list.filter((a) => a.visibility === 'personal' && a.owner_id === user?.id) },
          { label: 'Compartidas', accounts: list.filter((a) => a.visibility === 'shared') },
        ]}
      />

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

/** Ingresos y gastos del periodo, por cuenta, separando las personales de las compartidas */
function AccountFlowsCard({ loading, flows, groups }: {
  loading: boolean
  flows: { account_id: string; income_cents: number; expense_cents: number }[]
  groups: { label: string; accounts: { id: string; name: string; color?: string | null }[] }[]
}) {
  const byId = new Map(flows.map((f) => [f.account_id, f]))
  const of = (id: string) => byId.get(id) ?? { income_cents: 0, expense_cents: 0 }
  const shown = groups.filter((g) => g.accounts.length)
  return (
    <Card className="mt-6" title="Ingresos y gastos por cuenta">
      {loading ? <PageLoader /> : !shown.length ? <p className="text-sm text-slate-500">Todavía no hay cuentas.</p> : (
        <div className="grid gap-6 lg:grid-cols-2">
          {shown.map((g) => {
            const inc = g.accounts.reduce((s, a) => s + of(a.id).income_cents, 0)
            const exp = g.accounts.reduce((s, a) => s + of(a.id).expense_cents, 0)
            return (
              <div key={g.label}>
                <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 border-b border-slate-100 pb-2 text-xs font-medium text-slate-500">
                  <span>{g.label}</span><span className="block w-24 text-right">Ingresos</span><span className="block w-24 text-right">Gastos</span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {g.accounts.map((a) => (
                    <li key={a.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color ?? '#94a3b8' }} />
                        <span className="truncate">{a.name}</span>
                      </span>
                      <Money cents={of(a.id).income_cents} signed={of(a.id).income_cents ? 1 : 0} className="block w-24 text-right" />
                      <Money cents={of(a.id).expense_cents} signed={of(a.id).expense_cents > 0 ? -1 : 0} className="block w-24 text-right" />
                    </li>
                  ))}
                </ul>
                {g.accounts.length > 1 && (
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-t border-slate-200 pt-2 text-sm font-semibold">
                    <span>Total</span>
                    <Money cents={inc} signed={inc ? 1 : 0} className="block w-24 text-right" />
                    <Money cents={exp} signed={exp > 0 ? -1 : 0} className="block w-24 text-right" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">Las transferencias y aportaciones no cuentan: solo mueven dinero entre cuentas. Los gastos ya descuentan devoluciones.</p>
    </Card>
  )
}
