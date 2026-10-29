import { beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRegistry, runTool } from "../src/core/registry"
import * as proveedor from "../src/tools/proveedor"

const ROOT = join(import.meta.dir, "..")
const dir = mkdtempSync(join(tmpdir(), "r01-"))
const ctx = { directory: dir, sessionId: "test" }
const reg = buildRegistry({ proveedor })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (n: string, a: Record<string, unknown>): Promise<{ ok: boolean; data: any; error: string }> =>
  JSON.parse((await runTool(reg, `proveedor_${n}`, a, ctx, { perCaseLog: true })).raw)

beforeAll(() => {
  cpSync(join(ROOT, "fixtures"), join(dir, "fixtures"), { recursive: true })
  cpSync(join(ROOT, "src", "knowledge"), join(dir, "src", "knowledge"), { recursive: true })
})

const etiquetas = async (caso: string): Promise<string[]> => (await call("leer_solicitud", { caso })).data.campos.map((c: { etiqueta: string }) => c.etiqueta)

describe("HU-1 leer_solicitud", () => {
  test("co-industrias-delta: xlsx, 17 campos, 4 soportes", async () => {
    const r = await call("leer_solicitud", { caso: "co-industrias-delta" })
    expect(r.ok).toBe(true)
    expect(r.data.formato).toBe("xlsx")
    expect(r.data.pais).toBe("CO")
    expect(r.data.campos).toHaveLength(17)
    expect(r.data.soportes).toEqual(["camara_comercio", "rut", "certificacion_bancaria", "estados_financieros"])
  })
  test("ec-corp-andina: pdf, RUC ambiguo propuesto", async () => {
    const r = await call("leer_solicitud", { caso: "ec-corp-andina" })
    expect(r.data.formato).toBe("pdf")
    expect(r.data.identificador_tributario_pais).toBe("RUC")
  })
  test("caso inexistente y nombre peligroso → error claro", async () => {
    expect((await call("leer_solicitud", { caso: "nope" })).error).toContain("no existe")
    expect((await call("leer_solicitud", { caso: "../../etc" })).error).toContain("inválido")
  })
})

describe("HU-2 mapear_campos", () => {
  test("CO: todo lleno, NIT sin confirmación, datos bancarios marcados sensibles", async () => {
    const r = await call("mapear_campos", { caso: "co-industrias-delta", campos: await etiquetas("co-industrias-delta") })
    expect(r.data.llenos).toHaveLength(17)
    expect(r.data.faltantes).toHaveLength(0)
    const nit = r.data.llenos.find((x: { etiqueta: string }) => x.etiqueta === "NIT")
    expect(nit.valor).toBe("900123456")
    expect(nit.ruta).toBe("nit")
    expect(r.data.llenos.find((x: { etiqueta: string }) => x.etiqueta === "Número de cuenta").sensible).toBe(true)
  })
  test("EC: RUC requiere confirmación (identificador extranjero); contribuyente especial faltante, nunca inventado", async () => {
    const r = await call("mapear_campos", { caso: "ec-corp-andina", campos: await etiquetas("ec-corp-andina") })
    expect(r.data.requiere_confirmacion.map((x: { etiqueta: string }) => x.etiqueta)).toEqual(["RUC"])
    expect(r.data.requiere_confirmacion[0].nota).toContain("identificador extranjero")
    expect(r.data.faltantes.map((x: { etiqueta: string }) => x.etiqueta)).toEqual(["Número de contribuyente especial"])
    expect(r.data.faltantes[0].valor).toBeNull()
  })
  test("HN: RTN por confirmar, referencias comerciales faltante", async () => {
    const r = await call("mapear_campos", { caso: "hn-agroexport-sula", campos: await etiquetas("hn-agroexport-sula") })
    expect(r.data.requiere_confirmacion.map((x: { etiqueta: string }) => x.etiqueta)).toEqual(["RTN"])
    expect(r.data.faltantes.map((x: { etiqueta: string }) => x.etiqueta)).toEqual(["Referencias comerciales"])
  })
  test("etiqueta ambigua 'Identificación tributaria' en CO → requiere_confirmacion proponiendo NIT", async () => {
    const r = await call("mapear_campos", { caso: "co-industrias-delta", campos: ["Identificación tributaria", "Campo inventado XYZ"] })
    expect(r.data.requiere_confirmacion[0].nota).toContain("NIT")
    expect(r.data.faltantes[0].etiqueta).toBe("Campo inventado XYZ")
  })
})

describe("HU-3 generar_formulario", () => {
  test("xlsx escribe etiqueta y valor en las celdas exactas", async () => {
    const r = await call("generar_formulario", { caso: "co-industrias-delta" })
    expect(r.data.ruta).toBe("out/co-industrias-delta/formulario.xlsx")
    const JSZip = (await import("jszip")).default
    const zip = await JSZip.loadAsync(readFileSync(join(dir, r.data.ruta)))
    const s1 = await zip.file("xl/worksheets/sheet1.xml")!.async("string")
    const s2 = await zip.file("xl/worksheets/sheet2.xml")!.async("string")
    expect(s1).toContain('<c r="B4" t="inlineStr" s="1"><is><t xml:space="preserve">NIT</t>')
    expect(s1).toContain('<c r="C4" t="inlineStr" s="2"><is><t xml:space="preserve">900123456</t>')
    expect(s2).toContain('<c r="C5" t="inlineStr" s="2"><is><t xml:space="preserve">03100012345</t>')
    const wb = await zip.file("xl/workbook.xml")!.async("string")
    expect(wb).toContain('name="Datos Proveedor"')
    expect(wb).toContain('name="Datos Bancarios"')
  })
  test("pdf generado con todos los campos en orden", async () => {
    const r = await call("generar_formulario", { caso: "ec-corp-andina" })
    expect(r.data.formato).toBe("pdf")
    expect(readFileSync(join(dir, r.data.ruta)).subarray(0, 5).toString()).toBe("%PDF-")
  })
  test("portal → formato no soportado + valores-portal.md", async () => {
    const r = await call("generar_formulario", { caso: "pa-logistica-istmo" })
    expect(r.data.soportado).toBe(false)
    expect(r.data.advertencia).toContain("formato no soportado")
    expect(existsSync(join(dir, "out/pa-logistica-istmo/valores-portal.md"))).toBe(true)
  })
  test("ajuste de mapeo: solo rutas, valores siempre del maestro", async () => {
    const r = await call("generar_formulario", { caso: "hn-agroexport-sula", mapeo: [{ etiqueta: "RTN", ruta: "nit" }] })
    expect(r.data.por_confirmar).toEqual([])
    const m = JSON.parse(readFileSync(join(dir, "out/hn-agroexport-sula/mapeo.json"), "utf8"))
    expect(m.llenos.find((x: { etiqueta: string }) => x.etiqueta === "RTN").valor).toBe("900123456")
  })
})

describe("HU-4 armar_paquete (fecha 2026-09-03)", () => {
  test("CO listo para firma con 4 soportes y sin datos bancarios en el correo", async () => {
    const r = await call("armar_paquete", { caso: "co-industrias-delta", fecha_ejecucion: "2026-09-03" })
    expect(r.data.listo_para_firma).toBe(true)
    const p = join(dir, "out/co-industrias-delta/paquete")
    for (const f of ["formulario.xlsx", "checklist.md", "borrador-correo.md", "soportes/rut-2026.txt", "soportes/camara-comercio-2026-08.txt", "soportes/certificacion-bancaria-2026-08.txt", "soportes/estados-financieros-2025.txt"])
      expect(existsSync(join(p, f))).toBe(true)
    const correo = readFileSync(join(p, "borrador-correo.md"), "utf8")
    for (const s of ["03100012345", "COLOCOBM", "Ahorros"]) expect(correo).not.toContain(s)
  })
  test("EC bloqueado por soporte ausente; HN bloqueado por parafiscales vencidos", async () => {
    const ec = await call("armar_paquete", { caso: "ec-corp-andina", fecha_ejecucion: "2026-09-03" })
    expect(ec.data.listo_para_firma).toBe(false)
    expect(ec.data.bloqueos.join()).toContain("certificado_cumplimiento_tributario: ausente")
    const hn = await call("armar_paquete", { caso: "hn-agroexport-sula", fecha_ejecucion: "2026-09-03" })
    expect(hn.data.listo_para_firma).toBe(false)
    expect(hn.data.bloqueos.join()).toContain("parafiscales: vencido")
    expect(readFileSync(join(dir, "out/hn-agroexport-sula/paquete/checklist.md"), "utf8")).toContain("Referencias comerciales")
  })
  test("con fecha 2026-10-28 la Cámara de Comercio (vence 2026-09-30) bloquea CO", async () => {
    const r = await call("armar_paquete", { caso: "co-industrias-delta", fecha_ejecucion: "2026-10-28" })
    expect(r.data.listo_para_firma).toBe(false)
    expect(r.data.bloqueos.join()).toContain("camara_comercio: vencido")
  })
  test("RN5: log por caso con ts, herramienta, ok, resumen", () => {
    const line = JSON.parse(readFileSync(join(dir, "out/co-industrias-delta/log.jsonl"), "utf8").trim().split("\n")[0]!)
    expect(Object.keys(line).sort()).toEqual(["herramienta", "ok", "resumen", "ts"])
  })
})

describe("HU-5 envío y errores", () => {
  test("sin confirmación → error exacto; con confirmación → solo ENVIO-SIMULADO.md", async () => {
    expect((await call("simular_envio", { caso: "co-industrias-delta", confirmado: false })).error).toBe("requiere confirmación explícita")
    expect(existsSync(join(dir, "out/co-industrias-delta/ENVIO-SIMULADO.md"))).toBe(false)
    const r = await call("simular_envio", { caso: "co-industrias-delta", confirmado: true })
    expect(r.data.ruta).toBe("out/co-industrias-delta/ENVIO-SIMULADO.md")
  })
  test("plantilla corrupta: mensaje claro y el paquete (checklist) igual se arma", async () => {
    writeFileSync(join(dir, "fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json"), "{ roto")
    const s = await call("leer_solicitud", { caso: "co-industrias-delta" })
    expect(s.ok).toBe(true)
    expect(s.data.advertencias[0]).toContain("corrupto")
    const g = await call("generar_formulario", { caso: "co-industrias-delta" })
    expect(g.ok).toBe(false)
    expect(g.error).not.toContain("at ")
  })
})
