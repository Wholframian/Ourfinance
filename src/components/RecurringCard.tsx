import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useDeleteRecurring, useRegisterRecurring, useSaveRecurring } from '../hooks/phase2'
import { formatDate, todayISO } from '../lib/dates'
import { FREQUENCY_LABEL, TX_TYPE_LABEL, txSign, type RecurringTransaction } from '../lib/types'
import { useHousehold } from '../providers/HouseholdProvider'
import { RecurringForm } from './RecurringForm'
import { txAccountsLabel, useTxLookups } from './TransactionList'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Money, PageLoader } from './ui'

/** Lista de recurrentes con registrar cuota, pausar, editar y borrar. */
export function RecurringCard({ items, defaultCategoryId, loading, title = 'Movimientos periódicos', emptyText, className = 'mt-6' }: {
  items: RecurringTransaction[]; defaultCategoryId?: string; loading: boolean; title?: string; emptyText?: string; className?: string
}) {
  const { profileById } = useHousehold()
  const { accountName, category } = useTxLookups()
  const register = useRegisterRecurring()
  const save = useSaveRecurring()
  const del = useDeleteRecurring()
  const [editing, setEditing] = useState<RecurringTransaction | 'new' | null>(null)
  const [deleting, setDeleting] = useState<RecurringTransaction | null>(null)
  const today = todayISO()
  const sorted = useMemo(() => [...items].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.next_due_on.localeCompare(b.next_due_on)), [items])

  return (
    <Card className={className} title={title} action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Nuevo</Button>}>
      {loading ? <PageLoader /> : !sorted.length ? (
        <EmptyState title="Sin movimientos periódicos">{emptyText ?? 'Nómina, alquiler, aportación a la cuenta común, ahorro mensual a inversión… Créalos aquí o marca «Repetir» al añadir un movimiento.'}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {sorted.map((r) => {
            const due = r.is_active && r.next_due_on <= today
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                <CalendarClock className="size-5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {r.description}
                    <Badge>{FREQUENCY_LABEL[r.frequency]}</Badge>
                    {r.type !== 'expense' && <Badge tone="brand">{TX_TYPE_LABEL[r.type]}</Badge>}
                    {r.auto_register && r.is_active && <Badge tone="violet">Automático</Badge>}
                    {!r.is_active && <Badge>Pausado</Badge>}
                    {due && <Badge tone="amber">Pendiente</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {r.is_active ? `Próxima: ${formatDate(r.next_due_on)}` : 'Sin próximas cuotas'} · {r.type === 'expense' || r.type === 'income' ? `${category(r.subcategory_id)?.name ?? category(r.category_id)?.name ?? 'Sin categoría'} · ` : ''}{txAccountsLabel(r as never, accountName) || '—'} · {profileById(r.created_by)?.full_name?.split(' ')[0]}
                  </p>
                </div>
                <Money cents={r.amount_cents} signed={txSign(r.type)} className="text-sm font-semibold" />
                <div className="flex items-center gap-1">
                  {r.is_active && (
                    <Button size="sm" variant={due ? 'primary' : 'secondary'} loading={register.isPending && register.variables === r.id}
                      onClick={() => register.mutate(r.id)} title={`Registra la cuota del ${formatDate(r.next_due_on)} como movimiento`}>
                      Registrar
                    </Button>
                  )}
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={r.is_active ? 'Pausar' : 'Reanudar'}
                    onClick={() => save.mutate({ ...r, is_active: !r.is_active })}>
                    {r.is_active ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Editar" onClick={() => setEditing(r)}><Pencil className="size-4" /></button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar" onClick={() => setDeleting(r)}><Trash2 className="size-4" /></button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <ErrorBox error={register.error ?? save.error} />
      {editing && <RecurringForm editing={editing === 'new' ? null : editing} defaultCategoryId={defaultCategoryId} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title="Eliminar recurrente"
        message={<p>¿Eliminar <strong>{deleting?.description}</strong>? Los movimientos ya registrados se conservan.</p>}
        loading={del.isPending}
        error={del.error}
        onCancel={() => { setDeleting(null); del.reset() }}
        onConfirm={() => deleting && del.mutateAsync(deleting.id).then(() => setDeleting(null)).catch(() => undefined)}
      />
    </Card>
  )
}
