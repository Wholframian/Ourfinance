#!/usr/bin/env bash
# Concatena las migraciones en un único setup.sql para pegar en el SQL Editor de Supabase.
set -euo pipefail
cd "$(dirname "$0")"
{
  echo "-- OURFINANCE · setup completo (generado por build_setup.sh, no editar a mano)"
  echo "-- Pegar entero en Supabase → SQL Editor → Run, en un proyecto vacío."
  for f in migrations/*.sql; do echo; echo "-- >>> $f"; cat "$f"; done
} > setup.sql
echo "setup.sql generado"
