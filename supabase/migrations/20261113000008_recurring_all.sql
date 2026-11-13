-- =============================================================================
-- Etxea · 0008 · Movimientos periódicos para cualquier tipo
--   * Gastos, ingresos, transferencias, aportaciones e inversiones periódicos.
--   * Más periodicidades: semanal, quincenal, mensual, bimestral, trimestral,
--     semestral y anual.
--   * Se conserva el día del mes (una cuota del día 31 vuelve al 31 tras febrero).
--   * Opción de apuntarlos automáticamente cuando llega la fecha.
-- Se puede ejecutar más de una vez.
-- =============================================================================

alter type public.recurrence_frequency add value if not exists 'weekly';
alter type public.recurrence_frequency add value if not exists 'biweekly';
alter type public.recurrence_frequency add value if not exists 'bimonthly';
alter type public.recurrence_frequency add value if not exists 'semiannual';

alter table public.recurring_transactions
  add column if not exists anchor_day smallint check (anchor_day between 1 and 31),
  add column if not exists auto_register boolean not null default true;

update public.recurring_transactions
   set anchor_day = extract(day from next_due_on)::smallint
 where anchor_day is null;

-- La versión anterior tenía dos parámetros; se sustituye por la de tres
drop function if exists public.next_occurrence(date, public.recurrence_frequency);

-- Siguiente fecha. Las comparaciones van sobre ::text para poder ejecutar este
-- fichero en la misma transacción que añade los valores nuevos al enum.
create or replace function public.next_occurrence(
  p_date date, p_freq public.recurrence_frequency, p_anchor_day int default null)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  months int;
  base date;
  last_day int;
begin
  case p_freq::text
    when 'weekly'   then return p_date + 7;
    when 'biweekly' then return p_date + 14;
    else null;
  end case;
  months := case p_freq::text
    when 'monthly' then 1 when 'bimonthly' then 2 when 'quarterly' then 3
    when 'semiannual' then 6 else 12 end;
  base := (date_trunc('month', p_date) + make_interval(months => months))::date;
  last_day := extract(day from (base + interval '1 month - 1 day'))::int;
  return base + (least(coalesce(p_anchor_day, extract(day from p_date)::int), last_day) - 1);
end;
$$;

-- Coste mensual equivalente (céntimos)
create or replace function public.monthly_equivalent(p_amount bigint, p_freq public.recurrence_frequency)
returns bigint
language sql immutable
set search_path = ''
as $$
  select round(p_amount * case p_freq::text
    when 'weekly' then 52 / 12.0 when 'biweekly' then 26 / 12.0 when 'monthly' then 1
    when 'bimonthly' then 1 / 2.0 when 'quarterly' then 1 / 3.0 when 'semiannual' then 1 / 6.0
    else 1 / 12.0 end)::bigint;
$$;

-- Registra la cuota pendiente y avanza la próxima fecha conservando el día
create or replace function public.register_recurring(p_recurring uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  r public.recurring_transactions;
  tx_id uuid;
  nxt date;
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

  nxt := public.next_occurrence(r.next_due_on, r.frequency, r.anchor_day);
  update public.recurring_transactions
     set next_due_on = nxt,
         is_active = case when r.end_on is not null and nxt > r.end_on then false else is_active end
   where id = r.id;

  return tx_id;
end;
$$;

-- Apunta todas las cuotas vencidas (hasta hoy, hora de Madrid) de los periódicos
-- automáticos que el usuario puede ver. Si los dos abren la app a la vez, el
-- bloqueo de register_recurring y el índice único evitan duplicados.
create or replace function public.register_due_recurring(p_household uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Europe/Madrid')::date;
  rid uuid;
  n int := 0;
  guard int;
begin
  for rid in
    select id from public.recurring_transactions
    where household_id = p_household and is_active and auto_register and next_due_on <= today
  loop
    guard := 0;
    while guard < 60 and exists (
      select 1 from public.recurring_transactions r
      where r.id = rid and r.is_active and r.auto_register and r.next_due_on <= today
        and (r.end_on is null or r.next_due_on <= r.end_on)
    ) loop
      begin
        perform public.register_recurring(rid);
        n := n + 1;
      exception when unique_violation then
        -- esa cuota ya estaba apuntada (p. ej. a mano): se salta a la siguiente
        update public.recurring_transactions r
           set next_due_on = public.next_occurrence(r.next_due_on, r.frequency, r.anchor_day)
         where r.id = rid;
      end;
      guard := guard + 1;
    end loop;
  end loop;
  return n;
end;
$$;

-- Convierte un movimiento ya guardado en el primero de una serie periódica
create or replace function public.make_recurring_from_transaction(
  p_transaction uuid, p_frequency public.recurrence_frequency,
  p_end_on date default null, p_auto boolean default true)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  t public.transactions;
  rid uuid;
  anchor int;
begin
  select * into t from public.transactions where id = p_transaction;
  if t.id is null then
    raise exception 'Movimiento no encontrado' using errcode = 'P0002';
  end if;
  if t.recurring_id is not null then
    raise exception 'Este movimiento ya es periódico' using errcode = '23514';
  end if;
  if t.type = 'investment' and (t.account_id is null or t.to_account_id is null) then
    raise exception 'Las compras de la cartera no pueden ser periódicas; usa una transferencia a la cuenta de inversión' using errcode = '23514';
  end if;
  anchor := extract(day from t.occurred_on)::int;
  insert into public.recurring_transactions (
    household_id, visibility, type, amount_cents, description, category_id, subcategory_id,
    account_id, to_account_id, frequency, next_due_on, end_on, notes, anchor_day, auto_register
  ) values (
    t.household_id, t.visibility, t.type, t.amount_cents, t.description, t.category_id, t.subcategory_id,
    t.account_id, t.to_account_id, p_frequency, public.next_occurrence(t.occurred_on, p_frequency, anchor),
    p_end_on, t.notes, anchor, coalesce(p_auto, true)
  ) returning id into rid;
  update public.transactions set recurring_id = rid where id = t.id;
  return rid;
end;
$$;

-- Plantillas: mismas reglas de cuentas que los movimientos, según el tipo
create or replace function private.tg_recurring_validate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accounts;
  acc_id uuid;
begin
  if tg_op = 'INSERT' or new.anchor_day is null then
    new.anchor_day := coalesce(new.anchor_day, extract(day from new.next_due_on)::smallint);
  end if;

  if (new.type in ('income', 'expense', 'refund') and (new.account_id is null or new.to_account_id is not null))
     or (new.type in ('transfer', 'investment') and (new.account_id is null or new.to_account_id is null))
     or (new.type = 'contribution' and new.to_account_id is null)
     or (new.account_id is not null and new.account_id = new.to_account_id) then
    raise exception 'Cuentas no válidas para este tipo de movimiento' using errcode = '23514';
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
      raise exception 'Los periódicos de una cuenta compartida deben ser compartidos' using errcode = '23514';
    end if;
  end loop;

  if new.type = 'contribution'
     and not exists (select 1 from public.accounts a where a.id = new.to_account_id and a.visibility = 'shared') then
    raise exception 'Las aportaciones deben ir a una cuenta compartida' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Los recurrentes antiguos solo tenían cuenta de origen si eran gastos: se respeta.
drop trigger if exists recurring_validate on public.recurring_transactions;
create trigger recurring_validate before insert or update on public.recurring_transactions
  for each row execute function private.tg_recurring_validate();

revoke all on function
  public.register_due_recurring(uuid),
  public.make_recurring_from_transaction(uuid, public.recurrence_frequency, date, boolean),
  public.register_recurring(uuid)
from public, anon;
revoke all on function private.tg_recurring_validate() from public, anon, authenticated;
grant execute on function
  public.register_due_recurring(uuid),
  public.make_recurring_from_transaction(uuid, public.recurrence_frequency, date, boolean),
  public.register_recurring(uuid),
  public.next_occurrence(date, public.recurrence_frequency, int),
  public.monthly_equivalent(bigint, public.recurrence_frequency)
to authenticated;
