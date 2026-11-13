import { CheckCircle2, Lock, Pencil, PiggyBank, Plus, Trash2, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { PageHeader } from '../components/Layout'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, Input, Modal, Money, PageLoader, ProgressBar, Segmented, Select } from '../components/ui'
import { useAccounts } from '../hooks/data'
import { useDeleteGoal, useGoals, useSaveGoal } from '../hooks/phase2'
import { formatDate, isValidISODate, parts, todayISO } from '../lib/dates'
import { centsToInput, formatCents, parseAmountToCents, formatPercent } from '../lib/money'
import { GOAL_TYPE_LABEL, type GoalType, type SavingsGoal, type Visibility } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'

/** Meses completos que faltan hasta una fecha (mínimo 1) */
function monthsUntil(target: string, from = todayISO()) {
  const a = parts(from), b = parts(target)
  return Math.max(1, (b.y - a.y) * 12 + (b.m - a.m))
}

export function GoalsPage() {
  const goals = useGoals()
  const accounts = useAccounts()
  const save = useSaveGoal()
  const del = useDeleteGoal()
  const { user } = useAuth()
  const [editing, setEditing] = useState<SavingsGoal | 'new' | null>(null)
  const [adding, setAdding] = useState<SavingsGoal | null>(null)
  const [deleting, setDeleting] = useState<SavingsGoal | null>(null)

  const accById = new Map((accounts.data ?? []).map((a) => [a.id, a]))
  const savedOf = (g: SavingsGoal) => (g.account_id && accById.has(g.account_id) ? Math.max(0, accById.get(g.account_id)!.balance_cents) : g.saved_cents)

  return (
    <>
      <PageHeader title="Objetivos de ahorro" subtitle="Fondo de emergencia, viajes, vivienda, inversión…" actions={<Button onClick={() => setEditing('new')}><Plus className="size-4" />Nuevo objetivo</Button>} />
      <ErrorBox error={goals.error ?? save.error} />
      {goals.isLoading ? <PageLoader /> : !goals.data?.length ? (
        <Card><EmptyState title="Sin objetivos" action={<Button onClick={() => setEditing('new')}><Plus className="size-4" />Crear objetivo</Button>}>
          Define cuánto queréis ahorrar y para cuándo. Puedes vincularlo a una cuenta de ahorro para que el progreso sea su saldo real.
        </EmptyState></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {goals.data.map((g) => {
            const saved = savedOf(g)
            const done = saved >= g.target_cents
            const remaining = Math.max(0, g.target_cents - saved)
            const perMonth = g.target_date && !done ? Math.ceil(remaining / monthsUntil(g.target_date)) : null
            const canEdit = g.visibility === 'shared' || g.owner_id === user?.id
            return (
              <Card key={g.id}>
                <div className="flex items-start gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><PiggyBank className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{g.name}</p>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      {GOAL_TYPE_LABEL[g.goal_type]}
                      <Badge tone={g.visibility === 'shared' ? 'brand' : 'slate'}>{g.visibility === 'shared' ? <Users className="mr-1 size-3" /> : <Lock className="mr-1 size-3" />}{g.visibility === 'shared' ? 'Compartido' : 'Personal'}</Badge>
                      {g.target_date && <span>· para el {formatDate(g.target_date)}</span>}
                    </p>
                  </div>
                  {canEdit && <div className="flex">
                    <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Editar" onClick={() => setEditing(g)}><Pencil className="size-4" /></button>
                    <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar" onClick={() => setDeleting(g)}><Trash2 className="size-4" /></button>
                  </div>}
                </div>
                <div className="mt-4 flex items-baseline justify-between">
                  <Money cents={saved} className="text-xl font-semibold" />
                  <span className="text-sm text-slate-500">de {formatCents(g.target_cents)} · {formatPercent(saved, g.target_cents)} %</span>
                </div>
                <div className="mt-2"><ProgressBar value={saved} max={g.target_cents} tone={done ? 'ok' : 'brand'} /></div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                  {done ? <span className="flex items-center gap-1.5 font-medium text-emerald-700"><CheckCircle2 className="size-4" />¡Objetivo conseguido!</span>
                    : <span className="text-slate-600">Faltan {formatCents(remaining)}{perMonth ? ` · ${formatCents(perMonth)}/mes para llegar a tiempo` : ''}</span>}
                  {canEdit && !g.account_id && !done && <Button size="sm" variant="secondary" onClick={() => setAdding(g)}>Añadir ahorro</Button>}
                </div>
                {g.account_id && <p className="mt-2 text-xs text-slate-500">Progreso = saldo de la cuenta «{accById.get(g.account_id)?.name ?? 'privada'}».</p>}
              </Card>
            )
          })}
        </div>
      )}
      {editing && <GoalForm goal={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {adding && <AddSavingForm goal={adding} onClose={() => setAdding(null)} />}
      <ConfirmDialog open={!!deleting} title="Eliminar objetivo" message={<p>¿Eliminar <strong>{deleting?.name}</strong>?</p>}
        loading={del.isPending} error={del.error} onCancel={() => { setDeleting(null); del.reset() }}
        onConfirm={() => deleting && del.mutateAsync(deleting.id).then(() => setDeleting(null)).catch(() => undefined)} />
    </>
  )
}

function AddSavingForm({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const save = useSaveGoal()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const cents = parseAmountToCents(amount)
    if (cents === null || cents === 0) return setError('Importe no válido (puedes usar negativo para corregir).')
    const next = Math.max(0, goal.saved_cents + cents)
    try { await save.mutateAsync({ id: goal.id, saved_cents: next, is_achieved: next >= goal.target_cents }); onClose() } catch { /* abajo */ }
  }
  return (
    <Modal open onClose={onClose} title={`Añadir ahorro · ${goal.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="add-saving" loading={save.isPending}>Guardar</Button></>}>
      <form id="add-saving" onSubmit={submit} className="space-y-3" noValidate>
        <Field label="Importe (€)" htmlFor="sav" hint="Esto actualiza el progreso del objetivo; no crea un movimiento. Para mover dinero entre cuentas usa una transferencia.">
          <Input id="sav" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}

function GoalForm({ goal, onClose }: { goal: SavingsGoal | null; onClose: () => void }) {
  const save = useSaveGoal()
  const accounts = useAccounts()
  const { user } = useAuth()
  const [name, setName] = useState(goal?.name ?? '')
  const [type, setType] = useState<GoalType>(goal?.goal_type ?? 'emergency')
  const [target, setTarget] = useState(goal ? centsToInput(goal.target_cents) : '')
  const [saved, setSaved] = useState(goal ? centsToInput(goal.saved_cents) : '0')
  const [date, setDate] = useState(goal?.target_date ?? '')
  const [visibility, setVisibility] = useState<Visibility>(goal?.visibility ?? 'shared')
  const [accountId, setAccountId] = useState(goal?.account_id ?? '')
  const [error, setError] = useState<string | null>(null)

  const usable = (accounts.data ?? []).filter((a) => !a.is_archived && (visibility === 'shared' ? a.visibility === 'shared' : a.owner_id === user?.id && a.visibility === 'personal'))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const t = parseAmountToCents(target)
    const s = parseAmountToCents(saved || '0')
    if (!name.trim()) return setError('Ponle un nombre.')
    if (!t || t <= 0) return setError('Objetivo no válido.')
    if (s === null || s < 0) return setError('Ahorrado no válido.')
    if (date && !isValidISODate(date)) return setError('Fecha no válida.')
    try {
      await save.mutateAsync({
        id: goal?.id, name: name.trim(), goal_type: type, target_cents: t, saved_cents: s, target_date: date || null,
        visibility, account_id: accountId || null, is_achieved: s >= t,
      })
      onClose()
    } catch { /* abajo */ }
  }

  return (
    <Modal open onClose={onClose} title={goal ? 'Editar objetivo' : 'Nuevo objetivo'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="goal-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="goal-form" className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" htmlFor="gname"><Input id="gname" maxLength={80} placeholder="p. ej. Colchón 6 meses" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Tipo" htmlFor="gtype">
            <Select id="gtype" value={type} onChange={(e) => setType(e.target.value as GoalType)}>
              {Object.entries(GOAL_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Objetivo (€)" htmlFor="gtarget"><Input id="gtarget" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
          <Field label="Fecha objetivo (opcional)" htmlFor="gdate"><Input id="gdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Visibilidad">
          <Segmented value={visibility} onChange={(v) => { setVisibility(v); setAccountId('') }} options={[{ value: 'shared', label: 'Compartido' }, { value: 'personal', label: 'Personal' }]} />
        </Field>
        <Field label="Cuenta vinculada (opcional)" htmlFor="gacc" hint="Si la vinculas, el progreso es el saldo real de esa cuenta.">
          <Select id="gacc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Ninguna: lo actualizo a mano</option>
            {usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatCents(a.balance_cents)})</option>)}
          </Select>
        </Field>
        {!accountId && <Field label="Ya ahorrado (€)" htmlFor="gsaved"><Input id="gsaved" inputMode="decimal" value={saved} onChange={(e) => setSaved(e.target.value)} /></Field>}
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}
