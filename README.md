# OURFINANCE

Gestor financiero personal y compartido para una pareja. Cada uno tiene su cuenta y sus
finanzas privadas, y juntos compartís un espacio con la cuenta común, los gastos de casa
y las aportaciones.

React + TypeScript + Vite · Tailwind CSS · Recharts · Supabase (PostgreSQL, Auth, RLS, Storage) · PWA.
Español, EUR, Europe/Madrid, fechas DD/MM/YYYY.

- Arquitectura, modelo de datos y reglas de seguridad: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)
- Esquema SQL: [`supabase/migrations`](supabase/migrations) (todo junto en [`supabase/setup.sql`](supabase/setup.sql))

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Registro e inicio de sesión, espacio compartido e invitación, dashboard, movimientos (alta, edición, duplicado, borrado, justificantes), personales/compartidos, cuenta común y aportaciones, gráficas básicas | ✅ |
| 2 | Casa, viajes, comidas, presupuestos, objetivos de ahorro | Tablas creadas, pantallas pendientes |
| 3 | Inversiones, patrimonio neto, rentabilidad, analítica avanzada, exportación | Tablas creadas, pantallas pendientes |

## Puesta en marcha

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com) (región UE).
2. **SQL Editor → New query**: pega el contenido de `supabase/setup.sql` y pulsa **Run**.
   En un proyecto que ya tenga el esquema, ejecuta solo las migraciones nuevas de `supabase/migrations/`, en orden.
3. **Authentication → Sign In / Providers → Email**: deja activado *Confirm email* en producción.
4. **Authentication → URL Configuration**: pon como *Site URL* la URL donde publiques la app
   (y `http://localhost:5173` en *Redirect URLs* para desarrollo). Se usa en los emails de confirmación y de recuperar contraseña.

### 2. Aplicación

```bash
npm install
cp .env.example .env.local   # y rellena URL y clave publishable/anon
npm run dev                  # http://localhost:5173
```

Variables (`.env.local`):

| Variable | Valor |
|---|---|
| `VITE_SUPABASE_URL` | Project URL (Settings → API) |
| `VITE_SUPABASE_ANON_KEY` | Clave **publishable / anon** |

> ⚠️ Nunca uses la `service_role` key en la app: todo lo que empieza por `VITE_` se incluye en el
> código que descarga el navegador. La seguridad la aplican las políticas RLS de la base de datos.

### 3. Primeros pasos en la app

1. Regístrate y crea el espacio: se crean la **cuenta común** y las categorías.
2. En **Ajustes → Cuentas** añade tus cuentas personales (con su saldo inicial).
3. En **Ajustes → Espacio compartido** genera la invitación y envíasela a tu pareja.
   Tu pareja se registra con ese enlace y queda unida al espacio.

## Despliegue

### GitHub Pages (configurado)

El workflow `.github/workflows/deploy.yml` publica la app en `https://wholframian.github.io/Ourfinance/`
en cada push a `main` (pasa antes las pruebas unitarias). Necesita:

- Settings → Pages → Source: **GitHub Actions**.
- La URL y la clave **publishable** están en `.env.production` (son públicas por diseño; la `service_role` nunca va ahí).
- En Supabase → Authentication → URL Configuration: *Site URL* `https://wholframian.github.io/Ourfinance/`.

### Otros hostings

Es una SPA estática. Cualquier hosting estático sirve (Vercel, Netlify, Cloudflare Pages):

- Comando de build: `npm run build` · Carpeta: `dist`
- Variables de entorno: `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`
- Reescritura de rutas a `/index.html` (SPA). En Vercel se hace con `vercel.json` (incluido);
  en Netlify con `public/_redirects` (incluido).

Tras desplegar, añade la URL en Supabase → Authentication → URL Configuration.

### Instalar en el móvil (PWA)

- **iPhone (Safari)**: Compartir → *Añadir a pantalla de inicio*.
- **Android (Chrome)**: menú ⋮ → *Instalar aplicación*.

El service worker solo cachea los ficheros de la app; los datos financieros siempre se piden a Supabase.

## Pruebas

```bash
npm test                 # unitarias: importes, céntimos y fechas
npm run test:rls         # RLS e integridad con 3 usuarios en un PostgreSQL local (requiere psql y un servidor local)
npm run verify:supabase  # comprobación real contra tu proyecto con usuarios de prueba (requiere "Confirm email" desactivado)
```

`verify:supabase` crea tres usuarios `ourfinance.test.*`, comprueba persistencia, invitación,
privacidad, saldos y justificantes, y borra el espacio de prueba. Los usuarios quedan en
Authentication → Users para que los borres.

## Reglas contables

- Importes en céntimos enteros (sin coma flotante).
- **Gasto** = gastos − reembolsos. **Ahorro** = ingresos − gasto.
- Transferencias, **aportaciones a la cuenta común** y movimientos de inversión no son gasto:
  solo mueven dinero entre cuentas. Así no se cuenta dos veces lo que aportas y lo que se gasta desde la cuenta común.
- Cualquier movimiento de una cuenta compartida es compartido, para que los dos veáis el mismo saldo.

## Estructura

```
src/
  lib/         cliente Supabase, dinero, fechas, errores, tipos
  providers/   sesión, espacio compartido, periodo seleccionado
  hooks/       consultas y mutaciones (TanStack Query)
  components/  layout, UI, gráficas, formulario y lista de movimientos
  pages/       Inicio, Movimientos, Cuenta común, Inversiones, Estadísticas, Ajustes, acceso
supabase/
  migrations/  esquema, seguridad (RLS), RPC, storage
  tests/       pruebas de RLS
scripts/       verificación contra Supabase
```
