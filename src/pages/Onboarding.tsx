import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, ErrorBox, Field, Input, PageLoader } from '../components/ui'
import { supabase } from '../lib/supabase'
import { useAuth } from '../providers/AuthProvider'
import { useHousehold } from '../providers/HouseholdProvider'
import { AuthShell } from './AuthPages'

const PENDING_KEY = 'ourfinance.pendingInvite'

export function readPendingInvite(): string | null {
  try { return sessionStorage.getItem(PENDING_KEY) } catch { return null }
}
function setPendingInvite(token: string | null) {
  try {
    if (token) sessionStorage.setItem(PENDING_KEY, token)
    else sessionStorage.removeItem(PENDING_KEY)
  } catch { /* almacenamiento no disponible */ }
}

/** Extrae el token de un enlace /invitacion/<token> o del token pegado tal cual */
function extractToken(input: string): string {
  const s = input.trim()
  const m = /invitacion\/([a-f0-9]{48})/i.exec(s)
  return (m ? m[1] : s).toLowerCase()
}

async function accept(token: string) {
  const { error } = await supabase.rpc('accept_invitation', { p_token: token })
  if (error) throw error
}

/** Sin espacio todavía: crear uno o unirse con una invitación. */
export function OnboardingPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [name, setName] = useState('Nuestras finanzas')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState<'create' | 'join' | null>(null)

  const done = () => qc.invalidateQueries({ queryKey: ['household'] })

  async function create(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading('create')
    const { error } = await supabase.rpc('create_household', { p_name: name })
    setLoading(null)
    if (error) setError(error)
    else await done()
  }

  async function join(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const token = extractToken(invite)
    if (!/^[a-f0-9]{48}$/.test(token)) return setError('Pega el enlace de invitación completo que te ha enviado tu pareja.')
    setLoading('join')
    try {
      await accept(token)
      await done()
    } catch (err) {
      setError(err)
    } finally {
      setLoading(null)
    }
  }

  return (
    <AuthShell
      title={`Hola${user?.user_metadata?.full_name ? `, ${user.user_metadata.full_name}` : ''}`}
      subtitle="Crea vuestro espacio compartido o únete al de tu pareja."
      footer={<button className="underline" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>}
    >
      <form onSubmit={create} className="space-y-3">
        <Field label="Nombre del espacio" htmlFor="hname">
          <Input id="hname" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={loading === 'create'}>Crear espacio</Button>
        <p className="text-xs text-slate-500">Se creará la cuenta común y las categorías por defecto. Después podrás invitar a tu pareja.</p>
      </form>
      <div className="my-6 flex items-center gap-3 text-xs text-slate-400"><div className="h-px flex-1 bg-slate-200" />o<div className="h-px flex-1 bg-slate-200" /></div>
      <form onSubmit={join} className="space-y-3">
        <Field label="Enlace de invitación" htmlFor="invite">
          <Input id="invite" placeholder="https://…/invitacion/…" value={invite} onChange={(e) => setInvite(e.target.value)} />
        </Field>
        <Button type="submit" variant="secondary" className="w-full" loading={loading === 'join'}>Unirme</Button>
      </form>
      <div className="mt-4"><ErrorBox error={error} /></div>
    </AuthShell>
  )
}

/** /invitacion/:token — guarda el token si no hay sesión y lo acepta al entrar. */
export function AcceptInvitePage() {
  const { token = '' } = useParams()
  const { user, loading: authLoading } = useAuth()
  const { household, loading: hLoading } = useHousehold()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const started = useRef(false)

  useEffect(() => {
    if (authLoading) return
    if (!user) {
      setPendingInvite(token)
      navigate('/registro', { replace: true })
      return
    }
    if (hLoading || started.current) return
    started.current = true
    if (household) {
      setPendingInvite(null)
      setError('Ya perteneces a un espacio compartido.')
      return
    }
    accept(extractToken(token))
      .then(async () => {
        setPendingInvite(null)
        await qc.invalidateQueries({ queryKey: ['household'] })
        navigate('/', { replace: true })
      })
      .catch((e) => { setPendingInvite(null); setError(e) })
  }, [authLoading, user, hLoading, household, token, navigate, qc])

  if (!error) return <PageLoader />
  return (
    <AuthShell title="Invitación">
      <ErrorBox error={error} />
      <Button className="mt-4 w-full" onClick={() => navigate('/', { replace: true })}>Ir al inicio</Button>
    </AuthShell>
  )
}

export { setPendingInvite }
