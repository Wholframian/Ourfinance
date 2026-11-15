import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ErrorBox, PageLoader } from './components/ui'
import { isSupabaseConfigured } from './lib/supabase'
import { AuthProvider, useAuth } from './providers/AuthProvider'
import { HouseholdProvider, useHousehold } from './providers/HouseholdProvider'
import { PeriodProvider } from './providers/PeriodProvider'
import { ForgotPasswordPage, LoginPage, NewPasswordPage, RegisterPage } from './pages/AuthPages'
import { AcceptInvitePage, OnboardingPage, readPendingInvite } from './pages/Onboarding'
import { ErrorBoundary } from './components/ErrorBoundary'
import { lazy } from 'react'

// Cada pantalla se descarga cuando se abre: la app arranca mucho más rápido en el móvil
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))
const DashboardPage = named(() => import('./pages/Dashboard'), 'DashboardPage')
const MovementsPage = named(() => import('./pages/Movements'), 'MovementsPage')
const AccountsPage = named(() => import('./pages/Accounts'), 'AccountsPage')
const AccountDetailPage = named(() => import('./pages/Accounts'), 'AccountDetailPage')
const CommonAccountPage = named(() => import('./pages/CommonAccount'), 'CommonAccountPage')
const InvestmentsPage = named(() => import('./pages/Investments'), 'InvestmentsPage')
const InvestmentDetailPage = named(() => import('./pages/Investments'), 'InvestmentDetailPage')
const StatsPage = named(() => import('./pages/Stats'), 'StatsPage')
const SettingsPage = named(() => import('./pages/Settings'), 'SettingsPage')
const HousePage = named(() => import('./pages/House'), 'HousePage')
const TripsPage = named(() => import('./pages/Trips'), 'TripsPage')
const TripDetailPage = named(() => import('./pages/Trips'), 'TripDetailPage')
const FoodPage = named(() => import('./pages/Food'), 'FoodPage')
const BudgetsPage = named(() => import('./pages/Budgets'), 'BudgetsPage')
const GoalsPage = named(() => import('./pages/Goals'), 'GoalsPage')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
  },
})

/** Rutas privadas: exige sesión y un espacio compartido */
function Protected() {
  const { user, loading } = useAuth()
  const { household, loading: hLoading, error, refetch } = useHousehold()
  const location = useLocation()

  if (loading || (user && hLoading)) return <PageLoader />
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  if (error) return <div className="mx-auto max-w-md p-6"><ErrorBox error={error} onRetry={refetch} /></div>
  if (!household) {
    const pending = readPendingInvite()
    if (pending) return <Navigate to={`/invitacion/${pending}`} replace />
    return <OnboardingPage />
  }
  return <Layout />
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <PageLoader />
  if (user) return <Navigate to="/" replace />
  return <>{children}</>
}

function ConfigMissing() {
  return (
    <div className="mx-auto max-w-lg p-8 text-sm text-slate-700">
      <h1 className="mb-2 text-lg font-semibold">Falta configurar Supabase</h1>
      <p>Copia <code>.env.example</code> a <code>.env.local</code> y rellena <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>.</p>
    </div>
  )
}

export default function App() {
  if (!isSupabaseConfigured) return <ConfigMissing />
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <HouseholdProvider>
          <PeriodProvider>
            <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
              <Routes>
                <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
                <Route path="/registro" element={<PublicOnly><RegisterPage /></PublicOnly>} />
                <Route path="/recuperar" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
                <Route path="/nueva-contrasena" element={<NewPasswordPage />} />
                <Route path="/invitacion/:token" element={<AcceptInvitePage />} />
                <Route element={<Protected />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="movimientos" element={<MovementsPage />} />
                  <Route path="cuentas" element={<AccountsPage />} />
                  <Route path="cuentas/:id" element={<AccountDetailPage />} />
                  <Route path="cuenta-comun" element={<CommonAccountPage />} />
                  <Route path="inversiones" element={<InvestmentsPage />} />
                  <Route path="inversiones/:id" element={<InvestmentDetailPage />} />
                  <Route path="estadisticas" element={<StatsPage />} />
                  <Route path="ajustes" element={<SettingsPage />} />
                  <Route path="casa" element={<HousePage />} />
                  <Route path="viajes" element={<TripsPage />} />
                  <Route path="viajes/:id" element={<TripDetailPage />} />
                  <Route path="comidas" element={<FoodPage />} />
                  <Route path="presupuestos" element={<BudgetsPage />} />
                  <Route path="objetivos" element={<GoalsPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </PeriodProvider>
        </HouseholdProvider>
      </AuthProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  )
}
