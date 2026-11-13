-- =============================================================================
-- Etxea · 0009 · Categorías de ingresos
--   * Los ingresos pueden usar también las categorías de gastos (mismos
--     conceptos: vivienda, transporte, alimentación...). Las estadísticas de
--     gasto y los presupuestos siguen contando solo gastos y devoluciones.
--   * Nueva subcategoría de ingresos «Peajes».
-- Se puede ejecutar más de una vez.
-- =============================================================================

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
    -- Los ingresos pueden usar sus categorías o las de gastos (p. ej. un
    -- reembolso de peajes en Transporte); gastos y devoluciones, solo las de gastos.
    if new.type in ('expense', 'refund') and cat.kind <> 'expense' then
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
    (8, 'income',  'Ingresos',     'income',    'wallet',        '#16a34a', array['Nómina','Freelance','Peajes','Intereses y dividendos','Regalos recibidos','Otros ingresos'])
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

-- «Peajes» en los espacios que ya existen
insert into public.categories (household_id, parent_id, kind, name, group_key, icon, color, sort_order, is_system)
select c.household_id, c.id, 'income', 'Peajes', c.group_key, c.icon, c.color, 3, true
from public.categories c
where c.parent_id is null and c.kind = 'income' and c.group_key = 'income' and c.is_system
  and not exists (select 1 from public.categories s where s.parent_id = c.id and lower(s.name) = 'peajes');

revoke all on function private.seed_default_categories(uuid) from public, anon, authenticated;
