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

reset role;
\echo 'TODAS LAS PRUEBAS DE RLS SUPERADAS'
