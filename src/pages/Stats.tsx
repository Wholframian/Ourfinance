import { useState } from 'react'
import { DonutWithTable, GROUP_COLOR, MonthlyBars, NEUTRAL, SERIES, StackedMonthlyBars, TrendArea } from '../components/charts'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { Card, ErrorBox, PageLoader, Segmented, Select } from '../components/ui'
import { useCategories, useCategoryBreakdown, useContributions, useMonthlyFlows } from '../hooks/data'
import { periodLabel } from '../lib/dates'
import { memberSeriesColor } from '../lib/members'
import type { Visibility } from '../lib/types'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'
import { trendWindow } from './Dashboard'

export function StatsPage() {
  const { period } = usePeriod()
  const { members } = useHousehold()
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

        <Card title="Aportaciones de cada miembro" className="lg:col-span-2">
          {contrib.isLoading ? <PageLoader /> : (
            <StackedMonthlyBars data={contribData} series={members.map((m, i) => ({ key: `m_${m.user_id}`, label: m.profile?.full_name ?? 'Miembro', color: memberSeriesColor(i) }))} />
          )}
        </Card>
      </div>
    </>
  )
}
