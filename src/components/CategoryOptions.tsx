import type { Category } from '../lib/types'

/** Categorías principales que admite un tipo de movimiento: los ingresos usan
 *  las suyas y también las de gastos (mismos conceptos); el resto, las de gastos. */
export function parentCategoriesFor(type: string, all: Category[], keepId?: string) {
  const ok = (c: Category) => !c.parent_id && (!c.is_archived || c.id === keepId)
  const expense = all.filter((c) => ok(c) && c.kind === 'expense')
  return type === 'income' ? { income: all.filter((c) => ok(c) && c.kind === 'income'), expense } : { income: [], expense }
}

/** <option>s del selector de categoría, agrupadas cuando es un ingreso */
export function CategoryOptions({ groups }: { groups: ReturnType<typeof parentCategoriesFor> }) {
  const opts = (list: Category[]) => list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)
  if (!groups.income.length) return <>{opts(groups.expense)}</>
  return (
    <>
      <optgroup label="Ingresos">{opts(groups.income)}</optgroup>
      <optgroup label="Mismos conceptos que los gastos">{opts(groups.expense)}</optgroup>
    </>
  )
}
