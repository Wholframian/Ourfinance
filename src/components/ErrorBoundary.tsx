import { Component, type ReactNode } from 'react'

const RELOAD_KEY = 'etxea:chunk-reload'

/** Tras publicar una versión nueva, los trozos antiguos de la app ya no existen. */
function isStaleChunk(err: unknown) {
  const msg = String((err as Error)?.message ?? err)
  return /dynamically imported module|Importing a module script failed|Failed to fetch dynamically|error loading dynamically/i.test(msg)
}

/**
 * Si algo falla al pintar una pantalla, en vez de quedarse en blanco se
 * muestra un aviso con un botón para recargar. Si el fallo es porque hay una
 * versión nueva publicada, recarga sola una vez.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
    if (isStaleChunk(error)) {
      let already = false
      try { already = sessionStorage.getItem(RELOAD_KEY) === '1'; sessionStorage.setItem(RELOAD_KEY, '1') } catch { /* sin almacenamiento */ }
      if (!already) window.location.reload()
    }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Al cambiar de pantalla se vuelve a intentar
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="text-base font-semibold text-slate-900">Algo no ha ido bien</p>
        <p className="text-sm text-slate-500">
          Esta pantalla no se ha podido mostrar. Tus datos están a salvo. Prueba a recargar la app.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 h-11 rounded-xl bg-ink px-5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Recargar
        </button>
      </div>
    )
  }
}

/** Una carga correcta borra la marca de recarga para la próxima versión. */
export function clearChunkReloadFlag() {
  try { sessionStorage.removeItem(RELOAD_KEY) } catch { /* nada */ }
}
