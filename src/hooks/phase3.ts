import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Investment, InvestmentOperation, InvestmentTxType, Position, Visibility } from '../lib/types'
import { useHouseholdId } from '../providers/HouseholdProvider'
import { useInvalidateFinance } from './data'

const num = (v: unknown) => (typeof v === 'string' ? Number(v) : ((v as number) ?? 0))
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : num(v))
function norm<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const k of Object.keys(out)) if (k.endsWith('_cents') && out[k] !== null) out[k] = num(out[k])
  return out as T
}
async function must<T>(p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await p
  if (error) throw error
  return data as T
}

// ---------------------------------------------------------------- Inversiones
export function useInvestments() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['inv', 'list', hid],
    queryFn: async () =>
      (await must(supabase.from('investments')
        .select('id, household_id, owner_id, visibility, name, asset_type, platform, account_id, quote_source, quote_symbol, acquired_on, notes, created_at')
        .eq('household_id', hid).order('name'))) as Investment[],
  })
}

/** Posiciones calculadas en la base de datos desde el historial de operaciones */
export function usePositions(at?: string | null) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['inv', 'positions', hid, at ?? null],
    queryFn: async () => {
      const rows = await must(supabase.rpc('investment_positions', { p_household: hid, p_at: at ?? null })) as Record<string, unknown>[]
      return rows.map((r) => ({
        ...norm(r),
        units: numOrNull(r.units),
        last_price: numOrNull(r.last_price),
      })) as unknown as Position[]
    },
  })
}

export function useInvestmentOperations(investmentId: string | undefined) {
  return useQuery({
    queryKey: ['inv', 'ops', investmentId],
    enabled: !!investmentId,
    queryFn: async () =>
      (await must(supabase.from('investment_transactions').select('*').eq('investment_id', investmentId!)
        .order('occurred_on', { ascending: false }).order('created_at', { ascending: false }))).map(norm) as InvestmentOperation[],
  })
}

/** Todas las operaciones visibles del espacio (para exportar) */
export async function fetchAllOperations(hid: string) {
  return (await must(supabase.from('investment_transactions').select('*').eq('household_id', hid)
    .order('occurred_on'))).map(norm) as InvestmentOperation[]
}

export interface InvestmentInput {
  name: string
  asset_type: Investment['asset_type']
  visibility: Visibility
  platform: string | null
  account_id: string | null
  quote_symbol: string | null
  notes: string | null
}

function useInvalidateInvestments() {
  const qc = useQueryClient()
  const invalidate = useInvalidateFinance()
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['inv'] }), invalidate()])
}

export function useSaveInvestment() {
  const hid = useHouseholdId()
  const invalidate = useInvalidateInvestments()
  return useMutation({
    mutationFn: async ({ id, ...input }: InvestmentInput & { id?: string }) => {
      if (id) {
        await must(supabase.from('investments').update(input).eq('id', id))
        return id
      }
      const { data: u } = await supabase.auth.getUser()
      const row = await must(supabase.from('investments').insert({ ...input, household_id: hid, owner_id: u.user!.id }).select('id').single()) as { id: string }
      return row.id
    },
    onSuccess: () => invalidate(),
  })
}

export function useDeleteInvestment() {
  const invalidate = useInvalidateInvestments()
  return useMutation({
    mutationFn: async (id: string) => { await must(supabase.from('investments').delete().eq('id', id)) },
    onSuccess: () => invalidate(),
  })
}

export interface OperationInput {
  investmentId: string
  type: InvestmentTxType
  on: string
  amountCents: number | null
  units: string | null
  unitPrice: string | null
  feeCents: number
  cashAccountId: string | null
  notes: string | null
  clientRequestId: string
}

export function useRecordOperation() {
  const invalidate = useInvalidateInvestments()
  return useMutation({
    mutationFn: async (op: OperationInput) =>
      must(supabase.rpc('record_investment_operation', {
        p_investment: op.investmentId,
        p_type: op.type,
        p_on: op.on,
        p_amount_cents: op.amountCents,
        p_units: op.units,
        p_unit_price: op.unitPrice,
        p_fee_cents: op.feeCents,
        p_cash_account: op.cashAccountId,
        p_notes: op.notes,
        p_client_request_id: op.cashAccountId ? op.clientRequestId : null,
      })),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteOperation() {
  const invalidate = useInvalidateInvestments()
  return useMutation({
    mutationFn: async (id: string) => { await must(supabase.from('investment_transactions').delete().eq('id', id)) },
    onSuccess: () => invalidate(),
  })
}

// ---------------------------------------------------------------- Patrimonio
export interface BreakdownRow { source: 'account' | 'investment'; kind: string; visibility: Visibility; value_cents: number }

export function useNetWorthBreakdown(at?: string | null) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'nw-breakdown', hid, at ?? null],
    queryFn: async () =>
      (await must(supabase.rpc('net_worth_breakdown', { p_household: hid, p_at: at ?? null })) as BreakdownRow[]).map(norm),
  })
}

export interface MemberNetWorth { user_id: string | null; is_sharing: boolean; net_worth_cents: number | null }

/** Patrimonio de cada miembro (solo si lo comparte) + lo compartido (user_id null) */
export function useHouseholdNetWorth() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'household-nw', hid],
    queryFn: async () =>
      (await must(supabase.rpc('household_net_worth', { p_household: hid })) as MemberNetWorth[])
        .map((r) => ({ ...r, net_worth_cents: numOrNull(r.net_worth_cents) })),
  })
}

export function useHouseholdNetWorthSeries(from: string, to: string, enabled: boolean) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'household-nw-series', hid, from, to],
    enabled,
    queryFn: async () =>
      (await must(supabase.rpc('household_net_worth_series', { p_household: hid, p_from: from, p_to: to })) as
        { month: string; user_id: string | null; net_worth_cents: number }[]).map(norm),
  })
}

export function useSetNetWorthSharing() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (share: boolean) => must(supabase.rpc('set_net_worth_sharing', { p_household: hid, p_share: share })),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['stats'] }),
      qc.invalidateQueries({ queryKey: ['household'] }),
      qc.invalidateQueries({ queryKey: ['members'] }),
    ]),
  })
}

// ---------------------------------------------------------------- Analítica
export function useExpenseByPayer(from: string, to: string) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'by-payer', hid, from, to],
    queryFn: async () =>
      (await must(supabase.rpc('expense_by_payer', { p_household: hid, p_from: from, p_to: to })) as
        { user_id: string; visibility: Visibility; expense_cents: number }[]).map(norm),
  })
}

export function useTopSubcategories(from: string, to: string, limit = 10) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'top-sub', hid, from, to, limit],
    queryFn: async () =>
      (await must(supabase.rpc('top_subcategories', { p_household: hid, p_from: from, p_to: to, p_limit: limit })) as
        { category_id: string | null; parent_name: string; name: string; color: string; expense_cents: number; tx_count: number }[])
        .map((r) => ({ ...norm(r), tx_count: num(r.tx_count) })),
  })
}
