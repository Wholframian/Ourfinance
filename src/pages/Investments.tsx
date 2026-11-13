import { ArrowLeft, Lock, Pencil, Plus, Trash2, TrendingUp, Users } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DonutWithTable, NEUTRAL, SERIES } from '../components/charts'
import { PageHeader } from '../components/Layout'
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, Input, Modal, Money, PageLoader, Segmented, Select, StatCard, Textarea,
} from '../components/ui'
import { useAccounts, type AccountWithBalance } from '../hooks/data'
import {
  useDeleteInvestment, useDeleteOperation, useInvestmentOperations, useInvestments, usePositions, useRecordOperation, useSaveInvestment,
} from '../hooks/phase3'
import { formatDate, isValidISODate, todayISO } from '../lib/dates'
import {
  formatCents, formatPrice, formatQuantity, formatSignedPercent, parseAmountToCents, parseDecimal,
} from '../lib/money'
import {
  ACCOUNT_KIND_LABEL, ASSET_TYPE_LABEL, INV_TX_LABEL, UNITLESS_ASSETS,
  type AssetType, type Investment, type InvestmentOperation, type InvestmentTxType, type Position, type Visibility,
} from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'

/** Color fijo por tipo de activo (sigue a la entidad, no al orden) */
export const ASSET_COLOR: Record<AssetType, string> = {
  etf: SERIES[0], stock: SERIES[1], fund: SERIES[2], crypto: SERIES[3], deposit: SERIES[4], savings_account: SERIES[6], other: NEUTRAL,
}

const isUnitless = (t: AssetType) => UNITLESS_ASSETS.includes(t)

/** Etiqueta de la operación según el tipo de activo (en un depósito no se "compra") */
function opLabel(type: InvestmentTxType, asset: AssetType) {
  if (isUnitless(asset) && type === 'buy') return 'Aportación'
  if (isUnitless(asset) && type === 'sell') return 'Retirada'
  return INV_TX_LABEL[type]
}

function ReturnText({ cents, base, className = '' }: { cents: number; base: number; className?: string }) {
  const tone = cents > 0 ? 'text-emerald-700' : cents < 0 ? 'text-red-600' : 'text-slate-500'
  return (
    <span className={`tabular ${tone} ${className}`}>
      {cents > 0 ? '+' : cents < 0 ? '−' : ''}{formatCents(Math.abs(cents))}
      {base > 0 && <span className="ml-1 text-xs">({formatSignedPercent(cents, base)})</span>}
    </span>
  )
}

function VisibilityBadge({ v }: { v: Visibility }) {
  return (
    <Badge tone={v === 'shared' ? 'brand' : 'slate'}>
      {v === 'shared' ? <Users className="mr-1 size-3" /> : <Lock className="mr-1 size-3" />}
      {v === 'shared' ? 'Compartida' : 'Personal'}
    </Badge>
  )
}

/** Cuentas desde las que se puede pagar o cobrar una operación */
function cashAccountsFor(accounts: AccountWithBalance[], visibility: Visibility, userId: string | undefined) {
  return accounts.filter((a) => !a.is_archived && (
    a.visibility === 'personal' ? a.owner_id === userId : visibility === 'shared'
  ))
}

// =============================================================== Cartera
export function InvestmentsPage() {
  const investments = useInvestments()
  const positions = usePositions()
  const accounts = useAccounts()
  const [creating, setCreating] = useState(false)

  const posById = useMemo(() => new Map((positions.data ?? []).map((p) => [p.investment_id, p])), [positions.data])
  const list = investments.data ?? []
  const totals = (positions.data ?? []).reduce(
    (t, p) => ({
      value: t.value + p.value_cents,
      contributed: t.contributed + p.contributed_cents,
      net: t.net + p.contributed_cents - p.withdrawn_cents,
      ret: t.ret + p.total_return_cents,
      income: t.income + p.income_cents,
    }),
    { value: 0, contributed: 0, net: 0, ret: 0, income: 0 },
  )
  const byType = Object.entries(
    list.reduce<Record<string, number>>((m, i) => {
      m[i.asset_type] = (m[i.asset_type] ?? 0) + (posById.get(i.id)?.value_cents ?? 0)
      return m
    }, {}),
  ).map(([k, v]) => ({ name: ASSET_TYPE_LABEL[k as AssetType], value: v, color: ASSET_COLOR[k as AssetType] }))
    .sort((a, b) => b.value - a.value)

  const brokers = (accounts.data ?? []).filter((a) => a.kind === 'investment' && !a.is_archived)
  const loading = investments.isLoading || positions.isLoading

  return (
    <>
      <PageHeader title="Inversiones" subtitle="Cartera, rentabilidad y patrimonio"
        actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" />Nueva inversión</Button>} />
      <ErrorBox error={investments.error ?? positions.error} onRetry={() => { investments.refetch(); positions.refetch() }} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1">
          <StatCard tone="brand" label="Valor de la cartera" icon={<TrendingUp className="size-3.5" />} cents={loading ? undefined : totals.value}
            hint={`${list.length} ${list.length === 1 ? 'inversión' : 'inversiones'}`} />
        </div>
        <StatCard label="Aportado neto" cents={loading ? undefined : totals.net} hint="Compras − ventas" />
        <StatCard label="Rentabilidad total" cents={loading ? undefined : totals.ret} tone={totals.ret >= 0 ? 'positive' : 'negative'}
          hint={totals.contributed ? `${formatSignedPercent(totals.ret, totals.contributed)} sobre lo aportado` : 'Sin aportaciones'} />
        <StatCard label="Dividendos e intereses" cents={loading ? undefined : totals.income} hint="Ya incluidos en la rentabilidad" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Posiciones">
          {loading ? <PageLoader /> : !list.length ? (
            <EmptyState title="Todavía no hay inversiones" action={<Button onClick={() => setCreating(true)}><Plus className="size-4" />Añadir inversión</Button>}>
              Añade un ETF, acciones, criptomonedas, un fondo o un depósito y registra sus compras. Comprar no cuenta como gasto: el dinero pasa de tu cuenta a la cartera.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.map((i) => <PositionRow key={i.id} inv={i} pos={posById.get(i.id)} />)}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Distribución por tipo de activo">
            {loading ? <PageLoader /> : <DonutWithTable slices={byType} emptyText="Sin valor en cartera" />}
          </Card>
          <Card title="Cuentas de inversión">
            {brokers.length ? (
              <ul className="divide-y divide-slate-100">
                {brokers.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2.5 text-sm">
                    <span>{a.name} <span className="text-slate-400">· {a.institution ?? ACCOUNT_KIND_LABEL[a.kind]}</span></span>
                    <Money cents={a.balance_cents} className="font-semibold" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">
                Opcional: si tienes liquidez en un bróker, crea una cuenta de tipo «Inversión» en <Link to="/ajustes" className="underline">Ajustes</Link> y paga las compras desde ella.
              </p>
            )}
            <p className="mt-3 text-xs text-slate-500">El saldo en efectivo del bróker y el valor de la cartera se suman por separado al patrimonio, sin contarse dos veces.</p>
          </Card>
        </div>
      </div>

      {creating && <InvestmentForm investment={null} onClose={() => setCreating(false)} />}
    </>
  )
}

function PositionRow({ inv, pos }: { inv: Investment; pos: Position | undefined }) {
  const unitless = isUnitless(inv.asset_type)
  return (
    <li>
      <Link to={`/inversiones/${inv.id}`} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-slate-50">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: ASSET_COLOR[inv.asset_type] }} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{inv.name}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            {ASSET_TYPE_LABEL[inv.asset_type]}{inv.platform ? ` · ${inv.platform}` : ''}
            <VisibilityBadge v={inv.visibility} />
          </p>
          {pos && !unitless && pos.units ? (
            <p className="text-xs text-slate-500 tabular">{formatQuantity(pos.units)} × {formatPrice(pos.last_price)}</p>
          ) : null}
        </div>
        <div className="text-right">
          <Money cents={pos?.value_cents ?? 0} className="font-semibold" />
          <p className="text-xs">{pos ? <ReturnText cents={pos.total_return_cents} base={pos.contributed_cents} /> : null}</p>
        </div>
      </Link>
    </li>
  )
}

// =============================================================== Detalle
export function InvestmentDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { profileById } = useHousehold()
  const investments = useInvestments()
  const positions = usePositions()
  const ops = useInvestmentOperations(id)
  const delInv = useDeleteInvestment()
  const delOp = useDeleteOperation()
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState<InvestmentTxType | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deletingOp, setDeletingOp] = useState<InvestmentOperation | null>(null)

  const inv = investments.data?.find((i) => i.id === id)
  const pos = positions.data?.find((p) => p.investment_id === id)
  if (investments.isLoading) return <PageLoader />
  if (!inv) {
    return (
      <Card><EmptyState title="Inversión no encontrada" action={<Link to="/inversiones" className="underline">Volver a la cartera</Link>}>
        Puede que se haya eliminado o que sea personal de otro miembro.
      </EmptyState></Card>
    )
  }
  const unitless = isUnitless(inv.asset_type)
  const canEdit = inv.visibility === 'shared' || inv.owner_id === user?.id
  const owner = profileById(inv.owner_id)?.full_name

  return (
    <>
      <Link to="/inversiones" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" />Cartera</Link>
      <PageHeader
        title={inv.name}
        subtitle={`${ASSET_TYPE_LABEL[inv.asset_type]}${inv.platform ? ` · ${inv.platform}` : ''}${inv.visibility === 'shared' && owner ? ` · creada por ${owner}` : ''}`}
        actions={canEdit && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" />Editar</Button>
            <Button variant="secondary" onClick={() => setDeleting(true)} aria-label="Eliminar inversión"><Trash2 className="size-4" /></Button>
          </div>
        )}
      />
      <ErrorBox error={positions.error ?? ops.error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1">
          <StatCard tone="brand" label="Valor actual" cents={pos?.value_cents}
            hint={pos?.valued_on ? `Precio del ${formatDate(pos.valued_on)}` : 'Sin operaciones'} />
        </div>
        <StatCard label={unitless ? 'Capital' : 'Coste de lo que tienes'} cents={pos?.cost_cents}
          hint={!unitless && pos?.units ? `${formatQuantity(pos.units)} uds · medio ${formatPrice(pos.cost_cents / 100 / pos.units)}` : undefined} />
        <StatCard label="Rentabilidad total" cents={pos?.total_return_cents} tone={(pos?.total_return_cents ?? 0) >= 0 ? 'positive' : 'negative'}
          hint={pos?.contributed_cents ? formatSignedPercent(pos.total_return_cents, pos.contributed_cents) + ' sobre lo aportado' : undefined} />
        <StatCard label="Realizado + rentas" cents={pos ? pos.realized_cents + pos.income_cents - pos.fees_cents : undefined}
          hint={pos ? `Ventas ${formatCents(pos.realized_cents)} · rentas ${formatCents(pos.income_cents)}` : undefined} />
      </div>

      {canEdit && (
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => setAdding('buy')}><Plus className="size-4" />{opLabel('buy', inv.asset_type)}</Button>
          <Button variant="secondary" onClick={() => setAdding('sell')}>{opLabel('sell', inv.asset_type)}</Button>
          <Button variant="secondary" onClick={() => setAdding('valuation')}>Actualizar valor</Button>
          <Button variant="secondary" onClick={() => setAdding(unitless ? 'interest' : 'dividend')}>{unitless ? 'Intereses' : 'Dividendo'}</Button>
          <Button variant="ghost" onClick={() => setAdding('fee')}>Comisión</Button>
        </div>
      )}

      <Card className="mt-6" title="Operaciones">
        {ops.isLoading ? <PageLoader /> : !ops.data?.length ? (
          <EmptyState title="Sin operaciones">Registra la primera {unitless ? 'aportación' : 'compra'} para empezar a seguir la rentabilidad.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {ops.data.map((o) => (
              <li key={o.id} className="flex items-center gap-3 py-3 text-sm">
                <div className="w-20 shrink-0 text-xs text-slate-500 tabular">{formatDate(o.occurred_on)}</div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{opLabel(o.type, inv.asset_type)}</p>
                  <p className="truncate text-xs text-slate-500">
                    {o.units ? `${formatQuantity(o.units)} × ${formatPrice(o.unit_price)}` : o.type === 'valuation' && o.unit_price ? `Precio ${formatPrice(o.unit_price)}` : ''}
                    {o.fee_cents ? ` · comisión ${formatCents(o.fee_cents)}` : ''}
                    {o.transaction_id ? ' · con movimiento de caja' : ''}
                    {o.notes ? ` · ${o.notes}` : ''}
                  </p>
                </div>
                <Money cents={o.amount_cents} className={o.type === 'valuation' ? 'text-slate-500' : 'font-medium'} />
                {canEdit && (
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar operación" onClick={() => setDeletingOp(o)}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Rentabilidad = valor actual + ventas + rentas − comisiones − lo aportado. El coste usa el método de precio medio.
          {inv.quote_symbol ? ` Símbolo: ${inv.quote_symbol}.` : ''}
        </p>
      </Card>

      {editing && <InvestmentForm investment={inv} onClose={() => setEditing(false)} />}
      {adding && <OperationForm inv={inv} pos={pos} initialType={adding} onClose={() => setAdding(null)} />}
      <ConfirmDialog open={deleting} title="Eliminar inversión"
        message={<p>¿Eliminar <strong>{inv.name}</strong> y todas sus operaciones? Los movimientos de caja enlazados también se eliminan, así que el saldo de tus cuentas volverá a como estaba antes de invertir.</p>}
        loading={delInv.isPending} error={delInv.error} onCancel={() => { setDeleting(false); delInv.reset() }}
        onConfirm={() => delInv.mutateAsync(inv.id).then(() => navigate('/inversiones')).catch(() => undefined)} />
      <ConfirmDialog open={!!deletingOp} title="Eliminar operación"
        message={<p>¿Eliminar esta {deletingOp && opLabel(deletingOp.type, inv.asset_type).toLowerCase()} de {deletingOp && formatCents(deletingOp.amount_cents)}?{deletingOp?.transaction_id ? ' También se elimina su movimiento de caja.' : ''}</p>}
        loading={delOp.isPending} error={delOp.error} onCancel={() => { setDeletingOp(null); delOp.reset() }}
        onConfirm={() => deletingOp && delOp.mutateAsync(deletingOp.id).then(() => setDeletingOp(null)).catch(() => undefined)} />
    </>
  )
}

// =============================================================== Formularios
function InvestmentForm({ investment, onClose }: { investment: Investment | null; onClose: () => void }) {
  const save = useSaveInvestment()
  const accounts = useAccounts()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [name, setName] = useState(investment?.name ?? '')
  const [type, setType] = useState<AssetType>(investment?.asset_type ?? 'etf')
  const [visibility, setVisibility] = useState<Visibility>(investment?.visibility ?? 'personal')
  const [platform, setPlatform] = useState(investment?.platform ?? '')
  const [accountId, setAccountId] = useState(investment?.account_id ?? '')
  const [symbol, setSymbol] = useState(investment?.quote_symbol ?? '')
  const [notes, setNotes] = useState(investment?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const usable = cashAccountsFor(accounts.data ?? [], visibility, user?.id)
  // si la cuenta elegida es personal de otro miembro (inversión compartida), se conserva sin mostrarla
  const keepHidden = !!accountId && !usable.some((a) => a.id === accountId)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Ponle un nombre.')
    try {
      const id = await save.mutateAsync({
        id: investment?.id, name: name.trim(), asset_type: type, visibility, platform: platform.trim() || null,
        account_id: accountId || null, quote_symbol: symbol.trim().toUpperCase() || null, notes: notes.trim() || null,
      })
      onClose()
      if (!investment) navigate(`/inversiones/${id}`)
    } catch { /* abajo */ }
  }

  return (
    <Modal open onClose={onClose} title={investment ? 'Editar inversión' : 'Nueva inversión'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="inv-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="inv-form" className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" htmlFor="iname"><Input id="iname" maxLength={80} placeholder="p. ej. Vanguard Global" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Tipo de activo" htmlFor="itype" hint={investment ? 'No se puede cambiar si ya tiene operaciones.' : undefined}>
            <Select id="itype" value={type} onChange={(e) => setType(e.target.value as AssetType)}>
              {Object.entries(ASSET_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Visibilidad" hint={visibility === 'shared' ? 'Los dos la veis y podéis registrar operaciones.' : 'Solo tú la ves.'}>
          <Segmented value={visibility} onChange={(v) => { setVisibility(v); setAccountId('') }}
            options={[{ value: 'personal', label: 'Personal' }, { value: 'shared', label: 'Compartida' }]} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plataforma (opcional)" htmlFor="iplat"><Input id="iplat" maxLength={80} placeholder="p. ej. MyInvestor" value={platform} onChange={(e) => setPlatform(e.target.value)} /></Field>
          <Field label="Símbolo o ISIN (opcional)" htmlFor="isym" hint="Para identificarla; las cotizaciones se actualizan a mano con «Actualizar valor»."><Input id="isym" maxLength={40} placeholder="p. ej. IE00B3RBWM25" value={symbol} onChange={(e) => setSymbol(e.target.value)} /></Field>
        </div>
        <Field label="Cuenta habitual (opcional)" htmlFor="iacc" hint="Se propone al registrar compras y ventas.">
          <Select id="iacc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Ninguna</option>
            {keepHidden && <option value={accountId}>Cuenta de otro miembro</option>}
            {usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatCents(a.balance_cents)})</option>)}
          </Select>
        </Field>
        <Field label="Notas (opcional)" htmlFor="inotes"><Textarea id="inotes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}

function OperationForm({ inv, pos, initialType, onClose }: { inv: Investment; pos: Position | undefined; initialType: InvestmentTxType; onClose: () => void }) {
  const record = useRecordOperation()
  const accounts = useAccounts()
  const { user } = useAuth()
  const unitless = isUnitless(inv.asset_type)
  const [type, setType] = useState<InvestmentTxType>(initialType)
  const [date, setDate] = useState(todayISO())
  const [units, setUnits] = useState('')
  const [price, setPrice] = useState(!unitless && pos?.last_price ? String(pos.last_price).replace('.', ',') : '')
  const [amount, setAmount] = useState('')
  const [fee, setFee] = useState('')
  const usable = cashAccountsFor(accounts.data ?? [], inv.visibility, user?.id)
  const [cash, setCash] = useState(inv.account_id && usable.some((a) => a.id === inv.account_id) ? inv.account_id : '')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const clientRequestId = useMemo(() => crypto.randomUUID(), [])

  const byUnits = !unitless && (type === 'buy' || type === 'sell')
  const priceOnly = !unitless && type === 'valuation'
  const hasFee = type === 'buy' || type === 'sell' || type === 'dividend' || type === 'interest'
  const hasCash = type !== 'valuation'

  const u = parseDecimal(units, 10)
  const pr = parseDecimal(price, 8)
  const gross = byUnits && u && pr ? Math.round(Number(u) * Number(pr) * 100) : parseAmountToCents(amount) ?? 0
  const feeCents = hasFee ? parseAmountToCents(fee || '0') ?? 0 : 0
  const cashCents = type === 'buy' || type === 'fee' ? gross + feeCents : gross - feeCents

  const types: InvestmentTxType[] = unitless ? ['buy', 'sell', 'interest', 'fee', 'valuation'] : ['buy', 'sell', 'dividend', 'fee', 'valuation']

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!isValidISODate(date)) return setError('Fecha no válida.')
    if (byUnits) {
      if (!u || Number(u) <= 0) return setError('Unidades no válidas (hasta 10 decimales).')
      if (!pr) return setError('Precio por unidad no válido (hasta 8 decimales).')
      if (type === 'sell' && pos?.units != null && Number(u) > pos.units + 1e-10) return setError(`Solo tienes ${formatQuantity(pos.units)} unidades.`)
    } else if (priceOnly) {
      if (!pr) return setError('Precio actual no válido.')
    } else {
      const a = parseAmountToCents(amount)
      if (a === null || a < 0 || (type !== 'valuation' && a === 0)) return setError('Importe no válido.')
    }
    if (hasFee && parseAmountToCents(fee || '0') === null) return setError('Comisión no válida.')
    try {
      await record.mutateAsync({
        investmentId: inv.id, type, on: date,
        amountCents: byUnits || priceOnly ? null : parseAmountToCents(amount),
        units: byUnits ? u : null, unitPrice: byUnits || priceOnly ? pr : null,
        feeCents, cashAccountId: hasCash ? cash || null : null, notes: notes.trim() || null, clientRequestId,
      })
      onClose()
    } catch { /* abajo */ }
  }

  const cashHint = {
    buy: 'Sale de la cuenta como movimiento «Inversión»: no cuenta como gasto.',
    sell: 'Entra en la cuenta como movimiento «Inversión»: no cuenta como ingreso.',
    dividend: 'Entra como ingreso (Intereses y dividendos).',
    interest: 'Entra como ingreso (Intereses y dividendos).',
    fee: 'Sale de la cuenta; reduce la rentabilidad de la inversión.',
    valuation: '',
  }[type]

  return (
    <Modal open onClose={onClose} title={`${opLabel(type, inv.asset_type)} · ${inv.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="op-form" loading={record.isPending}>Guardar</Button></>}>
      <form id="op-form" className="space-y-4" onSubmit={submit} noValidate>
        <Segmented value={type} onChange={setType} className="w-full"
          options={types.map((t) => ({ value: t, label: t === 'valuation' ? 'Valor' : opLabel(t, inv.asset_type) }))} />
        {type === 'valuation' && (
          <p className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {unitless ? 'Indica el saldo actual del producto (con los intereses que se hayan sumado).' : 'Indica la cotización actual. No mueve dinero; solo actualiza el valor de la cartera.'}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fecha" htmlFor="op-date" hint={formatDate(date)}><Input id="op-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          {byUnits ? (
            <Field label="Unidades" htmlFor="op-units" hint={type === 'sell' && pos?.units != null ? `Tienes ${formatQuantity(pos.units)}` : undefined}>
              <Input id="op-units" inputMode="decimal" placeholder="0,00" value={units} onChange={(e) => setUnits(e.target.value)} autoFocus />
            </Field>
          ) : priceOnly ? (
            <Field label="Precio actual por unidad (€)" htmlFor="op-price"><Input id="op-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus /></Field>
          ) : (
            <Field label={type === 'valuation' ? 'Valor actual (€)' : 'Importe (€)'} htmlFor="op-amount">
              <Input id="op-amount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </Field>
          )}
        </div>
        {byUnits && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Precio por unidad (€)" htmlFor="op-price"><Input id="op-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
            <Field label="Importe" hint="Unidades × precio"><p className="flex h-11 items-center font-semibold tabular">{formatCents(gross)}</p></Field>
          </div>
        )}
        {priceOnly && pos?.units ? <p className="text-sm text-slate-600">Valor resultante: <strong className="tabular">{formatCents(Math.round(pos.units * Number(pr ?? 0) * 100))}</strong> ({formatQuantity(pos.units)} uds)</p> : null}
        {hasFee && (
          <Field label="Comisión (€, opcional)" htmlFor="op-fee"><Input id="op-fee" inputMode="decimal" placeholder="0,00" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        )}
        {hasCash && (
          <Field label={type === 'buy' || type === 'fee' ? 'Pagado desde' : 'Cobrado en'} htmlFor="op-cash"
            hint={cash ? `${formatCents(Math.max(cashCents, 0))}. ${cashHint}` : 'Sin cuenta: solo se registra en la cartera (útil para cargar posiciones que ya tenías).'}>
            <Select id="op-cash" value={cash} onChange={(e) => setCash(e.target.value)}>
              <option value="">Ninguna (no mueve dinero de tus cuentas)</option>
              {usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatCents(a.balance_cents)})</option>)}
            </Select>
          </Field>
        )}
        <Field label="Notas (opcional)" htmlFor="op-notes"><Input id="op-notes" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorBox error={error ?? record.error} />
      </form>
    </Modal>
  )
}
