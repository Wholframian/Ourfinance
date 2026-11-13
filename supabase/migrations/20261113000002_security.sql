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
