import { clsx } from 'clsx'
import { AlertCircle, Loader2, X } from 'lucide-react'
import {
  forwardRef, useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { errorMessage } from '../lib/errors'
import { formatCents } from '../lib/money'

// ---------------------------------------------------------------- Botones
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-slate-800 disabled:bg-slate-400',
  secondary: 'bg-white text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
}

export function Button({
  variant = 'primary', loading, className, children, disabled, size = 'md', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed',
        size === 'md' ? 'h-11 px-4 text-sm' : 'h-9 px-3 text-sm',
        variants[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- Tarjetas
export function Card({ className, children, title, action }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={clsx('rounded-2xl bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/70', className)}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function StatCard({ label, cents, hint, tone = 'default', icon, loading }: {
  label: string; cents: number | undefined; hint?: ReactNode; tone?: 'default' | 'positive' | 'negative' | 'brand'; icon?: ReactNode; loading?: boolean
}) {
  return (
    <div className={clsx('rounded-2xl p-4 ring-1 sm:p-5', tone === 'brand' ? 'bg-ink text-white ring-ink' : 'bg-white ring-slate-200/70')}>
      <div className={clsx('flex items-center gap-2 text-xs font-medium', tone === 'brand' ? 'text-slate-300' : 'text-slate-500')}>
        {icon}
        {label}
      </div>
      <div className={clsx(
        'mt-2 text-xl font-semibold tracking-tight tabular sm:text-2xl',
        tone === 'positive' && 'text-emerald-600',
        tone === 'negative' && 'text-slate-900',
      )}>
        {loading || cents === undefined ? <span className="inline-block h-7 w-28 animate-pulse rounded bg-slate-200/60" /> : formatCents(cents)}
      </div>
      {hint && <div className={clsx('mt-1 text-xs', tone === 'brand' ? 'text-slate-400' : 'text-slate-500')}>{hint}</div>}
    </div>
  )
}

export function Money({ cents, signed, className }: { cents: number; signed?: -1 | 0 | 1; className?: string }) {
  const sign = signed === 1 ? '+' : signed === -1 ? '−' : ''
  return (
    <span className={clsx('tabular whitespace-nowrap', signed === 1 && 'text-emerald-600', className)}>
      {sign}{formatCents(Math.abs(cents))}
    </span>
  )
}

// ---------------------------------------------------------------- Formularios
export function Field({ label, error, children, hint, htmlFor }: { label: string; error?: string | null; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-600">{label}</label>
      {children}
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  )
}

const inputCls = 'block w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-600 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return <input ref={ref} {...rest} className={clsx(inputCls, invalid && 'ring-red-400', className)} />
  },
)

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={clsx(inputCls, 'pr-8', className)}>{children}</select>
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={clsx(inputCls, 'min-h-20', className)} />
}

export function Segmented<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; className?: string
}) {
  return (
    <div className={clsx('inline-flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1', className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40',
            value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Estados
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-slate-400', className)} aria-label="Cargando" />
}

export function PageLoader() {
  return <div className="flex min-h-[40vh] items-center justify-center"><Spinner className="size-7" /></div>
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-100">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">{errorMessage(error)}</div>
      {onRetry && <button className="font-medium underline" onClick={onRetry}>Reintentar</button>}
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {children && <p className="max-w-sm text-sm text-slate-500">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'brand' | 'amber' | 'violet' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    brand: 'bg-brand-50 text-brand-700',
    amber: 'bg-amber-50 text-amber-700',
    violet: 'bg-violet-50 text-violet-700',
  }
  return <span className={clsx('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>
}

export function Avatar({ name, color, size = 'sm' }: { name?: string | null; color?: string | null; size?: 'sm' | 'md' }) {
  const initials = (name ?? '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span
      className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', size === 'sm' ? 'size-6 text-[10px]' : 'size-9 text-xs')}
      style={{ backgroundColor: color ?? '#64748b' }}
      title={name ?? undefined}
    >
      {initials}
    </span>
  )
}

// ---------------------------------------------------------------- Modal
export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className={clsx('relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-white shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Cerrar"><X className="size-5" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 safe-bottom">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Eliminar', onConfirm, onCancel, loading, error }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onCancel: () => void; loading?: boolean; error?: unknown
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-600">
        {message}
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}
