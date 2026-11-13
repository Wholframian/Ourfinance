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
  share_net_worth?: boolean
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

// ---------------------------------------------------------------- Fase 2
export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'yearly'
export type TripStatus = 'planned' | 'ongoing' | 'finished' | 'cancelled'
export type TripExpenseCategory = 'flights' | 'hotels' | 'car_rental' | 'fuel' | 'restaurants' | 'activities' | 'transport' | 'shopping' | 'other'
export type BudgetPeriod = 'monthly' | 'yearly' | 'custom'
export type GoalType = 'emergency' | 'travel' | 'housing' | 'investment' | 'other'

export interface RecurringTransaction {
  id: string
  household_id: string
  created_by: string
  visibility: Visibility
  type: TransactionType
  amount_cents: number
  description: string
  category_id: string | null
  subcategory_id: string | null
  account_id: string | null
  to_account_id: string | null
  frequency: Frequency
  next_due_on: string
  end_on: string | null
  is_active: boolean
  notes: string | null
  anchor_day?: number | null
  auto_register: boolean
}

export interface Trip {
  id: string
  household_id: string
  created_by: string
  visibility: Visibility
  name: string
  destination: string | null
  start_date: string | null
  end_date: string | null
  budget_cents: number | null
  status: TripStatus
  notes: string | null
  trip_participants?: { user_id: string }[]
}

export interface TripExpense {
  id: string
  trip_id: string
  transaction_id: string
  trip_category: TripExpenseCategory
  created_by: string
}

export interface Budget {
  id: string
  household_id: string
  owner_id: string
  visibility: Visibility
  name: string
  period: BudgetPeriod
  category_id: string | null
  trip_id: string | null
  amount_cents: number
  start_date: string
  end_date: string | null
}

export interface SavingsGoal {
  id: string
  household_id: string
  owner_id: string
  visibility: Visibility
  name: string
  goal_type: GoalType
  target_cents: number
  saved_cents: number
  account_id: string | null
  target_date: string | null
  is_achieved: boolean
}

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Semanal', biweekly: 'Cada 2 semanas', monthly: 'Mensual', bimonthly: 'Cada 2 meses',
  quarterly: 'Trimestral', semiannual: 'Semestral', yearly: 'Anual',
}
/** Cuotas al mes de cada periodicidad (para el coste mensual equivalente) */
export const FREQUENCY_PER_MONTH: Record<Frequency, number> = {
  weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, bimonthly: 1 / 2, quarterly: 1 / 3, semiannual: 1 / 6, yearly: 1 / 12,
}
export const TRIP_STATUS_LABEL: Record<TripStatus, string> = { planned: 'Planificado', ongoing: 'En curso', finished: 'Terminado', cancelled: 'Cancelado' }
export const TRIP_CATEGORY_LABEL: Record<TripExpenseCategory, string> = {
  flights: 'Vuelos', hotels: 'Hoteles', car_rental: 'Alquiler de vehículo', fuel: 'Gasolina', restaurants: 'Restaurantes',
  activities: 'Actividades', transport: 'Transporte', shopping: 'Compras', other: 'Otros',
}
export const BUDGET_PERIOD_LABEL: Record<BudgetPeriod, string> = { monthly: 'Mensual', yearly: 'Anual', custom: 'Personalizado' }
export const GOAL_TYPE_LABEL: Record<GoalType, string> = {
  emergency: 'Fondo de emergencia', travel: 'Viajes', housing: 'Vivienda', investment: 'Inversiones', other: 'Otro',
}

// ---------------------------------------------------------------- Fase 3
export type AssetType = 'crypto' | 'stock' | 'etf' | 'fund' | 'deposit' | 'savings_account' | 'other'
export type InvestmentTxType = 'buy' | 'sell' | 'dividend' | 'interest' | 'fee' | 'valuation'

export interface Investment {
  id: string
  household_id: string
  owner_id: string
  visibility: Visibility
  name: string
  asset_type: AssetType
  platform: string | null
  account_id: string | null
  quote_source: string | null
  quote_symbol: string | null
  acquired_on: string | null
  notes: string | null
  created_at: string
}

export interface InvestmentOperation {
  id: string
  investment_id: string
  household_id: string
  created_by: string
  type: InvestmentTxType
  occurred_on: string
  units: string | null
  unit_price: string | null
  amount_cents: number
  fee_cents: number
  transaction_id: string | null
  notes: string | null
  created_at: string
}

export interface Position {
  investment_id: string
  units: number | null
  last_price: number | null
  cost_cents: number
  contributed_cents: number
  withdrawn_cents: number
  realized_cents: number
  income_cents: number
  fees_cents: number
  value_cents: number
  total_return_cents: number
  valued_on: string | null
}

/** Depósitos y cuentas remuneradas se siguen por importe, sin unidades */
export const UNITLESS_ASSETS: AssetType[] = ['deposit', 'savings_account']

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  crypto: 'Criptomoneda', stock: 'Acción', etf: 'ETF', fund: 'Fondo de inversión',
  deposit: 'Depósito', savings_account: 'Cuenta remunerada', other: 'Otro',
}
export const INV_TX_LABEL: Record<InvestmentTxType, string> = {
  buy: 'Compra', sell: 'Venta', dividend: 'Dividendo', interest: 'Intereses', fee: 'Comisión', valuation: 'Valoración',
}
