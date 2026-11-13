-- OURFINANCE · setup completo (generado por build_setup.sh, no editar a mano)
-- Pegar entero en Supabase → SQL Editor → Run, en un proyecto vacío.

-- >>> migrations/20261113000001_schema.sql
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

-- >>> migrations/20261113000002_security.sql
-- =============================================================================
-- OURFINANCE · 0002 · Seguridad: funciones auxiliares, integridad y RLS
-- -----------------------------------------------------------------------------
-- Modelo de acceso:
--   * Un usuario solo ve filas de los households a los que pertenece.
--   * Dentro del household, una fila 'personal' solo la ve su propietario;
--     una fila 'shared' la ven y gestionan todos los miembros.
--   * Anon (no autenticado) no tiene acceso a ninguna tabla.
--   * Las validaciones entre tablas (cuentas, categorías, pagador) se hacen en
--     triggers SECURITY DEFINER para que no dependan del frontend.
-- =============================================================================

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Funciones auxiliares (SECURITY DEFINER para evitar recursión de RLS)
-- ---------------------------------------------------------------------------
create or replace function private.is_member(p_household uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = p_household and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_household_owner(p_household uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = p_household
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

-- ¿Puede el usuario actual ver/gestionar una fila con esta visibilidad y propietario?
create or replace function private.can_access(p_household uuid, p_visibility public.visibility, p_owner uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.is_member(p_household)
     and (p_visibility = 'shared' or p_owner = (select auth.uid()));
$$;

create or replace function private.shares_household_with(p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members a
    join public.household_members b on b.household_id = a.household_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  );
$$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Perfil automático al registrarse
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Propietario automático e inmutable
-- ---------------------------------------------------------------------------
-- Fija created_by/owner_id al usuario autenticado en INSERT y lo bloquea en UPDATE.
create or replace function private.tg_owner_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text := tg_argv[0];
  uid uuid := auth.uid();
  new_j jsonb := to_jsonb(new);
  old_j jsonb;
begin
  if tg_op = 'INSERT' then
    if uid is not null then
      new := jsonb_populate_record(new, jsonb_build_object(col, uid));
    end if;
  else
    old_j := to_jsonb(old);
    if new_j ->> col is distinct from old_j ->> col then
      raise exception 'No se puede cambiar el propietario (%)', col using errcode = '42501';
    end if;
    if (new_j ? 'household_id') and new_j ->> 'household_id' is distinct from old_j ->> 'household_id' then
      raise exception 'No se puede mover un registro a otro espacio' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger owner_guard before insert or update on public.accounts
  for each row execute function private.tg_owner_guard('owner_id');
create trigger owner_guard before insert or update on public.transactions
  for each row execute function private.tg_owner_guard('created_by');
create trigger owner_guard before insert or update on public.trips
  for each row execute function private.tg_owner_guard('created_by');
create trigger owner_guard before insert or update on public.recurring_transactions
  for each row execute function private.tg_owner_guard('created_by');
create trigger owner_guard before insert or update on public.investments
  for each row execute function private.tg_owner_guard('owner_id');
create trigger owner_guard before insert or update on public.investment_transactions
  for each row execute function private.tg_owner_guard('created_by');
create trigger owner_guard before insert or update on public.budgets
  for each row execute function private.tg_owner_guard('owner_id');
create trigger owner_guard before insert or update on public.savings_goals
  for each row execute function private.tg_owner_guard('owner_id');
create trigger owner_guard before insert or update on public.attachments
  for each row execute function private.tg_owner_guard('uploaded_by');
create trigger owner_guard before insert or update on public.trip_expenses
  for each row execute function private.tg_owner_guard('created_by');

-- ---------------------------------------------------------------------------
-- Integridad de cuentas
-- ---------------------------------------------------------------------------
create or replace function private.tg_accounts_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.visibility <> old.visibility then
    if exists (select 1 from public.transactions t
               where t.account_id = new.id or t.to_account_id = new.id) then
      raise exception 'No se puede cambiar la visibilidad de una cuenta con movimientos'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger accounts_validate before update on public.accounts
  for each row execute function private.tg_accounts_validate();

-- ---------------------------------------------------------------------------
-- Integridad de categorías (máximo 2 niveles, mismo espacio y tipo)
-- ---------------------------------------------------------------------------
create or replace function private.tg_categories_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare p public.categories;
begin
  if new.parent_id is not null then
    select * into p from public.categories where id = new.parent_id;
    if p.id is null or p.household_id <> new.household_id then
      raise exception 'Categoría padre no válida' using errcode = '23514';
    end if;
    if p.parent_id is not null then
      raise exception 'Solo se permiten dos niveles de categorías' using errcode = '23514';
    end if;
    new.kind := p.kind;
    new.group_key := p.group_key;
  end if;
  return new;
end;
$$;

create trigger categories_validate before insert or update on public.categories
  for each row execute function private.tg_categories_validate();

-- ---------------------------------------------------------------------------
-- Integridad de movimientos
--   * Las cuentas deben ser del mismo espacio.
--   * Una cuenta personal solo la puede usar su propietario (created_by).
--   * Un movimiento que toca una cuenta compartida es obligatoriamente 'shared'
--     (si no, el saldo de la cuenta común sería distinto para cada miembro).
--   * Las aportaciones van siempre a una cuenta compartida.
--   * La categoría debe ser del espacio y del tipo correcto; la subcategoría hija.
--   * paid_by debe ser miembro; en movimientos personales es el propio usuario.
-- ---------------------------------------------------------------------------
create or replace function private.tg_transactions_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  cat public.categories;
  sub public.categories;
  acc_id uuid;
begin
  new.paid_by := coalesce(new.paid_by, new.created_by);
  new.description := trim(new.description);
  new.tags := coalesce(
    (select array_agg(distinct lower(trim(t))) from unnest(new.tags) t where trim(t) <> ''),
    '{}');

  if not exists (select 1 from public.household_members m
                 where m.household_id = new.household_id and m.user_id = new.paid_by) then
    raise exception 'El pagador debe ser miembro del espacio' using errcode = '23514';
  end if;

  if new.visibility = 'personal' and new.paid_by <> new.created_by then
    raise exception 'Un movimiento personal solo puede pagarlo su propietario' using errcode = '23514';
  end if;

  foreach acc_id in array array[new.account_id, new.to_account_id] loop
    continue when acc_id is null;
    select * into acc from public.accounts where id = acc_id;
    if acc.id is null or acc.household_id <> new.household_id then
      raise exception 'Cuenta no válida para este espacio' using errcode = '23514';
    end if;
    if acc.visibility = 'personal' and acc.owner_id <> new.created_by then
      raise exception 'No puedes usar la cuenta personal de otro miembro' using errcode = '42501';
    end if;
    if acc.visibility = 'shared' and new.visibility <> 'shared' then
      raise exception 'Los movimientos de una cuenta compartida deben ser compartidos' using errcode = '23514';
    end if;
  end loop;

  if new.type = 'contribution' then
    select * into acc from public.accounts where id = new.to_account_id;
    if acc.visibility <> 'shared' then
      raise exception 'Las aportaciones deben ir a una cuenta compartida' using errcode = '23514';
    end if;
  end if;

  if new.category_id is not null then
    select * into cat from public.categories where id = new.category_id;
    if cat.id is null or cat.household_id <> new.household_id or cat.parent_id is not null then
      raise exception 'Categoría no válida' using errcode = '23514';
    end if;
    if (new.type = 'income' and cat.kind <> 'income')
       or (new.type in ('expense', 'refund') and cat.kind <> 'expense') then
      raise exception 'La categoría no corresponde al tipo de movimiento' using errcode = '23514';
    end if;
  end if;

  if new.subcategory_id is not null then
    select * into sub from public.categories where id = new.subcategory_id;
    if sub.id is null or new.category_id is null or sub.parent_id <> new.category_id then
      raise exception 'Subcategoría no válida' using errcode = '23514';
    end if;
  end if;

  if new.trip_id is not null and not exists (
    select 1 from public.trips tr where tr.id = new.trip_id and tr.household_id = new.household_id) then
    raise exception 'Viaje no válido' using errcode = '23514';
  end if;

  return new;
end;
$$;

-- se ejecuta después de owner_guard (orden alfabético de triggers)
create trigger tx_validate before insert or update on public.transactions
  for each row execute function private.tg_transactions_validate();

-- Coherencia de household en tablas hijas
create or replace function private.tg_child_household()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'attachments' then
    if not exists (select 1 from public.transactions t
                   where t.id = new.transaction_id and t.household_id = new.household_id) then
      raise exception 'Justificante no válido' using errcode = '23514';
    end if;
    if split_part(new.storage_path, '/', 1) <> new.household_id::text
       or split_part(new.storage_path, '/', 2) <> new.uploaded_by::text then
      raise exception 'Ruta de fichero no válida' using errcode = '23514';
    end if;
  elsif tg_table_name = 'investment_transactions' then
    if not exists (select 1 from public.investments i
                   where i.id = new.investment_id and i.household_id = new.household_id) then
      raise exception 'Inversión no válida' using errcode = '23514';
    end if;
  elsif tg_table_name = 'trip_expenses' then
    if not exists (select 1 from public.trips tr join public.transactions t on t.household_id = tr.household_id
                   where tr.id = new.trip_id and t.id = new.transaction_id) then
      raise exception 'Gasto de viaje no válido' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger child_household before insert or update on public.attachments
  for each row execute function private.tg_child_household();
create trigger child_household before insert or update on public.investment_transactions
  for each row execute function private.tg_child_household();
create trigger child_household before insert or update on public.trip_expenses
  for each row execute function private.tg_child_household();

-- ---------------------------------------------------------------------------
-- Privilegios: anon sin acceso; authenticated pasa siempre por RLS
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles                enable row level security;
alter table public.households              enable row level security;
alter table public.household_members       enable row level security;
alter table public.household_invitations   enable row level security;
alter table public.accounts                enable row level security;
alter table public.categories              enable row level security;
alter table public.transactions            enable row level security;
alter table public.attachments             enable row level security;
alter table public.recurring_transactions  enable row level security;
alter table public.trips                   enable row level security;
alter table public.trip_participants       enable row level security;
alter table public.trip_expenses           enable row level security;
alter table public.investments             enable row level security;
alter table public.investment_transactions enable row level security;
alter table public.budgets                 enable row level security;
alter table public.savings_goals           enable row level security;

-- profiles ---------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_household_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- households (alta mediante RPC create_household) ------------------------
create policy households_select on public.households for select to authenticated
  using (private.is_member(id));
create policy households_update on public.households for update to authenticated
  using (private.is_household_owner(id)) with check (private.is_household_owner(id));
create policy households_delete on public.households for delete to authenticated
  using (private.is_household_owner(id));

-- household_members (alta mediante RPC accept_invitation) ----------------
create policy members_select on public.household_members for select to authenticated
  using (private.is_member(household_id));
create policy members_delete on public.household_members for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_household_owner(household_id));

-- household_invitations (alta mediante RPC create_invitation) ------------
create policy invitations_select on public.household_invitations for select to authenticated
  using (private.is_member(household_id));
create policy invitations_delete on public.household_invitations for delete to authenticated
  using (private.is_member(household_id));

-- accounts ---------------------------------------------------------------
create policy accounts_select on public.accounts for select to authenticated
  using (private.can_access(household_id, visibility, owner_id));
create policy accounts_insert on public.accounts for insert to authenticated
  with check (owner_id = (select auth.uid()) and private.is_member(household_id));
create policy accounts_update on public.accounts for update to authenticated
  using (private.can_access(household_id, visibility, owner_id))
  with check (private.can_access(household_id, visibility, owner_id));
create policy accounts_delete on public.accounts for delete to authenticated
  using (private.can_access(household_id, visibility, owner_id));

-- categories (metadatos comunes del espacio) -----------------------------
create policy categories_select on public.categories for select to authenticated
  using (private.is_member(household_id));
create policy categories_insert on public.categories for insert to authenticated
  with check (private.is_member(household_id) and not is_system);
create policy categories_update on public.categories for update to authenticated
  using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy categories_delete on public.categories for delete to authenticated
  using (private.is_member(household_id) and not is_system);

-- transactions -----------------------------------------------------------
create policy transactions_select on public.transactions for select to authenticated
  using (private.can_access(household_id, visibility, created_by));
create policy transactions_insert on public.transactions for insert to authenticated
  with check (created_by = (select auth.uid()) and private.is_member(household_id));
create policy transactions_update on public.transactions for update to authenticated
  using (private.can_access(household_id, visibility, created_by))
  with check (private.can_access(household_id, visibility, created_by));
create policy transactions_delete on public.transactions for delete to authenticated
  using (private.can_access(household_id, visibility, created_by));

-- attachments: heredan la visibilidad del movimiento ----------------------
create policy attachments_select on public.attachments for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));
create policy attachments_insert on public.attachments for insert to authenticated
  with check (uploaded_by = (select auth.uid())
              and exists (select 1 from public.transactions t where t.id = transaction_id));
create policy attachments_delete on public.attachments for delete to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));

-- Tablas con (household_id, visibility, propietario) ----------------------
do $$
declare
  r record;
begin
  for r in select * from (values
      ('recurring_transactions', 'created_by'),
      ('trips',                  'created_by'),
      ('investments',            'owner_id'),
      ('budgets',                'owner_id'),
      ('savings_goals',          'owner_id')
    ) as v(tbl, owner_col)
  loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (private.can_access(household_id, visibility, %2$I));
      create policy %1$s_insert on public.%1$I for insert to authenticated
        with check (%2$I = (select auth.uid()) and private.is_member(household_id));
      create policy %1$s_update on public.%1$I for update to authenticated
        using (private.can_access(household_id, visibility, %2$I))
        with check (private.can_access(household_id, visibility, %2$I));
      create policy %1$s_delete on public.%1$I for delete to authenticated
        using (private.can_access(household_id, visibility, %2$I));
    $f$, r.tbl, r.owner_col);
  end loop;
end $$;

-- trip_participants / trip_expenses: heredan del viaje (y del movimiento) --
create policy trip_participants_all on public.trip_participants for all to authenticated
  using (exists (select 1 from public.trips tr where tr.id = trip_id))
  with check (exists (select 1 from public.trips tr where tr.id = trip_id)
              and private.shares_household_with(user_id));

create policy trip_expenses_all on public.trip_expenses for all to authenticated
  using (exists (select 1 from public.trips tr where tr.id = trip_id)
         and exists (select 1 from public.transactions t where t.id = transaction_id))
  with check (exists (select 1 from public.trips tr where tr.id = trip_id)
              and exists (select 1 from public.transactions t where t.id = transaction_id));

-- investment_transactions: heredan de la inversión -------------------------
create policy investment_tx_all on public.investment_transactions for all to authenticated
  using (exists (select 1 from public.investments i where i.id = investment_id))
  with check (exists (select 1 from public.investments i where i.id = investment_id));

-- >>> migrations/20261113000003_functions.sql
-- =============================================================================
-- OURFINANCE · 0003 · RPC: espacio compartido, invitaciones y analítica
-- -----------------------------------------------------------------------------
-- Reglas contables (aplicadas en todas las funciones de analítica):
--   * Gasto        = movimientos 'expense' − 'refund'.
--   * Ingreso      = movimientos 'income'.
--   * 'transfer', 'contribution' e 'investment' NO son ni ingreso ni gasto:
--     solo mueven dinero entre cuentas. Así la aportación a la cuenta común y el
--     gasto pagado desde ella no se cuentan dos veces.
--   * Ahorro       = Ingreso − Gasto.
--   * Las funciones de analítica son SECURITY INVOKER: la RLS se aplica, de modo
--     que cada usuario solo agrega lo que puede ver.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Categorías por defecto
-- ---------------------------------------------------------------------------
create or replace function private.seed_default_categories(p_household uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  g record;
  parent uuid;
  child text;
  i int;
begin
  for g in select * from (values
    (1, 'expense', 'Vivienda',     'housing',   'home',          '#0f766e', array['Hipoteca o alquiler','Comunidad','Electricidad','Agua','Gas','Internet','Seguros','Mantenimiento','Reparaciones','Mobiliario','Electrodomésticos','Impuestos','Otros gastos del hogar']),
    (2, 'expense', 'Alimentación', 'food',      'utensils',      '#ea580c', array['Supermercado','Restaurantes','Bares','Cafeterías','Comida a domicilio','Comidas de trabajo','Otros gastos de alimentación']),
    (3, 'expense', 'Personal',     'personal',  'shopping-bag',  '#7c3aed', array['Compras personales','Ropa','Suscripciones','Ocio','Gimnasio','Tecnología','Otros gastos']),
    (4, 'expense', 'Transporte',   'transport', 'car',           '#2563eb', array['Gasolina','Transporte público','Parking y peajes','Mantenimiento del vehículo','Taxi y VTC']),
    (5, 'expense', 'Viajes',       'travel',    'plane',         '#0891b2', array['Vuelos','Hoteles','Alquiler de vehículos','Actividades','Otros gastos de viaje']),
    (6, 'expense', 'Salud',        'health',    'heart-pulse',   '#db2777', array['Farmacia','Médico','Seguro médico']),
    (7, 'expense', 'Otros',        'other',     'circle',        '#64748b', array['Regalos','Educación','Mascotas','Varios']),
    (8, 'income',  'Ingresos',     'income',    'wallet',        '#16a34a', array['Nómina','Freelance','Intereses y dividendos','Regalos recibidos','Otros ingresos'])
  ) as v(ord, kind, name, group_key, icon, color, children)
  loop
    insert into public.categories (household_id, kind, name, group_key, icon, color, sort_order, is_system)
    values (p_household, g.kind::public.category_kind, g.name, g.group_key, g.icon, g.color, g.ord, true)
    returning id into parent;

    i := 0;
    foreach child in array g.children loop
      i := i + 1;
      insert into public.categories (household_id, parent_id, kind, name, group_key, icon, color, sort_order, is_system)
      values (p_household, parent, g.kind::public.category_kind, child, g.group_key, g.icon, g.color, i, true);
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_household: crea el espacio, el miembro propietario, la cuenta común
-- y las categorías por defecto.
-- ---------------------------------------------------------------------------
create or replace function public.create_household(p_name text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  hid uuid;
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;
  if exists (select 1 from public.household_members where user_id = uid) then
    raise exception 'Ya perteneces a un espacio compartido' using errcode = '23505';
  end if;

  insert into public.households (name, created_by)
  values (coalesce(nullif(trim(p_name), ''), 'Nuestro espacio'), uid)
  returning id into hid;

  insert into public.household_members (household_id, user_id, role) values (hid, uid, 'owner');

  insert into public.accounts (household_id, owner_id, visibility, kind, name, color)
  values (hid, uid, 'shared', 'common', 'Cuenta común', '#0f766e');

  perform private.seed_default_categories(hid);
  return hid;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_invitation: devuelve el token en claro UNA sola vez (se guarda el hash)
-- ---------------------------------------------------------------------------
create or replace function public.create_invitation(p_household uuid, p_email text default null)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  token text;
  members int;
  pending int;
  cap int;
begin
  if not private.is_member(p_household) then
    raise exception 'No perteneces a este espacio' using errcode = '42501';
  end if;

  select count(*) into members from public.household_members where household_id = p_household;
  select count(*) into pending from public.household_invitations
   where household_id = p_household and accepted_at is null and revoked_at is null and expires_at > now();
  select max_members into cap from public.households where id = p_household;
  if members + pending >= cap then
    raise exception 'El espacio ya está completo o tiene una invitación pendiente' using errcode = '23514';
  end if;

  token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.household_invitations (household_id, email, token_hash, invited_by)
  values (p_household, nullif(lower(trim(p_email)), ''), encode(extensions.digest(token, 'sha256'), 'hex'), uid);
  return token;
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invitation
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv public.household_invitations;
  my_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  members int;
  cap int;
begin
  if uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  select * into inv from public.household_invitations
   where token_hash = encode(extensions.digest(trim(p_token), 'sha256'), 'hex')
   for update;

  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at <= now() then
    raise exception 'Invitación no válida o caducada' using errcode = 'P0002';
  end if;
  if inv.email is not null and inv.email <> my_email then
    raise exception 'Esta invitación es para otro correo electrónico' using errcode = '42501';
  end if;
  if exists (select 1 from public.household_members where user_id = uid) then
    raise exception 'Ya perteneces a un espacio compartido' using errcode = '23505';
  end if;

  select count(*) into members from public.household_members where household_id = inv.household_id;
  select max_members into cap from public.households where id = inv.household_id;
  if members >= cap then
    raise exception 'El espacio está completo' using errcode = '23514';
  end if;

  insert into public.household_members (household_id, user_id, role) values (inv.household_id, uid, 'member');
  update public.household_invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.household_id;
end;
$$;

create or replace function public.revoke_invitation(p_invitation uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.household_invitations i set revoked_at = now()
   where i.id = p_invitation and i.accepted_at is null and private.is_member(i.household_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Analítica (SECURITY INVOKER: respeta RLS)
-- ---------------------------------------------------------------------------

-- Efecto de un movimiento sobre una cuenta concreta (en céntimos, con signo)
create or replace function public.tx_effect_on_account(
  p_type public.transaction_type, p_amount bigint, p_from uuid, p_to uuid, p_account uuid)
returns bigint
language sql immutable
set search_path = ''
as $$
  select case
    when p_type in ('income', 'refund') and p_from = p_account then p_amount
    when p_type = 'expense' and p_from = p_account then -p_amount
    when p_type in ('transfer', 'contribution', 'investment') then
      (case when p_to = p_account then p_amount else 0 end)
      - (case when p_from = p_account then p_amount else 0 end)
    else 0
  end;
$$;

-- Saldo de cada cuenta visible a una fecha (incluida)
create or replace function public.account_balances(p_household uuid, p_at date default null)
returns table (account_id uuid, balance_cents bigint)
language sql stable
set search_path = ''
as $$
  select a.id,
         a.opening_balance_cents + coalesce(sum(
           public.tx_effect_on_account(t.type, t.amount_cents, t.account_id, t.to_account_id, a.id)
         ), 0)::bigint
  from public.accounts a
  left join public.transactions t
    on (t.account_id = a.id or t.to_account_id = a.id)
   and (p_at is null or t.occurred_on <= p_at)
  where a.household_id = p_household
  group by a.id, a.opening_balance_cents;
$$;

-- Resumen de un periodo
create or replace function public.period_summary(p_household uuid, p_from date, p_to date)
returns table (
  income_cents bigint,
  expense_cents bigint,          -- gasto neto (gastos − reembolsos)
  personal_expense_cents bigint,
  shared_expense_cents bigint,
  refund_cents bigint,
  contribution_cents bigint,
  savings_cents bigint,
  tx_count bigint
)
language sql stable
set search_path = ''
as $$
  with t as (
    select * from public.transactions
    where household_id = p_household and occurred_on between p_from and p_to
  ), s as (
    select
      coalesce(sum(amount_cents) filter (where type = 'income'), 0) as inc,
      coalesce(sum(amount_cents) filter (where type = 'expense'), 0) as exp,
      coalesce(sum(amount_cents) filter (where type = 'refund'), 0) as ref,
      coalesce(sum(amount_cents) filter (where type = 'expense' and visibility = 'personal'), 0)
        - coalesce(sum(amount_cents) filter (where type = 'refund' and visibility = 'personal'), 0) as pexp,
      coalesce(sum(amount_cents) filter (where type = 'expense' and visibility = 'shared'), 0)
        - coalesce(sum(amount_cents) filter (where type = 'refund' and visibility = 'shared'), 0) as sexp,
      coalesce(sum(amount_cents) filter (where type = 'contribution'), 0) as con,
      count(*) as n
    from t
  )
  select inc::bigint, (exp - ref)::bigint, pexp::bigint, sexp::bigint, ref::bigint, con::bigint,
         (inc - (exp - ref))::bigint, n
  from s;
$$;

-- Serie mensual de ingresos / gastos / ahorro / aportaciones
create or replace function public.monthly_flows(
  p_household uuid, p_from date, p_to date,
  p_category uuid default null, p_visibility public.visibility default null)
returns table (
  month date,
  income_cents bigint,
  expense_cents bigint,
  personal_expense_cents bigint,
  shared_expense_cents bigint,
  contribution_cents bigint,
  savings_cents bigint
)
language sql stable
set search_path = ''
as $$
  with months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as m
  ), t as (
    select date_trunc('month', occurred_on)::date as m, type, visibility, amount_cents
    from public.transactions
    where household_id = p_household and occurred_on between p_from and p_to
      and (p_category is null or category_id = p_category or subcategory_id = p_category)
      and (p_visibility is null or visibility = p_visibility)
  )
  select months.m,
    coalesce(sum(t.amount_cents) filter (where t.type = 'income'), 0)::bigint,
    (coalesce(sum(t.amount_cents) filter (where t.type = 'expense'), 0)
      - coalesce(sum(t.amount_cents) filter (where t.type = 'refund'), 0))::bigint,
    (coalesce(sum(t.amount_cents) filter (where t.type = 'expense' and t.visibility = 'personal'), 0)
      - coalesce(sum(t.amount_cents) filter (where t.type = 'refund' and t.visibility = 'personal'), 0))::bigint,
    (coalesce(sum(t.amount_cents) filter (where t.type = 'expense' and t.visibility = 'shared'), 0)
      - coalesce(sum(t.amount_cents) filter (where t.type = 'refund' and t.visibility = 'shared'), 0))::bigint,
    coalesce(sum(t.amount_cents) filter (where t.type = 'contribution'), 0)::bigint,
    (coalesce(sum(t.amount_cents) filter (where t.type = 'income'), 0)
      - coalesce(sum(t.amount_cents) filter (where t.type = 'expense'), 0)
      + coalesce(sum(t.amount_cents) filter (where t.type = 'refund'), 0))::bigint
  from months left join t on t.m = months.m
  group by months.m
  order by months.m;
$$;

-- Gasto neto por categoría principal (opcionalmente filtrado por visibilidad)
create or replace function public.category_breakdown(
  p_household uuid, p_from date, p_to date, p_visibility public.visibility default null,
  p_parent uuid default null)
returns table (category_id uuid, name text, color text, group_key text, expense_cents bigint)
language sql stable
set search_path = ''
as $$
  -- sin p_parent: agrupa por categoría principal; con p_parent: por subcategoría
  select c.id, coalesce(c.name, case when p_parent is null then 'Sin categoría' else 'Sin subcategoría' end),
         coalesce(c.color, '#94a3b8'), coalesce(c.group_key, 'other'),
         sum(case when t.type = 'expense' then t.amount_cents else -t.amount_cents end)::bigint as total
  from public.transactions t
  left join public.categories c on c.id = case when p_parent is null then t.category_id else t.subcategory_id end
  where t.household_id = p_household
    and (p_parent is null or t.category_id = p_parent)
    and t.occurred_on between p_from and p_to
    and t.type in ('expense', 'refund')
    and (p_visibility is null or t.visibility = p_visibility)
  group by c.id, c.name, c.color, c.group_key
  having sum(case when t.type = 'expense' then t.amount_cents else -t.amount_cents end) <> 0
  order by total desc;
$$;

-- Aportaciones a cuentas compartidas por miembro y mes
create or replace function public.contributions_by_member(p_household uuid, p_from date, p_to date)
returns table (month date, user_id uuid, contribution_cents bigint)
language sql stable
set search_path = ''
as $$
  select date_trunc('month', t.occurred_on)::date, t.paid_by, sum(t.amount_cents)::bigint
  from public.transactions t
  where t.household_id = p_household
    and t.type = 'contribution'
    and t.occurred_on between p_from and p_to
  group by 1, 2
  order by 1, 2;
$$;

-- Patrimonio (suma de saldos visibles) al final de cada mes
create or replace function public.net_worth_series(p_household uuid, p_from date, p_to date)
returns table (month date, net_worth_cents bigint)
language sql stable
set search_path = ''
as $$
  with months as (
    select (date_trunc('month', d) + interval '1 month - 1 day')::date as month_end
    from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') d
  )
  select date_trunc('month', m.month_end)::date,
         coalesce((select sum(b.balance_cents) from public.account_balances(p_household, m.month_end) b), 0)::bigint
  from months m
  order by 1;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function
  public.create_household(text),
  public.create_invitation(uuid, text),
  public.accept_invitation(text),
  public.revoke_invitation(uuid),
  public.account_balances(uuid, date),
  public.period_summary(uuid, date, date),
  public.monthly_flows(uuid, date, date, uuid, public.visibility),
  public.category_breakdown(uuid, date, date, public.visibility, uuid),
  public.contributions_by_member(uuid, date, date),
  public.net_worth_series(uuid, date, date)
from public, anon;

grant execute on function
  public.create_household(text),
  public.create_invitation(uuid, text),
  public.accept_invitation(text),
  public.revoke_invitation(uuid),
  public.account_balances(uuid, date),
  public.period_summary(uuid, date, date),
  public.monthly_flows(uuid, date, date, uuid, public.visibility),
  public.category_breakdown(uuid, date, date, public.visibility, uuid),
  public.contributions_by_member(uuid, date, date),
  public.net_worth_series(uuid, date, date)
to authenticated;

revoke all on function private.seed_default_categories(uuid) from public, anon, authenticated;

-- >>> migrations/20261113000004_storage.sql
-- =============================================================================
-- OURFINANCE · 0004 · Storage para justificantes
-- Bucket privado 'attachments'. Ruta: {household_id}/{user_id}/{fichero}
--   * Subir: solo en tu carpeta y en un espacio al que perteneces.
--   * Leer: tus propios ficheros, o los asociados a un movimiento que puedes ver
--     (la consulta a public.attachments aplica su RLS).
--   * Borrar: solo tus propios ficheros.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy attachments_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and private.is_member(((storage.foldername(name))[1])::uuid)
  );

create policy attachments_read on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or exists (select 1 from public.attachments a where a.storage_path = name)
    )
  );

create policy attachments_remove on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- >>> migrations/20261113000005_balance_opening_date.sql
-- =============================================================================
-- OURFINANCE · 0005 · El saldo inicial solo cuenta a partir de su fecha
-- Corrige la evolución del patrimonio: antes de opening_date la cuenta no existía.
-- =============================================================================
create or replace function public.account_balances(p_household uuid, p_at date default null)
returns table (account_id uuid, balance_cents bigint)
language sql stable
set search_path = ''
as $$
  select a.id,
         (case when p_at is null or a.opening_date <= p_at then a.opening_balance_cents else 0 end
          + coalesce(sum(
              public.tx_effect_on_account(t.type, t.amount_cents, t.account_id, t.to_account_id, a.id)
            ), 0))::bigint
  from public.accounts a
  left join public.transactions t
    on (t.account_id = a.id or t.to_account_id = a.id)
   and (p_at is null or t.occurred_on <= p_at)
  where a.household_id = p_household
  group by a.id, a.opening_balance_cents, a.opening_date;
$$;

-- >>> migrations/20261113000006_phase2.sql
-- =============================================================================
-- OURFINANCE · 0006 · Fase 2: recurrentes, viajes y presupuestos
-- Se puede ejecutar más de una vez (create or replace / if not exists).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Recurrentes: un mismo recurrente no puede generar dos movimientos el mismo día
-- ---------------------------------------------------------------------------
create unique index if not exists transactions_recurring_once
  on public.transactions (recurring_id, occurred_on)
  where recurring_id is not null;

-- Siguiente fecha según la periodicidad (conserva el día; ajusta a fin de mes)
create or replace function public.next_occurrence(p_date date, p_freq public.recurrence_frequency)
returns date
language sql immutable
set search_path = ''
as $$
  select (p_date + case p_freq
            when 'monthly'   then interval '1 month'
            when 'quarterly' then interval '3 months'
            when 'yearly'    then interval '1 year'
          end)::date;
$$;

-- Coste mensual equivalente de un recurrente (en céntimos)
create or replace function public.monthly_equivalent(p_amount bigint, p_freq public.recurrence_frequency)
returns bigint
language sql immutable
set search_path = ''
as $$
  select round(p_amount / case p_freq when 'monthly' then 1 when 'quarterly' then 3 else 12 end::numeric)::bigint;
$$;

-- Registra la cuota pendiente de un recurrente y avanza su próxima fecha.
-- SECURITY INVOKER: la RLS y los triggers de movimientos se aplican igual que en un alta manual.
create or replace function public.register_recurring(p_recurring uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  r public.recurring_transactions;
  tx_id uuid;
begin
  select * into r from public.recurring_transactions where id = p_recurring for update;
  if r.id is null then
    raise exception 'Recurrente no encontrado' using errcode = 'P0002';
  end if;
  if not r.is_active then
    raise exception 'El recurrente está pausado' using errcode = '23514';
  end if;
  if r.end_on is not null and r.next_due_on > r.end_on then
    raise exception 'El recurrente ya ha finalizado' using errcode = '23514';
  end if;

  insert into public.transactions (
    household_id, type, visibility, amount_cents, occurred_on, description,
    category_id, subcategory_id, account_id, to_account_id, notes, recurring_id
  ) values (
    r.household_id, r.type, r.visibility, r.amount_cents, r.next_due_on, r.description,
    r.category_id, r.subcategory_id, r.account_id, r.to_account_id, r.notes, r.id
  )
  returning id into tx_id;

  update public.recurring_transactions
     set next_due_on = public.next_occurrence(r.next_due_on, r.frequency),
         is_active = case when r.end_on is not null
                           and public.next_occurrence(r.next_due_on, r.frequency) > r.end_on
                          then false else is_active end
   where id = r.id;

  return tx_id;
end;
$$;

-- Plantillas: las cuentas siguen las mismas reglas que los movimientos
create or replace function private.tg_recurring_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  acc_id uuid;
begin
  foreach acc_id in array array[new.account_id, new.to_account_id] loop
    continue when acc_id is null;
    select * into acc from public.accounts where id = acc_id;
    if acc.id is null or acc.household_id <> new.household_id then
      raise exception 'Cuenta no válida para este espacio' using errcode = '23514';
    end if;
    if acc.visibility = 'personal' and acc.owner_id <> new.created_by then
      raise exception 'No puedes usar la cuenta personal de otro miembro' using errcode = '42501';
    end if;
    if acc.visibility = 'shared' and new.visibility <> 'shared' then
      raise exception 'Los recurrentes de una cuenta compartida deben ser compartidos' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists recurring_validate on public.recurring_transactions;
create trigger recurring_validate before insert or update on public.recurring_transactions
  for each row execute function private.tg_recurring_validate();

-- ---------------------------------------------------------------------------
-- Viajes: trip_expenses es el enlace; transactions.trip_id se mantiene sincronizado
-- ---------------------------------------------------------------------------
create or replace function private.tg_trip_expenses_sync()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  tr public.trips;
  tx public.transactions;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select * into tr from public.trips where id = new.trip_id;
    select * into tx from public.transactions where id = new.transaction_id;
    if tx.type not in ('expense', 'refund') then
      raise exception 'Solo se pueden asignar gastos y reembolsos a un viaje' using errcode = '23514';
    end if;
    -- en un viaje compartido, todos sus gastos son compartidos (mismo total para todos)
    if tr.visibility = 'shared' and tx.visibility <> 'shared' then
      raise exception 'Los gastos de un viaje compartido deben ser compartidos' using errcode = '23514';
    end if;
    if tr.visibility = 'personal' and tx.created_by <> tr.created_by then
      raise exception 'Viaje no válido' using errcode = '42501';
    end if;
    update public.transactions set trip_id = new.trip_id where id = new.transaction_id;
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    if tg_op = 'DELETE' or old.transaction_id <> new.transaction_id then
      update public.transactions set trip_id = null where id = old.transaction_id;
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trip_expenses_sync on public.trip_expenses;
create trigger trip_expenses_sync after insert or update or delete on public.trip_expenses
  for each row execute function private.tg_trip_expenses_sync();

-- Un movimiento enlazado a un viaje compartido no puede volverse personal
create or replace function private.tg_tx_trip_visibility()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.visibility = 'personal' and exists (
    select 1 from public.trip_expenses te join public.trips tr on tr.id = te.trip_id
    where te.transaction_id = new.id and tr.visibility = 'shared') then
    raise exception 'Este gasto pertenece a un viaje compartido y debe seguir siendo compartido' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists tx_trip_visibility on public.transactions;
create trigger tx_trip_visibility before update of visibility on public.transactions
  for each row execute function private.tg_tx_trip_visibility();

-- Resumen de viajes (SECURITY INVOKER: respeta RLS)
create or replace function public.trip_summaries(p_household uuid)
returns table (trip_id uuid, spent_cents bigint, expense_count bigint)
language sql stable
set search_path = ''
as $$
  select tr.id,
         coalesce(sum(case t.type when 'expense' then t.amount_cents when 'refund' then -t.amount_cents else 0 end), 0)::bigint,
         count(t.id)
  from public.trips tr
  left join public.trip_expenses te on te.trip_id = tr.id
  left join public.transactions t on t.id = te.transaction_id
  where tr.household_id = p_household
  group by tr.id;
$$;

-- ---------------------------------------------------------------------------
-- Presupuestos: consumo en el periodo vigente a una fecha
--   * personal  → tus gastos personales
--   * shared    → gastos compartidos
--   * con categoría → solo esa categoría (o subcategoría)
--   * con viaje → gastos del viaje (sin límite de fechas)
-- ---------------------------------------------------------------------------
create or replace function public.budget_progress(p_household uuid, p_on date)
returns table (budget_id uuid, period_from date, period_to date, spent_cents bigint)
language sql stable
set search_path = ''
as $$
  with b as (
    select bu.*,
      case
        when bu.trip_id is not null then null
        when bu.period = 'monthly' then date_trunc('month', p_on)::date
        when bu.period = 'yearly'  then date_trunc('year', p_on)::date
        else bu.start_date
      end as pf,
      case
        when bu.trip_id is not null then null
        when bu.period = 'monthly' then (date_trunc('month', p_on) + interval '1 month - 1 day')::date
        when bu.period = 'yearly'  then (date_trunc('year', p_on) + interval '1 year - 1 day')::date
        else coalesce(bu.end_date, p_on)
      end as pt
    from public.budgets bu
    where bu.household_id = p_household
  )
  select b.id, b.pf, b.pt,
    coalesce((
      select sum(case t.type when 'expense' then t.amount_cents else -t.amount_cents end)
      from public.transactions t
      where t.household_id = p_household
        and t.type in ('expense', 'refund')
        and (b.trip_id is null or t.trip_id = b.trip_id)
        and (b.pf is null or t.occurred_on between b.pf and b.pt)
        and (b.category_id is null or t.category_id = b.category_id or t.subcategory_id = b.category_id)
        and (b.trip_id is not null or t.visibility = b.visibility)
        and (b.visibility = 'shared' or t.created_by = b.owner_id)
    ), 0)::bigint
  from b;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
revoke all on function
  public.register_recurring(uuid),
  public.trip_summaries(uuid),
  public.budget_progress(uuid, date)
from public, anon;
grant execute on function
  public.register_recurring(uuid),
  public.trip_summaries(uuid),
  public.budget_progress(uuid, date),
  public.next_occurrence(date, public.recurrence_frequency),
  public.monthly_equivalent(bigint, public.recurrence_frequency)
to authenticated;
