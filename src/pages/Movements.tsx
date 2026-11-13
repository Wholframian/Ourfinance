import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, Lock, Paperclip, Search, SlidersHorizontal, Users } from 'lucide-react'
import { useDeferredValue, useEffect, useState } from 'react'
import { PageHeader } from '../components/Layout'
import { PeriodFilter } from '../components/PeriodFilter'
import { TransactionDetail, TransactionRow, txAccountsLabel, useTxLookups } from '../components/TransactionList'
import { Avatar, Button, Card, ErrorBox, Input, Money, PageLoader, Segmented, Select } from '../components/ui'
import { PAGE_SIZE, useAccounts, useCategories, useTransactions, type TxFilters } from '../hooks/data'
import { formatDate } from '../lib/dates'
import { TX_TYPE_LABEL, txSign, type Transaction, type TransactionType, type Visibility } from '../lib/types'
import { useHousehold } from '../providers/HouseholdProvider'
import { usePeriod } from '../providers/PeriodProvider'

export function MovementsPage() {
  const { period } = usePeriod()
  const { members, profileById } = useHousehold()
  const accounts = useAccounts()
  const categories = useCategories()
  const lookups = useTxLookups()

  const [visibility, setVisibility] = useState<Visibility | 'all'>('all')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [type, setType] = useState<TransactionType | ''>('')
  const [categoryId, setCategoryId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [userId, setUserId] = useState('')
  const [sort, setSort] = useState<NonNullable<TxFilters['sort']>>('date_desc')
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  const [selected, setSelected] = useState<Transaction | null>(null)

  const filters: TxFilters = {
    from: period.from, to: period.to, search: deferredSearch, visibility,
    types: type ? [type] : undefined, categoryId: categoryId || undefined, accountId: accountId || undefined,
    userId: userId || undefined, sort,
  }
  const key = JSON.stringify(filters)
  useEffect(() => setPage(0), [key])

  const q = useTransactions(filters, page)
  const rows = q.data?.rows ?? []
  const count = q.data?.count ?? 0
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  const activeFilters = [type, categoryId, accountId, userId].filter(Boolean).length

  const parents = (categories.data ?? []).filter((c) => !c.parent_id)
  const clear = () => { setType(''); setCategoryId(''); setAccountId(''); setUserId(''); setSearch('') }

  return (
    <>
      <PageHeader title="Movimientos" subtitle="Historial, búsqueda y filtros" actions={<PeriodFilter />} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented value={visibility} onChange={setVisibility} options={[
          { value: 'all', label: 'Todos' },
          { value: 'personal', label: 'Mis personales' },
          { value: 'shared', label: 'Compartidos' },
        ]} />
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input placeholder="Buscar por descripción o notas" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" aria-label="Buscar" />
        </div>
        <Button variant="secondary" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
          <SlidersHorizontal className="size-4" /> Filtros{activeFilters ? ` (${activeFilters})` : ''}
        </Button>
      </div>

      {showFilters && (
        <Card className="mb-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as TransactionType | '')}>
              <option value="">Todos los tipos</option>
              {Object.entries(TX_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select aria-label="Categoría" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Todas las categorías</option>
              {parents.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  <option value={p.id}>{p.name} (todas)</option>
                  {(categories.data ?? []).filter((c) => c.parent_id === p.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              ))}
            </Select>
            <Select aria-label="Cuenta" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Todas las cuentas</option>
              {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <Select aria-label="Usuario" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Registrado por cualquiera</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name}</option>)}
            </Select>
            <Select aria-label="Orden" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="date_desc">Más recientes</option>
              <option value="date_asc">Más antiguos</option>
              <option value="amount_desc">Mayor importe</option>
              <option value="amount_asc">Menor importe</option>
            </Select>
          </div>
          {activeFilters > 0 && <button className="mt-3 text-sm text-slate-500 underline" onClick={clear}>Quitar filtros</button>}
        </Card>
      )}

      <ErrorBox error={q.error} onRetry={() => q.refetch()} />

      <Card className="p-0!">
        {q.isLoading ? <PageLoader /> : !rows.length ? (
          <p className="py-12 text-center text-sm text-slate-500">No hay movimientos con estos filtros.</p>
        ) : (
          <>
            {/* Móvil: lista */}
            <ul className="divide-y divide-slate-100 px-3 py-1 md:hidden">
              {rows.map((tx) => <TransactionRow key={tx.id} tx={tx} onClick={() => setSelected(tx)} />)}
            </ul>
            {/* Escritorio: tabla */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                    {['Fecha', 'Descripción', 'Categoría', 'Usuario', 'Tipo', 'Cuenta', 'Visibilidad'].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}
                    <th className="px-4 py-3 text-right font-medium">Importe</th>
                  </tr>
                </thead>
                <tbody className={clsx('divide-y divide-slate-50', q.isFetching && 'opacity-60')}>
                  {rows.map((tx) => {
                    const cat = lookups.category(tx.category_id)
                    const sub = lookups.category(tx.subcategory_id)
                    const author = profileById(tx.created_by)
                    return (
                      <tr key={tx.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelected(tx)}>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-500 tabular">{formatDate(tx.occurred_on)}</td>
                        <td className="max-w-64 px-4 py-3">
                          <span className="flex items-center gap-1.5 font-medium text-slate-900">
                            <span className="truncate">{tx.description}</span>
                            {!!tx.attachments?.length && <Paperclip className="size-3 shrink-0 text-slate-400" />}
                          </span>
                          {!!tx.tags.length && <span className="block truncate text-xs text-slate-400">{tx.tags.map((t) => `#${t}`).join(' ')}</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {cat ? <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: cat.color }} />{sub?.name ?? cat.name}</span> : '—'}
                        </td>
                        <td className="px-4 py-3"><span className="inline-flex items-center gap-2"><Avatar name={author?.full_name} color={author?.color} />{author?.full_name?.split(' ')[0]}</span></td>
                        <td className="px-4 py-3 text-slate-600">{TX_TYPE_LABEL[tx.type]}</td>
                        <td className="max-w-48 truncate px-4 py-3 text-slate-600">{txAccountsLabel(tx, lookups.accountName, author?.full_name?.split(' ')[0])}</td>
                        <td className="px-4 py-3 text-slate-500">
                          {tx.visibility === 'shared'
                            ? <span className="inline-flex items-center gap-1"><Users className="size-3.5" />Compartido</span>
                            : <span className="inline-flex items-center gap-1"><Lock className="size-3.5" />Personal</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold"><Money cents={tx.amount_cents} signed={txSign(tx.type)} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
          <span>{count} movimientos</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Página anterior"><ChevronLeft className="size-4" /></Button>
            <span className="tabular">{page + 1} / {pages}</span>
            <Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Página siguiente"><ChevronRight className="size-4" /></Button>
          </div>
        </div>
      </Card>

      <TransactionDetail tx={selected} onClose={() => setSelected(null)} />
    </>
  )
}
