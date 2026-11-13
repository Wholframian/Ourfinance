import { Landmark, PiggyBank, TrendingUp, User, Users, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DonutWithTable, GROUP_COLOR, MonthlyBars, NEUTRAL, SERIES, ShareBar, TrendArea } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionList } from '../components/TransactionList'
import { Card, ErrorBox, PageLoader, StatCard } from '../components/ui'
import {
  useAccounts, useCategoryBreakdown, useMonthlyFlows, useNetWorthSeries, usePeriodSummary, useTransactions,
} from '../hooks/data'
import { addMonths, endOfMonth, periodLabel, startOfMonth } from '../lib/dates'
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
  const latest = useTransactions({}, 0, 8)

  const list = (accounts.data ?? []).filter((a) => !a.is_archived || a.balance_cents !== 0)
  const total = list.reduce((s, a) => s + a.balance_cents, 0)
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1">
          <StatCard tone="brand" label="Patrimonio total" icon={<Landmark className="size-3.5" />} cents={accounts.data ? total : undefined}
            hint="Suma de tus cuentas y las compartidas" />
        </div>
        <StatCard label="Mis cuentas" icon={<User className="size-3.5" />} cents={accounts.data ? sum(personal) : undefined} hint={`${personal.length} ${personal.length === 1 ? 'cuenta personal' : 'cuentas personales'}`} />
        <StatCard label="Cuenta común" icon={<Users className="size-3.5" />} cents={accounts.data ? sum(common) : undefined} hint={<Link to="/cuenta-comun" className="underline">Ver detalle</Link>} />
        <StatCard label="Inversiones" icon={<TrendingUp className="size-3.5" />} cents={accounts.data ? sum(investment) : undefined}
          hint={investment.length ? 'Saldo en cuentas de inversión' : 'Sin cuentas de inversión'} />
        <StatCard label="Ingresos" icon={<Wallet className="size-3.5" />} cents={s?.income_cents} tone="positive" loading={summary.isLoading} />
        <StatCard label="Gastos" cents={s?.expense_cents} loading={summary.isLoading}
          hint={s ? `${s.refund_cents ? 'Ya descontados reembolsos' : 'Sin transferencias ni aportaciones'}` : undefined} />
        <StatCard label="Aportaciones a común" icon={<PiggyBank className="size-3.5" />} cents={s?.contribution_cents} loading={summary.isLoading} hint="Transferencias, no gasto" />
        <StatCard label="Ahorro" cents={s?.savings_cents} tone={s && s.savings_cents >= 0 ? 'positive' : 'default'} loading={summary.isLoading} hint="Ingresos − gastos" />
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
