import { clsx } from 'clsx'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Copy, Lock, Paperclip, Pencil, PiggyBank, RotateCcw, Trash2, TrendingUp, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { openAttachment, useAccounts, useCategories, useDeleteTransaction } from '../hooks/data'
import { useInvestmentLink } from '../hooks/phase3'
import { Link } from 'react-router-dom'
import { formatDate } from '../lib/dates'
import { TX_TYPE_LABEL, VISIBILITY_LABEL, txSign, type Transaction, type TransactionType } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'
import { TransactionForm } from './TransactionForm'
import { Avatar, Badge, Button, ConfirmDialog, ErrorBox, Modal, Money } from './ui'

const TYPE_ICON: Record<TransactionType, typeof ArrowUpRight> = {
  expense: ArrowUpRight,
  income: ArrowDownLeft,
  transfer: ArrowLeftRight,
  contribution: PiggyBank,
  investment: TrendingUp,
  refund: RotateCcw,
}

/** Datos auxiliares para pintar movimientos (nombres de cuenta/categoría). */
export function useTxLookups() {
  const accounts = useAccounts()
  const categories = useCategories()
  return useMemo(() => {
    const acc = new Map((accounts.data ?? []).map((a) => [a.id, a]))
    const cat = new Map((categories.data ?? []).map((c) => [c.id, c]))
    return {
      accountName: (id: string | null) => (id ? acc.get(id)?.name ?? 'Cuenta privada' : null),
      category: (id: string | null) => (id ? cat.get(id) ?? null : null),
    }
  }, [accounts.data, categories.data])
}

export function txAccountsLabel(tx: Transaction, accountName: (id: string | null) => string | null, ownerFirstName?: string) {
  // Las cuentas personales de tu pareja no son visibles: se muestran como "Cuenta de <nombre>"
  const name = (id: string | null) => {
    const n = accountName(id)
    return n === 'Cuenta privada' && ownerFirstName ? `Cuenta de ${ownerFirstName}` : n
  }
  const from = name(tx.account_id)
  const to = name(tx.to_account_id)
  // Operaciones de cartera: un solo lado (compra sale de la cuenta, venta entra)
  if (tx.type === 'investment' && !from && to) return `Cartera → ${to}`
  if (tx.type === 'investment' && from && !to) return `${from} → Cartera`
  if (to) return `${from ?? 'Fuera de la app'} → ${to}`
  return from ?? ''
}

export function TransactionRow({ tx, onClick }: { tx: Transaction; onClick: () => void }) {
  const { profileById } = useHousehold()
  const { accountName, category } = useTxLookups()
  const Icon = TYPE_ICON[tx.type]
  const cat = category(tx.subcategory_id) ?? category(tx.category_id)
  const author = profileById(tx.created_by)
  const sign = txSign(tx.type)
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-slate-50">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: (cat?.color ?? '#64748b') + '1a', color: cat?.color ?? '#475569' }}
        >
          <Icon className="size-[18px]" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-slate-900">{tx.description}</span>
            {tx.visibility === 'personal' && <Lock className="size-3 shrink-0 text-slate-400" aria-label="Personal" />}
            {!!tx.attachments?.length && <Paperclip className="size-3 shrink-0 text-slate-400" aria-label="Con justificante" />}
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {formatDate(tx.occurred_on)} · {cat?.name ?? TX_TYPE_LABEL[tx.type]} · {txAccountsLabel(tx, accountName, author?.full_name?.split(' ')[0])}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <Money cents={tx.amount_cents} signed={sign} className={clsx('text-sm font-semibold', sign === 0 && 'text-slate-500')} />
          <Avatar name={author?.full_name} color={author?.color} />
        </span>
      </button>
    </li>
  )
}

/** Lista con detalle, edición, duplicado y borrado. */
export function TransactionList({ rows, emptyText = 'No hay movimientos' }: { rows: Transaction[]; emptyText?: string }) {
  const [selected, setSelected] = useState<Transaction | null>(null)
  if (!rows.length) return <p className="py-8 text-center text-sm text-slate-500">{emptyText}</p>
  return (
    <>
      <ul className="-mx-2 divide-y divide-slate-100">
        {rows.map((tx) => <TransactionRow key={tx.id} tx={tx} onClick={() => setSelected(tx)} />)}
      </ul>
      <TransactionDetail tx={selected} onClose={() => setSelected(null)} />
    </>
  )
}

export function TransactionDetail({ tx, onClose }: { tx: Transaction | null; onClose: () => void }) {
  const { user } = useAuth()
  const { profileById } = useHousehold()
  const { accountName, category } = useTxLookups()
  const del = useDeleteTransaction()
  const [mode, setMode] = useState<'view' | 'edit' | 'duplicate' | 'delete'>('view')
  const [error, setError] = useState<unknown>(null)
  const investmentLink = useInvestmentLink(tx?.id)

  if (!tx) return null
  const close = () => { setMode('view'); setError(null); del.reset(); onClose() }
  const author = profileById(tx.created_by)
  const payer = profileById(tx.paid_by)
  const canEdit = tx.visibility === 'shared' || tx.created_by === user?.id

  if (mode === 'edit') return <TransactionForm open editing={tx} onClose={close} />
  if (mode === 'duplicate') return <TransactionForm open duplicateOf={tx} onClose={close} />

  const rows: [string, React.ReactNode][] = [
    ['Tipo', TX_TYPE_LABEL[tx.type]],
    ['Fecha', formatDate(tx.occurred_on)],
    ['Categoría', [category(tx.category_id)?.name, category(tx.subcategory_id)?.name].filter(Boolean).join(' › ') || '—'],
    ['Cuenta', txAccountsLabel(tx, accountName, author?.full_name?.split(' ')[0]) || '—'],
    ['Visibilidad', <Badge key="v" tone={tx.visibility === 'shared' ? 'brand' : 'slate'}>{tx.visibility === 'shared' ? <Users className="mr-1 size-3" /> : <Lock className="mr-1 size-3" />}{VISIBILITY_LABEL[tx.visibility]}</Badge>],
    ['Registrado por', author?.full_name ?? '—'],
  ]
  if (tx.paid_by && tx.paid_by !== tx.created_by) rows.push([tx.type === 'contribution' ? 'Aportado por' : 'Pagado por', payer?.full_name ?? '—'])
  if (tx.tags.length) rows.push(['Etiquetas', <span key="t" className="flex flex-wrap gap-1">{tx.tags.map((t) => <Badge key={t}>#{t}</Badge>)}</span>])
  if (tx.notes) rows.push(['Notas', <span key="n" className="whitespace-pre-wrap">{tx.notes}</span>])

  return (
    <>
      <Modal
        open={mode === 'view'}
        onClose={close}
        title={tx.description}
        footer={investmentLink.data ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Creado por una operación de inversión: se gestiona desde la inversión.</span>
            <Link to={`/inversiones/${investmentLink.data}`} onClick={close}
              className="inline-flex h-11 items-center rounded-xl bg-ink px-4 text-sm font-medium text-white">Ir a la inversión</Link>
          </div>
        ) : canEdit && !investmentLink.isLoading ? (
          <div className="flex w-full flex-wrap justify-between gap-2">
            <Button variant="ghost" className="text-red-600" onClick={() => setMode('delete')}><Trash2 className="size-4" />Eliminar</Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode('duplicate')}><Copy className="size-4" />Duplicar</Button>
              <Button onClick={() => setMode('edit')}><Pencil className="size-4" />Editar</Button>
            </div>
          </div>
        ) : undefined}
      >
        <div className="mb-4 text-3xl font-semibold tracking-tight">
          <Money cents={tx.amount_cents} signed={txSign(tx.type)} />
        </div>
        <dl className="divide-y divide-slate-100 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-4 py-2.5">
              <dt className="w-32 shrink-0 text-slate-500">{k}</dt>
              <dd className="min-w-0 flex-1 text-slate-900">{v}</dd>
            </div>
          ))}
        </dl>
        {!!tx.attachments?.length && (
          <div className="mt-4 space-y-2">
            {tx.attachments.map((a) => (
              <button key={a.id} onClick={() => openAttachment(a.storage_path).catch(setError)}
                className="flex w-full items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-left text-sm hover:bg-slate-100">
                <Paperclip className="size-4 text-slate-400" /> <span className="truncate">{a.file_name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-3"><ErrorBox error={error} /></div>
      </Modal>
      <ConfirmDialog
        open={mode === 'delete'}
        title="Eliminar movimiento"
        message={<p>¿Seguro que quieres eliminar <strong>{tx.description}</strong>? Esta acción no se puede deshacer{tx.visibility === 'shared' ? ' y desaparecerá también para tu pareja' : ''}.</p>}
        loading={del.isPending}
        error={del.error}
        onCancel={() => setMode('view')}
        onConfirm={() => del.mutateAsync(tx).then(close).catch(() => undefined)}
      />
    </>
  )
}
