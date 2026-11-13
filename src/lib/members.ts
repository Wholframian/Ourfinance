import { SERIES } from '../components/charts'

/** Color de gráfico por miembro: orden fijo de incorporación al espacio. */
export function memberSeriesColor(index: number): string {
  return SERIES[index % SERIES.length]
}
