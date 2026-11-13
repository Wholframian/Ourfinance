import { clsx } from 'clsx'
import { BarChart3, Home, LineChart, ListOrdered, Plus, Settings, Users } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useHousehold } from '../providers/HouseholdProvider'
import { useAuth } from '../providers/AuthProvider'
import { TransactionForm } from './TransactionForm'
import { Avatar } from './ui'

export const NAV = [
  { to: '/', label: 'Inicio', icon: Home, end: true },
  { to: '/movimientos', label: 'Movimientos', icon: ListOrdered },
  { to: '/cuenta-comun', label: 'Cuenta común', shortLabel: 'Común', icon: Users },
  { to: '/inversiones', label: 'Inversiones', icon: LineChart },
  { to: '/estadisticas', label: 'Estadísticas', shortLabel: 'Stats', icon: BarChart3 },
  { to: '/ajustes', label: 'Ajustes', icon: Settings },
]

export function Logo({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <img src="/favicon.svg" alt="" className="size-8" />
      <span className="text-[15px] font-bold tracking-tight">OURFINANCE</span>
    </div>
  )
}

export function Layout() {
  const { household, profileById } = useHousehold()
  const { user } = useAuth()
  const me = profileById(user?.id)
  const [adding, setAdding] = useState(false)

  return (
    <div className="min-h-dvh lg:pl-64">
      {/* Menú lateral (escritorio) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200/70 bg-white px-4 py-6 lg:flex">
        <Logo className="px-2" />
        <p className="mt-1 truncate px-2 text-xs text-slate-500">{household?.name}</p>
        <button
          onClick={() => setAdding(true)}
          className="mt-6 flex h-11 items-center justify-center gap-2 rounded-xl bg-ink text-sm font-medium text-white hover:bg-slate-800"
        >
          <Plus className="size-4" /> Nuevo movimiento
        </button>
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => clsx(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              <Icon className="size-[18px]" strokeWidth={1.8} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <Avatar name={me?.full_name} color={me?.color} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{me?.full_name}</p>
            <p className="truncate text-xs text-slate-500">{user?.email}</p>
          </div>
        </div>
      </aside>

      {/* Cabecera móvil */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200/60 bg-slate-50/85 px-4 py-3 backdrop-blur lg:hidden">
        <Logo />
        <Avatar name={me?.full_name} color={me?.color} size="md" />
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-12">
        <Outlet />
      </main>

      {/* Botón flotante (móvil) */}
      <button
        onClick={() => setAdding(true)}
        aria-label="Nuevo movimiento"
        className="fixed right-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-30 flex size-14 items-center justify-center rounded-full bg-ink text-white shadow-lg shadow-slate-900/20 lg:hidden"
      >
        <Plus className="size-6" />
      </button>

      {/* Navegación inferior (móvil) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-slate-200/70 bg-white/95 backdrop-blur safe-bottom lg:hidden">
        {NAV.map(({ to, label, shortLabel, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => clsx(
              'flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium',
              isActive ? 'text-slate-900' : 'text-slate-400',
            )}
          >
            <Icon className="size-5" strokeWidth={1.8} />
            {shortLabel ?? label}
          </NavLink>
        ))}
      </nav>

      <TransactionForm open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
