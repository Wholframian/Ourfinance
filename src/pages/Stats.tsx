import { useState } from 'react'
import { DonutWithTable, GROUP_COLOR, MonthlyBars, NEUTRAL, PercentBars, SERIES, ShareBar, StackedMonthlyBars, TrendArea } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { Card, ErrorBox, PageLoader, Segmented, Select } from '../components/ui'
import { useCategories, useCategoryBreakdown, useContributions, useMonthlyFlows, useNetWorthSeries } from '../hooks/data'
import {
  useExpenseByPayer, useHouseholdNetWorth, useHouseholdNetWorthSeries, useNetWorthBreakdown, useTopSubcategories,
} from '../hooks/phase3'
import { formatCents } from '../lib/money'
import { ASSET_TYPE_LABEL, type AssetType } from '../lib/types'
import { ASSET_COLOR } from './Investments'
import { Link } from 'react-router-dom'
import { useAuth } from '../providers/AuthProvider'
import { periodLabel } from '../lib/dates'
import { memberSeriesColor } from '../lib/members'
import type { Visibility } from '../lib/types'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'
import { trendWindow } from './Dashboard'

export function StatsPage() {
  const { period } = usePeriod()
  const { members, profileById } = useHousehold()
  const { user } = useAuth()
  const categories = useCategories()
  const [visibility, setVisibility] = useState<Visibility | 'all'>('all')
  const [categoryId, setCategoryId] = useState('')
  const [drill, setDrill] = useState<{ id: string; name: string } | null>(null)
  const vis = visibility === 'all' ? null : visibility

  // Las series usan al menos 12 meses para que la evolución tenga sentido
  const win = period.kind === 'month' ? trendWindow(period.to, period.from) : { from: period.from, to: period.to }
  const flows = useMonthlyFlows(win.from, win.to, categoryId || null, vis)
  const cats = useCategoryBreakdown(period.from, period.to, vis, drill?.id ?? null)
  const contrib = useContributions(win.from, win.to)
  const netWorth = useNetWorthSeries(win.from, win.to)
  const breakdown = useNetWorthBreakdown(period.to)
  const joint = useHouseholdNetWorth()
  const allSharing = !!joint.data?.length && joint.data.every((r) => r.is_sharing)
  const jointSeries = useHouseholdNetWorthSeries(win.from, win.to, allSharing)
  const byPayer = useExpenseByPayer(period.from, period.to)
  const topSub = useTopSubcategories(period.from, period.to, 8)

  const savingsRate = (flows.data ?? []).map((f) => ({
    month: f.month,
    rate: f.income_cents > 0 ? Math.round((f.savings_cents / f.income_cents) * 1000) / 10 : null,
  }))

  // Composición del patrimonio al final del periodo
  const comp: Record<string, { name: string; value: number; color: string }> = {}
  for (const r of breakdown.data ?? []) {
    const key = r.source === 'investment' ? `i_${r.kind}` : r.visibility === 'shared' ? 'a_shared' : 'a_personal'
    const name = r.source === 'investment' ? ASSET_TYPE_LABEL[r.kind as AssetType] : r.visibility === 'shared' ? 'Cuentas compartidas' : 'Mis cuentas'
    const color = r.source === 'investment' ? ASSET_COLOR[r.kind as AssetType] : r.visibility === 'shared' ? SERIES[0] : SERIES[2]
    comp[key] ??= { name, value: 0, color }
    comp[key].value += r.value_cents
  }
  const compTotal = (breakdown.data ?? []).reduce((a, r) => a + r.value_cents, 0)
  const memberIdx = new Map(members.map((m, i) => [m.user_id, i]))

  const jointData = Object.values(
    (jointSeries.data ?? []).reduce<Record<string, Record<string, number | string>>>((m, r) => {
      m[r.month] ??= { month: r.month }
      m[r.month][r.user_id ? `m_${r.user_id}` : 'shared'] = r.net_worth_cents
      return m
    }, {}),
  )
  const sharedByPayer = (byPayer.data ?? []).filter((r) => r.visibility === 'shared')

  let acc = 0
  const savingsCumulative = (flows.data ?? []).map((f) => ({ month: f.month, cumulative: (acc += f.savings_cents) }))

  const contribData = Object.values(
    (contrib.data ?? []).reduce<Record<string, Record<string, number | string>>>((m, c) => {
      m[c.month] ??= { month: c.month }
      m[c.month][`m_${c.user_id}`] = c.contribution_cents
      return m
    }, {}),
  ).sort((a, b) => String(a.month).localeCompare(String(b.month)))

  const parents = (categories.data ?? []).filter((c) => !c.parent_id && c.kind === 'expense')
  const parentById = new Map(parents.map((p) => [p.id, p]))

  return (
    <>
      <PageHeader title="Estadísticas" subtitle={`${periodLabel(period)}${period.kind === 'month' ? ' · evolución de los últimos 12 meses' : ''}`} actions={<PeriodFilter />} />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented value={visibility} onChange={setVisibility} options={[
          { value: 'all', label: 'Todo lo que veo' },
          { value: 'personal', label: 'Mis personales' },
          { value: 'shared', label: 'Compartidos' },
        ]} />
        <Select aria-label="Categoría" className="sm:max-w-64" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Todas las categorías</option>
          {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      <ErrorBox error={flows.error ?? cats.error ?? contrib.error} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={categoryId ? `Gasto mensual · ${parentById.get(categoryId)?.name}` : 'Ingresos y gastos'}>
          {flows.isLoading ? <PageLoader /> : (
            <MonthlyBars data={(flows.data ?? []) as never} series={categoryId
              ? [{ key: 'expense_cents', label: 'Gasto', color: SERIES[1] }]
              : [{ key: 'income_cents', label: 'Ingresos', color: SERIES[0] }, { key: 'expense_cents', label: 'Gastos', color: SERIES[1] }]} />
          )}
        </Card>

        <Card title="Ahorro acumulado" >
          {flows.isLoading ? <PageLoader /> : <TrendArea data={savingsCumulative} dataKey="cumulative" label="Ahorro acumulado" color={SERIES[2]} />}
          <p className="mt-2 text-xs text-slate-500">Suma de (ingresos − gastos) mes a mes en la ventana mostrada.</p>
        </Card>

        <Card
          title={drill ? `Subcategorías · ${drill.name}` : 'Gastos por categoría'}
          action={drill && <button className="text-sm text-slate-500 underline" onClick={() => setDrill(null)}>Volver</button>}
        >
          {cats.isLoading ? <PageLoader /> : (
            <DonutWithTable
              slices={(cats.data ?? []).map((c, i) => ({
                name: c.name,
                value: c.expense_cents,
                color: drill ? (c.category_id ? SERIES[i % SERIES.length] : NEUTRAL) : c.category_id ? GROUP_COLOR[c.group_key] ?? NEUTRAL : NEUTRAL,
              }))}
              onSelect={drill ? undefined : (s) => {
                const c = (cats.data ?? []).find((x) => x.name === s.name)
                if (c?.category_id) setDrill({ id: c.category_id, name: c.name })
              }}
            />
          )}
          {!drill && <p className="mt-3 text-xs text-slate-500">Pulsa una categoría para ver sus subcategorías.</p>}
        </Card>

        <Card title="Gastos personales y compartidos por mes">
          {flows.isLoading ? <PageLoader /> : (
            <StackedMonthlyBars data={(flows.data ?? []) as never} series={[
              { key: 'personal_expense_cents', label: 'Mis personales', color: SERIES[2] },
              { key: 'shared_expense_cents', label: 'Compartidos', color: SERIES[0] },
            ]} />
          )}
        </Card>

        <Card title="Tasa de ahorro mensual">
          {flows.isLoading ? <PageLoader /> : <PercentBars data={savingsRate} dataKey="rate" label="Ahorro sobre ingresos" />}
          <p className="mt-2 text-xs text-slate-500">(Ingresos − gastos) / ingresos de cada mes. En rojo, los meses en que se gastó más de lo ingresado.</p>
        </Card>

        <Card title="Dónde se va más dinero">
          {topSub.isLoading ? <PageLoader /> : !topSub.data?.length ? <p className="text-sm text-slate-500">Sin gastos en este periodo.</p> : (
            <ul className="space-y-2.5">
              {topSub.data.map((r) => (
                <li key={`${r.category_id}-${r.name}`} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-slate-700">{r.name}{r.name !== r.parent_name && <span className="text-slate-400"> · {r.parent_name}</span>}</span>
                    <span className="shrink-0 font-medium tabular">{formatCents(r.expense_cents)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${(r.expense_cents / topSub.data![0].expense_cents) * 100}%`, background: r.color }} />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{r.tx_count} {r.tx_count === 1 ? 'movimiento' : 'movimientos'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Gastos compartidos según quién paga">
          {byPayer.isLoading ? <PageLoader /> : !sharedByPayer.length ? <p className="text-sm text-slate-500">Sin gastos compartidos en este periodo.</p> : (
            <ShareBar parts={members.map((m, i) => ({
              label: m.profile?.full_name ?? 'Miembro',
              value: sharedByPayer.filter((r) => r.user_id === m.user_id).reduce((a, r) => a + r.expense_cents, 0),
              color: memberSeriesColor(i),
            }))} />
          )}
          <p className="mt-3 text-xs text-slate-500">Incluye lo pagado desde la cuenta común por quien registró el gasto. Los gastos personales de cada uno no se comparan.</p>
        </Card>

        <Card title="Aportaciones de cada miembro">
          {contrib.isLoading ? <PageLoader /> : (
            <StackedMonthlyBars data={contribData} series={members.map((m, i) => ({ key: `m_${m.user_id}`, label: m.profile?.full_name ?? 'Miembro', color: memberSeriesColor(i) }))} />
          )}
        </Card>
      </div>

      <h2 className="mt-10 mb-4 text-lg font-semibold">Patrimonio</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Evolución de tu patrimonio">
          {netWorth.isLoading ? <PageLoader /> : <TrendArea data={netWorth.data ?? []} dataKey="net_worth_cents" label="Patrimonio" />}
          <p className="mt-2 text-xs text-slate-500">Tus cuentas, las compartidas y el valor de la cartera al final de cada mes.</p>
        </Card>
        <Card title={`Composición · ${formatCents(compTotal)}`}>
          {breakdown.isLoading ? <PageLoader /> : <DonutWithTable slices={Object.values(comp)} emptyText="Sin patrimonio registrado" />}
          {Object.values(comp).some((c) => c.value < 0) && <p className="mt-2 text-xs text-slate-500">Los saldos negativos (p. ej. tarjetas) restan del total pero no aparecen en el gráfico.</p>}
        </Card>
        <Card title="Patrimonio conjunto" className="lg:col-span-2">
          {joint.isLoading ? <PageLoader /> : allSharing ? (
            jointSeries.isLoading ? <PageLoader /> : (
              <StackedMonthlyBars data={jointData} series={[
                ...members.map((m) => ({ key: `m_${m.user_id}`, label: m.profile?.full_name ?? 'Miembro', color: memberSeriesColor(memberIdx.get(m.user_id) ?? 0) })),
                { key: 'shared', label: 'Compartido', color: SERIES[6] },
              ]} />
            )
          ) : (
            <div className="space-y-2 text-sm text-slate-600">
              <p>Cada uno puede compartir el <strong>total</strong> de su patrimonio personal con el otro, sin enseñar cuentas ni movimientos. Cuando los dos lo activéis veréis aquí el patrimonio de la pareja.</p>
              <ul className="space-y-1">
                {(joint.data ?? []).filter((r) => r.user_id).map((r) => (
                  <li key={r.user_id}>· {r.user_id === user?.id ? 'Tú' : profileById(r.user_id)?.full_name ?? 'Miembro'}: {r.is_sharing ? 'lo comparte' : 'no lo comparte'}</li>
                ))}
              </ul>
              <Link to="/ajustes" className="inline-block font-medium underline">Activarlo en Ajustes</Link>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
