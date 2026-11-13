-- =============================================================================
-- OURFINANCE · 0001 · Esquema base
-- -----------------------------------------------------------------------------
-- Convenciones:
--   * Todos los identificadores son UUID (gen_random_uuid()).
--   * Los importes monetarios se guardan como BIGINT en céntimos de euro
--     (columnas *_cents). Nunca se usan float. Los precios unitarios de activos
--     (que pueden tener más de 2 decimales) usan NUMERIC(20,8) en euros.
--   * Todas las tablas tienen created_at / updated_at (timestamptz).
--   * Cada fila financiera pertenece a un household (espacio) y tiene un
--     propietario (created_by / owner_id) y una visibilidad 'personal' | 'shared'.
--   * Las fechas de los movimientos son DATE (día natural en Europe/Madrid).
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Tipos enumerados
-- -----------------------------------------------------------------------------
create type public.visibility as enum ('personal', 'shared');

create type public.member_role as enum ('owner', 'member');

create type public.account_kind as enum (
  'checking',     -- cuenta corriente
  'savings',      -- cuenta de ahorro / remunerada
  'cash',         -- efectivo
  'credit_card',  -- tarjeta de crédito
  'common',       -- cuenta común de la pareja
  'investment',   -- cuenta de inversión / broker
  'other'
);

create type public.transaction_type as enum (
  'income',        -- ingreso: +importe en account_id
  'expense',       -- gasto de consumo: -importe en account_id
  'transfer',      -- transferencia: -account_id, +to_account_id (no es gasto)
  'contribution',  -- aportación a cuenta común: -account_id (opcional), +to_account_id (no es gasto)
  'investment',    -- movimiento hacia/desde inversión: -account_id, +to_account_id (no es gasto)
  'refund'         -- reembolso: +importe en account_id, resta del gasto de su categoría
);

create type public.category_kind as enum ('expense', 'income');

create type public.recurrence_frequency as enum ('monthly', 'quarterly', 'yearly');

create type public.trip_status as enum ('planned', 'ongoing', 'finished', 'cancelled');

create type public.trip_expense_category as enum (
  'flights', 'hotels', 'car_rental', 'fuel', 'restaurants',
  'activities', 'transport', 'shopping', 'other'
);

create type public.asset_type as enum (
  'crypto', 'stock', 'etf', 'fund', 'deposit', 'savings_account', 'other'
);

create type public.investment_tx_type as enum (
  'buy', 'sell', 'dividend', 'interest', 'fee', 'valuation'
);

create type public.budget_period as enum ('monthly', 'yearly', 'custom');

create type public.goal_type as enum ('emergency', 'travel', 'housing', 'investment', 'other');

-- -----------------------------------------------------------------------------
-- Función genérica updated_at
-- -----------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles: un perfil por usuario de Supabase Auth
-- -----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  full_name     text not null default '' check (char_length(full_name) <= 120),
  avatar_url    text,
  color         text not null default '#0f766e' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- households: espacio financiero compartido (pareja, preparado para N miembros)
-- -----------------------------------------------------------------------------
create table public.households (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 80),
  currency      char(3) not null default 'EUR',
  timezone      text not null default 'Europe/Madrid',
  max_members   smallint not null default 2 check (max_members between 1 and 20),
  created_by    uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.household_members (
  household_id  uuid not null references public.households (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.member_role not null default 'member',
  joined_at     timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members (user_id);

-- Invitaciones seguras: solo se guarda el hash SHA-256 del token.
create table public.household_invitations (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  email         text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token_hash    text not null unique,
  invited_by    uuid not null references auth.users (id),
  expires_at    timestamptz not null default (now() + interval '7 days'),
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users (id),
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index household_invitations_household_idx on public.household_invitations (household_id);

-- -----------------------------------------------------------------------------
-- accounts: cuentas personales o compartidas (la cuenta común es shared + common)
-- -----------------------------------------------------------------------------
create table public.accounts (
  id                     uuid primary key default gen_random_uuid(),
  household_id           uuid not null references public.households (id) on delete cascade,
  owner_id               uuid not null references auth.users (id),
  visibility             public.visibility not null default 'personal',
  kind                   public.account_kind not null default 'checking',
  name                   text not null check (char_length(name) between 1 and 80),
  institution            text check (char_length(institution) <= 80),
  opening_balance_cents  bigint not null default 0,
  opening_date           date not null default (now() at time zone 'Europe/Madrid')::date,
  color                  text not null default '#0f172a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_archived            boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- la cuenta común siempre es compartida
  constraint accounts_common_is_shared check (kind <> 'common' or visibility = 'shared')
);
create index accounts_household_idx on public.accounts (household_id);
create index accounts_owner_idx on public.accounts (owner_id);
create unique index accounts_unique_name on public.accounts (household_id, owner_id, lower(name));

-- -----------------------------------------------------------------------------
-- categories: categorías y subcategorías (parent_id) del espacio
-- group_key agrupa para los módulos: 'housing', 'food', 'travel', 'personal'...
-- -----------------------------------------------------------------------------
create table public.categories (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  parent_id     uuid references public.categories (id) on delete cascade,
  kind          public.category_kind not null default 'expense',
  name          text not null check (char_length(name) between 1 and 60),
  group_key     text not null default 'other' check (group_key ~ '^[a-z_]{1,30}$'),
  icon          text not null default 'circle',
  color         text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order    integer not null default 0,
  is_system     boolean not null default false,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint categories_not_self_parent check (parent_id is null or parent_id <> id)
);
create index categories_household_idx on public.categories (household_id);
create index categories_parent_idx on public.categories (parent_id);
create unique index categories_unique_name
  on public.categories (household_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, lower(name));

-- -----------------------------------------------------------------------------
-- trips (Fase 2, se crea ya para que transactions pueda referenciarla)
-- -----------------------------------------------------------------------------
create table public.trips (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid not null references auth.users (id),
  visibility    public.visibility not null default 'shared',
  name          text not null check (char_length(name) between 1 and 80),
  destination   text check (char_length(destination) <= 120),
  start_date    date,
  end_date      date,
  budget_cents  bigint check (budget_cents is null or budget_cents >= 0),
  status        public.trip_status not null default 'planned',
  notes         text check (char_length(notes) <= 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint trips_dates check (end_date is null or start_date is null or end_date >= start_date)
);
create index trips_household_idx on public.trips (household_id);

create table public.trip_participants (
  trip_id       uuid not null references public.trips (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  primary key (trip_id, user_id)
);

-- -----------------------------------------------------------------------------
-- recurring_transactions: plantillas de movimientos periódicos
-- -----------------------------------------------------------------------------
create table public.recurring_transactions (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households (id) on delete cascade,
  created_by       uuid not null references auth.users (id),
  visibility       public.visibility not null default 'shared',
  type             public.transaction_type not null default 'expense',
  amount_cents     bigint not null check (amount_cents > 0),
  description      text not null check (char_length(description) between 1 and 140),
  category_id      uuid references public.categories (id) on delete set null,
  subcategory_id   uuid references public.categories (id) on delete set null,
  account_id       uuid references public.accounts (id) on delete set null,
  to_account_id    uuid references public.accounts (id) on delete set null,
  frequency        public.recurrence_frequency not null default 'monthly',
  next_due_on      date not null,
  end_on           date,
  is_active        boolean not null default true,
  notes            text check (char_length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index recurring_household_idx on public.recurring_transactions (household_id);

-- -----------------------------------------------------------------------------
-- transactions: el libro de movimientos
-- -----------------------------------------------------------------------------
create table public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households (id) on delete cascade,
  created_by         uuid not null references auth.users (id),
  -- quién aporta / paga (por defecto quien registra). Para aportaciones es el aportante.
  paid_by            uuid references auth.users (id),
  type               public.transaction_type not null,
  visibility         public.visibility not null default 'personal',
  amount_cents       bigint not null check (amount_cents > 0 and amount_cents < 100000000000),
  occurred_on        date not null,
  description        text not null check (char_length(description) between 1 and 140),
  category_id        uuid references public.categories (id) on delete set null,
  subcategory_id     uuid references public.categories (id) on delete set null,
  account_id         uuid references public.accounts (id) on delete restrict,
  to_account_id      uuid references public.accounts (id) on delete restrict,
  tags               text[] not null default '{}',
  notes              text check (char_length(notes) <= 2000),
  trip_id            uuid references public.trips (id) on delete set null,
  recurring_id       uuid references public.recurring_transactions (id) on delete set null,
  -- clave de idempotencia generada en el cliente: evita duplicados por doble envío
  client_request_id  uuid unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint tx_accounts_by_type check (
    case type
      when 'income'       then account_id is not null and to_account_id is null
      when 'expense'      then account_id is not null and to_account_id is null
      when 'refund'       then account_id is not null and to_account_id is null
      when 'transfer'     then account_id is not null and to_account_id is not null
      when 'investment'   then account_id is not null and to_account_id is not null
      when 'contribution' then to_account_id is not null
    end
  ),
  constraint tx_distinct_accounts check (account_id is null or to_account_id is null or account_id <> to_account_id),
  constraint tx_tags_limit check (cardinality(tags) <= 20)
);
create index transactions_household_date_idx on public.transactions (household_id, occurred_on desc);
create index transactions_created_by_idx on public.transactions (created_by);
create index transactions_account_idx on public.transactions (account_id);
create index transactions_to_account_idx on public.transactions (to_account_id);
create index transactions_category_idx on public.transactions (category_id);
create index transactions_type_idx on public.transactions (household_id, type);
create index transactions_tags_idx on public.transactions using gin (tags);
create index transactions_trip_idx on public.transactions (trip_id);

-- -----------------------------------------------------------------------------
-- attachments: justificantes/facturas (fichero en Storage, bucket 'attachments')
-- storage_path = '{household_id}/{user_id}/{uuid}-{nombre}'
-- -----------------------------------------------------------------------------
create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  uploaded_by     uuid not null references auth.users (id),
  storage_path    text not null unique,
  file_name       text not null check (char_length(file_name) between 1 and 200),
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at      timestamptz not null default now()
);
create index attachments_transaction_idx on public.attachments (transaction_id);

-- -----------------------------------------------------------------------------
-- trip_expenses (Fase 2): enlaza movimientos reales con un viaje (sin duplicar importes)
-- -----------------------------------------------------------------------------
create table public.trip_expenses (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.trips (id) on delete cascade,
  transaction_id  uuid not null unique references public.transactions (id) on delete cascade,
  trip_category   public.trip_expense_category not null default 'other',
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now()
);
create index trip_expenses_trip_idx on public.trip_expenses (trip_id);

-- -----------------------------------------------------------------------------
-- investments (Fase 3)
-- -----------------------------------------------------------------------------
create table public.investments (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references public.households (id) on delete cascade,
  owner_id              uuid not null references auth.users (id),
  visibility            public.visibility not null default 'personal',
  name                  text not null check (char_length(name) between 1 and 80),
  asset_type            public.asset_type not null,
  platform              text check (char_length(platform) <= 80),
  account_id            uuid references public.accounts (id) on delete set null,
  -- preparado para APIs de cotización (p. ej. 'coingecko', 'yahoo')
  quote_source          text,
  quote_symbol          text,
  units                 numeric(28, 10) not null default 0 check (units >= 0),
  avg_price             numeric(20, 8) check (avg_price is null or avg_price >= 0),
  invested_cents        bigint not null default 0 check (invested_cents >= 0),
  current_value_cents   bigint check (current_value_cents is null or current_value_cents >= 0),
  value_updated_at      timestamptz,
  acquired_on           date,
  notes                 text check (char_length(notes) <= 2000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index investments_household_idx on public.investments (household_id);

create table public.investment_transactions (
  id               uuid primary key default gen_random_uuid(),
  investment_id    uuid not null references public.investments (id) on delete cascade,
  household_id     uuid not null references public.households (id) on delete cascade,
  created_by       uuid not null references auth.users (id),
  type             public.investment_tx_type not null,
  occurred_on      date not null,
  units            numeric(28, 10),
  unit_price       numeric(20, 8),
  amount_cents     bigint not null check (amount_cents >= 0),
  fee_cents        bigint not null default 0 check (fee_cents >= 0),
  -- movimiento de caja asociado (type 'investment'), para no duplicar
  transaction_id   uuid unique references public.transactions (id) on delete set null,
  notes            text check (char_length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index investment_tx_investment_idx on public.investment_transactions (investment_id, occurred_on);

-- -----------------------------------------------------------------------------
-- budgets (Fase 2)
-- -----------------------------------------------------------------------------
create table public.budgets (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  owner_id       uuid not null references auth.users (id),
  visibility     public.visibility not null default 'shared',
  name           text not null check (char_length(name) between 1 and 80),
  period         public.budget_period not null default 'monthly',
  category_id    uuid references public.categories (id) on delete cascade,
  trip_id        uuid references public.trips (id) on delete cascade,
  amount_cents   bigint not null check (amount_cents > 0),
  start_date     date not null,
  end_date       date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint budgets_dates check (end_date is null or end_date >= start_date)
);
create index budgets_household_idx on public.budgets (household_id);

-- -----------------------------------------------------------------------------
-- savings_goals (Fase 2)
-- -----------------------------------------------------------------------------
create table public.savings_goals (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  owner_id       uuid not null references auth.users (id),
  visibility     public.visibility not null default 'shared',
  name           text not null check (char_length(name) between 1 and 80),
  goal_type      public.goal_type not null default 'other',
  target_cents   bigint not null check (target_cents > 0),
  saved_cents    bigint not null default 0 check (saved_cents >= 0),
  account_id     uuid references public.accounts (id) on delete set null,
  target_date    date,
  is_achieved    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index savings_goals_household_idx on public.savings_goals (household_id);

-- -----------------------------------------------------------------------------
-- Triggers updated_at
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','households','accounts','categories','trips','recurring_transactions',
    'transactions','investments','investment_transactions','budgets','savings_goals'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.tg_set_updated_at()', t);
  end loop;
end $$;
