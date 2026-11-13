import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { Card, EmptyState, Money } from '../components/ui'
import { useAccounts } from '../hooks/data'
import { ACCOUNT_KIND_LABEL } from '../lib/types'

/**
 * El módulo completo de inversiones (activos, unidades, rentabilidad) llega en la Fase 3.
 * Mientras tanto se muestran los saldos reales de las cuentas de tipo "Inversión".
 */
export function InvestmentsPage() {
  const accounts = useAccounts()
  const inv = (accounts.data ?? []).filter((a) => a.kind === 'investment' && !a.is_archived)
  return (
    <>
      <PageHeader title="Inversiones" subtitle="Cartera, rentabilidad y patrimonio" />
      <Card title="Cuentas de inversión">
        {inv.length ? (
          <ul className="divide-y divide-slate-100">
            {inv.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-3 text-sm">
                <span>{a.name} <span className="text-slate-400">· {a.institution ?? ACCOUNT_KIND_LABEL[a.kind]}</span></span>
                <Money cents={a.balance_cents} className="font-semibold" />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Sin cuentas de inversión">
            Crea una cuenta de tipo "Inversión" en <Link to="/ajustes" className="underline">Ajustes</Link> y registra movimientos de tipo "Inversión" para mover dinero hacia ella sin que cuente como gasto.
          </EmptyState>
        )}
      </Card>
      <Card className="mt-6">
        <p className="text-sm text-slate-600">
          El seguimiento por activo (criptomonedas, acciones, ETFs, fondos, depósitos), con unidades, precio medio, valor actual y rentabilidad,
          está previsto para la <strong>Fase 3</strong>. La base de datos ya tiene las tablas preparadas.
        </p>
      </Card>
    </>
  )
}
