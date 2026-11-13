/** Tipos de las filas de Supabase usadas por la app (ver supabase/migrations). */

export type Visibility = 'personal' | 'shared'
export type TransactionType = 'income' | 'expense' | 'transfer' | 'contribution' | 'investment' | 'refund'
export type AccountKind = 'checking' | 'savings' | 'cash' | 'credit_card' | 'common' | 'investment' | 'other'
export type CategoryKind = 'expense' | 'income'

export interface Profile {
  id: string
  full_name: string
  avatar_url: string | null
  color: string
}

export interface Household {
  id: string
  name: string
  currency: string
  timezone: string
  max_members: number
  created_by: string
}

export interface HouseholdMember {
  household_id: string
  user_id: string
  role: 'owner' | 'member'
  joined_at: string
}

export interface Invitation {
  id: string
  household_id: string
  email: string | null
  invited_by: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface Account {
  id: string
  household_id: string
  owner_id: string
  visibility: Visibility
  kind: AccountKind
  name: string
  institution: string | null
  opening_balance_cents: number
  opening_date: string
  color: string
  is_archived: boolean
}

export interface Category {
  id: string
  household_id: string
  parent_id: string | null
  kind: CategoryKind
  name: string
  group_key: string
  icon: string
  color: string
  sort_order: number
  is_system: boolean
  is_archived: boolean
}

export interface Transaction {
  id: string
  household_id: string
  created_by: string
  paid_by: string | null
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
  client_request_id: string | null
  created_at: string
  updated_at: string
  attachments?: Attachment[]
}

export interface Attachment {
  id: string
  household_id: string
  transaction_id: string
  uploaded_by: string
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  created_at: string
}

export interface PeriodSummary {
  income_cents: number
  expense_cents: number
  personal_expense_cents: number
  shared_expense_cents: number
  refund_cents: number
  contribution_cents: number
  savings_cents: number
  tx_count: number
}

export interface MonthlyFlow {
  month: string
  income_cents: number
  expense_cents: number
  personal_expense_cents: number
  shared_expense_cents: number
  contribution_cents: number
  savings_cents: number
}

export interface CategoryTotal {
  category_id: string | null
  name: string
  color: string
  group_key: string
  expense_cents: number
}

export const TX_TYPE_LABEL: Record<TransactionType, string> = {
  expense: 'Gasto',
  income: 'Ingreso',
  transfer: 'Transferencia',
  contribution: 'Aportación',
  investment: 'Inversión',
  refund: 'Reembolso',
}

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  checking: 'Cuenta corriente',
  savings: 'Ahorro',
  cash: 'Efectivo',
  credit_card: 'Tarjeta de crédito',
  common: 'Cuenta común',
  investment: 'Inversión',
  other: 'Otra',
}

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  personal: 'Personal',
  shared: 'Compartido',
}

/** Signo con el que se muestra un movimiento desde el punto de vista de "flujo" */
export function txSign(type: TransactionType): 1 | -1 | 0 {
  if (type === 'income' || type === 'refund') return 1
  if (type === 'expense') return -1
  return 0
}
