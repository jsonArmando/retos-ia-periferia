import { beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRegistry, runTool } from "../src/core/registry"
import { OrdenCompraSchema } from "../src/sap/adapter"
import * as oc from "../src/tools/oc"

const ROOT = join(import.meta.dir, "..")
const dir = mkdtempSync(join(tmpdir(), "r03-"))
const ctx = { directory: dir, sessionId: "test" }
const reg = buildRegistry({ oc })
// biome-ignore lint: resultados JSON inspeccionados dinámicamente en pruebas
type J = { ok: boolean; data: any; error: string }
const call = async (n: string, a: Record<string, unknown>): Promise<J> => JSON.parse((await runTool(reg, `oc_${n}`, a, ctx, { perCaseLog: true })).raw) as J
const control = (): string[][] => readFileSync(join(dir, "out/control.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","))

beforeAll(() => {
  process.env.FECHA_REFERENCIA = "2026-09-03"
  cpSync(join(ROOT, "fixtures"), join(dir, "fixtures"), { recursive: true })
  cpSync(join(ROOT, "src", "knowledge"), join(dir, "src", "knowledge"), { recursive: true })
})

describe("HU-1 leer_paquete", () => {
  test("normaliza correo, solicitud, cotización, aprobación y factura", async () => {
    const p = (await call("leer_paquete", { caso: "sol-005" })).data
    expect(p.cotizacion).toMatchObject({ proveedor: "Papelería Central Ltda.", nit: "800444555", total: 3200000, moneda: "COP", validez_hasta: "2026-09-04" })
    expect(p.aprobacion.aprobado).toBe(true)
    expect(p.factura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3200000 })
    expect((await call("leer_paquete", { caso: "sol-001" })).data.factura).toBeNull()
  })
  test("HU-6: JSON malformado / monto no numérico / caso inexistente → error legible con acción", async () => {
    cpSync(join(dir, "fixtures/reto-03/solicitudes/sol-001"), join(dir, "fixtures/reto-03/solicitudes/zz-roto"), { recursive: true })
    writeFileSync(join(dir, "fixtures/reto-03/solicitudes/zz-roto/solicitud.json"), "{ malo")
    expect((await call("leer_paquete", { caso: "zz-roto" })).error).toContain("corrupto")
    cpSync(join(dir, "fixtures/reto-03/solicitudes/sol-001"), join(dir, "fixtures/reto-03/solicitudes/zz-monto"), { recursive: true })
    const s = JSON.parse(readFileSync(join(dir, "fixtures/reto-03/solicitudes/sol-001/solicitud.json"), "utf8"))
    writeFileSync(join(dir, "fixtures/reto-03/solicitudes/zz-monto/solicitud.json"), JSON.stringify({ ...s, valor_total: "once millones" }))
    const e = (await call("validar", { caso: "zz-monto" })).error
    expect(e).toContain("valor_total no es numérico")
    expect(e).toContain("Pedir al solicitante")
    expect((await call("leer_paquete", { caso: "sol-999" })).error).toContain("no existe")
  })
})

describe("HU-2 validar (matriz RC)", () => {
  const casos: Array<[string, boolean, string[], string[], boolean]> = [
    ["sol-001", true, [], [], false],
    ["sol-002", false, ["RC1"], [], false],
    ["sol-003", false, ["RC2"], [], false],
    ["sol-004", true, [], ["RC5"], false],
    ["sol-005", true, [], ["RC8"], true],
    ["sol-006", true, [], ["RC6"], false],
  ]
  for (const [caso, apta, bloq, conf, retro] of casos)
    test(`${caso}: apta=${apta} bloqueos=[${bloq}] confirmaciones=[${conf}] retroactiva=${retro}`, async () => {
      const v = (await call("validar", { caso })).data
      expect(v.apta).toBe(apta)
      expect(v.bloqueos.map((b: { codigo: string }) => b.codigo)).toEqual(bloq)
      expect(v.confirmaciones.map((b: { codigo: string }) => b.codigo)).toEqual(conf)
      expect(v.retroactiva).toBe(retro)
      for (const b of v.bloqueos) expect(b.accion_sugerida.length).toBeGreaterThan(10)
    })
  test("sol-004 muestra ambos valores; sol-006 deriva IVA (confirmación) y condiciones (informativo)", async () => {
    const v4 = (await call("validar", { caso: "sol-004" })).data
    expect(v4.confirmaciones[0].valores).toMatchObject({ solicitud: 25000000, cotizacion: 26500000 })
    const v6 = (await call("validar", { caso: "sol-006" })).data
    expect(v6.derivados.indicador_iva).toEqual({ valor: "C1", fuente: "maestro.proveedores.indicador_iva_default" })
    expect(v6.derivados.condiciones_pago.valor).toBe("Z030")
  })
})

describe("HU-3/HU-4 payload y evidencia", () => {
  test("payload válido contra zod, descripción ≤ 40, unidad H, trazabilidad completa", async () => {
    const r = (await call("construir_payload", { caso: "sol-004" })).data
    expect(OrdenCompraSchema.safeParse(r.orden).success).toBe(true)
    expect(r.orden.posiciones[0].descripcion.length).toBeLessThanOrEqual(40)
    expect(r.orden.posiciones[0].unidad).toBe("H")
    expect(r.orden.posiciones[0].precio_unitario).toBe(250000)
    const t = JSON.parse(readFileSync(join(dir, "out/sol-004/trazabilidad.json"), "utf8"))
    expect(t["proveedor.codigo_sap"]).toContain("maestro.proveedores")
    const r6 = (await call("construir_payload", { caso: "sol-006" })).data
    expect(r6.orden.posiciones[0].indicador_iva).toBe("C1")
    expect(JSON.parse(readFileSync(join(dir, "out/sol-006/trazabilidad.json"), "utf8"))["posiciones[0].indicador_iva"]).toContain("derivado")
  })
  test("caso bloqueado no construye payload", async () => {
    expect((await call("construir_payload", { caso: "sol-002" })).error).toContain("RC1")
  })
  test("evidencia txt + pdf; sha256 verificable y coincide con el payload", async () => {
    const e = (await call("generar_evidencia", { caso: "sol-001" })).data
    const txt = readFileSync(join(dir, e.ruta), "utf8")
    const contenido = txt.split("\n---\n")[0] ?? ""
    expect(createHash("sha256").update(contenido).digest("hex")).toBe(e.sha256)
    expect(readFileSync(join(dir, e.ruta_pdf)).subarray(0, 5).toString()).toBe("%PDF-")
    expect((await call("construir_payload", { caso: "sol-001" })).data.orden.aprobador.evidencia_sha256).toBe(e.sha256)
  })
})

describe("HU-5 crear", () => {
  test("O1: sol-001 se crea sin intervención con número 4500000001", async () => {
    const r = await call("crear", { caso: "sol-001" })
    expect(r.data).toMatchObject({ numero_oc: "4500000001", idempotente: false, fecha: "2026-09-03" })
  })
  test("idempotencia: segunda vez devuelve el mismo número y no crea otra OC", async () => {
    const r = await call("crear", { caso: "sol-001" })
    expect(r.data).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    expect(readFileSync(join(dir, "out/sap/ordenes.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
  })
  test("O2: sol-002 y sol-003 no crean OC", async () => {
    for (const caso of ["sol-002", "sol-003"]) {
      const r = await call("crear", { caso, confirmado: true })
      expect(r.ok).toBe(false)
      expect(r.error).toStartWith("bloqueada")
    }
  })
  test("O3: sol-004 y sol-006 piden confirmación; con confirmado crean", async () => {
    for (const caso of ["sol-004", "sol-006"]) expect((await call("crear", { caso })).error).toStartWith("requiere confirmación")
    expect((await call("crear", { caso: "sol-004", confirmado: true })).data.numero_oc).toBe("4500000002")
  })
  test("payload alterado por el modelo se rechaza", async () => {
    const r = await call("crear", { caso: "sol-006", confirmado: true, payload: { posiciones: [{ precio_unitario: 1 }] } })
    expect(r.error).toContain("posiciones.0.precio_unitario")
  })
  test("O4: sol-005 solo con confirmación y marcada retroactiva en control.csv", async () => {
    expect((await call("crear", { caso: "sol-005" })).ok).toBe(false)
    const r = await call("crear", { caso: "sol-005", confirmado: true })
    expect(r.data.retroactiva).toBe(true)
    const fila = control().find((f) => f[0] === "SOL-2026-005" && f[1] === "creada")
    expect(fila?.[3]).toBe("true")
    expect(fila?.[2]).toBe("4500000003")
    const orden = JSON.parse(readFileSync(join(dir, "out/sol-005/orden.json"), "utf8"))
    expect(orden.orden.excepciones[0]).toMatchObject({ codigo: "RC8", confirmado_por: "analista (sesión test)" })
  })
  test("control.csv registra cada intento con las columnas exigidas", () => {
    expect(readFileSync(join(dir, "out/control.csv"), "utf8").split("\n")[0]).toBe("solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts")
    const res = control().map((f) => f[1])
    for (const x of ["creada", "idempotente", "bloqueada", "pendiente_confirmacion", "rechazada_payload_alterado"]) expect(res).toContain(x)
    expect(existsSync(join(dir, "out/sol-001/log.jsonl"))).toBe(true)
  })
})
