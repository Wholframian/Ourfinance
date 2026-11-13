import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type {
  Budget, RecurringTransaction, SavingsGoal, Transaction, Trip, TripExpense, TripExpenseCategory,
} from '../lib/types'
import { useHouseholdId } from '../providers/HouseholdProvider'
import { useInvalidateFinance } from './data'

const num = (v: unknown) => (typeof v === 'string' ? Number(v) : ((v as number) ?? 0))
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

// ---------------------------------------------------------------- Recurrentes
export function useRecurring() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['recurring', hid],
    queryFn: async () =>
      (await must(supabase.from('recurring_transactions').select('*').eq('household_id', hid).order('next_due_on'))).map(norm) as RecurringTransaction[],
  })
}

export type RecurringInput = Omit<RecurringTransaction, 'id' | 'household_id' | 'created_by'>

export function useSaveRecurring() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: RecurringInput & { id?: string }) => {
      if (id) await must(supabase.from('recurring_transactions').update(input).eq('id', id))
      else {
        const { data: u } = await supabase.auth.getUser()
        await must(supabase.from('recurring_transactions').insert({ ...input, household_id: hid, created_by: u.user!.id }))
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  })
}

export function useDeleteRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => { await must(supabase.from('recurring_transactions').delete().eq('id', id)) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  })
}

export function useRegisterRecurring() {
  const qc = useQueryClient()
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: async (id: string) => must(supabase.rpc('register_recurring', { p_recurring: id })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recurring'] }); invalidate() },
  })
}

// ---------------------------------------------------------------- Viajes
export function useTrips() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['trips', hid],
    queryFn: async () =>
      (await must(supabase.from('trips').select('*, trip_participants(user_id)').eq('household_id', hid)
        .order('start_date', { ascending: false, nullsFirst: true }))).map(norm) as Trip[],
  })
}

export function useTripSummaries() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['tx', 'trip-summaries', hid],
    queryFn: async () => {
      const rows = await must(supabase.rpc('trip_summaries', { p_household: hid })) as { trip_id: string; spent_cents: number; expense_count: number }[]
      return new Map(rows.map((r) => [r.trip_id, { spent: num(r.spent_cents), count: num(r.expense_count) }]))
    },
  })
}

export type TripInput = Omit<Trip, 'id' | 'household_id' | 'created_by' | 'trip_participants'> & { participants: string[] }

export function useSaveTrip() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, participants, ...input }: TripInput & { id?: string }) => {
      let tripId = id
      if (id) await must(supabase.from('trips').update(input).eq('id', id))
      else {
        const { data: u } = await supabase.auth.getUser()
        const row = await must(supabase.from('trips').insert({ ...input, household_id: hid, created_by: u.user!.id }).select('id').single()) as { id: string }
        tripId = row.id
      }
      await must(supabase.from('trip_participants').delete().eq('trip_id', tripId!))
      if (participants.length) {
        await must(supabase.from('trip_participants').insert(participants.map((user_id) => ({ trip_id: tripId, user_id }))))
      }
      return tripId!
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trips'] }),
  })
}

export function useDeleteTrip() {
  const qc = useQueryClient()
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: async (id: string) => { await must(supabase.from('trips').delete().eq('id', id)) },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['trips'] }); invalidate() },
  })
}

export interface TripExpenseRow extends TripExpense {
  transactions: Transaction
}

export function useTripExpenses(tripId: string | undefined) {
  return useQuery({
    queryKey: ['tx', 'trip-expenses', tripId],
    enabled: !!tripId,
    queryFn: async () => {
      const rows = await must(supabase.from('trip_expenses')
        .select('*, transactions(*, attachments(id, file_name, storage_path, mime_type, size_bytes))')
        .eq('trip_id', tripId!)) as TripExpenseRow[]
      return rows
        .filter((r) => r.transactions)
        .map((r) => ({ ...r, transactions: norm(r.transactions) }))
        .sort((a, b) => b.transactions.occurred_on.localeCompare(a.transactions.occurred_on))
    },
  })
}

/** Enlace de un movimiento a un viaje (null = desvincular) */
export async function setTripLink(transactionId: string, trip: { tripId: string; category: TripExpenseCategory } | null) {
  const existing = await must(supabase.from('trip_expenses').select('id, trip_id, trip_category').eq('transaction_id', transactionId)) as TripExpense[]
  const cur = existing[0]
  if (!trip) {
    if (cur) await must(supabase.from('trip_expenses').delete().eq('id', cur.id))
    return
  }
  if (cur) {
    if (cur.trip_id !== trip.tripId || cur.trip_category !== trip.category) {
      await must(supabase.from('trip_expenses').update({ trip_id: trip.tripId, trip_category: trip.category }).eq('id', cur.id))
    }
  } else {
    const { data: u } = await supabase.auth.getUser()
    await must(supabase.from('trip_expenses').insert({ trip_id: trip.tripId, transaction_id: transactionId, trip_category: trip.category, created_by: u.user!.id }))
  }
}

export async function getTripLink(transactionId: string): Promise<TripExpense | null> {
  const rows = await must(supabase.from('trip_expenses').select('*').eq('transaction_id', transactionId)) as TripExpense[]
  return rows[0] ?? null
}

// ---------------------------------------------------------------- Presupuestos
export function useBudgets(on: string) {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['tx', 'budgets', hid, on],
    queryFn: async () => {
      const [budgets, progress] = await Promise.all([
        must(supabase.from('budgets').select('*').eq('household_id', hid).order('name')) as Promise<Budget[]>,
        must(supabase.rpc('budget_progress', { p_household: hid, p_on: on })) as Promise<{ budget_id: string; period_from: string | null; period_to: string | null; spent_cents: number }[]>,
      ])
      const byId = new Map(progress.map((p) => [p.budget_id, p]))
      return budgets.map((b) => {
        const p = byId.get(b.id)
        return { ...norm(b), spent_cents: num(p?.spent_cents), period_from: p?.period_from ?? null, period_to: p?.period_to ?? null }
      })
    },
  })
}

export type BudgetInput = Omit<Budget, 'id' | 'household_id' | 'owner_id'>

export function useSaveBudget() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: BudgetInput & { id?: string }) => {
      if (id) await must(supabase.from('budgets').update(input).eq('id', id))
      else {
        const { data: u } = await supabase.auth.getUser()
        await must(supabase.from('budgets').insert({ ...input, household_id: hid, owner_id: u.user!.id }))
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tx', 'budgets'] }),
  })
}

export function useDeleteBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => { await must(supabase.from('budgets').delete().eq('id', id)) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tx', 'budgets'] }),
  })
}

// ---------------------------------------------------------------- Objetivos
export function useGoals() {
  const hid = useHouseholdId()
  return useQuery({
    queryKey: ['goals', hid],
    queryFn: async () =>
      (await must(supabase.from('savings_goals').select('*').eq('household_id', hid).order('target_date', { nullsFirst: false }))).map(norm) as SavingsGoal[],
  })
}

export type GoalInput = Omit<SavingsGoal, 'id' | 'household_id' | 'owner_id'>

export function useSaveGoal() {
  const hid = useHouseholdId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...input }: Partial<GoalInput> & { id?: string }) => {
      if (id) await must(supabase.from('savings_goals').update(input).eq('id', id))
      else {
        const { data: u } = await supabase.auth.getUser()
        await must(supabase.from('savings_goals').insert({ ...input, household_id: hid, owner_id: u.user!.id }))
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  })
}

export function useDeleteGoal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => { await must(supabase.from('savings_goals').delete().eq('id', id)) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  })
}
