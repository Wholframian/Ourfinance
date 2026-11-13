/** URL absoluta dentro de la app, respetando la ruta base (p. ej. /Ourfinance/ en GitHub Pages). */
export function appUrl(path = ''): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
}
