import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Check, Copy, Lock, LogOut, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { PageHeader } from '../components/Layout'
import { Avatar, Badge, Button, Card, ConfirmDialog, ErrorBox, Field, Input, Modal, Money, PageLoader, Segmented, Select } from '../components/ui'
import {
  useAccounts, useArchiveAccount, useCategories, useDeleteAccount, useInvitations, useSaveAccount, useSaveCategory,
  type AccountWithBalance,
} from '../hooks/data'
import { formatDate, todayISO } from '../lib/dates'
import { centsToInput, parseAmountToCents } from '../lib/money'
import { supabase } from '../lib/supabase'
import { ACCOUNT_KIND_LABEL, type AccountKind, type Category, type Visibility } from '../lib/types'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'
import { appUrl } from '../lib/url'
import { useHouseholdNetWorth, useSetNetWorthSharing, useInvestments, usePositions, fetchAllOperations } from '../hooks/phase3'
import { buildWorkbook, downloadBlob, fetchTransactionsForExport, toCsv, transactionColumns, type ExportData } from '../lib/export'
import { formatCents } from '../lib/money'
import { Download, Eye, EyeOff } from 'lucide-react'
import { useHouseholdId } from '../providers/HouseholdProvider'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Ajustes" />
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileCard />
        <HouseholdCard />
        <AccountsCard />
        <NetWorthSharingCard />
        <ExportCard />
        <CategoriesCard />
      </div>
      <div className="mt-8 flex justify-center">
        <Button variant="secondary" onClick={() => supabase.auth.signOut()}><LogOut className="size-4" />Cerrar sesión</Button>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ Perfil
const COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0f172a']

function ProfileCard() {
  const { user } = useAuth()
  const { profileById, refetch } = useHousehold()
  const me = profileById(user?.id)
  const [name, setName] = useState(me?.full_name ?? '')
  const [color, setColor] = useState(me?.color ?? COLORS[0])
  const [saved, setSaved] = useState(false)
  const m = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('El nombre no puede estar vacío.')
      const { error } = await supabase.from('profiles').update({ full_name: name.trim(), color }).eq('id', user!.id)
      if (error) throw error
    },
    onSuccess: () => { refetch(); setSaved(true); setTimeout(() => setSaved(false), 2000) },
  })
  return (
    <Card title="Mi perfil">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate() }}>
        <div className="flex items-center gap-3">
          <Avatar name={name} color={color} size="md" />
          <div className="text-sm text-slate-500">{user?.email}</div>
        </div>
        <Field label="Nombre" htmlFor="pname"><Input id="pname" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Color">
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Color ${c}`}
                className="flex size-8 items-center justify-center rounded-full ring-offset-2" style={{ background: c, boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined }}>
                {color === c && <Check className="size-4 text-white" />}
              </button>
            ))}
          </div>
        </Field>
        <ErrorBox error={m.error} />
        <Button type="submit" loading={m.isPending}>{saved ? 'Guardado' : 'Guardar'}</Button>
      </form>
    </Card>
  )
}

// ------------------------------------------------------------------ Espacio e invitación
function HouseholdCard() {
  const { household, members, myRole, refetch } = useHousehold()
  const { user } = useAuth()
  const qc = useQueryClient()
  const invitations = useInvitations()
  const [email, setEmail] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [name, setName] = useState(household?.name ?? '')

  const rename = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('households').update({ name: name.trim() }).eq('id', household!.id)
      if (error) throw error
    },
    onSuccess: refetch,
  })

  const invite = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('create_invitation', { p_household: household!.id, p_email: email.trim() || null })
      if (error) throw error
      return data as string
    },
    onSuccess: (token) => {
      setLink(appUrl(`invitacion/${token}`))
      qc.invalidateQueries({ queryKey: ['invitations'] })
    },
  })

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('revoke_invitation', { p_invitation: id })
      if (error) throw error
    },
    onSuccess: () => { setLink(null); qc.invalidateQueries({ queryKey: ['invitations'] }) },
  })

  const pending = (invitations.data ?? []).filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date())
  const full = members.length + pending.length >= (household?.max_members ?? 2)

  const share = async () => {
    if (!link) return
    const text = `Únete a nuestro espacio en Etxea: ${link}`
    try {
      if (navigator.share) await navigator.share({ title: 'Etxea', text, url: link })
      else { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    } catch { /* cancelado */ }
  }

  return (
    <Card title="Espacio compartido">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate() }}>
        <Input aria-label="Nombre del espacio" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={myRole !== 'owner'} />
        {myRole === 'owner' && <Button type="submit" variant="secondary" loading={rename.isPending} disabled={!name.trim() || name === household?.name}>Guardar</Button>}
      </form>
      <ErrorBox error={rename.error} />

      <h3 className="mt-5 mb-2 text-xs font-medium text-slate-500">Miembros ({members.length}/{household?.max_members})</h3>
      <ul className="space-y-2">
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center gap-3 text-sm">
            <Avatar name={m.profile?.full_name} color={m.profile?.color} size="md" />
            <span className="flex-1">{m.profile?.full_name}{m.user_id === user?.id && <span className="text-slate-400"> (tú)</span>}</span>
            <Badge tone={m.role === 'owner' ? 'brand' : 'slate'}>{m.role === 'owner' ? 'Propietario' : 'Miembro'}</Badge>
          </li>
        ))}
      </ul>

      {pending.map((i) => (
        <div key={i.id} className="mt-3 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>Invitación pendiente{i.email ? ` para ${i.email}` : ''} · caduca el {formatDate(i.expires_at.slice(0, 10))}</span>
          <button className="font-medium underline" onClick={() => revoke.mutate(i.id)}>Anular</button>
        </div>
      ))}

      {link && (
        <div className="mt-4 space-y-2 rounded-xl bg-brand-50 p-3">
          <p className="text-xs text-brand-700">Envía este enlace a tu pareja. Solo se muestra ahora, sirve una vez y caduca en 7 días.</p>
          <div className="flex gap-2">
            <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Enlace de invitación" />
            <Button type="button" onClick={share}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? 'Copiado' : 'Compartir'}</Button>
          </div>
        </div>
      )}

      {!full && !link && (
        <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); invite.mutate() }}>
          <Field label="Invitar a tu pareja" hint="Opcional: si pones su email, solo esa cuenta podrá usar la invitación." htmlFor="iemail">
            <Input id="iemail" type="email" placeholder="email@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" loading={invite.isPending}><Users className="size-4" />Generar invitación</Button>
        </form>
      )}
      <div className="mt-3"><ErrorBox error={invite.error ?? revoke.error ?? invitations.error} /></div>
    </Card>
  )
}

// ------------------------------------------------------------------ Cuentas
function AccountsCard() {
  const { user } = useAuth()
  const accounts = useAccounts()
  const archive = useArchiveAccount()
  const del = useDeleteAccount()
  const [editing, setEditing] = useState<AccountWithBalance | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AccountWithBalance | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const list = (accounts.data ?? []).filter((a) => showArchived || !a.is_archived)

  return (
    <Card title="Cuentas" action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Nueva</Button>}>
      {accounts.isLoading ? <PageLoader /> : (
        <ul className="divide-y divide-slate-100">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-3">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                  {a.name}
                  {a.visibility === 'personal' ? <Lock className="size-3 text-slate-400" /> : <Users className="size-3 text-slate-400" />}
                  {a.is_archived && <Badge>Archivada</Badge>}
                </p>
                <p className="text-xs text-slate-500">{ACCOUNT_KIND_LABEL[a.kind]}{a.institution ? ` · ${a.institution}` : ''}</p>
              </div>
              <Money cents={a.balance_cents} className="text-sm font-semibold" />
              {(a.visibility === 'shared' || a.owner_id === user?.id) && (
                <div className="flex">
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Editar" onClick={() => setEditing(a)}><Pencil className="size-4" /></button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={a.is_archived ? 'Restaurar' : 'Archivar'}
                    onClick={() => archive.mutate({ id: a.id, archived: !a.is_archived })}>
                    {a.is_archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                  </button>
                  {a.kind !== 'common' && (
                    <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar" onClick={() => setDeleting(a)}><Trash2 className="size-4" /></button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <button className="mt-2 text-xs text-slate-500 underline" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Ocultar archivadas' : 'Mostrar archivadas'}</button>
      <ErrorBox error={accounts.error ?? archive.error} />
      {editing && <AccountModal account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title="Eliminar cuenta"
        message={<p>¿Eliminar <strong>{deleting?.name}</strong>? Solo se puede eliminar una cuenta sin movimientos; si tiene, archívala.</p>}
        loading={del.isPending}
        error={del.error}
        onCancel={() => { setDeleting(null); del.reset() }}
        onConfirm={() => deleting && del.mutateAsync(deleting.id).then(() => setDeleting(null)).catch(() => undefined)}
      />
    </Card>
  )
}

const KINDS: AccountKind[] = ['checking', 'savings', 'cash', 'credit_card', 'investment', 'common', 'other']

function AccountModal({ account, onClose }: { account: AccountWithBalance | null; onClose: () => void }) {
  const save = useSaveAccount()
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'checking')
  const [visibility, setVisibility] = useState<Visibility>(account?.visibility ?? 'personal')
  const [institution, setInstitution] = useState(account?.institution ?? '')
  const [opening, setOpening] = useState(account ? centsToInput(account.opening_balance_cents) : '0')
  const [openingDate, setOpeningDate] = useState(account?.opening_date ?? todayISO())
  const [color, setColor] = useState(account?.color ?? '#0f172a')
  const [error, setError] = useState<string | null>(null)

  const effectiveVis: Visibility = kind === 'common' ? 'shared' : visibility

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const cents = parseAmountToCents(opening)
    if (!name.trim()) return setError('Escribe un nombre.')
    if (cents === null) return setError('Saldo inicial no válido.')
    try {
      await save.mutateAsync({
        id: account?.id, name: name.trim(), kind, visibility: effectiveVis, institution: institution.trim() || null,
        opening_balance_cents: cents, opening_date: openingDate, color,
      })
      onClose()
    } catch { /* se muestra abajo */ }
  }

  return (
    <Modal open onClose={onClose} title={account ? 'Editar cuenta' : 'Nueva cuenta'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="acc-form" loading={save.isPending}>Guardar</Button></>}>
      <form id="acc-form" className="space-y-4" onSubmit={submit} noValidate>
        <Field label="Nombre" htmlFor="aname"><Input id="aname" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. BBVA nómina" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo" htmlFor="akind">
            <Select id="akind" value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
          <Field label="Entidad" htmlFor="ainst"><Input id="ainst" maxLength={80} value={institution} onChange={(e) => setInstitution(e.target.value)} /></Field>
        </div>
        <Field label="Visibilidad" hint={account ? 'No se puede cambiar si la cuenta ya tiene movimientos.' : effectiveVis === 'personal' ? 'Solo tú verás la cuenta y su saldo.' : 'La veréis y usaréis los dos.'}>
          <Segmented value={effectiveVis} onChange={setVisibility} options={[
            { value: 'personal', label: 'Personal', disabled: kind === 'common' },
            { value: 'shared', label: 'Compartida' },
          ]} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Saldo inicial (€)" htmlFor="aopen"><Input id="aopen" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>
          <Field label="Fecha del saldo inicial" htmlFor="adate"><Input id="adate" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} /></Field>
        </div>
        <Field label="Color">
          <div className="flex gap-2">
            {['#0f172a', '#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a'].map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Color ${c}`} className="size-7 rounded-full"
                style={{ background: c, boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined }} />
            ))}
          </div>
        </Field>
        <ErrorBox error={error ?? save.error} />
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------------ Categorías
function CategoriesCard() {
  const categories = useCategories()
  const save = useSaveCategory()
  const [kind, setKind] = useState<Category['kind']>('expense')
  const [parentId, setParentId] = useState('')
  const [name, setName] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const all = categories.data ?? []
  const parents = all.filter((c) => !c.parent_id && c.kind === kind)

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await save.mutateAsync({ name: name.trim(), parent_id: parentId || null, kind })
      setName('')
    } catch { /* se muestra abajo */ }
  }

  return (
    <Card title="Categorías" action={<Segmented value={kind} onChange={(k) => { setKind(k); setParentId('') }} options={[{ value: 'expense', label: 'Gastos' }, { value: 'income', label: 'Ingresos' }]} />}>
      {categories.isLoading ? <PageLoader /> : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
          {parents.map((p) => {
            const kids = all.filter((c) => c.parent_id === p.id)
            return (
              <li key={p.id} className="py-2">
                <button className="flex w-full items-center gap-2 text-left text-sm font-medium" onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <span className="size-2.5 rounded-full" style={{ background: p.color }} />
                  <span className="flex-1">{p.name}</span>
                  <span className="text-xs text-slate-400">{kids.length}</span>
                </button>
                {open === p.id && (
                  <ul className="mt-2 ml-5 space-y-1">
                    {kids.map((c) => (
                      <li key={c.id} className="flex items-center justify-between text-sm text-slate-600">
                        <span className={c.is_archived ? 'line-through opacity-50' : ''}>{c.name}</span>
                        <button className="text-xs text-slate-400 hover:text-slate-700"
                          onClick={() => save.mutate({ id: c.id, name: c.name, parent_id: c.parent_id, kind: c.kind, is_archived: !c.is_archived })}>
                          {c.is_archived ? 'Restaurar' : 'Ocultar'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <form onSubmit={add} className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Select aria-label="Dentro de" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">Nueva categoría principal</option>
          {parents.map((p) => <option key={p.id} value={p.id}>Subcategoría de {p.name}</option>)}
        </Select>
        <Input aria-label="Nombre de la categoría" placeholder="Nombre" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="secondary" loading={save.isPending}><Plus className="size-4" />Añadir</Button>
      </form>
      <div className="mt-2"><ErrorBox error={save.error ?? categories.error} /></div>
    </Card>
  )
}

// ------------------------------------------------------------------ Patrimonio conjunto
function NetWorthSharingCard() {
  const { user } = useAuth()
  const { members, profileById } = useHousehold()
  const joint = useHouseholdNetWorth()
  const setSharing = useSetNetWorthSharing()
  const rows = joint.data ?? []
  const mine = rows.find((r) => r.user_id === user?.id)
  const sharing = !!mine?.is_sharing
  const all = rows.length > 0 && rows.every((r) => r.is_sharing)
  const total = rows.reduce((a, r) => a + (r.net_worth_cents ?? 0), 0)

  return (
    <Card title="Patrimonio conjunto">
      <p className="text-sm text-slate-600">
        Comparte con tu pareja solo el <strong>total</strong> de tu patrimonio personal (cuentas e inversiones personales).
        No verá tus cuentas, inversiones ni movimientos. Puedes desactivarlo cuando quieras.
      </p>
      {joint.isLoading ? <PageLoader /> : (
        <>
          <ul className="mt-4 space-y-2">
            {rows.filter((r) => r.user_id).map((r) => (
              <li key={r.user_id} className="flex items-center gap-3 text-sm">
                <Avatar name={profileById(r.user_id)?.full_name} color={profileById(r.user_id)?.color} />
                <span className="flex-1">{r.user_id === user?.id ? 'Tú' : profileById(r.user_id)?.full_name ?? 'Miembro'}</span>
                {r.is_sharing ? <Badge tone="brand"><Eye className="mr-1 size-3" />Lo comparte</Badge> : <Badge><EyeOff className="mr-1 size-3" />No lo comparte</Badge>}
                <span className="w-28 text-right font-medium tabular">{r.net_worth_cents == null ? '—' : formatCents(r.net_worth_cents)}</span>
              </li>
            ))}
            <li className="flex items-center gap-3 text-sm">
              <span className="ml-9 flex-1">Compartido (cuenta común e inversiones compartidas)</span>
              <span className="w-28 text-right font-medium tabular">{formatCents(rows.find((r) => !r.user_id)?.net_worth_cents ?? 0)}</span>
            </li>
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
            <span>{all ? <>Patrimonio de la pareja: <strong className="tabular">{formatCents(total)}</strong></> : members.length < 2 ? 'Cuando tu pareja se una, podréis activarlo los dos.' : 'El total conjunto aparece cuando los dos lo activáis.'}</span>
            <Button size="sm" variant={sharing ? 'secondary' : 'primary'} loading={setSharing.isPending} onClick={() => setSharing.mutate(!sharing)}>
              {sharing ? 'Dejar de compartir' : 'Compartir mi total'}
            </Button>
          </div>
        </>
      )}
      <div className="mt-3"><ErrorBox error={joint.error ?? setSharing.error} /></div>
    </Card>
  )
}

// ------------------------------------------------------------------ Exportar
function ExportCard() {
  const hid = useHouseholdId()
  const { profileById } = useHousehold()
  const accounts = useAccounts()
  const categories = useCategories()
  const investments = useInvestments()
  const positions = usePositions()
  const thisYear = todayISO().slice(0, 4)
  const years = Array.from({ length: 6 }, (_, i) => String(Number(thisYear) - i))
  const [range, setRange] = useState(thisYear)
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)

  async function run(kind: 'csv' | 'xlsx') {
    setBusy(kind); setError(null); setDone(null)
    try {
      const from = range === 'all' ? null : `${range}-01-01`
      const to = range === 'all' ? null : `${range}-12-31`
      const transactions = await fetchTransactionsForExport(hid, from, to)
      const data: ExportData = {
        transactions,
        accounts: accounts.data ?? [],
        categories: categories.data ?? [],
        investments: investments.data ?? [],
        positions: positions.data ?? [],
        operations: kind === 'xlsx' ? await fetchAllOperations(hid) : [],
        memberName: (id) => (id ? profileById(id)?.full_name ?? '' : ''),
      }
      const name = `ourfinance-${range === 'all' ? 'todo' : range}`
      if (kind === 'csv') {
        downloadBlob(new Blob([toCsv(transactions, transactionColumns(data))], { type: 'text/csv;charset=utf-8' }), `${name}-movimientos.csv`)
      } else {
        downloadBlob(await buildWorkbook(data), `${name}.xlsx`)
      }
      setDone(`${transactions.length} ${transactions.length === 1 ? 'movimiento exportado' : 'movimientos exportados'}.`)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card title="Exportar datos">
      <p className="text-sm text-slate-600">
        Descarga lo que ves en la app: tus movimientos personales y los compartidos. Excel incluye además cuentas, inversiones y operaciones.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Periodo" htmlFor="exp-range">
          <Select id="exp-range" value={range} onChange={(e) => setRange(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>Año {y}</option>)}
            <option value="all">Todo el historial</option>
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button onClick={() => run('xlsx')} loading={busy === 'xlsx'} disabled={!!busy}><Download className="size-4" />Excel</Button>
          <Button variant="secondary" onClick={() => run('csv')} loading={busy === 'csv'} disabled={!!busy}><Download className="size-4" />CSV</Button>
        </div>
      </div>
      {done && <p className="mt-3 text-sm text-emerald-700">{done}</p>}
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Card>
  )
}
