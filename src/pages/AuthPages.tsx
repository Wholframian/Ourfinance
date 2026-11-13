import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Logo } from '../components/Layout'
import { Button, ErrorBox, Field, Input } from '../components/ui'
import { supabase } from '../lib/supabase'

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-8 justify-center" />
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70 sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>}
      </div>
    </div>
  )
}

const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim())

export function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!emailOk(email)) return setError('Introduce un email válido.')
    if (!password) return setError('Introduce tu contraseña.')
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setLoading(false)
    if (error) setError(error)
    else navigate('/', { replace: true })
  }

  return (
    <AuthShell
      title="Entrar"
      subtitle="Vuestras finanzas, personales y compartidas."
      footer={<>¿No tienes cuenta? <Link to="/registro" className="font-medium text-slate-900 underline">Regístrate</Link></>}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Contraseña" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" className="w-full" loading={loading}>Entrar</Button>
        <p className="text-center text-sm"><Link to="/recuperar" className="text-slate-500 hover:text-slate-900">¿Has olvidado la contraseña?</Link></p>
      </form>
    </AuthShell>
  )
}

export function RegisterPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Escribe tu nombre.')
    if (!emailOk(email)) return setError('Introduce un email válido.')
    if (password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres.')
    if (password !== password2) return setError('Las contraseñas no coinciden.')
    setLoading(true)
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: window.location.origin },
    })
    setLoading(false)
    if (error) return setError(error)
    if (data.session) navigate('/', { replace: true })
    else setInfo('Te hemos enviado un email para confirmar la cuenta. Ábrelo y vuelve a entrar.')
  }

  return (
    <AuthShell
      title="Crear cuenta"
      subtitle="Cada uno tiene su propia cuenta; luego os unís en un espacio común."
      footer={<>¿Ya tienes cuenta? <Link to="/login" className="font-medium text-slate-900 underline">Entra</Link></>}
    >
      {info ? (
        <p className="rounded-xl bg-brand-50 p-3 text-sm text-brand-700">{info}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Nombre" htmlFor="name">
            <Input id="name" autoComplete="given-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Contraseña" htmlFor="password" hint="Mínimo 8 caracteres">
            <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repite la contraseña" htmlFor="password2">
            <Input id="password2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" className="w-full" loading={loading}>Crear cuenta</Button>
        </form>
      )}
    </AuthShell>
  )
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!emailOk(email)) return setError('Introduce un email válido.')
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/nueva-contrasena` })
    setLoading(false)
    if (error) setError(error)
    else setSent(true)
  }

  return (
    <AuthShell title="Recuperar contraseña" footer={<Link to="/login" className="underline">Volver a entrar</Link>}>
      {sent ? (
        <p className="rounded-xl bg-brand-50 p-3 text-sm text-brand-700">Si el email existe, recibirás un enlace para crear una contraseña nueva.</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" className="w-full" loading={loading}>Enviar enlace</Button>
        </form>
      )}
    </AuthShell>
  )
}

export function NewPasswordPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres.')
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) setError(error)
    else navigate('/', { replace: true })
  }

  return (
    <AuthShell title="Nueva contraseña">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Contraseña nueva" htmlFor="password" hint="Mínimo 8 caracteres">
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" className="w-full" loading={loading}>Guardar</Button>
      </form>
    </AuthShell>
  )
}
