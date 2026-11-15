-- =============================================================================
-- Etxea · 0010 · Cuentas de inversión con valor y rentabilidad
--   * Una cuenta de tipo «Inversión» funciona como una inversión sencilla:
--     lo que le transfieres es lo aportado, y con «Actualizar valor» apuntas
--     cuánto vale. Rentabilidad = valor − aportado neto.
--   * El patrimonio usa el valor de esas cuentas (no lo aportado).
--   * Los resúmenes por periodo y por mes devuelven también lo invertido:
--     el dinero que pasa de tus cuentas normales a inversiones (menos lo que
--     vuelve). Nunca cuenta como gasto.
-- Se puede ejecutar más de una vez.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Valoraciones de cuentas de inversión
-- ---------------------------------------------------------------------------
create table if not exists public.account_valuations (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  account_id   uuid not null references public.accounts (id) on delete cascade,
  created_by   uuid not null default auth.uid() references auth.users (id),
  valued_on    date not null,
  value_cents  bigint not null check (value_cents >= 0),
  notes        text check (char_length(notes) <= 2000),
  created_at   timestamptz not null default now(),
  unique (account_id, valued_on)
);
create index if not exists account_valuations_household_idx on public.account_valuations (household_id);

alter table public.account_valuations enable row level security;

-- Heredan de la cuenta: si ves la cuenta, ves y gestionas sus valoraciones
drop policy if exists account_valuations_all on public.account_valuations;
create policy account_valuations_all on public.account_valuations for all to authenticated
  using (exists (select 1 from public.accounts a where a.id = account_id))
  with check (exists (select 1 from public.accounts a where a.id = account_id));

create or replace function private.tg_account_valuations_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare acc public.accounts;
begin
  select * into acc from public.accounts where id = new.account_id;
  if acc.id is null then
    raise exception 'Cuenta no encontrada' using errcode = 'P0002';
  end if;
  if acc.kind <> 'investment' then
    raise exception 'Solo se puede actualizar el valor de una cuenta de inversión' using errcode = '23514';
  end if;
  new.household_id := acc.household_id;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists account_valuations_validate on public.account_valuations;
create trigger account_valuations_validate before insert or update on public.account_valuations
  for each row execute function private.tg_account_valuations_validate();

-- Apunta (o sustituye) el valor de una cuenta de inversión en una fecha
create or replace function public.set_account_valuation(
  p_account uuid, p_on date, p_value_cents bigint, p_notes text default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  if p_value_cents is null or p_value_cents < 0 then
    raise exception 'Valor no válido' using errcode = '23514';
  end if;
  if not exists (select 1 from public.accounts a where a.id = p_account) then
    raise exception 'Cuenta no encontrada' using errcode = 'P0002';
  end if;
  insert into public.account_valuations (household_id, account_id, valued_on, value_cents, notes)
  select a.household_id, a.id, p_on, p_value_cents, nullif(trim(p_notes), '')
  from public.accounts a where a.id = p_account
  on conflict (account_id, valued_on)
  do update set value_cents = excluded.value_cents, notes = excluded.notes
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Valor de cada cuenta a una fecha (SECURITY INVOKER: respeta RLS)
--   balance_cents: saldo por movimientos (en una cuenta de inversión, lo aportado neto)
--   value_cents:   última valoración + lo que haya entrado o salido después;
--                  sin valoración, igual al saldo
-- ---------------------------------------------------------------------------
create or replace function public.account_values(p_household uuid, p_at date default null)
returns table (account_id uuid, balance_cents bigint, value_cents bigint, valued_on date)
language sql stable
set search_path = ''
as $$
  with b as (
    select * from public.account_balances(p_household, p_at)
  ), lv as (
    select distinct on (v.account_id) v.account_id, v.valued_on, v.value_cents
    from public.account_valuations v
    where v.household_id = p_household and (p_at is null or v.valued_on <= p_at)
    order by v.account_id, v.valued_on desc, v.created_at desc
  )
  select b.account_id, b.balance_cents,
         case when lv.account_id is null then b.balance_cents
              else (lv.value_cents + coalesce((
                select sum(public.tx_effect_on_account(t.type, t.amount_cents, t.account_id, t.to_account_id, b.account_id))
                from public.transactions t
                where (t.account_id = b.account_id or t.to_account_id = b.account_id)
                  and t.occurred_on > lv.valued_on
                  and (p_at is null or t.occurred_on <= p_at)), 0))::bigint
         end,
         lv.valued_on
  from b left join lv on lv.account_id = b.account_id;
$$;

-- ---------------------------------------------------------------------------
-- Patrimonio: ahora con el valor de las cuentas de inversión
-- ---------------------------------------------------------------------------
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
         (coalesce((select sum(b.value_cents) from public.account_values(p_household, m.month_end) b), 0)
          + coalesce((select sum(p.value_cents) from public.investment_positions(p_household, m.month_end) p), 0))::bigint
  from months m
  order by 1;
$$;

create or replace function public.net_worth_breakdown(p_household uuid, p_at date default null)
returns table (source text, kind text, visibility public.visibility, value_cents bigint)
language sql stable
set search_path = ''
as $$
  select 'account', a.kind::text, a.visibility, sum(b.value_cents)::bigint
  from public.account_values(p_household, p_at) b
  join public.accounts a on a.id = b.account_id
  group by a.kind, a.visibility
  union all
  select 'investment', i.asset_type::text, i.visibility, sum(p.value_cents)::bigint
  from public.investment_positions(p_household, p_at) p
  join public.investments i on i.id = p.investment_id
  group by i.asset_type, i.visibility;
$$;

create or replace function private.personal_net_worth(p_household uuid, p_user uuid, p_at date)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select (coalesce((
            select sum(b.value_cents)
            from public.account_values(p_household, p_at) b
            join public.accounts a on a.id = b.account_id
            where a.visibility = 'personal' and a.owner_id = p_user), 0)
        + coalesce((
            select sum(p.value_cents)
            from public.investment_positions(p_household, p_at) p
            join public.investments i on i.id = p.investment_id
            where i.visibility = 'personal' and i.owner_id = p_user), 0))::bigint;
$$;

create or replace function private.shared_net_worth(p_household uuid, p_at date)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select (coalesce((
            select sum(b.value_cents)
            from public.account_values(p_household, p_at) b
            join public.accounts a on a.id = b.account_id
            where a.visibility = 'shared'), 0)
        + coalesce((
            select sum(p.value_cents)
            from public.investment_positions(p_household, p_at) p
            join public.investments i on i.id = p.investment_id
            where i.visibility = 'shared'), 0))::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Lo invertido en un movimiento: positivo si el dinero sale de una cuenta
-- normal hacia una cuenta de inversión o la cartera; negativo si vuelve.
-- Entre dos cuentas normales, o dentro de inversiones, es 0.
-- ---------------------------------------------------------------------------
create or replace function private.invested_effect(
  p_type public.transaction_type, p_amount bigint, p_from_kind public.account_kind, p_to_kind public.account_kind,
  p_has_from boolean, p_has_to boolean)
returns bigint
language sql immutable
set search_path = ''
as $$
  select case
    when p_type not in ('investment', 'transfer') then 0
    -- de dónde sale / a dónde va: cuenta normal (false) o inversión (true).
    -- Sin cuenta en un lado de una 'investment' = la cartera (inversión).
    else (case when (case when p_has_to then p_to_kind = 'investment' else true end)
                 and not (case when p_has_from then p_from_kind = 'investment' else true end)
               then p_amount
               when (case when p_has_from then p_from_kind = 'investment' else true end)
                 and not (case when p_has_to then p_to_kind = 'investment' else true end)
               then -p_amount
               else 0 end)
  end::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Resúmenes con lo invertido (cambia el tipo devuelto: se recrean)
-- ---------------------------------------------------------------------------
drop function if exists public.period_summary(uuid, date, date);
create function public.period_summary(p_household uuid, p_from date, p_to date)
returns table (
  income_cents bigint,
  expense_cents bigint,          -- gasto neto (gastos − reembolsos)
  personal_expense_cents bigint,
  shared_expense_cents bigint,
  refund_cents bigint,
  contribution_cents bigint,
  savings_cents bigint,
  tx_count bigint,
  invested_cents bigint          -- a inversiones, neto de lo que vuelve
)
language sql stable
set search_path = ''
as $$
  with t as (
    select t.*,
           private.invested_effect(t.type, t.amount_cents, fa.kind, ta.kind, t.account_id is not null, t.to_account_id is not null) as inv
    from public.transactions t
    left join public.accounts fa on fa.id = t.account_id
    left join public.accounts ta on ta.id = t.to_account_id
    where t.household_id = p_household and t.occurred_on between p_from and p_to
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
      coalesce(sum(inv), 0) as inv,
      count(*) as n
    from t
  )
  select inc::bigint, (exp - ref)::bigint, pexp::bigint, sexp::bigint, ref::bigint, con::bigint,
         (inc - (exp - ref))::bigint, n, inv::bigint
  from s;
$$;

drop function if exists public.monthly_flows(uuid, date, date, uuid, public.visibility);
create function public.monthly_flows(
  p_household uuid, p_from date, p_to date,
  p_category uuid default null, p_visibility public.visibility default null)
returns table (
  month date,
  income_cents bigint,
  expense_cents bigint,
  personal_expense_cents bigint,
  shared_expense_cents bigint,
  contribution_cents bigint,
  savings_cents bigint,
  invested_cents bigint
)
language sql stable
set search_path = ''
as $$
  with months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as m
  ), t as (
    select date_trunc('month', t.occurred_on)::date as m, t.type, t.visibility, t.amount_cents,
           private.invested_effect(t.type, t.amount_cents, fa.kind, ta.kind, t.account_id is not null, t.to_account_id is not null) as inv
    from public.transactions t
    left join public.accounts fa on fa.id = t.account_id
    left join public.accounts ta on ta.id = t.to_account_id
    where t.household_id = p_household and t.occurred_on between p_from and p_to
      and (p_category is null or t.category_id = p_category or t.subcategory_id = p_category)
      and (p_visibility is null or t.visibility = p_visibility)
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
      + coalesce(sum(t.amount_cents) filter (where t.type = 'refund'), 0))::bigint,
    coalesce(sum(t.inv), 0)::bigint
  from months left join t on t.m = months.m
  group by months.m
  order by months.m;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.account_valuations to authenticated;

revoke all on function
  public.set_account_valuation(uuid, date, bigint, text),
  public.account_values(uuid, date),
  public.period_summary(uuid, date, date),
  public.monthly_flows(uuid, date, date, uuid, public.visibility)
from public, anon;

revoke all on function
  private.tg_account_valuations_validate(),
  private.invested_effect(public.transaction_type, bigint, public.account_kind, public.account_kind, boolean, boolean)
from public, anon;
revoke all on function private.tg_account_valuations_validate() from authenticated;
grant execute on function
  private.invested_effect(public.transaction_type, bigint, public.account_kind, public.account_kind, boolean, boolean)
to authenticated;

grant execute on function
  public.set_account_valuation(uuid, date, bigint, text),
  public.account_values(uuid, date),
  public.period_summary(uuid, date, date),
  public.monthly_flows(uuid, date, date, uuid, public.visibility)
to authenticated;
