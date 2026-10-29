/** Verificación sin modelo: procesa los 6 casos llamando directamente a las herramientas.  bun run demo.ts */
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildRegistry, runTool } from "./src/core/registry"
import * as oc from "./src/tools/oc"

const root = import.meta.dir ?? process.cwd()
process.env.FECHA_REFERENCIA ??= "2026-09-03"
rmSync(join(root, "out"), { recursive: true, force: true })
const registry = buildRegistry({ oc })
const ctx = { directory: root, sessionId: "demo" }
type R = { ok: boolean; data?: Record<string, unknown>; error?: string }
const call = async (name: string, args: Record<string, unknown>): Promise<R> => JSON.parse((await runTool(registry, `oc_${name}`, args, ctx, { perCaseLog: true })).raw) as R
const cods = (x: unknown): string => (x as Array<{ codigo: string }>).map((b) => b.codigo).join(",") || "-"

const casos = readdirSync(join(root, "fixtures/reto-03/solicitudes")).sort()
console.log(`Demo reto-03 · ${casos.length} casos (primera pasada sin confirmación)\n`)
console.log("caso     | apta  | bloqueos  | confirmaciones | retroactiva | resultado")
console.log("---------|-------|-----------|----------------|-------------|------------------------------")
for (const caso of casos) {
  await call("leer_paquete", { caso })
  const v = (await call("validar", { caso })).data ?? {}
  if (v.apta) { await call("construir_payload", { caso }); await call("generar_evidencia", { caso }) }
  const c = await call("crear", { caso })
  const res = c.ok ? `OC ${String(c.data?.numero_oc)}` : String(c.error).split(":")[0]
  console.log(`${caso}  | ${String(v.apta).padEnd(5)} | ${cods(v.bloqueos).padEnd(9)} | ${cods(v.confirmaciones).padEnd(14)} | ${String(v.retroactiva).padEnd(11)} | ${res}`)
}

console.log("\nMotivos de bloqueo:")
for (const caso of ["sol-002", "sol-003"]) console.log(`  ${caso}: ${(await call("crear", { caso })).error}`)

console.log("\nIdempotencia (sol-001 otra vez):")
const again = await call("crear", { caso: "sol-001" })
console.log(`  numero_oc=${String(again.data?.numero_oc)} idempotente=${String(again.data?.idempotente)}`)

console.log("\nConfirmación explícita:")
for (const caso of ["sol-004", "sol-005"]) {
  const r = await call("crear", { caso, confirmado: true })
  console.log(`  ${caso} → ${r.ok ? `${String(r.data?.resumen)} · evidencia ${(r.data?.evidencia as { ruta_pdf: string }).ruta_pdf}` : r.error}`)
}
console.log("\nPayload alterado por el modelo:")
console.log("  sol-006 →", (await call("crear", { caso: "sol-006", confirmado: true, payload: { posiciones: [{ precio_unitario: 1 }] } })).error ?? "?")

console.log("\nout/control.csv:")
console.log(readFileSync(join(root, "out/control.csv"), "utf8").replace(/,\d{4}-\d\d-\d\dT[\d:.]+Z/g, ",<ts>"))
