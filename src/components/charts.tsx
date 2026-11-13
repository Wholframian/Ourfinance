import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { monthShort } from '../lib/dates'
import { formatCents, formatCentsCompact, formatPercent } from '../lib/money'
import { EmptyState } from './ui'

/**
 * Paleta categórica validada (orden fijo, nunca rotado). El color sigue a la
 * entidad: cada grupo de categorías tiene siempre el mismo.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
export const GROUP_COLOR: Record<string, string> = {
  housing: SERIES[0],
  food: SERIES[1],
  personal: SERIES[2],
  transport: SERIES[3],
  travel: SERIES[4],
  health: SERIES[5],
  other: SERIES[6],
}
export const NEUTRAL = '#94a3b8'

const axis = { stroke: '#94a3b8', fontSize: 11, tickLine: false, axisLine: false } as const

interface TooltipRow { name: string; value: number; color: string }
function TooltipBox({ title, rows }: { title?: string; rows: TooltipRow[] }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      {title && <p className="mb-1 font-medium text-slate-900 capitalize">{title}</p>}
      {rows.map((r) => (
        <p key={r.name} className="flex items-center gap-2 text-slate-600">
          <span className="size-2 rounded-full" style={{ background: r.color }} />
          <span className="flex-1">{r.name}</span>
          <span className="font-medium text-slate-900 tabular">{formatCents(r.value)}</span>
        </p>
      ))}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTooltip(labelFmt?: (l: string) => string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function T({ active, payload, label }: any) {
    if (!active || !payload?.length) return null
    return (
      <TooltipBox
        title={labelFmt ? labelFmt(String(label)) : String(label ?? '')}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows={payload.map((p: any) => ({ name: p.name, value: p.value, color: p.color ?? p.payload?.fill }))}
      />
    )
  }
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

export interface BarSeries { key: string; label: string; color: string }

/** Barras agrupadas por mes (p. ej. ingresos vs gastos). */
export function MonthlyBars({ data, series, height = 240, xFormat = monthShort }: { data: Record<string, number | string>[]; series: BarSeries[]; height?: number; xFormat?: (v: string) => string }) {
  if (!data.length) return <EmptyState title="Sin datos en este periodo" />
  return (
    <div className="space-y-3">
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} barGap={2} barCategoryGap="24%">
          <CartesianGrid vertical={false} stroke="#eef2f6" />
          <XAxis dataKey="month" tickFormatter={xFormat} {...axis} />
          <YAxis tickFormatter={(v) => formatCentsCompact(v)} width={56} {...axis} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} content={makeTooltip(xFormat)} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Barras apiladas por mes (p. ej. aportaciones por miembro). */
export function StackedMonthlyBars({ data, series, height = 240 }: { data: Record<string, number | string>[]; series: BarSeries[]; height?: number }) {
  if (!data.length) return <EmptyState title="Sin datos en este periodo" />
  return (
    <div className="space-y-3">
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="#eef2f6" />
          <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
          <YAxis tickFormatter={(v) => formatCentsCompact(v)} width={56} {...axis} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} content={makeTooltip(monthShort)} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} stroke="#fff" strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={32} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Línea/área para la evolución (patrimonio, ahorro acumulado). */
export function TrendArea({ data, dataKey, label, color = SERIES[0], height = 220 }: {
  data: Record<string, number | string>[]; dataKey: string; label: string; color?: string; height?: number
}) {
  if (!data.length) return <EmptyState title="Sin datos en este periodo" />
  const id = `g-${dataKey}`
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.18} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="#eef2f6" />
        <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
        <YAxis tickFormatter={(v) => formatCentsCompact(v)} width={56} domain={['auto', 'auto']} {...axis} />
        <Tooltip cursor={{ stroke: '#cbd5e1' }} content={makeTooltip(monthShort)} />
        <Area type="monotone" dataKey={dataKey} name={label} stroke={color} strokeWidth={2} fill={`url(#${id})`}
          dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export interface Slice { name: string; value: number; color: string }

/** Donut con la tabla de valores al lado (accesible: la identidad no depende solo del color). */
export function DonutWithTable({ slices, totalLabel = 'Total', onSelect, emptyText = 'Sin gastos en este periodo' }: { slices: Slice[]; totalLabel?: string; onSelect?: (s: Slice) => void; emptyText?: string }) {
  const positive = slices.filter((s) => s.value > 0)
  if (!positive.length) return <EmptyState title={emptyText} />
  const total = positive.reduce((a, s) => a + s.value, 0)
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[180px_1fr]">
      <div className="relative mx-auto h-[180px] w-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={positive} dataKey="value" nameKey="name" innerRadius={58} outerRadius={84} paddingAngle={1.5}
              stroke="#fff" strokeWidth={2} isAnimationActive={false}>
              {positive.map((s) => <Cell key={s.name} fill={s.color} />)}
            </Pie>
            <Tooltip content={makeTooltip()} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] text-slate-500">{totalLabel}</span>
          <span className="text-sm font-semibold tabular">{formatCents(total)}</span>
        </div>
      </div>
      <ul className="space-y-1.5">
        {positive.map((s) => (
          <li key={s.name}>
            <button
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(s)}
              className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-sm enabled:hover:bg-slate-50"
            >
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="flex-1 truncate text-slate-700">{s.name}</span>
              <span className="text-xs text-slate-500 tabular">{formatPercent(s.value, total)} %</span>
              <span className="w-24 text-right font-medium tabular">{formatCents(s.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Barra de comparación horizontal entre dos (o más) partes */
export function ShareBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + Math.max(p.value, 0), 0)
  return (
    <div className="space-y-3">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-slate-100">
        {total > 0 && parts.map((p) => (
          <div key={p.label} style={{ width: `${(Math.max(p.value, 0) / total) * 100}%`, background: p.color }} title={`${p.label}: ${formatCents(p.value)}`} />
        ))}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2 text-sm">
            <span className="size-2.5 rounded-sm" style={{ background: p.color }} />
            <span className="flex-1 text-slate-700">{p.label}</span>
            <span className="text-xs text-slate-500 tabular">{formatPercent(p.value, total)} %</span>
            <span className="font-medium tabular">{formatCents(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const pctAxis = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })
const pctTip = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 })

/** Barras mensuales de un porcentaje (p. ej. tasa de ahorro). Los meses sin dato quedan vacíos. */
export function PercentBars({ data, dataKey, label, color = SERIES[2], height = 220 }: {
  data: Record<string, number | string | null>[]; dataKey: string; label: string; color?: string; height?: number
}) {
  if (!data.some((d) => d[dataKey] !== null)) return <EmptyState title="Sin ingresos en este periodo" />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke="#eef2f6" />
        <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
        <YAxis tickFormatter={(v) => `${pctAxis.format(v)} %`} width={48} {...axis} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload, label: l }) => {
          if (!active || !payload?.length || payload[0].value == null) return null
          return (
            <div className="rounded-xl bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
              <p className="mb-1 font-medium capitalize text-slate-900">{monthShort(String(l))}</p>
              <p className="text-slate-600">{label}: <span className="font-medium text-slate-900 tabular">{pctTip.format(Number(payload[0].value))} %</span></p>
            </div>
          )
        }} />
        <Bar dataKey={dataKey} name={label} radius={[4, 4, 0, 0]} maxBarSize={28}>
          {data.map((d, i) => <Cell key={i} fill={Number(d[dataKey]) < 0 ? SERIES[7] : color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
