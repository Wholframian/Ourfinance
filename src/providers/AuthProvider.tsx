import type { Session, User } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'

interface AuthState {
  session: Session | null
  user: User | null
  loading: boolean
}

const AuthContext = createContext<AuthState>({ session: null, user: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, user: null, loading: true })

  useEffect(() => {
    let settled = false
    const done = (session: Session | null) => {
      settled = true
      setState({ session, user: session?.user ?? null, loading: false })
    }
    supabase.auth.getSession()
      .then(({ data }) => done(data.session))
      // Si no se puede leer la sesión, se muestra el acceso en vez de cargar para siempre
      .catch(() => { if (!settled) done(null) })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => done(session))
    return () => sub.subscription.unsubscribe()
  }, [])

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
