-- =============================================================================
-- OURFINANCE · 0007 · Fase 3: cartera de inversiones, patrimonio neto y
-- patrimonio conjunto opcional.
-- Se puede ejecutar más de una vez (create or replace / if not exists).
-- -----------------------------------------------------------------------------
-- Modelo de cartera:
--   * Cada fila de `investments` es una posición (un activo).
--   * `investment_transactions` es su historial: compra, venta, dividendo,
--     interés, comisión y valoración. La posición (unidades, coste, valor y
--     rentabilidad) se CALCULA desde ese historial; no se escribe a mano.
--   * El dinero que sale o entra de una cuenta queda como movimiento de caja de
--     tipo 'investment' (no es gasto ni ingreso) enlazado a la operación.
--     Los dividendos e intereses cobrados sí son ingreso.
--   * Patrimonio = saldos de las cuentas + valor actual de la cartera.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 'investment' admite un solo lado: compra (sale de account_id hacia la cartera)
-- o venta (entra en to_account_id desde la cartera). El caso antiguo, de una
-- cuenta a una cuenta de inversión, sigue siendo válido.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint if exists tx_accounts_by_type;
alter table public.transactions add constraint tx_accounts_by_type check (
  case type
    when 'income'       then account_id is not null and to_account_id is null
    when 'expense'      then account_id is not null and to_account_id is null
    when 'refund'       then account_id is not null and to_account_id is null
    when 'transfer'     then account_id is not null and to_account_id is not null
    when 'investment'   then account_id is not null or to_account_id is not null
    when 'contribution' then to_account_id is not null
  end
);

-- ---------------------------------------------------------------------------
-- Estado de cada posición a una fecha (SECURITY INVOKER: respeta RLS)
--   coste (método de coste medio) · realizado · rentas · comisiones · valor
--   total_return = valor + retirado + rentas − comisiones − aportado
-- ---------------------------------------------------------------------------
create or replace function public.investment_positions(p_household uuid, p_at date default null)
returns table (
  investment_id      uuid,
  units              numeric,
  last_price         numeric,
  cost_cents         bigint,   -- coste de lo que sigue en cartera
  contributed_cents  bigint,   -- total aportado (compras + comisiones de compra)
  withdrawn_cents    bigint,   -- total retirado (ventas netas de comisión)
  realized_cents     bigint,   -- plusvalía realizada en ventas
  income_cents       bigint,   -- dividendos e intereses netos
  fees_cents         bigint,   -- comisiones sueltas
  value_cents        bigint,   -- valor actual
  total_return_cents bigint,
  valued_on          date      -- fecha del último precio o valoración
)
language plpgsql stable
set search_path = ''
as $$
declare
  inv record;
  op record;
  unitless boolean;
  v_units numeric; v_price numeric; v_cost numeric; v_value numeric;
  v_contrib bigint; v_withdrawn bigint; v_realized numeric; v_income bigint; v_fees bigint;
  v_on date; frac numeric; removed numeric;
begin
  for inv in
    select i.id, i.asset_type from public.investments i
    where i.household_id = p_household
    order by i.created_at
  loop
    unitless := inv.asset_type in ('deposit', 'savings_account');
    v_units := 0; v_price := null; v_cost := 0; v_value := 0;
    v_contrib := 0; v_withdrawn := 0; v_realized := 0; v_income := 0; v_fees := 0; v_on := null;

    for op in
      select t.* from public.investment_transactions t
      where t.investment_id = inv.id and (p_at is null or t.occurred_on <= p_at)
      order by t.occurred_on, t.created_at, t.id
    loop
      case op.type
        when 'buy' then
          v_contrib := v_contrib + op.amount_cents + op.fee_cents;
          v_cost := v_cost + op.amount_cents + op.fee_cents;
          if unitless then
            v_value := v_value + op.amount_cents;
          else
            v_units := v_units + coalesce(op.units, 0);
            if op.unit_price is not null then v_price := op.unit_price; end if;
          end if;
          v_on := op.occurred_on;
        when 'sell' then
          v_withdrawn := v_withdrawn + op.amount_cents - op.fee_cents;
          if unitless then
            frac := case when v_value > 0 then least(1, op.amount_cents / v_value) else 1 end;
            v_value := greatest(0, v_value - op.amount_cents);
          else
            frac := case when v_units > 0 then least(1, coalesce(op.units, 0) / v_units) else 1 end;
            v_units := greatest(0, v_units - coalesce(op.units, 0));
            if op.unit_price is not null then v_price := op.unit_price; end if;
          end if;
          removed := v_cost * frac;
          v_realized := v_realized + (op.amount_cents - op.fee_cents) - removed;
          v_cost := v_cost - removed;
          v_on := op.occurred_on;
        when 'dividend', 'interest' then
          v_income := v_income + op.amount_cents - op.fee_cents;
        when 'fee' then
          v_fees := v_fees + op.amount_cents + op.fee_cents;
        when 'valuation' then
          if unitless then
            v_value := op.amount_cents;
          elsif op.unit_price is not null then
            v_price := op.unit_price;
          end if;
          v_on := op.occurred_on;
      end case;
    end loop;

    if not unitless then
      v_value := case when v_price is null then v_cost else v_units * v_price * 100 end;
    end if;

    investment_id      := inv.id;
    units              := case when unitless then null else v_units end;
    last_price         := v_price;
    cost_cents         := round(v_cost)::bigint;
    contributed_cents  := v_contrib;
    withdrawn_cents    := v_withdrawn;
    realized_cents     := round(v_realized)::bigint;
    income_cents       := v_income;
    fees_cents         := v_fees;
    value_cents        := round(v_value)::bigint;
    total_return_cents := round(v_value)::bigint + v_withdrawn + v_income - v_fees - v_contrib;
    valued_on          := v_on;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Integridad de inversiones
-- ---------------------------------------------------------------------------
create or replace function private.tg_investments_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare acc public.accounts;
begin
  if new.account_id is not null then
    select * into acc from public.accounts where id = new.account_id;
    if acc.id is null or acc.household_id <> new.household_id then
      raise exception 'Cuenta no válida para este espacio' using errcode = '23514';
    end if;
    if acc.visibility = 'personal' and acc.owner_id <> new.owner_id then
      raise exception 'No puedes usar la cuenta personal de otro miembro' using errcode = '42501';
    end if;
    if acc.visibility = 'shared' and new.visibility <> 'shared' then
      raise exception 'Una inversión personal no puede usar una cuenta compartida' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.visibility <> old.visibility
     and exists (select 1 from public.investment_transactions t where t.investment_id = new.id) then
    raise exception 'No se puede cambiar la visibilidad de una inversión con operaciones' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.asset_type <> old.asset_type
     and exists (select 1 from public.investment_transactions t where t.investment_id = new.id) then
    raise exception 'No se puede cambiar el tipo de activo de una inversión con operaciones' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- se llama "validate_*" para ejecutarse después de owner_guard (orden alfabético)
drop trigger if exists validate_investment on public.investments;
create trigger validate_investment before insert or update on public.investments
  for each row execute function private.tg_investments_validate();

-- Operaciones: cifras coherentes con el tipo de activo
create or replace function private.tg_investment_tx_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  inv public.investments;
  unitless boolean;
begin
  select * into inv from public.investments where id = new.investment_id;
  unitless := inv.asset_type in ('deposit', 'savings_account');
  if new.type in ('buy', 'sell') and not unitless then
    if new.units is null or new.units <= 0 then
      raise exception 'Indica las unidades' using errcode = '23514';
    end if;
    if new.unit_price is null or new.unit_price < 0 then
      raise exception 'Indica el precio por unidad' using errcode = '23514';
    end if;
  end if;
  if new.type = 'valuation' and not unitless and new.unit_price is null then
    raise exception 'Indica el precio actual por unidad' using errcode = '23514';
  end if;
  if new.type in ('buy', 'sell', 'dividend', 'interest', 'fee') and new.amount_cents <= 0 then
    raise exception 'El importe debe ser mayor que cero' using errcode = '23514';
  end if;
  if new.type in ('sell', 'dividend', 'interest') and new.fee_cents > new.amount_cents then
    raise exception 'La comisión no puede superar el importe' using errcode = '23514';
  end if;
  if unitless then
    new.units := null;
    new.unit_price := null;
  end if;
  return new;
end;
$$;

drop trigger if exists investment_tx_validate on public.investment_transactions;
create trigger investment_tx_validate before insert or update on public.investment_transactions
  for each row execute function private.tg_investment_tx_validate();

-- Mantiene las columnas resumen de `investments` y borra el movimiento de caja
-- enlazado cuando se borra la operación.
create or replace function private.tg_investment_tx_after()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  inv_id uuid := coalesce(new.investment_id, old.investment_id);
  hh uuid := coalesce(new.household_id, old.household_id);
  p record;
begin
  if tg_op = 'DELETE' and old.transaction_id is not null then
    delete from public.transactions where id = old.transaction_id;
  end if;
  select * into p from public.investment_positions(hh) x where x.investment_id = inv_id;
  if p.investment_id is not null then
    update public.investments
       set units = coalesce(p.units, 0),
           invested_cents = greatest(p.cost_cents, 0),
           avg_price = case when coalesce(p.units, 0) > 0 then round(p.cost_cents / p.units / 100, 8) end,
           current_value_cents = greatest(p.value_cents, 0),
           value_updated_at = now()
     where id = inv_id;
  end if;
  return null;
end;
$$;

drop trigger if exists investment_tx_after on public.investment_transactions;
create trigger investment_tx_after after insert or update or delete on public.investment_transactions
  for each row execute function private.tg_investment_tx_after();

-- Un movimiento de caja enlazado a una operación de inversión solo se cambia
-- desde Inversiones (si no, la cartera y la cuenta dejarían de cuadrar).
create or replace function private.tg_tx_investment_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.investment_transactions it where it.transaction_id = old.id) then
    -- al borrar el espacio entero (cascada) no hay nada que proteger
    if not exists (select 1 from public.households h where h.id = old.household_id) then
      return coalesce(new, old);
    end if;
    if tg_op = 'DELETE' then
      raise exception 'Este movimiento pertenece a una operación de inversión: bórrala desde Inversiones' using errcode = '23514';
    end if;
    if new.amount_cents <> old.amount_cents or new.occurred_on <> old.occurred_on
       or new.type <> old.type or new.visibility <> old.visibility
       or new.account_id is distinct from old.account_id
       or new.to_account_id is distinct from old.to_account_id then
      raise exception 'Este movimiento pertenece a una operación de inversión: modifícala desde Inversiones' using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists tx_investment_guard on public.transactions;
create trigger tx_investment_guard before update or delete on public.transactions
  for each row execute function private.tg_tx_investment_guard();

-- ---------------------------------------------------------------------------
-- Registrar una operación (SECURITY INVOKER): crea la operación y, si se indica
-- cuenta, el movimiento de caja enlazado, todo en una sola transacción.
--   compra      → 'investment' sale de la cuenta (importe + comisión)
--   venta       → 'investment' entra en la cuenta (importe − comisión)
--   dividendo / interés → 'income' en la cuenta (importe − comisión)
--   comisión    → 'investment' sale de la cuenta
--   valoración  → sin movimiento de caja
-- ---------------------------------------------------------------------------
create or replace function public.record_investment_operation(
  p_investment uuid,
  p_type public.investment_tx_type,
  p_on date,
  p_amount_cents bigint,
  p_units numeric default null,
  p_unit_price numeric default null,
  p_fee_cents bigint default 0,
  p_cash_account uuid default null,
  p_notes text default null,
  p_client_request_id uuid default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  inv public.investments;
  pos record;
  unitless boolean;
  amount bigint := coalesce(p_amount_cents, 0);
  fee bigint := coalesce(p_fee_cents, 0);
  cash bigint;
  tx_id uuid;
  op_id uuid;
  cat uuid; sub uuid;
  label text;
begin
  select * into inv from public.investments where id = p_investment;
  if inv.id is null then
    raise exception 'Inversión no encontrada' using errcode = 'P0002';
  end if;
  unitless := inv.asset_type in ('deposit', 'savings_account');

  if not unitless and p_type in ('buy', 'sell') then
    if p_units is null or p_units <= 0 or p_unit_price is null or p_unit_price < 0 then
      raise exception 'Indica unidades y precio' using errcode = '23514';
    end if;
    amount := round(p_units * p_unit_price * 100)::bigint;
  end if;
  if not unitless and p_type = 'valuation' then
    if p_unit_price is null or p_unit_price < 0 then
      raise exception 'Indica el precio actual por unidad' using errcode = '23514';
    end if;
  end if;

  if p_type = 'sell' then
    select * into pos from public.investment_positions(inv.household_id, p_on) x where x.investment_id = inv.id;
    if not unitless and p_units > coalesce(pos.units, 0) + 0.0000000001 then
      raise exception 'No puedes vender más unidades de las que tienes (%)', trim_scale(coalesce(pos.units, 0)) using errcode = '23514';
    end if;
    if unitless and amount > coalesce(pos.value_cents, 0) then
      raise exception 'No puedes retirar más del saldo de la inversión' using errcode = '23514';
    end if;
  end if;

  if p_type = 'valuation' and not unitless then
    select * into pos from public.investment_positions(inv.household_id, p_on) x where x.investment_id = inv.id;
    amount := round(coalesce(pos.units, 0) * p_unit_price * 100)::bigint;
  end if;

  if p_cash_account is not null and p_type <> 'valuation' then
    cash := case p_type when 'buy' then amount + fee when 'fee' then amount + fee else amount - fee end;
    label := case p_type
      when 'buy' then 'Compra · ' when 'sell' then 'Venta · '
      when 'dividend' then 'Dividendo · ' when 'interest' then 'Intereses · '
      else 'Comisión · ' end || inv.name;

    if cash > 0 then
      if p_type in ('dividend', 'interest') then
        select c.id, s.id into cat, sub
        from public.categories c
        left join public.categories s on s.parent_id = c.id and s.name = 'Intereses y dividendos'
        where c.household_id = inv.household_id and c.parent_id is null
          and c.kind = 'income' and c.group_key = 'income'
        order by c.is_system desc, s.id nulls last
        limit 1;
        insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on,
          description, category_id, subcategory_id, account_id, client_request_id)
        values (inv.household_id, 'income', inv.visibility, cash, p_on, left(label, 140), cat, sub,
          p_cash_account, p_client_request_id)
        returning id into tx_id;
      else
        insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on,
          description, account_id, to_account_id, client_request_id)
        values (inv.household_id, 'investment', inv.visibility, cash, p_on, left(label, 140),
          case when p_type = 'sell' then null else p_cash_account end,
          case when p_type = 'sell' then p_cash_account else null end,
          p_client_request_id)
        returning id into tx_id;
      end if;
    end if;
  end if;

  insert into public.investment_transactions (investment_id, household_id, type, occurred_on,
    units, unit_price, amount_cents, fee_cents, transaction_id, notes)
  values (inv.id, inv.household_id, p_type, p_on,
    case when unitless or p_type not in ('buy', 'sell') then null else p_units end,
    case when unitless then null else p_unit_price end,
    amount, fee, tx_id, nullif(trim(p_notes), ''))
  returning id into op_id;

  return op_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Patrimonio: cuentas + cartera (lo que ve el usuario)
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
         (coalesce((select sum(b.balance_cents) from public.account_balances(p_household, m.month_end) b), 0)
          + coalesce((select sum(p.value_cents) from public.investment_positions(p_household, m.month_end) p), 0))::bigint
  from months m
  order by 1;
$$;

-- Desglose del patrimonio a una fecha, por tipo de cuenta y por tipo de activo
create or replace function public.net_worth_breakdown(p_household uuid, p_at date default null)
returns table (source text, kind text, visibility public.visibility, value_cents bigint)
language sql stable
set search_path = ''
as $$
  select 'account', a.kind::text, a.visibility, sum(b.balance_cents)::bigint
  from public.account_balances(p_household, p_at) b
  join public.accounts a on a.id = b.account_id
  group by a.kind, a.visibility
  union all
  select 'investment', i.asset_type::text, i.visibility, sum(p.value_cents)::bigint
  from public.investment_positions(p_household, p_at) p
  join public.investments i on i.id = p.investment_id
  group by i.asset_type, i.visibility;
$$;

-- ---------------------------------------------------------------------------
-- Patrimonio conjunto (opcional): cada miembro decide si comparte su TOTAL
-- personal. Nunca se exponen cuentas, inversiones ni movimientos del otro.
-- ---------------------------------------------------------------------------
alter table public.household_members
  add column if not exists share_net_worth boolean not null default false;

create or replace function public.set_net_worth_sharing(p_household uuid, p_share boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.household_members
     set share_net_worth = coalesce(p_share, false)
   where household_id = p_household and user_id = (select auth.uid());
  if not found then
    raise exception 'No perteneces a este espacio' using errcode = '42501';
  end if;
end;
$$;

-- Patrimonio personal de un miembro (cuentas personales + inversiones personales).
-- Interna: solo la llaman las funciones de abajo, que comprueban el permiso.
create or replace function private.personal_net_worth(p_household uuid, p_user uuid, p_at date)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select (coalesce((
            select sum(b.balance_cents)
            from public.account_balances(p_household, p_at) b
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
            select sum(b.balance_cents)
            from public.account_balances(p_household, p_at) b
            join public.accounts a on a.id = b.account_id
            where a.visibility = 'shared'), 0)
        + coalesce((
            select sum(p.value_cents)
            from public.investment_positions(p_household, p_at) p
            join public.investments i on i.id = p.investment_id
            where i.visibility = 'shared'), 0))::bigint;
$$;

-- Un registro por miembro (con su total solo si lo comparte o eres tú) y otro
-- para lo compartido (user_id nulo).
create or replace function public.household_net_worth(p_household uuid, p_at date default null)
returns table (user_id uuid, is_sharing boolean, net_worth_cents bigint)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_household) then
    raise exception 'No perteneces a este espacio' using errcode = '42501';
  end if;
  return query
    select m.user_id, m.share_net_worth,
           case when m.share_net_worth or m.user_id = (select auth.uid())
                then private.personal_net_worth(p_household, m.user_id, p_at) end
    from public.household_members m
    where m.household_id = p_household
    union all
    select null::uuid, true, private.shared_net_worth(p_household, p_at);
end;
$$;

-- Evolución mensual del patrimonio conjunto. Solo devuelve datos cuando todos los
-- miembros lo comparten (si no, el "total conjunto" no sería real).
create or replace function public.household_net_worth_series(p_household uuid, p_from date, p_to date)
returns table (month date, user_id uuid, net_worth_cents bigint)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_household) then
    raise exception 'No perteneces a este espacio' using errcode = '42501';
  end if;
  if exists (select 1 from public.household_members m
             where m.household_id = p_household and not m.share_net_worth) then
    return;
  end if;
  return query
    with months as (
      select (date_trunc('month', d) + interval '1 month - 1 day')::date as month_end
      from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') d
    )
    select date_trunc('month', mo.month_end)::date, m.user_id,
           private.personal_net_worth(p_household, m.user_id, mo.month_end)
    from months mo cross join public.household_members m
    where m.household_id = p_household
    union all
    select date_trunc('month', mo.month_end)::date, null::uuid,
           private.shared_net_worth(p_household, mo.month_end)
    from months mo
    order by 1, 2 nulls last;
end;
$$;

-- ---------------------------------------------------------------------------
-- Analítica avanzada (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
-- Gasto por miembro que lo pagó (paid_by), solo de lo que el usuario ve
create or replace function public.expense_by_payer(p_household uuid, p_from date, p_to date)
returns table (user_id uuid, visibility public.visibility, expense_cents bigint)
language sql stable
set search_path = ''
as $$
  select t.paid_by, t.visibility,
         sum(case when t.type = 'expense' then t.amount_cents else -t.amount_cents end)::bigint
  from public.transactions t
  where t.household_id = p_household
    and t.type in ('expense', 'refund')
    and t.occurred_on between p_from and p_to
  group by 1, 2;
$$;

-- Subcategorías con más gasto en el periodo
create or replace function public.top_subcategories(p_household uuid, p_from date, p_to date, p_limit int default 10)
returns table (category_id uuid, parent_name text, name text, color text, expense_cents bigint, tx_count bigint)
language sql stable
set search_path = ''
as $$
  select s.id, c.name, coalesce(s.name, c.name), coalesce(c.color, '#94a3b8'),
         sum(case when t.type = 'expense' then t.amount_cents else -t.amount_cents end)::bigint as total,
         count(*)
  from public.transactions t
  join public.categories c on c.id = t.category_id
  left join public.categories s on s.id = t.subcategory_id
  where t.household_id = p_household
    and t.type in ('expense', 'refund')
    and t.occurred_on between p_from and p_to
  group by s.id, c.name, s.name, c.color
  having sum(case when t.type = 'expense' then t.amount_cents else -t.amount_cents end) > 0
  order by total desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
revoke all on function
  public.investment_positions(uuid, date),
  public.record_investment_operation(uuid, public.investment_tx_type, date, bigint, numeric, numeric, bigint, uuid, text, uuid),
  public.net_worth_series(uuid, date, date),
  public.net_worth_breakdown(uuid, date),
  public.set_net_worth_sharing(uuid, boolean),
  public.household_net_worth(uuid, date),
  public.household_net_worth_series(uuid, date, date),
  public.expense_by_payer(uuid, date, date),
  public.top_subcategories(uuid, date, date, int)
from public, anon;

revoke all on function
  private.personal_net_worth(uuid, uuid, date),
  private.shared_net_worth(uuid, date),
  private.tg_investments_validate(),
  private.tg_investment_tx_validate(),
  private.tg_investment_tx_after(),
  private.tg_tx_investment_guard()
from public, anon, authenticated;

grant execute on function
  public.investment_positions(uuid, date),
  public.record_investment_operation(uuid, public.investment_tx_type, date, bigint, numeric, numeric, bigint, uuid, text, uuid),
  public.net_worth_series(uuid, date, date),
  public.net_worth_breakdown(uuid, date),
  public.set_net_worth_sharing(uuid, boolean),
  public.household_net_worth(uuid, date),
  public.household_net_worth_series(uuid, date, date),
  public.expense_by_payer(uuid, date, date),
  public.top_subcategories(uuid, date, date, int)
to authenticated;
