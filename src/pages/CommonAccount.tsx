import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ShareBar, StackedMonthlyBars } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionForm } from '../components/TransactionForm'
import { TransactionList } from '../components/TransactionList'
import { Button, Card, EmptyState, ErrorBox, Money, PageLoader, Select, StatCard } from '../components/ui'
import { useAccounts, useContributions, useTransactions } from '../hooks/data'
import { monthLong, periodLabel } from '../lib/dates'
import { memberSeriesColor } from '../lib/members'
import { formatCents, percent } from '../lib/money'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'
import { trendWindow } from './Dashboard'

export function CommonAccountPage() {
  const { period } = usePeriod()
  const { members } = useHousehold()
  const accounts = useAccounts()
  const commons = (accounts.data ?? []).filter((a) => a.kind === 'common')
  const [selectedId, setSelectedId] = useState('')
  const account = commons.find((a) => a.id === selectedId) ?? commons[0]
  const [adding, setAdding] = useState(false)

  const win = trendWindow(period.to, period.from)
  const contributions = useContributions(period.from, period.to)
  const contributionsWin = useContributions(win.from, win.to)
  const accountTx = useTransactions(
    { from: win.from, to: win.to, accountId: account?.id, sort: 'date_desc' }, 0, 1000,
  )
  const expensesPeriod = useTransactions(
    { from: period.from, to: period.to, accountId: account?.id, types: ['expense', 'refund'] }, 0, 50,
  )

  const memberIndex = useMemo(() => new Map(members.map((m, i) => [m.user_id, i])), [members])

  const perMember = members.map((m, i) => ({
    label: m.profile?.full_name ?? 'Miembro',
    value: (contributions.data ?? []).filter((c) => c.user_id === m.user_id).reduce((s, c) => s + c.contribution_cents, 0),
    color: memberSeriesColor(i),
  }))
  const totalContrib = perMember.reduce((s, p) => s + p.value, 0)

  // Histórico mensual de la cuenta: entradas por aportaciones (por miembro) y salidas por gastos
  const history = useMemo(() => {
    if (!account) return []
    const months = new Map<string, { month: string; out: number; in_other: number; [k: string]: number | string }>()
    const row = (m: string) => {
      if (!months.has(m)) months.set(m, { month: m, out: 0, in_other: 0 })
      return months.get(m)!
    }
    for (const c of contributionsWin.data ?? []) {
      const r = row(c.month)
      r[`m_${c.user_id}`] = ((r[`m_${c.user_id}`] as number) ?? 0) + c.contribution_cents
    }
    for (const t of accountTx.data?.rows ?? []) {
      const m = t.occurred_on.slice(0, 7) + '-01'
      const r = row(m)
      if (t.type === 'expense' || (t.account_id === account.id && t.to_account_id)) r.out += t.amount_cents
      else if (t.type === 'refund' || t.type === 'income') r.in_other += t.amount_cents
      else if (t.to_account_id === account.id && t.type !== 'contribution') r.in_other += t.amount_cents
    }
    return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
  }, [account, contributionsWin.data, accountTx.data])

  const series = members.map((m, i) => ({ key: `m_${m.user_id}`, label: m.profile?.full_name ?? 'Miembro', color: memberSeriesColor(i) }))
  const chartData = history.map((h) => {
    const r: Record<string, number | string> = { month: h.month }
    for (const s of series) r[s.key] = (h[s.key] as number) ?? 0
    return r
  })

  const periodExpenses = (expensesPeriod.data?.rows ?? []).reduce((s, t) => s + (t.type === 'expense' ? t.amount_cents : -t.amount_cents), 0)

  if (accounts.isLoading) return <PageLoader />
  if (!account) {
    return (
      <>
        <PageHeader title="Cuenta común" />
        <Card><EmptyState title="No hay cuenta común">Crea una cuenta compartida de tipo "Cuenta común" en Ajustes → Cuentas.</EmptyState></Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Cuenta común"
        subtitle={`Aportaciones y gastos · ${periodLabel(period)}`}
        actions={<>
          <PeriodFilter />
          <Button onClick={() => setAdding(true)}><Plus className="size-4" />Registrar aportación</Button>
        </>}
      />
      {commons.length > 1 && (
        <div className="mb-4 max-w-xs">
          <Select aria-label="Cuenta común" value={account.id} onChange={(e) => setSelectedId(e.target.value)}>
            {commons.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </div>
      )}
      <ErrorBox error={contributions.error ?? accountTx.error ?? expensesPeriod.error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1"><StatCard tone="brand" label={`Saldo · ${account.name}`} cents={account.balance_cents} hint="Saldo acumulado hoy" /></div>
        <StatCard label="Aportado en el periodo" cents={contributions.data ? totalContrib : undefined} />
        <StatCard label="Gastado desde la cuenta" cents={expensesPeriod.data ? periodExpenses : undefined} />
        <StatCard label="Diferencia" cents={contributions.data && expensesPeriod.data ? totalContrib - periodExpenses : undefined} hint="Aportado − gastado" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="¿Cuánto ha aportado cada uno?">
          {contributions.isLoading ? <PageLoader /> : totalContrib === 0
            ? <EmptyState title="Sin aportaciones en este periodo" />
            : <ShareBar parts={perMember} />}
          {totalContrib > 0 && perMember.length === 2 && (
            <p className="mt-4 text-xs text-slate-500">
              {perMember[0].value === perMember[1].value
                ? 'Habéis aportado lo mismo.'
                : `${perMember[0].value > perMember[1].value ? perMember[0].label : perMember[1].label} ha aportado ${formatCents(Math.abs(perMember[0].value - perMember[1].value))} más (${percent(Math.max(perMember[0].value, perMember[1].value), totalContrib)} % del total).`}
            </p>
          )}
        </Card>
        <Card title="Aportaciones por mes">
          {contributionsWin.isLoading ? <PageLoader /> : <StackedMonthlyBars data={chartData} series={series} />}
        </Card>
      </div>

      <Card className="mt-6" title="Histórico mensual">
        {accountTx.isLoading ? <PageLoader /> : !history.length ? <EmptyState title="Sin movimientos todavía" /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                  <th className="px-5 py-2 font-medium">Mes</th>
                  {series.map((s) => <th key={s.key} className="px-3 py-2 text-right font-medium">{s.label}</th>)}
                  <th className="px-3 py-2 text-right font-medium">Otras entradas</th>
                  <th className="px-3 py-2 text-right font-medium">Salidas</th>
                  <th className="px-5 py-2 text-right font-medium">Neto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {[...history].reverse().map((h) => {
                  const contrib = series.reduce((s, x) => s + ((h[x.key] as number) ?? 0), 0)
                  const net = contrib + h.in_other - h.out
                  return (
                    <tr key={h.month}>
                      <td className="px-5 py-2.5 capitalize">{monthLong(h.month)}</td>
                      {series.map((s) => {
                        const v = (h[s.key] as number) ?? 0
                        return <td key={s.key} className="px-3 py-2.5 text-right tabular">{formatCents(v)}<span className="ml-1 text-xs text-slate-400">{contrib ? `${percent(v, contrib)} %` : ''}</span></td>
                      })}
                      <td className="px-3 py-2.5 text-right tabular">{formatCents(h.in_other)}</td>
                      <td className="px-3 py-2.5 text-right tabular">{formatCents(h.out)}</td>
                      <td className="px-5 py-2.5 text-right font-medium"><Money cents={net} signed={net > 0 ? 1 : net < 0 ? -1 : 0} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-6" title="Gastos pagados desde la cuenta común">
        {expensesPeriod.isLoading ? <PageLoader /> : <TransactionList rows={expensesPeriod.data?.rows ?? []} emptyText="No hay gastos pagados desde la cuenta común en este periodo." />}
      </Card>

      <TransactionForm open={adding} onClose={() => setAdding(false)} presetType="contribution" />
      {memberIndex.size === 1 && (
        <p className="mt-6 text-center text-sm text-slate-500">Invita a tu pareja desde Ajustes para comparar aportaciones.</p>
      )}
    </>
  )
}
