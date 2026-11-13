#!/usr/bin/env bash
# Crea una base local limpia, aplica el shim + migraciones y ejecuta las pruebas de RLS.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${DB:-oftest}
PSQL=${PSQL:-psql}
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
$PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/local_supabase_shim.sql
for f in migrations/*.sql; do $PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f tests/rls_test.sql 2>&1 | grep -E 'OK|FALLO|ERROR|SUPERADAS'
