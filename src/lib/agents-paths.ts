import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Dónde viven los repos `director-*`.
 *
 * Mission Control vive en `repos/`, que NO se mueve. Los directores se mudan a
 * `<workspace>/agents/` (GON-71). Post-migración son dos árboles independientes y ninguno
 * contiene al otro, así que la ubicación de los directores **no es derivable** desde acá:
 * hay que declararla.
 *
 * Orden de resolución:
 *   1. `AIPATHS_AGENTS_DIR` — la fuente de verdad. Se setea en el archivo de entorno que
 *      carga `start-mission-control-validated.sh`.
 *   2. El layout viejo, mientras dure: los `director-*` cuelgan del mismo padre que `repos/`.
 *      Se acepta sólo si el director pedido **existe** ahí. Sin esa comprobación sería una
 *      heurística por forma, que es exactamente lo que rompió antes (GON-90).
 *   3. `null` — estado válido. Quien lo necesite debe fallar con un mensaje claro en vez de
 *      construir una ruta inventada.
 *
 * Ojo con lo que NO va acá: `~/.openclaw`, `~/Library/…` y demás cuelgan del $HOME del
 * usuario, no del workspace. Para esas, `os.homedir()` es la derivación correcta y portable.
 */

/**
 * `<repo>/../..` — el padre de `repos/`, donde en el layout viejo también viven los directores.
 *
 * Se parte de `process.cwd()` y no del módulo: en el server de Next el código vive bundleado
 * bajo `.next/server/`, así que `import.meta.url` no dice nada del árbol fuente. El cwd sí es
 * confiable acá porque el LaunchAgent fija `WorkingDirectory` en la raíz del repo.
 */
function legacySiblingRoot(): string {
  return path.resolve(process.cwd(), "..", "..");
}

/**
 * Repo de director en el layout anterior, sólo mientras siga existiendo físicamente.
 * Algunos assets históricos pueden sobrevivir allí aunque el agente ya no esté activo.
 */
export function legacyDirectorRoot(name: string): string | null {
  const legacy = path.join(legacySiblingRoot(), `director-${name}`);
  return existsSync(legacy) ? legacy : null;
}

export function agentsDir(): string | null {
  const declared = process.env.AIPATHS_AGENTS_DIR?.trim();
  return declared ? path.resolve(declared) : null;
}

/**
 * Ruta absoluta al repo de un director, o `null` si esta máquina no puede resolverla.
 * @param name nombre corto del director, sin el prefijo: `systems`, `strategist`, `content`…
 */
export function directorRoot(name: string): string | null {
  const declared = agentsDir();
  if (declared) return path.join(declared, `director-${name}`);

  // Layout viejo. La comprobación de existencia es la que separa "derivar" de "adivinar":
  // post-migración esta ruta no existe y devolvemos null en vez de una ruta plausible y muerta.
  return legacyDirectorRoot(name);
}

/** Como `directorRoot`, pero tira con la receta puesta. Para código que no puede seguir sin la ruta. */
export function requireDirectorRoot(name: string): string {
  const resolved = directorRoot(name);
  if (resolved) return resolved;
  throw new Error(
    `No se pudo resolver la ubicación de director-${name}. ` +
      "Declarala con AIPATHS_AGENTS_DIR=<la-carpeta-que-contiene-los-director-*> " +
      "en ~/.config/aipaths/mission-control.env y reiniciá com.aipaths.mission-control.",
  );
}
