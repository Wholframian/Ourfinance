import { useMemo, useState, type FormEvent } from 'react'
import { useAccounts, useCategories } from '../hooks/data'
import { useSaveRecurring } from '../hooks/phase2'
import { isValidISODate, todayISO } from '../lib/dates'
import { centsToInput, formatCents, parseAmountToCents } from '../lib/money'
import { FREQUENCY_LABEL, type Frequency, type RecurringTransaction, type Visibility } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { Button, ErrorBox, Field, Input, Modal, Segmented, Select } from './ui'

/** Alta/edición de un gasto recurrente (alquiler, luz, seguros, suscripciones...). */
export function RecurringForm({ editing, defaultCategoryId, onClose }: { editing: RecurringTransaction | null; defaultCategoryId?: string; onClose: () => void }) {
  const { user } = useAuth()
  const accounts = useAccounts()
  const categories = useCategories()
  const save = useSaveRecurring()

  const [description, setDescription] = useState(editing?.description ?? '')
  const [amount, setAmount] = useState(editing ? centsToInput(editing.amount_cents) : '')
  const [frequency, setFrequency] = useState<Frequency>(editing?.frequency ?? 'monthly')
  const [nextDue, setNextDue] = useState(editing?.next_due_on ?? todayISO())
  const [endOn, setEndOn] = useState(editing?.end_on ?? '')
  const [categoryId, setCategoryId] = useState(editing?.category_id ?? defaultCategoryId ?? '')
  const [subId, setSubId] = useState(editing?.subcategory_id ?? '')
  const [accountId, setAccountId] = useState(editing?.account_id ?? '')
  const [visibility, setVisibility] = useState<Visibility>(editing?.visibility ?? 'shared')
  const [error, setError] = useState<string | null>(null)

  const usable = useMemo(() => (accounts.data ?? []).filter((a) => !a.is_archived && (a.visibility === 'shared' || a.owner_id === user?.id)), [accounts.data, user?.id])
  const acc = usable.find((a) => a.id === accountId)
  const forcedShared = acc?.visibility === 'shared'
  const parents = (categories.data ?? []).filter((c) => !c.parent_id && c.kind === 'expense')
  const subs = (categories.data ?? []).filter((c) => c.parent_id === categoryId)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const cents = parseAmountToCents(amount)
    if (!description.trim()) return setError('Escribe una descripción.')
    if (!cents || cents <= 0) return setError('Importe no válido.')
    if (!isValidISODate(nextDue)) return setError('Fecha de la próxima cuota no válida.')
    if (endOn && (!isValidISODate(endOn) || endOn < nextDue)) return setError('La fecha de fin debe ser posterior a la próxima cuota.')
    if (!accountId) return setError('Elige la cuenta con la que se paga.')
    try {
      await save.mutateAsync({
        id: editing?.id, description: description.trim(), amount_cents: cents, frequency, next_due_on: nextDue,
        end_on: endOn || null, category_id: categoryId || null, subcategory_id: subId || null, account_id: accountId,
        to_account_id: null, type: 'expense', visibility: forcedShared ? 'shared' : visibility,
        is_active: editing?.is_active ?? true, notes: editing?.notes ?? null,
      })
      onClose()
    } catch { /* se muestra abajo */ }
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Editar gasto recurrente' : 'Nuevo gasto recurrente'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="rec-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="rec-form" className="space-y-4" onSubmit={submit} noValidate>
        <Field label="Descripción" htmlFor="rdesc"><Input id="rdesc" maxLength={140} placeholder="p. ej. Alquiler" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Importe por cuota (€)" htmlFor="ramount"><Input id="ramount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Periodicidad">
            <Segmented value={frequency} onChange={setFrequency} options={(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((k) => ({ value: k, label: FREQUENCY_LABEL[k] }))} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Próxima cuota" htmlFor="rnext"><Input id="rnext" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></Field>
          <Field label="Termina (opcional)" htmlFor="rend"><Input id="rend" type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Categoría" htmlFor="rcat">
            <Select id="rcat" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSubId('') }}>
              <option value="">Sin categoría</option>
              {parents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Subcategoría" htmlFor="rsub">
            <Select id="rsub" value={subId} onChange={(e) => setSubId(e.target.value)} disabled={!subs.length}>
              <option value="">—</option>
              {subs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Se paga con" htmlFor="racc">
          <Select id="racc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Elige cuenta</option>
            {usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.visibility === 'shared' ? ' · compartida' : ''} ({formatCents(a.balance_cents)})</option>)}
          </Select>
        </Field>
        <Field label="Visibilidad" hint={forcedShared ? 'Se paga con una cuenta compartida, así que es compartido.' : undefined}>
          <Segmented value={forcedShared ? 'shared' : visibility} onChange={setVisibility}
            options={[{ value: 'personal', label: 'Personal', disabled: forcedShared }, { value: 'shared', label: 'Compartido' }]} />
        </Field>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}
