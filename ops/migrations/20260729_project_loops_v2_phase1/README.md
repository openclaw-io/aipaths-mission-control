# Project Loops V2 — Fase 1 foundation

Estos artefactos preparan el esquema normalizado de Project Loops V2, pero **no activan el runtime V2**. La aplicación sigue creando y ejecutando Loops V1 porque `loops.workflow_version` conserva el default `1`; el read-model shadow es puro y no está conectado a rutas ni UI.

No se ejecutó esta migración contra bases live durante el desarrollo. La migración no contiene backfill mutante: los Loops existentes reciben defaults aditivos de PostgreSQL y las tablas V2 quedan vacías.

## Aplicación manual por store

Aplicar de forma independiente en cada store (cloud Supabase y PostgreSQL local), con servicios/escritores detenidos y backup verificado:

1. Revisar que el target sea el store esperado y capturar conteos de `loops`.
2. Ejecutar `supabase/migrations/032_project_loops_v2_foundation.sql`.
3. Ejecutar `verify.sql` en modo read-only.
4. Confirmar que `loop_count = untouched_v1_count` y que no se insertaron filas V2.

Cloud → local sync no reemplaza la migración de ninguno de los stores. Reanudarlo sólo cuando ambos stores tengan migration 032 y hayan pasado `verify.sql`.

## Rollback

`rollback.sql` es transaccional y rehearsable. Sólo revierte mientras el runtime V2 siga apagado: rechaza el rollback si alguna tabla V2 contiene filas o si cualquier Loop dejó los defaults `workflow_version=1`, `mode=linear`, `current_plan_revision_id=NULL`, `row_version=1`. Esto evita borrar silenciosamente datos V2.

Con backup verificado y escritores detenidos:

1. Ejecutar `rollback.sql`.
2. Verificar que las siete tablas V2 y las cuatro columnas aditivas ya no existan.
3. Comparar conteos y muestra/fingerprint de Loops contra el snapshot previo.

Si el guard rechaza el rollback, no forzarlo: conservar el store, diagnosticar el estado no-default y preparar una recuperación específica.
