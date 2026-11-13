# OURFINANCE · Arquitectura

Gestor financiero personal y compartido para una pareja (preparado para más miembros).
Idioma español, moneda EUR, zona horaria Europe/Madrid, fechas DD/MM/YYYY.

## 1. Visión general

```
┌────────────────────────── Navegador / PWA instalada ──────────────────────────┐
│ React 19 + TypeScript + Vite · Tailwind CSS · Recharts · TanStack Query       │
│                                                                               │
│  Páginas ─▶ hooks de datos (react-query) ─▶ supabase-js (clave publishable)   │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ HTTPS + JWT del usuario
┌───────────────────────────────────────▼───────────────────────────────────────┐
│ Supabase                                                                      │
│  Auth (email + contraseña) ─▶ JWT con auth.uid()                              │
│  PostgREST ─▶ PostgreSQL con RLS en todas las tablas financieras              │
│     · triggers de integridad (SECURITY DEFINER)                               │
│     · RPC: create_household, create/accept/revoke_invitation                  │
│     · RPC de analítica (SECURITY INVOKER, respetan RLS)                        │
│  Storage: bucket privado "attachments" con políticas por carpeta              │
└───────────────────────────────────────────────────────────────────────────────┘
```

* No hay backend propio: toda la seguridad vive en PostgreSQL (RLS + triggers + RPC).
  El frontend solo usa la clave **publishable/anon**. La `service_role` nunca se usa en la app.
* El frontend no filtra por seguridad; filtra por comodidad. Aunque alguien manipule
  las peticiones, la base de datos rechaza lo que no le corresponde.

## 2. Modelo de datos

| Tabla | Para qué | Visibilidad |
|---|---|---|
| `profiles` | Nombre y color de cada usuario (se crea al registrarse) | Propio + miembros del mismo espacio |
| `households` | Espacio compartido (`max_members`, por defecto 2) | Miembros |
| `household_members` | Pertenencia y rol (`owner` / `member`) | Miembros |
| `household_invitations` | Invitaciones de un solo uso; se guarda solo el hash SHA-256 del token | Miembros |
| `accounts` | Cuentas personales o compartidas. La **cuenta común** es `kind = common`, siempre `shared` | `personal` → solo dueño |
| `categories` | Categorías y subcategorías (2 niveles) con `group_key` (housing, food, travel…) | Miembros |
| `transactions` | Libro de movimientos | `personal` → solo autor |
| `attachments` | Justificantes en Storage | Heredan del movimiento |
| `recurring_transactions` | Plantillas periódicas (mensual / trimestral / anual) | `personal` → solo autor |
| `trips`, `trip_participants`, `trip_expenses` | Viajes (Fase 2). `trip_expenses` enlaza movimientos reales, sin duplicar importes | Del viaje |
| `investments`, `investment_transactions` | Cartera (Fase 3). Precio unitario `numeric(20,8)` | `personal` → solo dueño |
| `budgets`, `savings_goals` | Presupuestos y objetivos (Fase 2) | `personal` → solo dueño |

Todas las tablas usan UUID, claves foráneas, índices y `created_at`/`updated_at`.

### Dinero

* Importes en **céntimos (`bigint`)**. Nunca `float`. El frontend convierte `"1.234,56"` → `123456`.
* `amount_cents` siempre es positivo; el signo lo da el tipo de movimiento.

### Tipos de movimiento y efecto contable

| Tipo | Cuenta origen | Cuenta destino | ¿Cuenta como gasto/ingreso? |
|---|---|---|---|
| `income` | + importe | – | Ingreso |
| `expense` | − importe | – | Gasto |
| `refund` | + importe | – | Resta del gasto de su categoría |
| `transfer` | − importe | + importe | No |
| `contribution` | − importe (opcional) | + importe (cuenta compartida) | No |
| `investment` | − importe | + importe (cuenta de inversión) | No |

Así una aportación de 600 € a la cuenta común y un gasto de 120 € en el súper pagado desde
ella cuentan como **120 € de gasto**, no 720 €. Comprar acciones mueve dinero a la cuenta de
inversión: cambia la composición del patrimonio pero no es consumo.

* **Gasto** = `expense` − `refund`. **Ahorro** = Ingresos − Gasto.
* **Saldo de cuenta** = saldo inicial + efecto de todos sus movimientos.
* **Patrimonio** = suma de saldos de las cuentas visibles (en Fase 3 se sumará la valoración de la cartera).

## 3. Seguridad (RLS)

Funciones auxiliares en el esquema `private` (no expuesto por la API):

* `is_member(household)`: el usuario pertenece al espacio.
* `can_access(household, visibility, owner)`: miembro **y** (`shared` **o** es el dueño).

Reglas aplicadas en la base de datos:

1. Un usuario solo ve filas de espacios a los que pertenece; un externo no ve nada.
2. Las filas `personal` solo las ve y gestiona su dueño.
3. Las filas `shared` las ven y gestionan todos los miembros.
4. El dueño (`created_by` / `owner_id`) lo fija un trigger con `auth.uid()` y no se puede cambiar.
5. Integridad de movimientos (trigger):
   * solo puedes usar **tus** cuentas personales;
   * un movimiento que toca una cuenta compartida es obligatoriamente `shared`
     (así los dos veis el mismo saldo de la cuenta común);
   * las aportaciones van siempre a una cuenta compartida;
   * la categoría corresponde al tipo (ingreso/gasto) y la subcategoría a la categoría.
6. `anon` no tiene privilegios sobre ninguna tabla ni RPC.
7. Storage: subes solo a `{household}/{tu_usuario}/…`; lees tus ficheros o los de
   movimientos que puedes ver.
8. Anti-duplicados: `client_request_id` único (idempotencia ante doble clic o reintentos) y
   aviso en el formulario si ya existe un movimiento igual.

Las pruebas están en `supabase/tests/rls_test.sql` (15 escenarios con tres usuarios).

## 4. Invitación de la pareja

1. Paul crea el espacio (`create_household`): se crean la cuenta común y las categorías.
2. Genera una invitación (`create_invitation`, opcionalmente ligada a un email). El token
   se muestra **una vez** como enlace `/invitacion/<token>`; en la base solo queda su hash.
3. La pareja se registra y abre el enlace (`accept_invitation`): caduca a los 7 días,
   es de un solo uso y respeta `max_members`.

Para añadir más miembros en el futuro basta con subir `households.max_members`.

## 5. Frontend

```
src/
  lib/        supabase, dinero, fechas, errores, tipos
  providers/  sesión, espacio activo, periodo seleccionado
  hooks/      consultas y mutaciones (TanStack Query)
  components/ layout, tarjetas, modales, gráficas, filtros
  pages/      Inicio, Movimientos, Cuenta común, Inversiones, Estadísticas, Ajustes, auth
```

* Escritorio: menú lateral. Móvil: navegación inferior.
* PWA con `vite-plugin-pwa` (manifest + service worker que cachea solo los estáticos;
  los datos financieros nunca se cachean en el dispositivo).

## 6. Fases

| Fase | Contenido | Esquema |
|---|---|---|
| 1 | Auth, espacio, invitación, dashboard, movimientos, personales/compartidos, cuenta común, gráficas básicas | ✅ |
| 2 | Casa (recurrentes), viajes, comidas, presupuestos, objetivos | ✅ |
| 3 | Inversiones, patrimonio neto, rentabilidad, analítica avanzada, exportación | ✅ tablas ya creadas |

### Fase 2: reglas añadidas (migración 0006)

* **Recurrentes**: `register_recurring` crea la cuota pendiente como movimiento normal (misma RLS y validaciones) y avanza `next_due_on`. Un índice único `(recurring_id, occurred_on)` impide registrar dos veces la misma cuota.
* **Viajes**: `trip_expenses` enlaza movimientos reales con un viaje y su tipo de gasto (vuelos, hotel…), sin duplicar importes. `transactions.trip_id` se sincroniza por trigger. En un viaje compartido todos sus gastos son compartidos, para que el total sea el mismo para los dos.
* **Presupuestos**: `budget_progress` calcula lo consumido en el periodo vigente. Compartido suma gastos compartidos; personal, solo los tuyos; de viaje, los gastos del viaje. Gasto = gastos − reembolsos.
* **Objetivos**: progreso manual o, si se vincula una cuenta, su saldo real.

Las APIs de cotizaciones se integrarán con una Edge Function que use `investments.quote_source`
y `quote_symbol` y escriba `current_value_cents` (las claves de la API vivirán en secretos de Supabase).
