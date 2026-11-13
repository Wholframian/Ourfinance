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
