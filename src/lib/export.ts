/**
 * Exportación a CSV y Excel. Todo se genera en el navegador con los datos que el
 * usuario puede ver (la RLS ya ha filtrado lo que no le corresponde).
 */
import { supabase } from './supabase'
import { formatDate } from './dates'
import {
  ASSET_TYPE_LABEL, INV_TX_LABEL, TX_TYPE_LABEL, UNITLESS_ASSETS,
  type Account, type Category, type Investment, type InvestmentOperation, type Position, type Transaction,
} from './types'

export interface ExportColumn<T> { header: string; value: (row: T) => string | number | null; money?: boolean; date?: boolean }

/** Céntimos → euros como número (para Excel) */
export const euros = (cents: number | null | undefined) => (cents == null ? null : cents / 100)

const csvMoney = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
const csvNumber = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 10, useGrouping: false })

function csvCell(v: string | number | null, money?: boolean, date?: boolean): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (typeof v === 'number') s = money ? csvMoney.format(v) : csvNumber.format(v)
  else s = date ? formatDate(v) : v
  // evita que Excel interprete fórmulas (inyección CSV)
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * CSV en formato español: separador «;», coma decimal y BOM UTF-8 para que
 * Excel lo abra con acentos y columnas correctas.
 */
export function toCsv<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(';')
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r), c.money, c.date)).join(';'))
  return '﻿' + [head, ...body].join('\r\n') + '\r\n'
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------- Datos
export interface ExportData {
  transactions: Transaction[]
  accounts: (Account & { balance_cents: number })[]
  categories: Category[]
  investments: Investment[]
  positions: Position[]
  operations: InvestmentOperation[]
  memberName: (id: string | null) => string
}

/** Descarga todos los movimientos visibles del rango, en páginas de 1000 */
export async function fetchTransactionsForExport(hid: string, from: string | null, to: string | null) {
  const out: Transaction[] = []
  for (let page = 0; ; page++) {
    let q = supabase.from('transactions').select('*').eq('household_id', hid)
    if (from) q = q.gte('occurred_on', from)
    if (to) q = q.lte('occurred_on', to)
    const { data, error } = await q.order('occurred_on').order('created_at').range(page * 1000, page * 1000 + 999)
    if (error) throw error
    out.push(...(data as Transaction[]).map((t) => ({ ...t, amount_cents: Number(t.amount_cents) })))
    if (!data || data.length < 1000) break
  }
  return out
}

const SIGN: Record<Transaction['type'], number> = { income: 1, refund: 1, expense: -1, transfer: 0, contribution: 0, investment: 0 }

export function transactionColumns(d: ExportData): ExportColumn<Transaction>[] {
  const acc = new Map(d.accounts.map((a) => [a.id, a.name]))
  const cat = new Map(d.categories.map((c) => [c.id, c.name]))
  const accName = (id: string | null) => (id ? acc.get(id) ?? 'Cuenta de otro miembro' : '')
  return [
    { header: 'Fecha', value: (t) => t.occurred_on, date: true },
    { header: 'Tipo', value: (t) => TX_TYPE_LABEL[t.type] },
    { header: 'Descripción', value: (t) => t.description },
    { header: 'Importe (€)', value: (t) => euros(t.amount_cents), money: true },
    { header: 'Efecto en ingresos/gastos (€)', value: (t) => euros(SIGN[t.type] * t.amount_cents), money: true },
    { header: 'Categoría', value: (t) => (t.category_id ? cat.get(t.category_id) ?? '' : '') },
    { header: 'Subcategoría', value: (t) => (t.subcategory_id ? cat.get(t.subcategory_id) ?? '' : '') },
    { header: 'Cuenta origen', value: (t) => accName(t.account_id) },
    { header: 'Cuenta destino', value: (t) => accName(t.to_account_id) },
    { header: 'Visibilidad', value: (t) => (t.visibility === 'shared' ? 'Compartido' : 'Personal') },
    { header: 'Registrado por', value: (t) => d.memberName(t.created_by) },
    { header: 'Pagado por', value: (t) => d.memberName(t.paid_by) },
    { header: 'Etiquetas', value: (t) => (t.tags ?? []).join(', ') },
    { header: 'Notas', value: (t) => t.notes ?? '' },
  ]
}

export function accountColumns(): ExportColumn<ExportData['accounts'][number]>[] {
  return [
    { header: 'Cuenta', value: (a) => a.name },
    { header: 'Entidad', value: (a) => a.institution ?? '' },
    { header: 'Visibilidad', value: (a) => (a.visibility === 'shared' ? 'Compartida' : 'Personal') },
    { header: 'Saldo inicial (€)', value: (a) => euros(a.opening_balance_cents), money: true },
    { header: 'Fecha saldo inicial', value: (a) => a.opening_date, date: true },
    { header: 'Saldo actual (€)', value: (a) => euros(a.balance_cents), money: true },
    { header: 'Archivada', value: (a) => (a.is_archived ? 'Sí' : 'No') },
  ]
}

export function positionColumns(d: ExportData): ExportColumn<Investment>[] {
  const pos = new Map(d.positions.map((p) => [p.investment_id, p]))
  const p = (i: Investment) => pos.get(i.id)
  return [
    { header: 'Inversión', value: (i) => i.name },
    { header: 'Tipo', value: (i) => ASSET_TYPE_LABEL[i.asset_type] },
    { header: 'Plataforma', value: (i) => i.platform ?? '' },
    { header: 'Símbolo/ISIN', value: (i) => i.quote_symbol ?? '' },
    { header: 'Visibilidad', value: (i) => (i.visibility === 'shared' ? 'Compartida' : 'Personal') },
    { header: 'Unidades', value: (i) => (UNITLESS_ASSETS.includes(i.asset_type) ? null : p(i)?.units ?? 0) },
    { header: 'Último precio (€)', value: (i) => p(i)?.last_price ?? null },
    { header: 'Valor actual (€)', value: (i) => euros(p(i)?.value_cents ?? 0), money: true },
    { header: 'Coste en cartera (€)', value: (i) => euros(p(i)?.cost_cents ?? 0), money: true },
    { header: 'Aportado (€)', value: (i) => euros(p(i)?.contributed_cents ?? 0), money: true },
    { header: 'Retirado (€)', value: (i) => euros(p(i)?.withdrawn_cents ?? 0), money: true },
    { header: 'Plusvalía realizada (€)', value: (i) => euros(p(i)?.realized_cents ?? 0), money: true },
    { header: 'Dividendos e intereses (€)', value: (i) => euros(p(i)?.income_cents ?? 0), money: true },
    { header: 'Rentabilidad total (€)', value: (i) => euros(p(i)?.total_return_cents ?? 0), money: true },
  ]
}

export function operationColumns(d: ExportData): ExportColumn<InvestmentOperation>[] {
  const inv = new Map(d.investments.map((i) => [i.id, i.name]))
  return [
    { header: 'Fecha', value: (o) => o.occurred_on, date: true },
    { header: 'Inversión', value: (o) => inv.get(o.investment_id) ?? '' },
    { header: 'Operación', value: (o) => INV_TX_LABEL[o.type] },
    { header: 'Unidades', value: (o) => (o.units == null ? null : Number(o.units)) },
    { header: 'Precio (€)', value: (o) => (o.unit_price == null ? null : Number(o.unit_price)) },
    { header: 'Importe (€)', value: (o) => euros(o.amount_cents), money: true },
    { header: 'Comisión (€)', value: (o) => euros(o.fee_cents), money: true },
    { header: 'Notas', value: (o) => o.notes ?? '' },
  ]
}

/** Libro Excel con una hoja por tabla (la librería se carga solo al exportar) */
export async function buildWorkbook(d: ExportData): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  type Cell = { value?: string | number | Date; type?: StringConstructor | NumberConstructor | DateConstructor; format?: string; fontWeight?: 'bold' } | null
  const sheet = <T,>(name: string, rows: T[], cols: ExportColumn<T>[]) => ({
    sheet: name,
    data: [
      cols.map((c): Cell => ({ value: c.header, fontWeight: 'bold' })),
      ...rows.map((r) => cols.map((c): Cell => {
        const v = c.value(r)
        if (v === null || v === undefined || v === '') return null
        if (c.date && typeof v === 'string') {
          const [y, m, day] = v.split('-').map(Number)
          return { value: new Date(Date.UTC(y, m - 1, day)), type: Date, format: 'dd/mm/yyyy' }
        }
        if (typeof v === 'number') return { value: v, type: Number, format: c.money ? '#,##0.00' : undefined }
        return { value: v, type: String }
      })),
    ],
    columns: cols.map((c) => ({ width: c.header === 'Descripción' || c.header === 'Notas' ? 36 : c.date ? 12 : 16 })),
    stickyRowsCount: 1,
  })
  return writeXlsxFile([
    sheet('Movimientos', d.transactions, transactionColumns(d)),
    sheet('Cuentas', d.accounts, accountColumns()),
    sheet('Inversiones', d.investments, positionColumns(d)),
    sheet('Operaciones', d.operations, operationColumns(d)),
  ] as never).toBlob()
}
