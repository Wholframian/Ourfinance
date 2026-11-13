/** Traduce errores de Supabase/PostgREST a mensajes comprensibles en español. */
interface MaybePgError {
  message?: string
  code?: string
  details?: string
}

const AUTH_MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'Email o contraseña incorrectos.',
  'Email not confirmed': 'Tienes que confirmar tu email antes de entrar. Revisa tu correo.',
  'User already registered': 'Ya existe una cuenta con ese email.',
  'Password should be at least 6 characters.': 'La contraseña debe tener al menos 6 caracteres.',
}

export function errorMessage(err: unknown): string {
  if (!err) return 'Error desconocido.'
  if (typeof err === 'string') return err
  const e = err as MaybePgError
  const msg = e.message ?? ''
  if (AUTH_MESSAGES[msg]) return AUTH_MESSAGES[msg]
  if (/rate limit/i.test(msg)) return 'Demasiados intentos. Espera un momento y vuelve a probar.'
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sin conexión con el servidor. Revisa tu conexión a internet.'
  switch (e.code) {
    case '23505':
      return /client_request_id/.test(msg + (e.details ?? ''))
        ? 'Este movimiento ya se había guardado.'
        : /Ya perteneces/.test(msg) ? msg : 'Ya existe un registro igual.'
    case '23503':
      return 'No se puede completar: hay registros relacionados (por ejemplo, movimientos en esa cuenta).'
    case '42501':
      return /row-level security/i.test(msg) ? 'No tienes permiso para esta operación.' : msg
    case '23514':
    case 'P0001':
    case 'P0002':
      return /violates check constraint/.test(msg) ? 'Algún dato no es válido.' : msg
    case 'PGRST116':
      return 'No se ha encontrado el registro.'
  }
  return msg || 'Ha ocurrido un error inesperado.'
}
