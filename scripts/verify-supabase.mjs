// Verificación de extremo a extremo contra el proyecto Supabase real, usando
// SOLO la clave publishable (igual que el navegador). Crea tres usuarios de
// prueba (A y B pareja, C externo) y comprueba persistencia y RLS.
//   node --env-file=.env.local scripts/verify-supabase.mjs
// Requiere "Confirm email" desactivado mientras se ejecuta.
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')

const stamp = Date.now().toString(36)
const pass = `Prueba-${stamp}-x9!`
let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('OK   ', msg)
  else { failures++; console.log('FALLO', msg) }
}
const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

async function newUser(tag, name) {
  const c = createClient(url, key, { auth: { persistSession: false } })
  const email = `ourfinance.test.${tag}.${stamp}@gmail.com`
  const r = await c.auth.signUp({ email, password: pass, options: { data: { full_name: name } } })
  if (r.error) throw new Error(`signUp ${tag}: ${r.error.message}`)
  if (!r.data.session) throw new Error(`signUp ${tag}: sin sesión (¿"Confirm email" sigue activado?)`)
  return { c, id: r.data.user.id, email }
}

const A = await newUser('a', 'Prueba A')
const B = await newUser('b', 'Prueba B')
const C = await newUser('c', 'Prueba C')
const anon = createClient(url, key, { auth: { persistSession: false } })

// Espacio e invitación
const hid = must(await A.c.rpc('create_household', { p_name: `Prueba ${stamp}` }), 'create_household')
const common = must(await A.c.from('accounts').select('*').eq('household_id', hid).eq('kind', 'common').single(), 'common')
ok(common.visibility === 'shared', 'Se crea la cuenta común compartida')
const cats = must(await A.c.from('categories').select('id,name,parent_id,kind').eq('household_id', hid), 'categories')
ok(cats.length >= 50, `Categorías por defecto (${cats.length})`)

const token = must(await A.c.rpc('create_invitation', { p_household: hid, p_email: B.email }), 'invitation')
ok((await C.c.rpc('accept_invitation', { p_token: token })).error, 'C no puede aceptar una invitación para otro email')
must(await B.c.rpc('accept_invitation', { p_token: token }), 'accept')
ok((await B.c.rpc('accept_invitation', { p_token: token })).error, 'La invitación es de un solo uso')
const membersB = must(await B.c.from('household_members').select('*').eq('household_id', hid), 'members')
ok(membersB.length === 2, 'B es miembro y ve a los dos miembros')

// Cuentas
const a1 = must(await A.c.from('accounts').insert({ household_id: hid, owner_id: A.id, name: 'Nómina A', opening_balance_cents: 200000 }).select().single(), 'a1')
const b1 = must(await B.c.from('accounts').insert({ household_id: hid, owner_id: B.id, name: 'Nómina B', opening_balance_cents: 150000 }).select().single(), 'b1')
ok((await B.c.from('accounts').select('id').eq('id', a1.id)).data.length === 0, 'B no ve la cuenta personal de A')

// Movimientos
const super_ = cats.find((c) => c.name === 'Alimentación')
const reqId = crypto.randomUUID()
const txA = must(await A.c.from('transactions').insert({ household_id: hid, type: 'expense', visibility: 'personal', amount_cents: 4599, occurred_on: '2026-11-02', description: 'Camisa', account_id: a1.id }).select().single(), 'txA')
must(await A.c.from('transactions').insert({ household_id: hid, type: 'contribution', visibility: 'shared', amount_cents: 60000, occurred_on: '2026-11-01', description: 'Aportación', account_id: a1.id, to_account_id: common.id, client_request_id: reqId }), 'contrib A')
const dup = await A.c.from('transactions').insert({ household_id: hid, type: 'contribution', visibility: 'shared', amount_cents: 60000, occurred_on: '2026-11-01', description: 'Aportación', account_id: a1.id, to_account_id: common.id, client_request_id: reqId })
ok(dup.error?.code === '23505', 'Un doble envío no duplica el movimiento')
must(await B.c.from('transactions').insert({ household_id: hid, type: 'contribution', visibility: 'shared', amount_cents: 40000, occurred_on: '2026-11-01', description: 'Aportación', account_id: b1.id, to_account_id: common.id }), 'contrib B')
const shared = must(await A.c.from('transactions').insert({ household_id: hid, type: 'expense', visibility: 'shared', amount_cents: 12034, occurred_on: '2026-11-05', description: 'Mercadona', category_id: super_.id, account_id: common.id }).select().single(), 'shared')

const seenB = must(await B.c.from('transactions').select('id, visibility, created_by').eq('household_id', hid), 'seenB')
ok(seenB.length === 3 && !seenB.some((t) => t.id === txA.id), 'B ve los 3 compartidos y no el gasto personal de A')
ok(seenB.every((t) => [A.id, B.id].includes(t.created_by)), 'El autor se registra desde la sesión')
const upd = await B.c.from('transactions').update({ amount_cents: 1 }).eq('id', txA.id).select()
ok(!upd.error && upd.data.length === 0, 'B no puede modificar el gasto personal de A')
const del = await B.c.from('transactions').delete().eq('id', txA.id).select()
ok(!del.error && del.data.length === 0, 'B no puede borrar el gasto personal de A')
ok((await B.c.from('transactions').insert({ household_id: hid, type: 'expense', visibility: 'shared', amount_cents: 100, occurred_on: '2026-11-06', description: 'x', account_id: a1.id })).error, 'B no puede usar la cuenta de A')
ok((await B.c.from('transactions').insert({ household_id: hid, type: 'expense', visibility: 'personal', amount_cents: 100, occurred_on: '2026-11-06', description: 'x', account_id: common.id })).error, 'No hay gastos personales ocultos en la cuenta común')
const upShared = await B.c.from('transactions').update({ notes: 'revisado por B' }).eq('id', shared.id).select()
ok(upShared.data?.length === 1, 'B puede gestionar un movimiento compartido')

// Cálculos
const balA = must(await A.c.rpc('account_balances', { p_household: hid }), 'balA')
const balB = must(await B.c.rpc('account_balances', { p_household: hid }), 'balB')
const cA = balA.find((b) => b.account_id === common.id)?.balance_cents
const cB = balB.find((b) => b.account_id === common.id)?.balance_cents
ok(Number(cA) === 87966 && Number(cB) === 87966, `Saldo común idéntico para los dos: ${cA} / ${cB} (esperado 87966)`)
ok(!balB.some((b) => b.account_id === a1.id), 'B no obtiene el saldo personal de A')
const [sA] = must(await A.c.rpc('period_summary', { p_household: hid, p_from: '2026-11-01', p_to: '2026-11-30' }), 'sumA')
ok(Number(sA.expense_cents) === 4599 + 12034 && Number(sA.contribution_cents) === 100000, 'Las aportaciones no cuentan como gasto')

// Externo y anónimo
const cSees = (await C.c.from('transactions').select('id').eq('household_id', hid)).data.length
  + (await C.c.from('accounts').select('id').eq('household_id', hid)).data.length
ok(cSees === 0, 'Un usuario externo no ve nada')
ok((await C.c.from('transactions').insert({ household_id: hid, type: 'expense', visibility: 'shared', amount_cents: 100, occurred_on: '2026-11-06', description: 'x', account_id: common.id })).error, 'Un externo no puede escribir')
ok((await anon.from('transactions').select('id')).error, 'Anónimo sin acceso')

// Justificantes
const path = `${hid}/${A.id}/${crypto.randomUUID()}-ticket.pdf`
const pdf = new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' })
must(await A.c.storage.from('attachments').upload(path, pdf, { contentType: 'application/pdf' }), 'upload')
must(await A.c.from('attachments').insert({ household_id: hid, transaction_id: txA.id, uploaded_by: A.id, storage_path: path, file_name: 'ticket.pdf', mime_type: 'application/pdf', size_bytes: 15 }), 'attachment row')
ok((await B.c.storage.from('attachments').download(path)).error, 'B no puede descargar el justificante de un gasto personal de A')
ok(!(await A.c.storage.from('attachments').download(path)).error, 'A sí puede descargar su justificante')
ok((await B.c.storage.from('attachments').upload(`${hid}/${A.id}/falso.pdf`, pdf, { contentType: 'application/pdf' })).error, 'B no puede subir a la carpeta de A')

// Fase 3: cartera, patrimonio y patrimonio conjunto
const balBefore = must(await A.c.rpc('account_balances', { p_household: hid }), 'bal').find((b) => b.account_id === a1.id).balance_cents
const [sumBefore] = must(await A.c.rpc('period_summary', { p_household: hid, p_from: '2026-10-01', p_to: '2026-10-31' }), 'sum')
const etf = must(await A.c.from('investments').insert({ household_id: hid, owner_id: A.id, name: 'ETF prueba', asset_type: 'etf', visibility: 'personal', account_id: a1.id }).select().single(), 'etf')
must(await A.c.rpc('record_investment_operation', { p_investment: etf.id, p_type: 'buy', p_on: '2026-10-01', p_amount_cents: null, p_units: '10', p_unit_price: '50', p_fee_cents: 2, p_cash_account: a1.id }), 'buy')
must(await A.c.rpc('record_investment_operation', { p_investment: etf.id, p_type: 'dividend', p_on: '2026-10-10', p_amount_cents: 1500, p_cash_account: a1.id }), 'dividend')
must(await A.c.rpc('record_investment_operation', { p_investment: etf.id, p_type: 'valuation', p_on: '2026-10-15', p_amount_cents: null, p_unit_price: '60' }), 'valuation')
must(await A.c.rpc('record_investment_operation', { p_investment: etf.id, p_type: 'sell', p_on: '2026-10-20', p_amount_cents: null, p_units: '4', p_unit_price: '62', p_fee_cents: 1, p_cash_account: a1.id }), 'sell')
const pos = must(await A.c.rpc('investment_positions', { p_household: hid }), 'positions').find((p) => p.investment_id === etf.id)
ok(Number(pos.units) === 6 && pos.value_cents === 37200 && pos.total_return_cents === 13497 && pos.realized_cents === 4798, `Cartera: unidades, valor y rentabilidad (${pos.value_cents} / ${pos.total_return_cents})`)
const balAfter = must(await A.c.rpc('account_balances', { p_household: hid }), 'bal').find((b) => b.account_id === a1.id).balance_cents
ok(balAfter === balBefore - 50002 + 1500 + 24799, 'La cuenta refleja compra, dividendo y venta')
const [sumAfter] = must(await A.c.rpc('period_summary', { p_household: hid, p_from: '2026-10-01', p_to: '2026-10-31' }), 'sum')
ok(sumAfter.expense_cents === sumBefore.expense_cents && sumAfter.income_cents === sumBefore.income_cents + 1500, 'Comprar/vender no es gasto; el dividendo sí es ingreso')
ok((await A.c.rpc('record_investment_operation', { p_investment: etf.id, p_type: 'sell', p_on: '2026-10-25', p_amount_cents: null, p_units: '7', p_unit_price: '60', p_cash_account: a1.id })).error, 'No se puede vender más de lo que se tiene')
const cashTx = must(await A.c.from('investment_transactions').select('transaction_id').eq('investment_id', etf.id).eq('type', 'buy').single(), 'link').transaction_id
ok((await A.c.from('transactions').update({ amount_cents: 1 }).eq('id', cashTx)).error, 'El movimiento de caja de una operación no se edita desde Movimientos')
ok((await B.c.from('investments').select('id').eq('id', etf.id)).data.length === 0, 'B no ve la inversión personal de A')
ok(must(await B.c.rpc('investment_positions', { p_household: hid }), 'posB').length === 0, 'B no ve posiciones ajenas')
ok((await C.c.rpc('investment_positions', { p_household: hid })).data.length === 0, 'C no ve la cartera')
const [nw] = must(await A.c.rpc('net_worth_series', { p_household: hid, p_from: '2026-10-01', p_to: '2026-10-31' }), 'nw')
const accSum = must(await A.c.rpc('account_balances', { p_household: hid, p_at: '2026-10-31' }), 'b').reduce((s, b) => s + b.balance_cents, 0)
ok(nw.net_worth_cents === accSum + 37200, 'El patrimonio suma cuentas y cartera')
const jointB0 = must(await B.c.rpc('household_net_worth', { p_household: hid }), 'jointB')
ok(jointB0.find((r) => r.user_id === A.id).net_worth_cents === null, 'Sin activarlo, B no ve el total de A')
must(await A.c.rpc('set_net_worth_sharing', { p_household: hid, p_share: true }), 'share A')
const jointB1 = must(await B.c.rpc('household_net_worth', { p_household: hid }), 'jointB')
ok(jointB1.find((r) => r.user_id === A.id).net_worth_cents > 0, 'Con el permiso de A, B ve solo su total')
ok(must(await B.c.rpc('household_net_worth_series', { p_household: hid, p_from: '2026-10-01', p_to: '2026-11-30' }), 's').length === 0, 'La serie conjunta espera a que los dos compartan')
must(await B.c.rpc('set_net_worth_sharing', { p_household: hid, p_share: true }), 'share B')
ok(must(await A.c.rpc('household_net_worth_series', { p_household: hid, p_from: '2026-10-01', p_to: '2026-11-30' }), 's').length === 6, 'Serie conjunta con los dos activados')
ok((await C.c.rpc('household_net_worth', { p_household: hid })).error, 'C no puede consultar el patrimonio del espacio')
await B.c.from('household_members').update({ share_net_worth: false }).eq('user_id', A.id)
ok(must(await A.c.from('household_members').select('share_net_worth').eq('user_id', A.id).single(), 'm').share_net_worth === true, 'B no puede cambiar el permiso de A')
ok(must(await A.c.rpc('top_subcategories', { p_household: hid, p_from: '2026-11-01', p_to: '2026-11-30' }), 'top').length > 0, 'Analítica: top de subcategorías')

// Limpieza: borra el espacio de prueba (cascada). Los usuarios de prueba quedan en Auth.
await A.c.storage.from('attachments').remove([path])
const cleanup = await A.c.from('households').delete().eq('id', hid).select()
ok(cleanup.data?.length === 1, 'Limpieza del espacio de prueba')

console.log(failures ? `\n${failures} comprobaciones fallidas` : '\nTODO CORRECTO en Supabase')
console.log('Usuarios de prueba creados (puedes borrarlos en Authentication → Users):', A.email, B.email, C.email)
process.exit(failures ? 1 : 0)
