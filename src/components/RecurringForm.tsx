import { useMemo, useState, type FormEvent } from 'react'
import { CategoryOptions, parentCategoriesFor } from './CategoryOptions'
import { useAccounts, useCategories } from '../hooks/data'
import { useSaveRecurring } from '../hooks/phase2'
import { isValidISODate, todayISO } from '../lib/dates'
import { centsToInput, formatCents, parseAmountToCents } from '../lib/money'
import {
  FREQUENCY_LABEL, TX_TYPE_LABEL, type Frequency, type RecurringTransaction, type TransactionType, type Visibility,
} from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { Button, ErrorBox, Field, Input, Modal, Segmented, Select } from './ui'

export const RECURRING_TYPES: TransactionType[] = ['expense', 'income', 'transfer', 'contribution', 'investment']
const TWO_ACCOUNTS: TransactionType[] = ['transfer', 'contribution', 'investment']
const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as Frequency[]

/** Selector de periodicidad (compartido con el formulario de movimientos) */
export function FrequencySelect({ id, value, onChange }: { id: string; value: Frequency; onChange: (f: Frequency) => void }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value as Frequency)}>
      {FREQUENCIES.map((k) => <option key={k} value={k}>{FREQUENCY_LABEL[k]}</option>)}
    </Select>
  )
}

/** Alta/edición de un movimiento periódico: gasto, ingreso, transferencia, aportación o inversión. */
export function RecurringForm({ editing, defaultCategoryId, defaultType = 'expense', onClose }: {
  editing: RecurringTransaction | null; defaultCategoryId?: string; defaultType?: TransactionType; onClose: () => void
}) {
  const { user } = useAuth()
  const accounts = useAccounts()
  const categories = useCategories()
  const save = useSaveRecurring()

  const [type, setType] = useState<TransactionType>(editing?.type ?? defaultType)
  const [description, setDescription] = useState(editing?.description ?? '')
  const [amount, setAmount] = useState(editing ? centsToInput(editing.amount_cents) : '')
  const [frequency, setFrequency] = useState<Frequency>(editing?.frequency ?? 'monthly')
  const [nextDue, setNextDue] = useState(editing?.next_due_on ?? todayISO())
  const [endOn, setEndOn] = useState(editing?.end_on ?? '')
  const [categoryId, setCategoryId] = useState(editing?.category_id ?? defaultCategoryId ?? '')
  const [subId, setSubId] = useState(editing?.subcategory_id ?? '')
  const [accountId, setAccountId] = useState(editing?.account_id ?? '')
  const [toAccountId, setToAccountId] = useState(editing?.to_account_id ?? '')
  const [visibility, setVisibility] = useState<Visibility>(editing?.visibility ?? 'shared')
  const [auto, setAuto] = useState(editing?.auto_register ?? true)
  const [error, setError] = useState<string | null>(null)

  const usable = useMemo(() => (accounts.data ?? []).filter((a) => !a.is_archived && (a.visibility === 'shared' || a.owner_id === user?.id)), [accounts.data, user?.id])
  const twoAccounts = TWO_ACCOUNTS.includes(type)
  const fromOptions = type === 'contribution' ? usable.filter((a) => a.visibility === 'personal') : usable
  const toOptions = (type === 'contribution' ? usable.filter((a) => a.visibility === 'shared')
    : type === 'investment' ? [...usable].sort((a, b) => Number(b.kind === 'investment') - Number(a.kind === 'investment')) : usable)
    .filter((a) => a.id !== accountId)
  const touched = [accountId, twoAccounts ? toAccountId : ''].map((id) => usable.find((a) => a.id === id))
  const forcedShared = type === 'contribution' || touched.some((a) => a?.visibility === 'shared')
  const hasCategory = type === 'expense' || type === 'income'
  const catGroups = parentCategoriesFor(type, categories.data ?? [], categoryId)
  const subs = (categories.data ?? []).filter((c) => c.parent_id === categoryId)

  const changeType = (t: TransactionType) => {
    setType(t)
    const catIsIncome = (categories.data ?? []).find((c) => c.id === categoryId)?.kind === 'income'
    if (!(t === 'expense' || t === 'income') || (t === 'expense' && catIsIncome)) { setCategoryId(''); setSubId('') }
    if (!TWO_ACCOUNTS.includes(t)) setToAccountId('')
    if (t === 'contribution') { setAccountId(''); setToAccountId(usable.find((a) => a.kind === 'common')?.id ?? '') }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const cents = parseAmountToCents(amount)
    if (!description.trim()) return setError('Escribe una descripción.')
    if (!cents || cents <= 0) return setError('Importe no válido.')
    if (!isValidISODate(nextDue)) return setError('Fecha de la próxima cuota no válida.')
    if (endOn && (!isValidISODate(endOn) || endOn < nextDue)) return setError('La fecha de fin debe ser posterior a la próxima cuota.')
    if (type !== 'contribution' && !accountId) return setError('Elige la cuenta de origen.')
    if (twoAccounts && !toAccountId) return setError('Elige la cuenta de destino.')
    try {
      await save.mutateAsync({
        id: editing?.id, type, description: description.trim(), amount_cents: cents, frequency, next_due_on: nextDue,
        anchor_day: Number(nextDue.slice(8, 10)),
        end_on: endOn || null, category_id: hasCategory ? categoryId || null : null, subcategory_id: hasCategory ? subId || null : null,
        account_id: accountId || null, to_account_id: twoAccounts ? toAccountId : null,
        visibility: forcedShared ? 'shared' : visibility, auto_register: auto,
        is_active: editing?.is_active ?? true, notes: editing?.notes ?? null,
      })
      onClose()
    } catch { /* se muestra abajo */ }
  }

  const accLabel = (a: (typeof usable)[number]) => `${a.name}${a.visibility === 'shared' ? ' · compartida' : ''} (${formatCents(a.balance_cents)})`

  return (
    <Modal open onClose={onClose} title={editing ? 'Editar movimiento periódico' : 'Nuevo movimiento periódico'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="rec-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="rec-form" className="space-y-4" onSubmit={submit} noValidate>
        <Field label="Tipo" htmlFor="rtype">
          <Select id="rtype" value={type} onChange={(e) => changeType(e.target.value as TransactionType)} disabled={!!editing}>
            {RECURRING_TYPES.map((t) => <option key={t} value={t}>{TX_TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="Descripción" htmlFor="rdesc"><Input id="rdesc" maxLength={140} placeholder={type === 'expense' ? 'p. ej. Alquiler' : type === 'income' ? 'p. ej. Nómina' : type === 'contribution' ? 'p. ej. Aportación mensual' : 'p. ej. Ahorro mensual'} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Importe por cuota (€)" htmlFor="ramount"><Input id="ramount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Periodicidad" htmlFor="rfreq"><FrequencySelect id="rfreq" value={frequency} onChange={setFrequency} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Próxima cuota" htmlFor="rnext"><Input id="rnext" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></Field>
          <Field label="Termina (opcional)" htmlFor="rend"><Input id="rend" type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} /></Field>
        </div>
        {hasCategory && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Categoría" htmlFor="rcat">
              <Select id="rcat" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSubId('') }}>
                <option value="">Sin categoría</option>
                <CategoryOptions groups={catGroups} />
              </Select>
            </Field>
            <Field label="Subcategoría" htmlFor="rsub">
              <Select id="rsub" value={subId} onChange={(e) => setSubId(e.target.value)} disabled={!subs.length}>
                <option value="">—</option>
                {subs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <div className={twoAccounts ? 'grid gap-4 sm:grid-cols-2' : ''}>
          <Field label={twoAccounts ? 'Desde' : type === 'income' ? 'Se cobra en' : 'Se paga con'} htmlFor="racc">
            <Select id="racc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{type === 'contribution' ? 'Fuera de la app (efectivo, otra cuenta)' : 'Elige cuenta'}</option>
              {fromOptions.map((a) => <option key={a.id} value={a.id}>{accLabel(a)}</option>)}
            </Select>
          </Field>
          {twoAccounts && (
            <Field label="Hacia" htmlFor="rto">
              <Select id="rto" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="">Elige cuenta</option>
                {toOptions.map((a) => <option key={a.id} value={a.id}>{accLabel(a)}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Visibilidad" hint={forcedShared ? 'Toca una cuenta compartida, así que es compartido.' : undefined}>
          <Segmented value={forcedShared ? 'shared' : visibility} onChange={setVisibility}
            options={[{ value: 'personal', label: 'Personal', disabled: forcedShared }, { value: 'shared', label: 'Compartido' }]} />
        </Field>
        <label className="flex items-start gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-slate-900" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span><strong>Apuntar automáticamente</strong><br /><span className="text-slate-500">Cada cuota se registra sola cuando llega su fecha (al abrir la app). Si lo desactivas, la apuntas tú con «Registrar».</span></span>
        </label>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}
