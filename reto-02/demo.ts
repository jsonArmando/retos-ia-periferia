/** Verificación sin modelo: procesa los 6 mensajes del buzón llamando directamente a las herramientas.  bun run demo.ts */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { buildRegistry, runTool } from "./src/core/registry"
import * as contratos from "./src/tools/contratos"

const root = import.meta.dir ?? process.cwd()
const HOY = process.env.FECHA_DEMO ?? "2026-09-03"
process.env.FECHA_REFERENCIA ??= HOY // fecha_registro determinista
rmSync(join(root, "out"), { recursive: true, force: true })
const registry = buildRegistry({ contratos })
const ctx = { directory: root, sessionId: "demo" }
type R = { ok: boolean; data?: Record<string, unknown>; error?: string }
const call = async (name: string, args: Record<string, unknown>): Promise<R> => JSON.parse((await runTool(registry, `contratos_${name}`, args, ctx)).raw) as R

const buzon = (await call("leer_buzon", {})).data?.mensajes as Array<{ id: string; asunto: string; tiene_contrato: boolean }>
console.log(`Demo reto-02 · hoy=${HOY} · ${buzon.length} mensajes\n`)
console.log("mensaje  | clasificación  | revisión                         | acción")
console.log("---------|----------------|----------------------------------|----------------------------")
const pendientes: string[] = []
for (const m of buzon) {
  const v = await call("validar", { mensaje_id: m.id })
  const clas = v.ok ? String(v.data?.clasificacion) : "error"
  const rev = v.ok ? (v.data?.requiere_revision as string[]).join(", ") : String(v.error)
  const r = await call("registrar", { mensaje_id: m.id })
  const accion = r.ok ? String(r.data?.resumen) : `NO registrado → ${r.error?.split(":")[0]}`
  if (!r.ok) pendientes.push(m.id)
  console.log(`${m.id}  | ${clas.padEnd(14)} | ${rev.padEnd(32)} | ${accion}`)
}

console.log("\nSegunda pasada (confirmación humana explícita):")
for (const id of pendientes) {
  const r = await call("registrar", { mensaje_id: id, contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true })
  console.log(`  ${id} confirmado → ${r.ok ? String(r.data?.resumen) : r.error}`)
}

console.log("\nErrores controlados:")
console.log("  re-registrar msg-001 →", (await call("registrar", { mensaje_id: "msg-001" })).error)
console.log("  mensaje inexistente  →", (await call("extraer", { mensaje_id: "msg-999" })).error)
console.log("  fecha inválida       →", (await call("alertas", { hoy: "2026-02-30" })).error)

const a = await call("alertas", { hoy: HOY })
console.log(`\nAlertas → ${a.data?.ruta}: ${a.data?.resumen}`)
