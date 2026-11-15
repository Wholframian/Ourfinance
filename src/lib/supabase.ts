import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

if (!isSupabaseConfigured) {
  console.error('Faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. Copia .env.example a .env.local.')
}

/**
 * fetch con límite de tiempo: si la red del móvil se queda colgada (cobertura
 * mala, app vuelta del segundo plano...), la petición falla con un mensaje en
 * vez de dejar la pantalla cargando para siempre. Las subidas de archivos
 * tienen más margen.
 */
const TIMEOUT_MS = 25_000
const UPLOAD_TIMEOUT_MS = 120_000
export const fetchWithTimeout: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const ms = url.includes('/storage/v1/') ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('Tiempo de espera agotado', 'TimeoutError')), ms)
  const outer = init?.signal
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason)
    else outer.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true })
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

/**
 * Cliente único de Supabase. Usa exclusivamente la clave publishable/anon:
 * toda la seguridad la aplican las políticas RLS de la base de datos.
 */
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: fetchWithTimeout },
})
