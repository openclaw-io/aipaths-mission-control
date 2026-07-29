# Project Loops V2 — Fase 3 runtime serial

Migración manual y aditiva. No aplicar sobre live desde este worktree ni activar scheduler/servicios.

1. Crear backup del store objetivo.
2. Ejecutar `033_project_loops_v2_serial_runtime.sql` de forma independiente en cada store.
3. Ejecutar `verify.sql` en modo read-only.
4. Usar `rollback.sql` solamente antes de crear mappings de runtime; el guard rechaza pérdida de datos.

El rehearsal y los tests usan bases Postgres disposable, nunca la DB live.
