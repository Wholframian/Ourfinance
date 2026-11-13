import { Paperclip, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, findPossibleDuplicate, openAttachment, useAccounts, useCategories,
  useDeleteAttachment, useSaveTransaction, type AccountWithBalance, type TxInput,
} from '../hooks/data'
import { formatDate, isValidISODate, todayISO } from '../lib/dates'
import { errorMessage } from '../lib/errors'
import { centsToInput, formatCents, parseAmountToCents } from '../lib/money'
import { TX_TYPE_LABEL, type Transaction, type TransactionType, type Visibility } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { useHouseholdId } from '../providers/HouseholdProvider'
import { Button, ErrorBox, Field, Input, Modal, Segmented, Select, Textarea } from './ui'

export interface TransactionFormProps {
  open: boolean
  onClose: () => void
  /** Movimiento a editar */
  editing?: Transaction | null
  /** Movimiento a duplicar (se crea uno nuevo con fecha de hoy) */
  duplicateOf?: Transaction | null
  /** Tipo preseleccionado para un movimiento nuevo */
  presetType?: TransactionType
}

const TYPES: TransactionType[] = ['expense', 'income', 'contribution', 'transfer', 'investment', 'refund']
const NEEDS_TO_ACCOUNT: TransactionType[] = ['transfer', 'contribution', 'investment']
const HAS_CATEGORY: TransactionType[] = ['expense', 'income', 'refund']

interface FormState {
  type: TransactionType
  amount: string
  occurred_on: string
  description: string
  category_id: string
  subcategory_id: string
  account_id: string
  to_account_id: string
  visibility: Visibility
  tags: string
  notes: string
}

function initialState(src: Transaction | null | undefined, presetType: TransactionType | undefined, isDuplicate: boolean): FormState {
  if (src) {
    return {
      type: src.type,
      amount: centsToInput(src.amount_cents),
      occurred_on: isDuplicate ? todayISO() : src.occurred_on,
      description: src.description,
      category_id: src.category_id ?? '',
      subcategory_id: src.subcategory_id ?? '',
      account_id: src.account_id ?? '',
      to_account_id: src.to_account_id ?? '',
      visibility: src.visibility,
      tags: src.tags.join(', '),
      notes: src.notes ?? '',
    }
  }
  const type = presetType ?? 'expense'
  return {
    type, amount: '', occurred_on: todayISO(), description: type === 'contribution' ? 'Aportación cuenta común' : '',
    category_id: '', subcategory_id: '', account_id: '', to_account_id: '',
    visibility: type === 'contribution' ? 'shared' : 'personal', tags: '', notes: '',
  }
}

export function TransactionForm(props: TransactionFormProps) {
  // Se vuelve a montar cada vez que se abre: estado limpio y nueva clave de idempotencia
  if (!props.open) return null
  return <TransactionFormInner key={(props.editing?.id ?? props.duplicateOf?.id ?? 'new') + (props.presetType ?? '')} {...props} />
}

function TransactionFormInner({ open, onClose, editing, duplicateOf, presetType }: TransactionFormProps) {
  const hid = useHouseholdId()
  const { user } = useAuth()
  const accountsQ = useAccounts()
  const categoriesQ = useCategories()
  const save = useSaveTransaction()
  const delAttachment = useDeleteAttachment()

  const [f, setF] = useState<FormState>(() => initialState(editing ?? duplicateOf, presetType, !!duplicateOf))
  const [file, setFile] = useState<File | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState | 'file', string>>>({})
  const [submitError, setSubmitError] = useState<unknown>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const clientRequestId = useMemo(() => crypto.randomUUID(), [])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((prev) => ({ ...prev, [k]: v }))
    setErrors((e) => ({ ...e, [k]: undefined }))
    setDuplicateWarning(null)
  }

  // ---------------------------------------------------------------- Cuentas
  const usable = useMemo(
    () => (accountsQ.data ?? []).filter((a) => !a.is_archived && (a.visibility === 'shared' || a.owner_id === user?.id)),
    [accountsQ.data, user?.id],
  )
  const accById = useMemo(() => new Map((accountsQ.data ?? []).map((a) => [a.id, a])), [accountsQ.data])
  const fromOptions = useMemo(() => {
    if (f.type === 'contribution') return usable.filter((a) => a.visibility === 'personal')
    return usable
  }, [usable, f.type])
  const toOptions = useMemo(() => {
    if (f.type === 'contribution') return usable.filter((a) => a.visibility === 'shared')
    if (f.type === 'investment') return [...usable].sort((a, b) => Number(b.kind === 'investment') - Number(a.kind === 'investment'))
    return usable
  }, [usable, f.type])

  // Cuenta por defecto al cambiar de tipo
  useEffect(() => {
    if (!accountsQ.data) return
    setF((prev) => {
      const next = { ...prev }
      if (!fromOptions.some((a) => a.id === prev.account_id)) {
        next.account_id = prev.type === 'contribution' ? (fromOptions[0]?.id ?? '') : (fromOptions.find((a) => a.visibility === 'personal')?.id ?? fromOptions[0]?.id ?? '')
      }
      if (NEEDS_TO_ACCOUNT.includes(prev.type)) {
        if (!toOptions.some((a) => a.id === prev.to_account_id) || prev.to_account_id === next.account_id) {
          next.to_account_id = toOptions.find((a) => a.id !== next.account_id)?.id ?? ''
        }
      } else next.to_account_id = ''
      return next
    })
  }, [accountsQ.data, fromOptions, toOptions, f.type])

  // Un movimiento que toca una cuenta compartida debe ser compartido (regla de la base de datos)
  const touchesShared = [f.account_id, f.to_account_id].some((id) => id && accById.get(id)?.visibility === 'shared')
  const forcedShared = touchesShared || f.type === 'contribution'
  useEffect(() => {
    if (forcedShared && f.visibility !== 'shared') setF((p) => ({ ...p, visibility: 'shared' }))
  }, [forcedShared, f.visibility])

  // ---------------------------------------------------------------- Categorías
  const catKind = f.type === 'income' ? 'income' : 'expense'
  const parents = (categoriesQ.data ?? []).filter((c) => !c.parent_id && c.kind === catKind && (!c.is_archived || c.id === f.category_id))
  const children = (categoriesQ.data ?? []).filter((c) => c.parent_id && c.parent_id === f.category_id && (!c.is_archived || c.id === f.subcategory_id))

  const changeType = (type: TransactionType) => {
    setF((prev) => ({
      ...prev,
      type,
      category_id: HAS_CATEGORY.includes(type) && (type === 'income') === (prev.type === 'income') ? prev.category_id : '',
      subcategory_id: HAS_CATEGORY.includes(type) && (type === 'income') === (prev.type === 'income') ? prev.subcategory_id : '',
      description: !prev.description && type === 'contribution' ? 'Aportación cuenta común' : prev.description,
      visibility: type === 'contribution' ? 'shared' : prev.visibility,
    }))
    setErrors({})
    setDuplicateWarning(null)
  }

  // ---------------------------------------------------------------- Validación
  function validate(): TxInput | null {
    const e: typeof errors = {}
    const cents = parseAmountToCents(f.amount)
    if (cents === null) e.amount = 'Introduce un importe válido (máx. 2 decimales), p. ej. 12,50'
    else if (cents <= 0) e.amount = 'El importe debe ser mayor que 0'
    else if (cents >= 100_000_000_000) e.amount = 'Importe demasiado alto'
    if (!isValidISODate(f.occurred_on)) e.occurred_on = 'Fecha no válida'
    if (!f.description.trim()) e.description = 'Escribe una descripción'
    else if (f.description.trim().length > 140) e.description = 'Máximo 140 caracteres'
    if (f.type !== 'contribution' && !f.account_id) e.account_id = 'Elige una cuenta'
    if (NEEDS_TO_ACCOUNT.includes(f.type)) {
      if (!f.to_account_id) e.to_account_id = 'Elige la cuenta de destino'
      else if (f.to_account_id === f.account_id) e.to_account_id = 'Origen y destino deben ser distintos'
    }
    const tags = f.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (tags.length > 20) e.tags = 'Máximo 20 etiquetas'
    if (f.notes.length > 2000) e.notes = 'Máximo 2000 caracteres'
    if (file) {
      if (file.size > MAX_ATTACHMENT_BYTES) e.file = 'El fichero supera los 10 MB'
      else if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) e.file = 'Formato no admitido (PDF, JPG, PNG, WEBP, HEIC)'
    }
    setErrors(e)
    if (Object.keys(e).length) return null
    return {
      type: f.type,
      visibility: forcedShared ? 'shared' : f.visibility,
      amount_cents: cents!,
      occurred_on: f.occurred_on,
      description: f.description.trim(),
      category_id: HAS_CATEGORY.includes(f.type) ? f.category_id || null : null,
      subcategory_id: HAS_CATEGORY.includes(f.type) ? f.subcategory_id || null : null,
      account_id: f.account_id || null,
      to_account_id: NEEDS_TO_ACCOUNT.includes(f.type) ? f.to_account_id || null : null,
      tags: [...new Set(tags)],
      notes: f.notes.trim() || null,
      client_request_id: editing ? undefined : clientRequestId,
    }
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    setSubmitError(null)
    const input = validate()
    if (!input) return
    try {
      if (!duplicateWarning) {
        setChecking(true)
        const dup = await findPossibleDuplicate(hid, input, editing?.id).finally(() => setChecking(false))
        if (dup) {
          setDuplicateWarning(`Ya existe "${dup.description}" de ${formatCents(Number(dup.amount_cents))} el ${formatDate(dup.occurred_on)}. ¿Guardar igualmente?`)
          return
        }
      }
      await save.mutateAsync({ id: editing?.id, input, file })
      onClose()
    } catch (err) {
      // Si la clave de idempotencia ya existe, el movimiento ya se guardó (doble envío)
      if ((err as { code?: string }).code === '23505' && errorMessage(err).includes('ya se había guardado')) {
        onClose()
        return
      }
      setSubmitError(err)
    }
  }

  const title = editing ? 'Editar movimiento' : duplicateOf ? 'Duplicar movimiento' : 'Nuevo movimiento'
  const noAccounts = accountsQ.isSuccess && usable.length === 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      wide
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="tx-form" loading={save.isPending || checking} disabled={noAccounts}>
            {duplicateWarning ? 'Guardar igualmente' : 'Guardar'}
          </Button>
        </>
      }
    >
      <form id="tx-form" onSubmit={onSubmit} className="space-y-5" noValidate>
        <Segmented
          value={f.type}
          onChange={changeType}
          options={TYPES.map((t) => ({ value: t, label: TX_TYPE_LABEL[t], disabled: !!editing && t !== f.type && (NEEDS_TO_ACCOUNT.includes(t) !== NEEDS_TO_ACCOUNT.includes(f.type)) }))}
          className="w-full"
        />
        {f.type === 'contribution' && (
          <p className="rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700">
            Una aportación es una transferencia a la cuenta común: no cuenta como gasto. Los gastos se registran cuando se pagan desde la cuenta común.
          </p>
        )}
        {f.type === 'investment' && (
          <p className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
            Mover dinero a una cuenta de inversión no es un gasto: cambia dónde está tu patrimonio, no cuánto tienes.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Importe (€)" error={errors.amount} htmlFor="tx-amount">
            <Input id="tx-amount" inputMode="decimal" autoComplete="off" placeholder="0,00" value={f.amount}
              onChange={(e) => set('amount', e.target.value)} invalid={!!errors.amount} className="text-lg font-semibold tabular" autoFocus={!editing} />
          </Field>
          <Field label="Fecha" error={errors.occurred_on} htmlFor="tx-date" hint={formatDate(f.occurred_on)}>
            <Input id="tx-date" type="date" value={f.occurred_on} onChange={(e) => set('occurred_on', e.target.value)} invalid={!!errors.occurred_on} />
          </Field>
        </div>

        <Field label="Descripción" error={errors.description} htmlFor="tx-desc">
          <Input id="tx-desc" maxLength={140} placeholder="p. ej. Mercadona" value={f.description}
            onChange={(e) => set('description', e.target.value)} invalid={!!errors.description} />
        </Field>

        {HAS_CATEGORY.includes(f.type) && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Categoría" htmlFor="tx-cat">
              <Select id="tx-cat" value={f.category_id} onChange={(e) => { set('category_id', e.target.value); set('subcategory_id', '') }}>
                <option value="">Sin categoría</option>
                {parents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Subcategoría" htmlFor="tx-sub">
              <Select id="tx-sub" value={f.subcategory_id} onChange={(e) => set('subcategory_id', e.target.value)} disabled={!children.length}>
                <option value="">—</option>
                {children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          </div>
        )}

        {noAccounts ? (
          <ErrorBox error="Primero crea una cuenta en Ajustes → Cuentas." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={NEEDS_TO_ACCOUNT.includes(f.type) ? 'Desde' : f.type === 'expense' ? 'Pagado con' : 'Cuenta'} error={errors.account_id} htmlFor="tx-acc">
              <Select id="tx-acc" value={f.account_id} onChange={(e) => set('account_id', e.target.value)}>
                {f.type === 'contribution' && <option value="">Fuera de la app (efectivo, otra cuenta)</option>}
                {fromOptions.map((a) => <AccountOption key={a.id} a={a} />)}
              </Select>
            </Field>
            {NEEDS_TO_ACCOUNT.includes(f.type) && (
              <Field label="Hacia" error={errors.to_account_id} htmlFor="tx-to">
                <Select id="tx-to" value={f.to_account_id} onChange={(e) => set('to_account_id', e.target.value)}>
                  <option value="">Elige cuenta</option>
                  {toOptions.filter((a) => a.id !== f.account_id).map((a) => <AccountOption key={a.id} a={a} />)}
                </Select>
              </Field>
            )}
          </div>
        )}

        <Field
          label="Visibilidad"
          hint={forcedShared
            ? 'Los movimientos de la cuenta común y las aportaciones siempre son compartidos.'
            : f.visibility === 'personal' ? 'Solo tú podrás verlo.' : 'Lo veréis los dos.'}
        >
          <Segmented
            value={forcedShared ? 'shared' : f.visibility}
            onChange={(v) => set('visibility', v)}
            options={[
              { value: 'personal', label: 'Personal', disabled: forcedShared },
              { value: 'shared', label: 'Compartido' },
            ]}
          />
        </Field>

        <Field label="Etiquetas" hint="Separadas por comas" error={errors.tags} htmlFor="tx-tags">
          <Input id="tx-tags" placeholder="vacaciones, regalo" value={f.tags} onChange={(e) => set('tags', e.target.value)} />
        </Field>

        <Field label="Notas" error={errors.notes} htmlFor="tx-notes">
          <Textarea id="tx-notes" maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>

        <Field label="Justificante o factura" error={errors.file} hint="PDF o imagen, máx. 10 MB">
          {editing?.attachments?.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <Paperclip className="size-4 text-slate-400" />
              <button type="button" className="flex-1 truncate text-left text-slate-700 underline-offset-2 hover:underline"
                onClick={() => openAttachment(a.storage_path).catch(setSubmitError)}>{a.file_name}</button>
              <button type="button" aria-label="Quitar justificante" className="text-slate-400 hover:text-red-600"
                onClick={() => delAttachment.mutateAsync(a).then(onClose).catch(setSubmitError)}>
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <input
            type="file"
            accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErrors((x) => ({ ...x, file: undefined })) }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
        </Field>

        {duplicateWarning && (
          <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-100">{duplicateWarning}</div>
        )}
        <ErrorBox error={submitError} />
        <ErrorBox error={accountsQ.error ?? categoriesQ.error} />
      </form>
    </Modal>
  )
}

function AccountOption({ a }: { a: AccountWithBalance }) {
  return (
    <option value={a.id}>
      {a.name}{a.visibility === 'shared' ? ' · compartida' : ''} ({formatCents(a.balance_cents)})
    </option>
  )
}
