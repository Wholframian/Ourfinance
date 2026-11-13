-- =============================================================================
-- Pruebas de RLS e integridad con tres usuarios (A y B pareja, C externo).
-- Ejecutar en una base de pruebas LOCAL tras local_supabase_shim.sql + migraciones:
--   psql -v ON_ERROR_STOP=1 -d oftest -f supabase/tests/rls_test.sql
-- Cada bloque lanza una excepción 'FALLO: ...' si una comprobación no se cumple.
-- =============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

create schema t;
grant usage on schema t to authenticated, anon;
create table t.ctx (k text primary key, v uuid);
grant all on t.ctx to authenticated, anon;
create function t.get(text) returns uuid language sql stable as $$ select v from t.ctx where k = $1 $$;
create function t.put(text, uuid) returns void language sql as $$
  insert into t.ctx values ($1, $2) on conflict (k) do update set v = excluded.v $$;
grant execute on all functions in schema t to authenticated, anon;

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'paul@test.es',   '{"full_name":"Paul"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'pareja@test.es', '{"full_name":"Pareja"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'externo@test.es','{"full_name":"Externo"}');

\set as_a 'reset role; select set_config(''request.jwt.claims'', ''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","email":"paul@test.es","role":"authenticated"}'', false); set role authenticated;'
\set as_b 'reset role; select set_config(''request.jwt.claims'', ''{"sub":"bbbbbbbb-0000-0000-0000-000000000002","email":"pareja@test.es","role":"authenticated"}'', false); set role authenticated;'
\set as_c 'reset role; select set_config(''request.jwt.claims'', ''{"sub":"cccccccc-0000-0000-0000-000000000003","email":"externo@test.es","role":"authenticated"}'', false); set role authenticated;'
\set as_anon 'reset role; select set_config(''request.jwt.claims'', '''', false); set role anon;'

\o /dev/null
-- ---------------------------------------------------------------- 1. Espacio
:as_a
select t.put('hid', public.create_household('Paul y Pareja'));
select t.put('common', (select id from public.accounts where kind = 'common'));
\o
do $$ begin
  if (select count(*) from public.profiles) <> 1 then raise exception 'FALLO: A debería ver solo su perfil antes de invitar'; end if;
  if (select count(*) from public.categories where household_id = t.get('hid')) < 50 then raise exception 'FALLO: categorías por defecto'; end if;
  raise notice 'OK 1 · A crea el espacio con cuenta común y categorías';
end $$;

-- ------------------------------------------------------------ 2. Invitación
\o /dev/null
select set_config('test.token', public.create_invitation(t.get('hid'), 'pareja@test.es'), false);
\o
do $$ begin
  begin
    perform public.create_invitation(t.get('hid'), 'otro@test.es');
    raise exception 'FALLO: segunda invitación con el espacio completo';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
  end;
  raise notice 'OK 2 · No se puede invitar a más miembros de los permitidos';
end $$;

:as_c
do $$ begin
  begin
    perform public.accept_invitation(current_setting('test.token'));
    raise exception 'FALLO: C aceptó una invitación para otro correo';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
  end;
  begin
    perform public.accept_invitation('token-falso');
    raise exception 'FALLO: token falso aceptado';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
  end;
  if (select count(*) from public.households) <> 0 then raise exception 'FALLO: C ve el espacio'; end if;
  raise notice 'OK 3 · Un externo no puede usar la invitación ni ver el espacio';
end $$;

:as_b
do $$ begin
  perform public.accept_invitation(current_setting('test.token'));
  if (select count(*) from public.household_members where household_id = t.get('hid')) <> 2 then
    raise exception 'FALLO: B no es miembro';
  end if;
  if (select count(*) from public.profiles) <> 2 then raise exception 'FALLO: B debería ver ambos perfiles'; end if;
  begin
    perform public.accept_invitation(current_setting('test.token'));
    raise exception 'FALLO: invitación reutilizada';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
  end;
  raise notice 'OK 4 · B acepta la invitación (un solo uso)';
end $$;

-- -------------------------------------------------- 3. Cuentas personales
:as_a
\o /dev/null
with a as (insert into public.accounts (household_id, owner_id, name, kind, opening_balance_cents)
           values (t.get('hid'), t.get('hid'), 'Nómina Paul', 'checking', 200000) returning id)
select t.put('a1', id) from a;
\o
:as_b
\o /dev/null
with a as (insert into public.accounts (household_id, owner_id, name, kind, opening_balance_cents)
           values (t.get('hid'), 'bbbbbbbb-0000-0000-0000-000000000002', 'Nómina Pareja', 'checking', 150000) returning id)
select t.put('b1', id) from a;
\o
do $$ begin
  if exists (select 1 from public.accounts where id = t.get('a1')) then raise exception 'FALLO: B ve la cuenta personal de A'; end if;
  if not exists (select 1 from public.accounts where id = t.get('common')) then raise exception 'FALLO: B no ve la cuenta común'; end if;
  raise notice 'OK 5 · El propietario se fija desde auth.uid(); B no ve la cuenta personal de A';
end $$;

-- ---------------------------------------------------------- 4. Movimientos
:as_a
\o /dev/null
select t.put('cat_super', (select id from public.categories where name = 'Alimentación'));
select t.put('cat_ropa',  (select id from public.categories where name = 'Personal' and parent_id is null));
select t.put('sub_ropa',  (select id from public.categories where name = 'Ropa'));
with x as (insert into public.transactions (household_id, created_by, type, visibility, amount_cents, occurred_on, description, category_id, subcategory_id, account_id)
  values (t.get('hid'), t.get('hid'), 'expense', 'personal', 4599, '2026-11-02', 'Camisa', t.get('cat_ropa'), t.get('sub_ropa'), t.get('a1')) returning id)
select t.put('tx_a_personal', id) from x;
insert into public.transactions (household_id, created_by, type, visibility, amount_cents, occurred_on, description, account_id, to_account_id, client_request_id)
  values (t.get('hid'), t.get('hid'), 'contribution', 'shared', 60000, '2026-11-01', 'Aportación noviembre', t.get('a1'), t.get('common'), '11111111-1111-1111-1111-111111111111');
with x as (insert into public.transactions (household_id, created_by, type, visibility, amount_cents, occurred_on, description, category_id, account_id)
  values (t.get('hid'), t.get('hid'), 'expense', 'shared', 12034, '2026-11-05', 'Mercadona', t.get('cat_super'), t.get('common')) returning id)
select t.put('tx_shared', id) from x;
insert into public.transactions (household_id, created_by, type, visibility, amount_cents, occurred_on, description, category_id, account_id)
  values (t.get('hid'), t.get('hid'), 'income', 'personal', 250000, '2026-11-01', 'Nómina', (select id from public.categories where name = 'Ingresos'), t.get('a1'));
\o
:as_b
\o /dev/null
insert into public.transactions (household_id, created_by, type, visibility, amount_cents, occurred_on, description, account_id, to_account_id)
  values (t.get('hid'), t.get('hid'), 'contribution', 'shared', 40000, '2026-11-01', 'Aportación noviembre', t.get('b1'), t.get('common'));
insert into public.transactions (household_id, created_by, type, visibility, amount_cents, occurred_on, description, account_id)
  values (t.get('hid'), t.get('hid'), 'expense', 'personal', 1299, '2026-11-03', 'Spotify', t.get('b1'));
\o
do $$
declare n int;
begin
  -- B ve: aportación A, gasto común, su aportación, su gasto personal = 4
  select count(*) into n from public.transactions;
  if n <> 4 then raise exception 'FALLO: B ve % movimientos (esperado 4)', n; end if;
  if exists (select 1 from public.transactions where id = t.get('tx_a_personal')) then
    raise exception 'FALLO: B ve un gasto personal de A';
  end if;
  if exists (select 1 from public.transactions where created_by <> auth.uid() and visibility = 'personal') then
    raise exception 'FALLO: B ve movimientos personales ajenos';
  end if;
  if not exists (select 1 from public.transactions where created_by = t.get('hid') and visibility = 'personal') then
    null; -- (created_by se fijó a auth.uid(), no al valor enviado)
  end if;
  if exists (select 1 from public.transactions where created_by not in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002')) then
    raise exception 'FALLO: created_by no se fijó desde auth.uid()';
  end if;
  raise notice 'OK 6 · B ve los compartidos y los suyos, nunca los personales de A';

  update public.transactions set amount_cents = 1 where id = t.get('tx_a_personal');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO: B modificó un movimiento personal de A'; end if;
  delete from public.transactions where id = t.get('tx_a_personal');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO: B borró un movimiento personal de A'; end if;
  raise notice 'OK 7 · B no puede editar ni borrar movimientos personales de A';

  update public.transactions set notes = 'revisado' where id = t.get('tx_shared');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLO: B no puede gestionar un movimiento compartido'; end if;
  begin
    update public.transactions set visibility = 'personal' where id = t.get('tx_shared');
    raise exception 'FALLO: B ocultó un movimiento compartido de A';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    update public.transactions set created_by = auth.uid() where id = t.get('tx_shared');
    raise exception 'FALLO: B cambió el propietario';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 8 · B gestiona compartidos pero no puede apropiárselos ni ocultarlos';

  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id)
    values (t.get('hid'), 'expense', 'shared', 100, '2026-11-06', 'Truco', t.get('a1'));
    raise exception 'FALLO: B usó la cuenta personal de A';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id)
    values (t.get('hid'), 'expense', 'personal', 100, '2026-11-06', 'Oculto', t.get('common'));
    raise exception 'FALLO: gasto personal en la cuenta común';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id, to_account_id)
    values (t.get('hid'), 'contribution', 'shared', 100, '2026-11-06', 'Mal', t.get('common'), t.get('b1'));
    raise exception 'FALLO: aportación a cuenta personal';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id, paid_by)
    values (t.get('hid'), 'expense', 'personal', 100, '2026-11-06', 'Mal', t.get('b1'), 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'FALLO: gasto personal pagado por otro';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id)
    values (t.get('hid'), 'expense', 'personal', -100, '2026-11-06', 'Negativo', t.get('b1'));
    raise exception 'FALLO: importe negativo';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, category_id, account_id)
    values (t.get('hid'), 'income', 'personal', 100, '2026-11-06', 'Ingreso con categoría de gasto', t.get('cat_super'), t.get('b1'));
    raise exception 'FALLO: categoría de gasto en un ingreso';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 9 · Integridad: cuentas ajenas, cuenta común, aportaciones, pagador, importes y categorías';
end $$;

-- Idempotencia (anti-duplicados) -------------------------------------------
:as_a
do $$ begin
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id, to_account_id, client_request_id)
    values (t.get('hid'), 'contribution', 'shared', 60000, '2026-11-01', 'Aportación noviembre', t.get('a1'), t.get('common'), '11111111-1111-1111-1111-111111111111');
    raise exception 'FALLO: duplicado aceptado';
  exception when unique_violation then null; end;
  raise notice 'OK 10 · Un doble envío con la misma clave no duplica el movimiento';
end $$;

-- ------------------------------------------------------------- 5. Cálculos
:as_a
do $$
declare s record; bal bigint; bal_a1 bigint;
begin
  select balance_cents into bal from public.account_balances(t.get('hid')) where account_id = t.get('common');
  if bal <> 60000 + 40000 - 12034 then raise exception 'FALLO: saldo común para A = %', bal; end if;
  select balance_cents into bal_a1 from public.account_balances(t.get('hid')) where account_id = t.get('a1');
  if bal_a1 <> 200000 + 250000 - 4599 - 60000 then raise exception 'FALLO: saldo A1 = %', bal_a1; end if;

  select * into s from public.period_summary(t.get('hid'), '2026-11-01', '2026-11-30');
  -- A ve: su gasto personal 45,99 + gasto común 120,34. Aportaciones NO son gasto.
  if s.expense_cents <> 4599 + 12034 then raise exception 'FALLO: gasto A = %', s.expense_cents; end if;
  if s.personal_expense_cents <> 4599 or s.shared_expense_cents <> 12034 then raise exception 'FALLO: reparto personal/compartido A'; end if;
  if s.contribution_cents <> 100000 then raise exception 'FALLO: aportaciones = %', s.contribution_cents; end if;
  if s.income_cents <> 250000 or s.savings_cents <> 250000 - 4599 - 12034 then raise exception 'FALLO: ingresos/ahorro A'; end if;
  raise notice 'OK 11 · Saldos y resumen correctos para A (aportaciones fuera del gasto)';
end $$;

:as_b
do $$
declare s record; bal bigint; n int;
begin
  select balance_cents into bal from public.account_balances(t.get('hid')) where account_id = t.get('common');
  if bal <> 87966 then raise exception 'FALLO: saldo común para B = %', bal; end if;
  if exists (select 1 from public.account_balances(t.get('hid')) where account_id = t.get('a1')) then
    raise exception 'FALLO: B obtiene el saldo de la cuenta de A';
  end if;
  select * into s from public.period_summary(t.get('hid'), '2026-11-01', '2026-11-30');
  if s.expense_cents <> 1299 + 12034 or s.income_cents <> 0 then raise exception 'FALLO: resumen B % %', s.expense_cents, s.income_cents; end if;
  select count(*) into n from public.contributions_by_member(t.get('hid'), '2026-11-01', '2026-11-30');
  if n <> 2 then raise exception 'FALLO: aportaciones por miembro'; end if;
  if (select sum(net_worth_cents) from public.net_worth_series(t.get('hid'), '2026-11-01', '2026-11-30'))
     <> 87966 + 150000 - 40000 - 1299 then
    raise exception 'FALLO: patrimonio B';
  end if;
  raise notice 'OK 12 · B ve el mismo saldo común, nunca el saldo personal de A';
end $$;

-- --------------------------------------------------- 6. Externo y anónimo
:as_c
do $$ begin
  if (select count(*) from public.transactions) + (select count(*) from public.accounts)
     + (select count(*) from public.categories) + (select count(*) from public.household_members) <> 0 then
    raise exception 'FALLO: C ve datos del espacio';
  end if;
  if (select count(*) from public.account_balances(t.get('hid'))) <> 0 then raise exception 'FALLO: C obtiene saldos'; end if;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id)
    values (t.get('hid'), 'expense', 'shared', 100, '2026-11-06', 'Intruso', t.get('common'));
    raise exception 'FALLO: C insertó en el espacio';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.accounts (household_id, owner_id, name) values (t.get('hid'), auth.uid(), 'Intrusa');
    raise exception 'FALLO: C creó una cuenta en el espacio';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 13 · Un usuario externo no ve ni escribe nada';
end $$;

:as_anon
do $$ begin
  begin
    perform 1 from public.transactions;
    raise exception 'FALLO: anon lee transactions';
  exception when insufficient_privilege then null; end;
  begin
    perform public.create_household('x');
    raise exception 'FALLO: anon ejecuta RPC';
  exception when insufficient_privilege then null; end;
  raise notice 'OK 14 · Anónimo sin acceso a tablas ni RPC';
end $$;

-- ------------------------------------------------------ 7. Justificantes
:as_a
do $$
declare p_personal text := t.get('hid') || '/' || auth.uid() || '/ticket-camisa.pdf';
        p_shared   text := t.get('hid') || '/' || auth.uid() || '/ticket-mercadona.pdf';
begin
  insert into storage.objects (bucket_id, name) values ('attachments', p_personal), ('attachments', p_shared);
  insert into public.attachments (household_id, transaction_id, uploaded_by, storage_path, file_name, mime_type, size_bytes)
  values (t.get('hid'), t.get('tx_a_personal'), auth.uid(), p_personal, 'ticket-camisa.pdf', 'application/pdf', 1000),
         (t.get('hid'), t.get('tx_shared'),     auth.uid(), p_shared,   'ticket-mercadona.pdf', 'application/pdf', 1000);
end $$;
:as_b
do $$ begin
  if (select count(*) from public.attachments) <> 1 then raise exception 'FALLO: B ve justificantes personales de A'; end if;
  if (select count(*) from storage.objects) <> 1 then raise exception 'FALLO: B ve ficheros privados de A'; end if;
  begin
    insert into storage.objects (bucket_id, name)
    values ('attachments', t.get('hid') || '/aaaaaaaa-0000-0000-0000-000000000001/falso.pdf');
    raise exception 'FALLO: B subió a la carpeta de A';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 15 · Justificantes: B solo ve los de movimientos compartidos';
end $$;


-- ======================================================== FASE 2
-- Recurrentes ---------------------------------------------------------------
:as_a
\o /dev/null
with r as (insert into public.recurring_transactions (household_id, created_by, visibility, type, amount_cents, description, category_id, account_id, frequency, next_due_on)
  values (t.get('hid'), t.get('hid'), 'shared', 'expense', 85000, 'Alquiler', (select id from public.categories where name = 'Vivienda'), t.get('common'), 'monthly', '2026-10-01') returning id)
select t.put('rec', id) from r;
\o
do $$
declare n int; nd date;
begin
  perform public.register_recurring(t.get('rec'));
  perform public.register_recurring(t.get('rec'));
  select next_due_on into nd from public.recurring_transactions where id = t.get('rec');
  if nd <> '2026-12-01' then raise exception 'FALLO: próxima fecha %', nd; end if;
  select count(*) into n from public.transactions where recurring_id = t.get('rec');
  if n <> 2 then raise exception 'FALLO: recurrente generó % movimientos', n; end if;
  begin
    insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id, recurring_id)
    values (t.get('hid'), 'expense', 'shared', 85000, '2026-10-01', 'Alquiler', t.get('common'), t.get('rec'));
    raise exception 'FALLO: cuota duplicada';
  exception when unique_violation then null; end;
  begin
    insert into public.recurring_transactions (household_id, visibility, type, amount_cents, description, account_id, next_due_on)
    values (t.get('hid'), 'personal', 'expense', 100, 'x', t.get('common'), '2026-11-01');
    raise exception 'FALLO: recurrente personal en cuenta común';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 16 · Recurrentes: generan la cuota una sola vez y avanzan la fecha';
end $$;

:as_b
do $$ begin
  -- B puede registrar la cuota de un recurrente compartido de A
  perform public.register_recurring(t.get('rec'));
  if (select count(*) from public.transactions where recurring_id = t.get('rec')) <> 3 then raise exception 'FALLO: B no ve las cuotas'; end if;
  raise notice 'OK 17 · B gestiona los recurrentes compartidos';
end $$;

-- Viajes --------------------------------------------------------------------
:as_a
\o /dev/null
with x as (insert into public.trips (household_id, created_by, visibility, name, destination, budget_cents, start_date, end_date)
  values (t.get('hid'), t.get('hid'), 'shared', 'Roma', 'Italia', 150000, '2026-12-01', '2026-12-05') returning id)
select t.put('trip', id) from x;
with x as (insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id)
  values (t.get('hid'), 'expense', 'shared', 32000, '2026-11-10', 'Vuelos Roma', t.get('a1')) returning id)
select t.put('tx_vuelo', id) from x;
insert into public.trip_expenses (trip_id, transaction_id, created_by, trip_category) values (t.get('trip'), t.get('tx_vuelo'), t.get('hid'), 'flights');
\o
do $$ begin
  if (select trip_id from public.transactions where id = t.get('tx_vuelo')) <> t.get('trip') then raise exception 'FALLO: trip_id no sincronizado'; end if;
  begin
    insert into public.trip_expenses (trip_id, transaction_id, created_by) values (t.get('trip'), t.get('tx_a_personal'), auth.uid());
    raise exception 'FALLO: gasto personal en viaje compartido';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    update public.transactions set visibility = 'personal' where id = t.get('tx_vuelo');
    raise exception 'FALLO: gasto de viaje compartido pasado a personal';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 18 · Viajes: enlace sincronizado y gastos siempre compartidos';
end $$;
:as_b
do $$ begin
  if (select spent_cents from public.trip_summaries(t.get('hid')) where trip_id = t.get('trip')) <> 32000 then raise exception 'FALLO: total viaje para B'; end if;
  raise notice 'OK 19 · B ve el mismo total del viaje';
end $$;
:as_c
do $$ begin
  if (select count(*) from public.trips) + (select count(*) from public.trip_expenses) + (select count(*) from public.recurring_transactions) <> 0 then
    raise exception 'FALLO: C ve viajes o recurrentes';
  end if;
  raise notice 'OK 20 · Un externo no ve viajes ni recurrentes';
end $$;

-- Presupuestos --------------------------------------------------------------
:as_a
\o /dev/null
insert into public.budgets (household_id, owner_id, visibility, name, period, category_id, amount_cents, start_date)
values (t.get('hid'), t.get('hid'), 'shared', 'Súper', 'monthly', t.get('cat_super'), 40000, '2026-01-01'),
       (t.get('hid'), t.get('hid'), 'personal', 'Ropa', 'monthly', t.get('cat_ropa'), 10000, '2026-01-01'),
       (t.get('hid'), t.get('hid'), 'shared', 'Roma', 'custom', null, 150000, '2026-01-01');
update public.budgets set trip_id = t.get('trip') where name = 'Roma';
\o
do $$
declare s1 bigint; s2 bigint; s3 bigint;
begin
  select spent_cents into s1 from public.budget_progress(t.get('hid'), '2026-11-15') bp join public.budgets b on b.id = bp.budget_id where b.name = 'Súper';
  select spent_cents into s2 from public.budget_progress(t.get('hid'), '2026-11-15') bp join public.budgets b on b.id = bp.budget_id where b.name = 'Ropa';
  select spent_cents into s3 from public.budget_progress(t.get('hid'), '2026-11-15') bp join public.budgets b on b.id = bp.budget_id where b.name = 'Roma';
  if s1 <> 12034 or s2 <> 4599 or s3 <> 32000 then raise exception 'FALLO: presupuestos % % %', s1, s2, s3; end if;
  raise notice 'OK 21 · Presupuestos: compartido, personal y de viaje calculados bien';
end $$;
:as_b
do $$ begin
  if exists (select 1 from public.budgets where name = 'Ropa') then raise exception 'FALLO: B ve presupuesto personal de A'; end if;
  if (select count(*) from public.budget_progress(t.get('hid'), '2026-11-15')) <> 2 then raise exception 'FALLO: B ve progreso ajeno'; end if;
  raise notice 'OK 22 · B no ve los presupuestos personales de A';
end $$;

-- Borrar un movimiento enlazado a un viaje no falla
:as_a
do $$ begin
  delete from public.transactions where id = t.get('tx_vuelo');
  if exists (select 1 from public.trip_expenses where transaction_id = t.get('tx_vuelo')) then raise exception 'FALLO: enlace huérfano'; end if;
  raise notice 'OK 23 · Borrar un gasto de viaje elimina el enlace';
end $$;

-- =============================================================== Fase 3
-- Cartera: compra, dividendo, valoración y venta de un ETF personal de A
:as_a
\o /dev/null
select set_config('test.a1_before', (select balance_cents::text from public.account_balances(t.get('hid')) where account_id = t.get('a1')), false);
select set_config('test.inc_before', (select income_cents::text from public.period_summary(t.get('hid'), '2026-10-01', '2026-10-31')), false);
select set_config('test.exp_before', (select expense_cents::text from public.period_summary(t.get('hid'), '2026-10-01', '2026-10-31')), false);
with x as (insert into public.investments (household_id, owner_id, visibility, name, asset_type, account_id)
  values (t.get('hid'), t.get('hid'), 'personal', 'MSCI World', 'etf', t.get('a1')) returning id)
select t.put('etf', id) from x;
select t.put('op_buy', public.record_investment_operation(t.get('etf'), 'buy', '2026-10-01', null, 10, 50, 2, t.get('a1')));
select public.record_investment_operation(t.get('etf'), 'dividend', '2026-10-10', 1500, null, null, 0, t.get('a1'));
select public.record_investment_operation(t.get('etf'), 'valuation', '2026-10-15', null, null, 60);
select public.record_investment_operation(t.get('etf'), 'sell', '2026-10-20', null, 4, 62, 1, t.get('a1'));
\o
do $$
declare p record; bal bigint; s record;
begin
  select * into p from public.investment_positions(t.get('hid')) where investment_id = t.get('etf');
  if p.units <> 6 or p.cost_cents <> 30001 or p.value_cents <> 37200 or p.realized_cents <> 4798
     or p.income_cents <> 1500 or p.contributed_cents <> 50002 or p.withdrawn_cents <> 24799
     or p.total_return_cents <> 13497 then
    raise exception 'FALLO: posición %', row_to_json(p);
  end if;
  select balance_cents into bal from public.account_balances(t.get('hid')) where account_id = t.get('a1');
  if bal <> current_setting('test.a1_before')::bigint - 50002 + 1500 + 24799 then
    raise exception 'FALLO: saldo de la cuenta tras operar (%)', bal;
  end if;
  select * into s from public.period_summary(t.get('hid'), '2026-10-01', '2026-10-31');
  if s.expense_cents <> current_setting('test.exp_before')::bigint then raise exception 'FALLO: comprar o vender contó como gasto'; end if;
  if s.income_cents <> current_setting('test.inc_before')::bigint + 1500 then raise exception 'FALLO: el dividendo no cuenta como ingreso'; end if;
  if (select units from public.investments where id = t.get('etf')) <> 6
     or (select current_value_cents from public.investments where id = t.get('etf')) <> 37200 then
    raise exception 'FALLO: resumen de la inversión no actualizado';
  end if;
  raise notice 'OK 24 · Cartera: coste medio, plusvalía, dividendos y saldo de caja cuadran (sin contar como gasto)';
end $$;

do $$ begin
  begin
    perform public.record_investment_operation(t.get('etf'), 'sell', '2026-10-25', null, 7, 60, 0, t.get('a1'));
    raise exception 'FALLO: vendió más unidades de las que tiene';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    update public.transactions set amount_cents = 1 where id = (select transaction_id from public.investment_transactions where id = t.get('op_buy'));
    raise exception 'FALLO: editó el movimiento de caja de una operación';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    delete from public.transactions where id = (select transaction_id from public.investment_transactions where id = t.get('op_buy'));
    raise exception 'FALLO: borró el movimiento de caja de una operación';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    update public.investments set visibility = 'shared' where id = t.get('etf');
    raise exception 'FALLO: cambió la visibilidad de una inversión con operaciones';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.investments (household_id, owner_id, visibility, name, asset_type, account_id)
    values (t.get('hid'), t.get('hid'), 'personal', 'Mal', 'stock', t.get('common'));
    raise exception 'FALLO: inversión personal con cuenta compartida';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.investments (household_id, owner_id, visibility, name, asset_type, account_id)
    values (t.get('hid'), t.get('hid'), 'personal', 'Ajena', 'stock', t.get('b1'));
    raise exception 'FALLO: inversión con la cuenta personal de B';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 25 · No se puede vender de más, ni tocar la caja de una operación, ni usar cuentas no válidas';
end $$;

-- Depósito compartido financiado desde la cuenta común
\o /dev/null
with x as (insert into public.investments (household_id, owner_id, visibility, name, asset_type, account_id)
  values (t.get('hid'), t.get('hid'), 'shared', 'Depósito 12 meses', 'deposit', t.get('common')) returning id)
select t.put('dep', id) from x;
select public.record_investment_operation(t.get('dep'), 'buy', '2026-10-05', 30000, null, null, 0, t.get('common'));
select public.record_investment_operation(t.get('dep'), 'valuation', '2026-10-31', 30300);
\o
:as_b
do $$
declare p record;
begin
  if exists (select 1 from public.investments where id = t.get('etf')) then raise exception 'FALLO: B ve la inversión personal de A'; end if;
  if exists (select 1 from public.investment_transactions where investment_id = t.get('etf')) then raise exception 'FALLO: B ve operaciones de A'; end if;
  if exists (select 1 from public.transactions where description like '%MSCI%') then raise exception 'FALLO: B ve la caja de la inversión de A'; end if;
  if (select count(*) from public.investment_positions(t.get('hid'))) <> 1 then raise exception 'FALLO: B ve posiciones ajenas'; end if;
  select * into p from public.investment_positions(t.get('hid')) where investment_id = t.get('dep');
  if p.value_cents <> 30300 or p.total_return_cents <> 300 then raise exception 'FALLO: depósito compartido %', row_to_json(p); end if;
  if not exists (select 1 from public.transactions where description = 'Compra · Depósito 12 meses' and visibility = 'shared') then
    raise exception 'FALLO: B no ve el movimiento compartido del depósito';
  end if;
  raise notice 'OK 26 · B ve el depósito compartido (y su caja) pero no la cartera personal de A';
end $$;
:as_c
do $$ begin
  if (select count(*) from public.investments) + (select count(*) from public.investment_transactions) <> 0 then raise exception 'FALLO: C ve inversiones'; end if;
  if (select count(*) from public.investment_positions(t.get('hid'))) <> 0 then raise exception 'FALLO: C ve posiciones'; end if;
  raise notice 'OK 27 · Un externo no ve inversiones';
end $$;

-- Patrimonio = cuentas + cartera
:as_a
do $$
declare nw bigint; expected bigint;
begin
  select net_worth_cents into nw from public.net_worth_series(t.get('hid'), '2026-10-01', '2026-10-31');
  expected := (select sum(balance_cents) from public.account_balances(t.get('hid'), '2026-10-31'))
            + (select sum(value_cents) from public.investment_positions(t.get('hid'), '2026-10-31'));
  if nw <> expected then raise exception 'FALLO: patrimonio % <> %', nw, expected; end if;
  if (select sum(value_cents) from public.net_worth_breakdown(t.get('hid'), '2026-10-31')) <> expected then raise exception 'FALLO: desglose del patrimonio'; end if;
  raise notice 'OK 28 · El patrimonio suma cuentas y valor de la cartera';
end $$;

-- Patrimonio conjunto opcional
do $$
declare b_nw bigint; a_nw bigint;
begin
  select net_worth_cents into b_nw from public.household_net_worth(t.get('hid')) where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  if b_nw is not null then raise exception 'FALLO: A ve el patrimonio de B sin permiso'; end if;
  select net_worth_cents into a_nw from public.household_net_worth(t.get('hid')) where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if a_nw is null then raise exception 'FALLO: A no ve su propio patrimonio'; end if;
  if exists (select 1 from public.household_net_worth_series(t.get('hid'), '2026-10-01', '2026-11-30')) then
    raise exception 'FALLO: serie conjunta sin que todos compartan';
  end if;
  perform public.set_net_worth_sharing(t.get('hid'), true);
  raise notice 'OK 29 · Sin activarlo, nadie ve el total del otro';
end $$;
:as_b
do $$
declare a_nw bigint; b_expected bigint;
begin
  select net_worth_cents into a_nw from public.household_net_worth(t.get('hid')) where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if a_nw is null then raise exception 'FALLO: B no ve el total que A comparte'; end if;
  perform public.set_net_worth_sharing(t.get('hid'), true);
  -- B no puede tocar el permiso de A directamente
  update public.household_members set share_net_worth = false where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if not (select share_net_worth from public.household_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'FALLO: B cambió el permiso de A';
  end if;
  select sum(balance_cents) into b_expected from public.account_balances(t.get('hid')) b
    join public.accounts a on a.id = b.account_id where a.visibility = 'personal';
  if (select net_worth_cents from public.household_net_worth(t.get('hid')) where user_id = 'bbbbbbbb-0000-0000-0000-000000000002') <> b_expected then
    raise exception 'FALLO: patrimonio personal de B';
  end if;
  if (select count(*) from public.household_net_worth_series(t.get('hid'), '2026-10-01', '2026-11-30')) <> 6 then
    raise exception 'FALLO: serie conjunta (2 meses × 2 miembros + compartido)';
  end if;
  raise notice 'OK 30 · Con los dos activados se ve el total conjunto, sin ver cuentas ajenas';
end $$;
:as_c
do $$ begin
  begin
    perform public.household_net_worth(t.get('hid'));
    raise exception 'FALLO: C consultó el patrimonio del espacio';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 31 · Un externo no puede consultar el patrimonio conjunto';
end $$;

-- Borrar una operación borra su movimiento de caja
:as_a
do $$
declare tx uuid;
begin
  select transaction_id into tx from public.investment_transactions where id = t.get('op_buy');
  delete from public.investment_transactions where id = t.get('op_buy');
  if exists (select 1 from public.transactions where id = tx) then raise exception 'FALLO: quedó el movimiento de caja'; end if;
  if (select units from public.investments where id = t.get('etf')) <> 0 then raise exception 'FALLO: unidades no recalculadas'; end if;
  raise notice 'OK 32 · Borrar una operación elimina su caja y recalcula la posición';
end $$;

-- =============================================================== Periódicos
do $$ begin
  if public.next_occurrence('2026-01-31', 'monthly', 31) <> '2026-02-28'
     or public.next_occurrence('2026-02-28', 'monthly', 31) <> '2026-03-31'
     or public.next_occurrence('2026-11-13', 'weekly') <> '2026-11-20'
     or public.next_occurrence('2026-11-13', 'biweekly') <> '2026-11-27'
     or public.next_occurrence('2026-08-31', 'semiannual', 31) <> '2027-02-28'
     or public.next_occurrence('2026-11-30', 'bimonthly', 30) <> '2027-01-30' then
    raise exception 'FALLO: cálculo de la próxima fecha';
  end if;
  if public.monthly_equivalent(1200, 'weekly') <> 5200 or public.monthly_equivalent(60000, 'semiannual') <> 10000 then
    raise exception 'FALLO: equivalente mensual';
  end if;
  raise notice 'OK 33 · Periodicidades nuevas y el día 31 se conserva tras febrero';
end $$;

:as_a
\o /dev/null
with x as (insert into public.transactions (household_id, type, visibility, amount_cents, occurred_on, description, account_id, to_account_id)
  values (t.get('hid'), 'contribution', 'shared', 50000, (now() at time zone 'Europe/Madrid')::date - 21, 'Aportación semanal', t.get('a1'), t.get('common')) returning id)
select t.put('tx_rec', id) from x;
select t.put('rec', public.make_recurring_from_transaction(t.get('tx_rec'), 'weekly'));
\o
do $$
declare n int; m int;
begin
  if (select recurring_id from public.transactions where id = t.get('tx_rec')) <> t.get('rec') then raise exception 'FALLO: el movimiento no queda enlazado'; end if;
  n := public.register_due_recurring(t.get('hid'));
  if n <> 3 then raise exception 'FALLO: se apuntaron % cuotas (esperadas 3)', n; end if;
  m := public.register_due_recurring(t.get('hid'));
  if m <> 0 then raise exception 'FALLO: segunda pasada apuntó % cuotas', m; end if;
  if (select count(*) from public.transactions where recurring_id = t.get('rec')) <> 4 then raise exception 'FALLO: número de aportaciones'; end if;
  if (select next_due_on from public.recurring_transactions where id = t.get('rec')) <= (now() at time zone 'Europe/Madrid')::date then
    raise exception 'FALLO: la próxima fecha no avanzó';
  end if;
  begin
    perform public.make_recurring_from_transaction(t.get('tx_rec'), 'monthly');
    raise exception 'FALLO: un movimiento convertido dos veces';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.recurring_transactions (household_id, created_by, visibility, type, amount_cents, description, account_id, to_account_id, frequency, next_due_on)
    values (t.get('hid'), t.get('hid'), 'personal', 'contribution', 100, 'x', t.get('a1'), t.get('a1'), 'monthly', '2026-12-01');
    raise exception 'FALLO: aportación periódica a una cuenta personal';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  begin
    insert into public.recurring_transactions (household_id, created_by, visibility, type, amount_cents, description, account_id, frequency, next_due_on)
    values (t.get('hid'), t.get('hid'), 'personal', 'transfer', 100, 'x', t.get('a1'), 'monthly', '2026-12-01');
    raise exception 'FALLO: transferencia periódica sin destino';
  exception when others then if sqlerrm like 'FALLO%' then raise; end if; end;
  raise notice 'OK 34 · Un movimiento se hace periódico y las cuotas vencidas se apuntan una sola vez';
end $$;
:as_b
do $$ begin
  if public.register_due_recurring(t.get('hid')) <> 0 then raise exception 'FALLO: B duplicó cuotas'; end if;
  if (select count(*) from public.transactions where recurring_id = t.get('rec')) <> 4 then raise exception 'FALLO: B no ve las aportaciones periódicas compartidas'; end if;
  raise notice 'OK 35 · B ve las aportaciones periódicas y no se duplican al abrir la app';
end $$;
:as_c
do $$ begin
  if public.register_due_recurring(t.get('hid')) <> 0 then raise exception 'FALLO: C registró cuotas ajenas'; end if;
  raise notice 'OK 36 · Un externo no puede apuntar periódicos ajenos';
end $$;

reset role;
\echo 'TODAS LAS PRUEBAS DE RLS SUPERADAS'
