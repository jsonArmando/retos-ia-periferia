/**
 * Verificación sin modelo: ejecuta las herramientas sobre todos los casos.
 *   bun run demo.ts            (fecha de ejecución por defecto 2026-09-03, fecha del PRD)
 *   FECHA_DEMO=2026-10-28 bun run demo.ts
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { buildRegistry, runTool } from "./src/core/registry"
import * as proveedor from "./src/tools/proveedor"

const root = import.meta.dir ?? process.cwd()
const fecha = process.env.FECHA_DEMO ?? "2026-09-03"
rmSync(join(root, "out"), { recursive: true, force: true })
const registry = buildRegistry({ proveedor })
const ctx = { directory: root, sessionId: "demo" }
type R<T> = { ok: boolean; data?: T; error?: string }
const call = async <T>(name: string, args: Record<string, unknown>): Promise<R<T>> =>
  JSON.parse((await runTool(registry, name, args, ctx, { perCaseLog: true })).raw) as R<T>

const casos = (await call<{ casos: string[] }>("proveedor_listar_casos", {})).data?.casos ?? []
console.log(`Demo reto-01 · fecha de ejecución ${fecha} · ${casos.length} casos\n`)

for (const caso of casos) {
  console.log(`━━ ${caso}`)
  const sol = await call<{ cliente: string; pais: string; formato: string; campos: Array<{ etiqueta: string }>; soportes: string[]; ambiguos: unknown[] }>("proveedor_leer_solicitud", { caso })
  if (!sol.ok || !sol.data) { console.log(`  ✗ ${sol.error}`); continue }
  const d = sol.data
  console.log(`  ${d.cliente} · ${d.pais} · formato ${d.formato} · ${d.campos.length} campos · soportes: ${d.soportes.join(", ")}`)
  const map = await call<{ llenos: Array<{ etiqueta: string }>; faltantes: Array<{ etiqueta: string }>; requiere_confirmacion: Array<{ etiqueta: string; nota?: string }> }>("proveedor_mapear_campos", { caso, campos: d.campos.map((c) => c.etiqueta) })
  if (map.data) {
    console.log(`  mapeo: ${map.data.llenos.length} llenos · faltantes [${map.data.faltantes.map((f) => f.etiqueta).join(", ")}]`)
    for (const c of map.data.requiere_confirmacion) console.log(`  por confirmar: ${c.etiqueta} — ${c.nota}`)
  }
  const gen = await call<{ ruta: string; soportado: boolean; advertencia?: string }>("proveedor_generar_formulario", { caso })
  console.log(`  formulario: ${gen.ok ? gen.data?.ruta : gen.error}${gen.data?.advertencia ? ` (${gen.data.advertencia})` : ""}`)
  const paq = await call<{ ruta: string; listo_para_firma: boolean; bloqueos: string[] }>("proveedor_armar_paquete", { caso, fecha_ejecucion: fecha })
  console.log(`  paquete: ${paq.data?.ruta} · listo_para_firma=${paq.data?.listo_para_firma}${paq.data?.bloqueos.length ? ` · bloqueos: ${paq.data.bloqueos.join("; ")}` : ""}`)
  console.log()
}

console.log("━━ Errores controlados")
console.log("  caso inexistente  →", (await call("proveedor_leer_solicitud", { caso: "no-existe" })).error)
console.log("  envío sin confirmar →", (await call("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: false })).error)
console.log("  args inválidos    →", (await call("proveedor_mapear_campos", { caso: "co-industrias-delta" })).error)
const env = await call<{ ruta: string }>("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true })
console.log("  envío confirmado  →", env.data?.ruta)
