import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type {
  Account, Attachment, Category, CategoryTotal, Invitation, MonthlyFlow, PeriodSummary,
  Transaction, TransactionType, Visibility,
} from '../lib/types'
import { useHouseholdId } from '../providers/HouseholdProvider'

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

/** Convierte los bigint que devuelve PostgREST (number o string) a number */
function num(v: unknown): number {
  return typeof v === 'string' ? Number(v) : (v as number) ?? 0
}

function normalize<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const k of Object.keys(out)) if (k.endsWith('_cents') || k === 'tx_count') out[k] = num(out[k])
  return out as T
}

/** Invalida todo lo que depende de los movimientos */
export function useInvalidateFinance() {
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['tx'] }),
      qc.invalidateQueries({ queryKey: ['stats'] }),
      qc.invalidateQueries({ queryKey: ['accounts'] }),
    ])
}

// ---------------------------------------------------------------------------
// Cuentas y saldos
// ---------------------------------------------------------------------------
export interface AccountWithBalance extends Account {
  balance_cents: number
}

export function useAccounts() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['accounts', hid],
    queryFn: async (): Promise<AccountWithBalance[]> => {
      const [acc, bal] = await Promise.all([
        supabase.from('accounts').select('*').eq('household_id', hid).order('visibility', { ascending: false }).order('name'),
        rpc<{ account_id: string; balance_cents: number }[]>('account_balances', { p_household: hid }),
      ])
      if (acc.error) throw acc.error
      const balances = new Map(bal.map((b) => [b.account_id, num(b.balance_cents)]))
      return (acc.data as Account[]).map((a) => ({
        ...normalize(a),
        balance_cents: balances.get(a.id) ?? num(a.opening_balance_cents),
      }))
    },
  })
}

export type AccountInput = Pick<Account, 'name' | 'kind' | 'visibility' | 'opening_balance_cents' | 'opening_date' | 'color'> & {
  institution?: string | null
}

export function useSaveAccount() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: AccountInput & { id?: string }) => {
      if (id) {
        const { error } = await supabase.from('accounts').update(input).eq('id', id)
        if (error) throw error
      } else {
        const { data: u } = await supabase.auth.getUser()
        const { error } = await supabase.from('accounts').insert({ ...input, household_id: hid, owner_id: u.user!.id })
        if (error) throw error
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })
}

export function useArchiveAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const { error } = await supabase.from('accounts').update({ is_archived: archived }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })
}

export function useDeleteAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('accounts').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })
}

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------
export function useCategories() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['categories', hid],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase
        .from('categories').select('*').eq('household_id', hid).order('sort_order').order('name')
      if (error) throw error
      return data as Category[]
    },
  })
}

export function useSaveCategory() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (c: { id?: string; name: string; parent_id: string | null; kind: Category['kind']; color?: string; is_archived?: boolean }) => {
      const { id, ...rest } = c
      const q = id
        ? supabase.from('categories').update(rest).eq('id', id)
        : supabase.from('categories').insert({ ...rest, household_id: hid })
      const { error } = await q
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  })
}

// ---------------------------------------------------------------------------
// Movimientos
// ---------------------------------------------------------------------------
export interface TxFilters {
  from?: string
  to?: string
  search?: string
  types?: TransactionType[]
  visibility?: Visibility | 'all'
  categoryId?: string
  accountId?: string
  userId?: string
  sort?: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'
}

export const PAGE_SIZE = 25

export function useTransactions(filters: TxFilters, page = 0, pageSize = PAGE_SIZE) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['tx', hid, filters, page, pageSize],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase
        .from('transactions')
        .select('*, attachments(id, file_name, storage_path, mime_type, size_bytes)', { count: 'exact' })
        .eq('household_id', hid)
      if (filters.from) q = q.gte('occurred_on', filters.from)
      if (filters.to) q = q.lte('occurred_on', filters.to)
      if (filters.types?.length) q = q.in('type', filters.types)
      if (filters.visibility && filters.visibility !== 'all') q = q.eq('visibility', filters.visibility)
      if (filters.categoryId) q = q.or(`category_id.eq.${filters.categoryId},subcategory_id.eq.${filters.categoryId}`)
      if (filters.accountId) q = q.or(`account_id.eq.${filters.accountId},to_account_id.eq.${filters.accountId}`)
      if (filters.userId) q = q.eq('created_by', filters.userId)
      const s = filters.search?.trim()
      if (s) {
        // escapa los caracteres con significado en el filtro "or" de PostgREST
        const term = s.replace(/[%_,()\\*]/g, ' ').trim()
        if (term) q = q.or(`description.ilike.*${term}*,notes.ilike.*${term}*`)
      }
      switch (filters.sort ?? 'date_desc') {
        case 'date_desc': q = q.order('occurred_on', { ascending: false }).order('created_at', { ascending: false }); break
        case 'date_asc': q = q.order('occurred_on', { ascending: true }).order('created_at', { ascending: true }); break
        case 'amount_desc': q = q.order('amount_cents', { ascending: false }); break
        case 'amount_asc': q = q.order('amount_cents', { ascending: true }); break
      }
      const fromIdx = page * pageSize
      const { data, error, count } = await q.range(fromIdx, fromIdx + pageSize - 1)
      if (error) throw error
      return { rows: (data as Transaction[]).map(normalize), count: count ?? 0 }
    },
  })
}

export interface TxInput {
  type: TransactionType
  visibility: Visibility
  amount_cents: number
  occurred_on: string
  description: string
  category_id: string | null
  subcategory_id: string | null
  account_id: string | null
  to_account_id: string | null
  tags: string[]
  notes: string | null
  client_request_id?: string
}

/** Busca un posible duplicado (mismo tipo, importe, fecha y descripción) */
export async function findPossibleDuplicate(hid: string, input: TxInput, excludeId?: string) {
  let q = supabase
    .from('transactions')
    .select('id, description, occurred_on, amount_cents')
    .eq('household_id', hid)
    .eq('type', input.type)
    .eq('amount_cents', input.amount_cents)
    .eq('occurred_on', input.occurred_on)
    .ilike('description', input.description.trim().replace(/[%_\\]/g, '\\$&'))
    .limit(1)
  if (excludeId) q = q.neq('id', excludeId)
  const { data, error } = await q
  if (error) throw error
  return data?.[0] ?? null
}

export function useSaveTransaction() {
  const hid = useHouseholdId()
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: async ({ id, input, file }: { id?: string; input: TxInput; file?: File | null }) => {
      let txId = id
      if (id) {
        const { client_request_id: _ignored, ...patch } = input
        void _ignored
        const { error } = await supabase.from('transactions').update(patch).eq('id', id)
        if (error) throw error
      } else {
        const { data, error } = await supabase
          .from('transactions')
          .insert({ ...input, household_id: hid })
          .select('id')
          .single()
        if (error) throw error
        txId = data.id as string
      }
      if (file && txId) await uploadAttachment(hid, txId, file)
      return txId!
    },
    onSuccess: () => invalidate(),
  })
}

export function useDeleteTransaction() {
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: async (tx: Pick<Transaction, 'id'> & { attachments?: Pick<Attachment, 'storage_path'>[] }) => {
      const { error } = await supabase.from('transactions').delete().eq('id', tx.id)
      if (error) throw error
      const paths = (tx.attachments ?? []).map((a) => a.storage_path)
      if (paths.length) await supabase.storage.from('attachments').remove(paths)
    },
    onSuccess: () => invalidate(),
  })
}

// ---------------------------------------------------------------------------
// Justificantes
// ---------------------------------------------------------------------------
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const ALLOWED_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']

async function uploadAttachment(hid: string, txId: string, file: File) {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('El justificante supera los 10 MB.')
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) throw new Error('Formato no admitido. Usa PDF, JPG, PNG, WEBP o HEIC.')
  const { data: u } = await supabase.auth.getUser()
  const uid = u.user!.id
  const safeName = file.name.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-80)
  const path = `${hid}/${uid}/${crypto.randomUUID()}-${safeName}`
  const up = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type, upsert: false })
  if (up.error) throw new Error('No se pudo subir el justificante: ' + up.error.message)
  const { error } = await supabase.from('attachments').insert({
    household_id: hid, transaction_id: txId, uploaded_by: uid, storage_path: path,
    file_name: file.name.slice(0, 200), mime_type: file.type, size_bytes: file.size,
  })
  if (error) {
    await supabase.storage.from('attachments').remove([path])
    throw error
  }
}

export async function openAttachment(path: string) {
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 60)
  if (error) throw error
  window.open(data.signedUrl, '_blank', 'noopener')
}

export function useDeleteAttachment() {
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: async (a: Pick<Attachment, 'id' | 'storage_path'>) => {
      const { error } = await supabase.from('attachments').delete().eq('id', a.id)
      if (error) throw error
      await supabase.storage.from('attachments').remove([a.storage_path])
    },
    onSuccess: () => invalidate(),
  })
}

// ---------------------------------------------------------------------------
// Analítica (RPC con RLS)
// ---------------------------------------------------------------------------
export function usePeriodSummary(from: string, to: string) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'summary', hid, from, to],
    queryFn: async () => {
      const rows = await rpc<PeriodSummary[]>('period_summary', { p_household: hid, p_from: from, p_to: to })
      return normalize(rows[0])
    },
  })
}

/** Ingresos y gastos del periodo en cada cuenta visible */
export function useAccountFlows(from: string, to: string) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'account-flows', hid, from, to],
    queryFn: async () =>
      (await rpc<{ account_id: string; income_cents: number; expense_cents: number }[]>('account_flows', {
        p_household: hid, p_from: from, p_to: to,
      })).map(normalize),
  })
}

export function useMonthlyFlows(from: string, to: string, categoryId?: string | null, visibility?: Visibility | null) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'monthly', hid, from, to, categoryId ?? null, visibility ?? null],
    queryFn: async () =>
      (await rpc<MonthlyFlow[]>('monthly_flows', {
        p_household: hid, p_from: from, p_to: to, p_category: categoryId ?? null, p_visibility: visibility ?? null,
      })).map(normalize),
  })
}

export function useCategoryBreakdown(from: string, to: string, visibility?: Visibility | null, parentId?: string | null) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'categories', hid, from, to, visibility ?? null, parentId ?? null],
    queryFn: async () =>
      (await rpc<CategoryTotal[]>('category_breakdown', {
        p_household: hid, p_from: from, p_to: to, p_visibility: visibility ?? null, p_parent: parentId ?? null,
      })).map(normalize),
  })
}

export function useContributions(from: string, to: string) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'contributions', hid, from, to],
    queryFn: async () =>
      (await rpc<{ month: string; user_id: string; contribution_cents: number }[]>('contributions_by_member', {
        p_household: hid, p_from: from, p_to: to,
      })).map(normalize),
  })
}

export function useNetWorthSeries(from: string, to: string) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['stats', 'networth', hid, from, to],
    queryFn: async () =>
      (await rpc<{ month: string; net_worth_cents: number }[]>('net_worth_series', {
        p_household: hid, p_from: from, p_to: to,
      })).map(normalize),
  })
}

// ---------------------------------------------------------------------------
// Invitaciones
// ---------------------------------------------------------------------------
export function useInvitations() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['invitations', hid],
    queryFn: async (): Promise<Invitation[]> => {
      const { data, error } = await supabase
        .from('household_invitations')
        .select('id, household_id, email, invited_by, expires_at, accepted_at, revoked_at, created_at')
        .eq('household_id', hid)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as Invitation[]
    },
  })
}
