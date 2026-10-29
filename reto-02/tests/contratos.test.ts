import { beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRegistry, runTool } from "../src/core/registry"
import { parseCsv } from "../src/lib/csv"
import { addMonths, parseMonto } from "../src/lib/extraccion"
import * as contratos from "../src/tools/contratos"

const ROOT = join(import.meta.dir, "..")
const dir = mkdtempSync(join(tmpdir(), "r02-"))
const ctx = { directory: dir, sessionId: "test" }
const reg = buildRegistry({ contratos })
// biome-ignore lint: los resultados JSON se inspeccionan dinámicamente en pruebas
type J = { ok: boolean; data: any; error: string }
const call = async (n: string, a: Record<string, unknown>): Promise<J> => JSON.parse((await runTool(reg, `contratos_${n}`, a, ctx)).raw) as J
const maestro = (): Array<Record<string, string>> => parseCsv(readFileSync(join(dir, "out/sharepoint/maestro-contratos.csv"), "utf8"))

beforeAll(() => {
  process.env.FECHA_REFERENCIA = "2026-09-03"
  cpSync(join(ROOT, "fixtures"), join(dir, "fixtures"), { recursive: true })
  cpSync(join(ROOT, "src", "knowledge"), join(dir, "src", "knowledge"), { recursive: true })
})

describe("utilidades", () => {
  test("montos y meses", () => {
    expect(parseMonto("265.000.000")).toBe(265000000)
    expect(parseMonto("120,000.00")).toBe(120000)
    expect(parseMonto("1.234,50")).toBe(1234.5)
    expect(addMonths("2026-08-15", 12, true)).toBe("2027-08-14")
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28")
  })
})

describe("HU-1 leer_buzon", () => {
  test("6 mensajes; msg-005 sin contrato → rechazado con motivo", async () => {
    const r = await call("leer_buzon", {})
    expect(r.data.mensajes.map((m: { id: string }) => m.id)).toEqual(["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"])
    const m5 = r.data.mensajes[4]
    expect(m5.tiene_contrato).toBe(false)
    expect(m5.clasificacion).toBe("rechazado")
    expect(m5.motivo).toContain("cotizacion.txt")
  })
})

describe("HU-2 extraer", () => {
  test("msg-001: todos los campos con alta confianza", async () => {
    const x = (await call("extraer", { mensaje_id: "msg-001" })).data
    expect(x.id_contrato.valor).toBe("CT-2026-015")
    expect(x.cliente.valor).toBe("Industrias Delta S.A.S.")
    expect(x.nit_cliente.valor).toBe("890900111")
    expect(x.pais.valor).toBe("CO")
    expect(x.valor.valor).toBe(265000000)
    expect(x.moneda.valor).toBe("COP")
    expect(x.fecha_inicio.valor).toBe("2026-08-01")
    expect(x.fecha_fin.valor).toBe("2027-07-31")
    expect(x.requiere_poliza.valor).toBe(true)
    expect(x.tipo_poliza.valor).toBe("cumplimiento")
    expect(x.campos_baja_confianza).toEqual([])
  })
  test("msg-002 EC/USD sin póliza; msg-003 otrosí PEN", async () => {
    const a = (await call("extraer", { mensaje_id: "msg-002" })).data
    expect([a.pais.valor, a.moneda.valor, a.valor.valor, a.requiere_poliza.valor, a.fecha_fin.valor]).toEqual(["EC", "USD", 120000, false, "2027-08-14"])
    const b = (await call("extraer", { mensaje_id: "msg-003" })).data
    expect(b.tipo_documento).toBe("otrosi")
    expect([b.id_contrato.valor, b.pais.valor, b.moneda.valor, b.valor.valor, b.fecha_fin.valor, b.fecha_inicio.valor]).toEqual(["CT-2026-011", "PE", "PEN", 520000, "2027-11-01", null])
    expect(b.fecha_inicio.confianza).toBe(0)
  })
  test("msg-006: valor por demanda y plazo en meses → baja confianza, nunca inventado", async () => {
    const x = (await call("extraer", { mensaje_id: "msg-006" })).data
    expect(x.valor_indeterminado).toBe(true)
    expect(x.valor.valor).toBe(0)
    expect(x.fecha_fin.valor).toBe("2027-08-31")
    expect(x.campos_baja_confianza).toEqual(["valor", "fecha_inicio", "fecha_fin"])
  })
  test("HU-6: vacío, moneda desconocida y fecha inválida → ok:false legible", async () => {
    const mk = (id: string, txt: string): void => {
      mkdirSync(join(dir, "fixtures/reto-02/buzon", id), { recursive: true })
      writeFileSync(join(dir, "fixtures/reto-02/buzon", id, "correo.json"), JSON.stringify({ id, de: "x@y.com", para: "c", asunto: "a", fecha: "2026-08-01T00:00:00-05:00", cuerpo: "", adjuntos: ["contrato.txt"] }))
      writeFileSync(join(dir, "fixtures/reto-02/buzon", id, "contrato.txt"), txt)
    }
    mk("zz-vacio", "   ")
    mk("zz-moneda", "CONTRATO No. CT-2026-900\n\nEntre ACME S.A.S., NIT 900.000.001-1, y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7\n\nPRIMERA. OBJETO. Algo.\n\nSEGUNDA. VALOR. EUR 1.000.\n")
    mk("zz-fecha", "CONTRATO No. CT-2026-901\n\nEntre ACME S.A.S., NIT 900.000.001-1, y PERIFERIA\n\nPRIMERA. OBJETO. Algo.\n\nTERCERA. PLAZO. desde el treinta (30) de febrero de 2026 hasta el uno (1) de marzo de 2027.\n")
    expect((await call("extraer", { mensaje_id: "zz-vacio" })).error).toContain("rechazado")
    expect((await call("extraer", { mensaje_id: "zz-moneda" })).error).toContain("moneda desconocida: EUR")
    expect((await call("extraer", { mensaje_id: "zz-fecha" })).error).toContain("fecha inválida")
  })
})

describe("HU-3/HU-4 validar y registrar (sección 7.4)", () => {
  test("msg-001 nuevo con póliza → pendiente", async () => {
    expect((await call("validar", { mensaje_id: "msg-001" })).data.clasificacion).toBe("nuevo")
    const r = await call("registrar", { mensaje_id: "msg-001" })
    expect(r.data.ruta_archivo).toBe("Contratos/2026/industrias-delta/CT-2026-015.txt")
    expect(existsSync(join(dir, "out/sharepoint", r.data.ruta_archivo))).toBe(true)
    const f = maestro().find((x) => x.id_contrato === "CT-2026-015")
    expect(f?.estado_poliza).toBe("pendiente")
    expect(f?.comercial).toBe("Laura Gómez Restrepo")
    expect(readFileSync(join(dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8")).not.toContain("CT-2026-015")
  })
  test("msg-002 nuevo sin póliza → no_aplica", async () => {
    await call("registrar", { mensaje_id: "msg-002" })
    expect(maestro().find((x) => x.id_contrato === "CT-2026-016")?.estado_poliza).toBe("no_aplica")
  })
  test("msg-003 otrosí → actualización de la fila existente + historial", async () => {
    const v = await call("validar", { mensaje_id: "msg-003" })
    expect(v.data.clasificacion).toBe("actualizacion")
    expect(v.data.id_contrato_existente).toBe("CT-2026-011")
    await call("registrar", { mensaje_id: "msg-003" })
    const filas = maestro().filter((x) => x.id_contrato === "CT-2026-011")
    expect(filas).toHaveLength(1)
    expect([filas[0]?.fecha_fin, filas[0]?.valor, filas[0]?.fecha_inicio]).toEqual(["2027-11-01", "520000", "2026-05-02"])
    const h = readFileSync(join(dir, "out/sharepoint/historial.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const act = h.find((e) => e.accion === "actualizacion")
    expect(act.cambios.fecha_fin).toEqual({ antes: "2027-05-01", despues: "2027-11-01" })
    expect(Object.keys(act)).toEqual(expect.arrayContaining(["ts", "id_contrato", "accion", "cambios", "mensaje_id"]))
  })
  test("msg-004 duplicado → sin escritura; msg-005 rechazado", async () => {
    const antes = readFileSync(join(dir, "out/sharepoint/maestro-contratos.csv"), "utf8")
    expect((await call("validar", { mensaje_id: "msg-004" })).data.clasificacion).toBe("duplicado")
    expect((await call("registrar", { mensaje_id: "msg-004" })).data.accion).toBe("sin_cambios_duplicado")
    expect(readFileSync(join(dir, "out/sharepoint/maestro-contratos.csv"), "utf8")).toBe(antes)
    expect((await call("registrar", { mensaje_id: "msg-005" })).data.accion).toBe("rechazado")
  })
  test("msg-006 requiere revisión (valor, fecha_fin); remitente desconocido no bloquea; solo registra con confirmado", async () => {
    const v = await call("validar", { mensaje_id: "msg-006" })
    expect(v.data.clasificacion).toBe("nuevo")
    expect(v.data.requiere_revision).toEqual(expect.arrayContaining(["valor", "fecha_fin"]))
    expect(v.data.advertencias[0]).toContain("jperez@")
    const r1 = await call("registrar", { mensaje_id: "msg-006" })
    expect(r1.ok).toBe(false)
    expect(r1.error).toStartWith("requiere revisión")
    expect(maestro().some((x) => x.id_contrato === "CM-2026-03")).toBe(false)
    const r2 = await call("registrar", { mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true })
    expect(r2.ok).toBe(true)
    const f = maestro().find((x) => x.id_contrato === "CM-2026-03")
    expect([f?.valor, f?.fecha_fin, f?.comercial]).toEqual(["0", "2027-08-31", ""])
  })
  test("O2: cero filas duplicadas; procesados.json con los 6 mensajes; re-registro rechazado", async () => {
    const ids = maestro().map((x) => x.id_contrato)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(11)
    expect(JSON.parse(readFileSync(join(dir, "out/procesados.json"), "utf8"))).toHaveLength(6)
    expect((await call("registrar", { mensaje_id: "msg-001" })).error).toContain("ya fue procesado")
    expect((await call("leer_buzon", {})).data.mensajes.filter((m: { id: string }) => m.id.startsWith("msg"))).toHaveLength(0)
  })
  test("un valor modificado por el modelo entra a revisión (no se registra a ciegas)", async () => {
    const v = await call("validar", { mensaje_id: "msg-002", contrato: { valor: 999 } })
    expect(v.data.clasificacion).toBe("actualizacion")
    expect(v.data.requiere_revision).toContain("valor")
  })
})

describe("HU-5 alertas", () => {
  test("hoy=2026-09-03", async () => {
    const r = await call("alertas", { hoy: "2026-09-03" })
    expect(r.data.vencen.map((x: { id_contrato: string }) => x.id_contrato)).toEqual(["CT-2026-009", "CT-2026-004"])
    expect(r.data.polizas_pendientes.map((x: { id_contrato: string }) => x.id_contrato).sort()).toEqual(["CM-2026-03", "CT-2026-004", "CT-2026-011", "CT-2026-015"])
    expect(r.data.registrados_desde_corte.map((x: { id_contrato: string }) => x.id_contrato).sort()).toEqual(["CM-2026-03", "CT-2026-011", "CT-2026-015", "CT-2026-016"])
    const md = readFileSync(join(dir, "out/alertas.md"), "utf8")
    for (const s of ["Vencen en ≤ 60 días", "Pólizas exigidas no vigentes", "Registrados desde el corte"]) expect(md).toContain(s)
  })
  test("RN7: out/log.jsonl con mensaje_id", () => {
    const l = readFileSync(join(dir, "out/log.jsonl"), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x))
    expect(l.some((e) => e.mensaje_id === "msg-006" && e.herramienta === "contratos_registrar")).toBe(true)
  })
})
