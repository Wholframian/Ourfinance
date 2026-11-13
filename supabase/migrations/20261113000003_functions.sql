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
