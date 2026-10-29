import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod/v4"
import { isSafeId, outPath, readJsonFile, readTextFile, rel, writeOut } from "../core/files"
import { renderPdf } from "../core/pdf"
import { formatNumber, normalize, parseMonto } from "../core/text"
import { defineTool, fail, ok, safe, type ToolContext } from "../core/tool"
import { OrdenCompraSchema, type OrdenCompra, type SapAdapter } from "../sap/adapter"
import { SapMock } from "../sap/mock"

// ---------------------------------------------------------------- tipos
const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad no es numérica" }).positive(),
  valor_unitario: z.number({ error: "valor_unitario no es numérico" }).nonnegative(),
  valor_total: z.number({ error: "valor_total no es numérico" }).positive(),
  moneda: z.string().min(3),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser YYYY-MM-DD"),
})
type Solicitud = z.infer<typeof SolicitudSchema>
type Correo = { id: string; de: string; asunto: string; fecha: string; adjuntos?: string[] }
type AprobacionRaw = { de: string; para: string; cc?: string[]; fecha: string; asunto: string; cuerpo: string }
type Item = { descripcion: string; cantidad: number; precio_unitario: number }
export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: { numero: string | null; proveedor: string; nit: string | null; total: number; moneda: string; fecha: string | null; validez_hasta: string | null; items: Item[]; texto: string } | null
  aprobacion: { de: string; para: string; cc: string[]; fecha: string; asunto: string; aprobado: boolean; texto: string } | null
  factura: { numero: string; fecha: string; total: number } | null
  faltantes: string[]
}
type Proveedor = { codigo_sap: string; nit: string; nombre: string; condiciones_pago_default: string; indicador_iva_default: string; activo: boolean }
type Centro = { centro_costo: string; nombre: string; subareas: string[]; aprobadores: Array<{ email: string; nombre: string; tope: number }> }
type Reglas = { tolerancia_cotizacion: number; tolerancia_aritmetica: number; monedas: string[]; sociedad: "1000"; organizacion_compras: "1000"; unidades: Record<string, "H" | "MES"> }
type Bloqueo = { codigo: string; detalle: string; accion_sugerida: string }
type Confirmacion = { codigo: string; detalle: string; valores?: Record<string, string | number> }
type Derivado = { valor: string; fuente: string }
type Validacion = {
  apta: boolean
  bloqueos: Bloqueo[]
  confirmaciones: Confirmacion[]
  derivados: { proveedor?: { codigo_sap: string; nombre: string; nit: string }; indicador_iva?: Derivado; condiciones_pago?: Derivado }
  retroactiva: boolean
}

const FIX = (ctx: ToolContext, ...p: string[]): string => join(ctx.directory, "fixtures", "reto-03", ...p)
const maestro = <T>(ctx: ToolContext, f: string): T => JSON.parse(readFileSync(FIX(ctx, "maestros", f), "utf8")) as T
const reglas = (ctx: ToolContext): Reglas => JSON.parse(readFileSync(join(ctx.directory, "src", "knowledge", "reglas.json"), "utf8")) as Reglas
const sap = (ctx: ToolContext): SapAdapter => new SapMock(ctx.directory)
const soloFecha = (s: string): string => s.slice(0, 10)
const nitSinDv = (s: string): string => s.replace(/-\d$/, "").replace(/\D/g, "")
const cop = (n: number): string => formatNumber(n)

// ---------------------------------------------------------------- lectura y normalización (HU-1)
function addDays(iso: string, d: number): string {
  const dt = new Date(`${iso}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + d)
  return dt.toISOString().slice(0, 10)
}

function parseCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const linea = (re: RegExp): string | null => texto.match(re)?.[1]?.trim() ?? null
  const total = texto.match(/TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/)
  const fecha = linea(/Fecha:\s*(\d{4}-\d{2}-\d{2})/)
  const dias = Number(linea(/Validez[^:]*:\s*(\d+)\s*d[ií]as/) ?? NaN)
  const items = [...texto.matchAll(/^\s*\d+\.\s*(.+?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario[^:]*:\s*[A-Z]{3}\s*([\d.,]+)/gm)].map((m) => ({
    descripcion: m[1] ?? "",
    cantidad: parseMonto(m[2] ?? "") ?? 0,
    precio_unitario: parseMonto(m[3] ?? "") ?? 0,
  }))
  const nit = linea(/NIT:\s*([\d.\-]+)/)
  return {
    numero: linea(/COTIZACI[OÓ]N\s+([A-Z0-9-]+)/),
    proveedor: linea(/Proveedor:\s*(.+)/) ?? "",
    nit: nit ? nitSinDv(nit) : null,
    total: total?.[2] ? (parseMonto(total[2]) ?? Number.NaN) : Number.NaN,
    moneda: total?.[1] ?? "",
    fecha,
    validez_hasta: fecha && Number.isFinite(dias) ? addDays(fecha, dias) : null,
    items,
    texto,
  }
}

function parseFactura(texto: string): NonNullable<Paquete["factura"]> | null {
  const numero = texto.match(/No\.\s*([A-Z0-9-]+)/)?.[1]
  const fecha = texto.match(/Fecha[^:\n]*:\s*(\d{4}-\d{2}-\d{2})/)?.[1]
  const total = texto.match(/TOTAL[^:\n]*:\s*[A-Z]{3}\s*([\d.,]+)/)?.[1]
  return numero && fecha ? { numero, fecha, total: total ? (parseMonto(total) ?? 0) : 0 } : null
}

function leerPaquete(ctx: ToolContext, caso: string): { ok: true; value: Paquete } | { ok: false; error: string } {
  if (!isSafeId(caso)) return { ok: false, error: `nombre de caso inválido: "${caso}"` }
  const base = FIX(ctx, "solicitudes", caso)
  if (!existsSync(base)) {
    const disp = existsSync(FIX(ctx, "solicitudes")) ? readdirSync(FIX(ctx, "solicitudes")).sort().join(", ") : ""
    return { ok: false, error: `el caso "${caso}" no existe. Disponibles: ${disp}` }
  }
  const correo = readJsonFile<Correo>(join(base, "correo.json"), "correo.json")
  if (!correo.ok) return { ok: false, error: `${correo.error}. Pedir al solicitante reenviar el correo.` }
  const solRaw = readJsonFile<unknown>(join(base, "solicitud.json"), "solicitud.json (Excel de solicitud)")
  if (!solRaw.ok) return { ok: false, error: `${solRaw.error}. Pedir al solicitante el Excel de solicitud corregido.` }
  const sol = SolicitudSchema.safeParse(solRaw.value)
  if (!sol.success)
    return { ok: false, error: `solicitud.json inválida: ${sol.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Pedir al solicitante corregir el Excel.` }

  const faltantes: string[] = []
  const cot = readTextFile(join(base, "cotizacion.txt"), "cotización")
  if (!cot.ok) faltantes.push("cotizacion")
  const apr = readJsonFile<AprobacionRaw>(join(base, "aprobacion.json"), "aprobación")
  if (!apr.ok) faltantes.push("aprobacion")
  const fac = readTextFile(join(base, "factura.txt"), "factura")
  return {
    ok: true,
    value: {
      correo: { id: correo.value.id, de: correo.value.de, asunto: correo.value.asunto, fecha: correo.value.fecha },
      solicitud: sol.data,
      cotizacion: cot.ok ? parseCotizacion(cot.value) : null,
      aprobacion: apr.ok
        ? { de: apr.value.de, para: apr.value.para, cc: apr.value.cc ?? [], fecha: apr.value.fecha, asunto: apr.value.asunto, aprobado: /\baprobad[oa]\b/i.test(apr.value.cuerpo) && !/\bno\s+aprobad/i.test(apr.value.cuerpo), texto: apr.value.cuerpo }
        : null,
      factura: fac.ok ? parseFactura(fac.value) : null,
      faltantes,
    },
  }
}

// ---------------------------------------------------------------- controles RC1–RC10 (HU-2)
async function validarPaquete(ctx: ToolContext, p: Paquete): Promise<Validacion> {
  const r = reglas(ctx)
  const s = p.solicitud
  const bloqueos: Bloqueo[] = []
  const confirmaciones: Confirmacion[] = []
  const derivados: Validacion["derivados"] = {}
  const proveedores = maestro<Proveedor[]>(ctx, "proveedores.json")
  const centros = maestro<Centro[]>(ctx, "centros-costo.json")
  const ivas = maestro<Array<{ codigo: string; descripcion: string; tasa: number }>>(ctx, "indicadores-iva.json")
  const condiciones = maestro<Array<{ codigo: string; descripcion: string }>>(ctx, "condiciones-pago.json")

  // RC1 proveedor existe (por NIT vía adaptador SAP; si no hay NIT, por nombre) y está activo
  const nit = s.proveedor_nit ? nitSinDv(s.proveedor_nit) : null
  const porNombre = proveedores.find((x) => normalize(x.nombre) === normalize(s.proveedor_nombre))
  const enSap = nit ? await sap(ctx).consultarProveedor(nit) : porNombre ? { codigo_sap: porNombre.codigo_sap, activo: porNombre.activo } : null
  const prov = enSap ? proveedores.find((x) => x.codigo_sap === enSap.codigo_sap) : undefined
  if (!enSap || !prov)
    bloqueos.push({ codigo: "RC1", detalle: `el proveedor ${s.proveedor_nombre}${nit ? ` (NIT ${nit})` : ""} no existe en el maestro de proveedores`, accion_sugerida: "Solicitar la creación del proveedor en SAP (RUT, cámara de comercio, certificación bancaria) y reprocesar; o elegir un proveedor activo." })
  else if (!enSap.activo) bloqueos.push({ codigo: "RC1", detalle: `el proveedor ${prov.nombre} (${prov.codigo_sap}) está inactivo`, accion_sugerida: "Reactivar el proveedor en SAP o cambiar de proveedor." })
  else derivados.proveedor = { codigo_sap: prov.codigo_sap, nombre: prov.nombre, nit: prov.nit }

  // RC4 subárea pertenece al centro
  const centro = centros.find((c) => c.centro_costo === s.centro_costo)
  if (!centro) bloqueos.push({ codigo: "RC4", detalle: `el centro de costo ${s.centro_costo} no existe`, accion_sugerida: "Pedir al solicitante el centro de costo correcto." })
  else if (!centro.subareas.includes(s.subarea))
    bloqueos.push({ codigo: "RC4", detalle: `la subárea "${s.subarea}" no pertenece a ${s.centro_costo} (${centro.subareas.join(", ")})`, accion_sugerida: "Corregir centro de costo o subárea con el solicitante." })

  // RC2 aprobación válida y del aprobador del centro · RC3 tope
  const a = p.aprobacion
  if (!a) bloqueos.push({ codigo: "RC2", detalle: "no hay correo de aprobación", accion_sugerida: "Solicitar la aprobación por correo al líder del centro de costo." })
  else if (!a.aprobado) bloqueos.push({ codigo: "RC2", detalle: `el correo de ${a.de} no contiene "Aprobado"`, accion_sugerida: "Pedir aprobación explícita al líder." })
  else if (centro) {
    const aprobador = centro.aprobadores.find((x) => x.email.toLowerCase() === a.de.toLowerCase())
    const validos = centro.aprobadores.map((x) => `${x.nombre} <${x.email}> tope ${cop(x.tope)}`).join("; ")
    if (!aprobador) {
      const alcanza = centro.aprobadores.filter((x) => x.tope >= s.valor_total)
      bloqueos.push({
        codigo: "RC2",
        detalle: `${a.de} no es aprobador de ${s.centro_costo} (aprobadores: ${validos})`,
        accion_sugerida: alcanza.length ? `Pedir aprobación a ${alcanza.map((x) => x.nombre).join(" o ")}.` : `Ningún aprobador de ${s.centro_costo} tiene tope para ${cop(s.valor_total)}: escalar a la gerencia o dividir la compra según política.`,
      })
    } else if (s.valor_total > aprobador.tope) {
      bloqueos.push({ codigo: "RC3", detalle: `valor ${cop(s.valor_total)} supera el tope de ${aprobador.nombre} (${cop(aprobador.tope)})`, accion_sugerida: `Pedir aprobación a un aprobador con tope suficiente (${validos}).` })
    }
  }

  // RC10 aritmética
  const calc = s.cantidad * s.valor_unitario
  if (Math.abs(calc - s.valor_total) > r.tolerancia_aritmetica)
    bloqueos.push({ codigo: "RC10", detalle: `cantidad × valor unitario = ${cop(calc)} ≠ valor total ${cop(s.valor_total)}`, accion_sugerida: "Pedir al solicitante corregir cantidades o valores." })

  if (!r.monedas.includes(s.moneda)) bloqueos.push({ codigo: "MONEDA", detalle: `moneda ${s.moneda} no soportada (${r.monedas.join(", ")})`, accion_sugerida: "Confirmar la moneda con el solicitante." })

  // RC6 indicador IVA · RC7 condiciones de pago
  if (s.indicador_iva) {
    if (!ivas.some((i) => i.codigo === s.indicador_iva)) bloqueos.push({ codigo: "RC6", detalle: `indicador de IVA ${s.indicador_iva} no existe`, accion_sugerida: "Corregir el indicador de IVA." })
  } else if (prov) {
    const iva = ivas.find((i) => i.codigo === prov.indicador_iva_default)
    derivados.indicador_iva = { valor: prov.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" }
    confirmaciones.push({ codigo: "RC6", detalle: `la solicitud no informa IVA; se propone ${prov.indicador_iva_default} (${iva?.descripcion ?? "?"}) del maestro del proveedor`, valores: { indicador_iva: prov.indicador_iva_default } })
  }
  if (s.condiciones_pago) {
    if (!condiciones.some((c) => c.codigo === s.condiciones_pago)) bloqueos.push({ codigo: "RC7", detalle: `condición de pago ${s.condiciones_pago} no existe`, accion_sugerida: "Corregir la condición de pago." })
  } else if (prov) derivados.condiciones_pago = { valor: prov.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }

  // RC5 cotización vs solicitud (± 2 %)
  const c = p.cotizacion
  if (!c || !Number.isFinite(c.total)) confirmaciones.push({ codigo: "RC5", detalle: "no hay cotización legible para contrastar el valor" })
  else {
    const desvio = Math.abs(c.total - s.valor_total) / s.valor_total
    if (desvio > r.tolerancia_cotizacion) {
      const mencion = a?.texto.match(/por\s+([\d.,]+)\s*millones/i)?.[1]
      confirmaciones.push({
        codigo: "RC5",
        detalle: `cotización ${cop(c.total)} vs solicitud ${cop(s.valor_total)}: diferencia ${(desvio * 100).toFixed(1)} % (> ${r.tolerancia_cotizacion * 100} %)${mencion ? `; la aprobación menciona ${mencion} millones` : ""}. La OC se construye con los valores de la solicitud.`,
        valores: { solicitud: s.valor_total, cotizacion: c.total, diferencia_pct: Number((desvio * 100).toFixed(2)) },
      })
    }
    if (c.nit && nit && c.nit !== nit) confirmaciones.push({ codigo: "RC5", detalle: `el NIT de la cotización (${c.nit}) no coincide con el de la solicitud (${nit})` })
  }

  // RC8 factura anterior a la solicitud → retroactiva
  const retroactiva = !!p.factura && p.factura.fecha < s.fecha_solicitud
  if (retroactiva && p.factura)
    confirmaciones.push({ codigo: "RC8", detalle: `OC retroactiva: la factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud})`, valores: { factura: p.factura.fecha, solicitud: s.fecha_solicitud } })

  // RC9 aprobación posterior o igual a la solicitud
  if (a && soloFecha(a.fecha) < s.fecha_solicitud)
    confirmaciones.push({ codigo: "RC9", detalle: `la aprobación (${soloFecha(a.fecha)}) es anterior a la solicitud (${s.fecha_solicitud})` })

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva }
}

// ---------------------------------------------------------------- evidencia y payload (HU-3, HU-4)
function evidenciaTexto(p: Paquete): string | null {
  const a = p.aprobacion
  if (!a) return null
  return [`De: ${a.de}`, `Para: ${a.para}`, ...(a.cc.length ? [`CC: ${a.cc.join(", ")}`] : []), `Fecha: ${a.fecha}`, `Asunto: ${a.asunto}`, "", a.texto, ""].join("\n")
}
/** Texto breve SAP: máx. 40 caracteres cortando en palabra. */
const textoBreve = (s: string): string => (s.length <= 40 ? s : s.slice(0, 41).replace(/\s+\S*$/, "").slice(0, 40).trim())
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

function unidad(ctx: ToolContext, p: Paquete): "UN" | "H" | "MES" {
  const desc = p.cotizacion?.items[0]?.descripcion ?? ""
  const primera = normalize(desc).split(" ")[0] ?? ""
  return reglas(ctx).unidades[primera] ?? "UN"
}

function construir(ctx: ToolContext, p: Paquete, v: Validacion): { orden: OrdenCompra; trazabilidad: Record<string, string> } | { error: string } {
  if (!v.apta) return { error: `no se puede construir la OC: ${v.bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join("; ")}` }
  const s = p.solicitud
  const ev = evidenciaTexto(p)
  if (!ev || !p.aprobacion || !v.derivados.proveedor) return { error: "falta la aprobación o el proveedor para construir la OC" }
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor ?? ""
  const cond = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor ?? ""
  const orden = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.numero ?? null },
    sociedad: "1000" as const,
    organizacion_compras: "1000" as const,
    proveedor: v.derivados.proveedor,
    moneda: s.moneda as "COP" | "USD",
    condiciones_pago: cond,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: soloFecha(p.aprobacion.fecha), evidencia_sha256: sha256(ev) },
    posiciones: [{ numero: 10, descripcion: textoBreve(s.descripcion), cantidad: s.cantidad, unidad: unidad(ctx, p), precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: iva }],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }
  const parsed = OrdenCompraSchema.safeParse(orden)
  if (!parsed.success) return { error: `payload inválido: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }
  const trazabilidad: Record<string, string> = {
    "referencia.solicitud_id": "solicitud",
    "referencia.correo_id": "correo",
    "referencia.cotizacion_ref": p.cotizacion ? "cotizacion" : "sin cotización",
    sociedad: "constante (knowledge/reglas.json)",
    organizacion_compras: "constante (knowledge/reglas.json)",
    "proveedor.codigo_sap": "maestro.proveedores (consultado vía SapAdapter por NIT)",
    "proveedor.nit": "maestro.proveedores",
    "proveedor.nombre": "maestro.proveedores",
    moneda: "solicitud",
    condiciones_pago: s.condiciones_pago ? "solicitud" : `derivado (${v.derivados.condiciones_pago?.fuente})`,
    "aprobador.email": "aprobacion",
    "aprobador.fecha_aprobacion": "aprobacion",
    "aprobador.evidencia_sha256": "derivado (sha256 de la evidencia de aprobación)",
    "posiciones[0].descripcion": "solicitud (truncado a 40)",
    "posiciones[0].cantidad": "solicitud",
    "posiciones[0].unidad": p.cotizacion?.items[0] ? "derivado (texto del ítem de la cotización)" : "derivado (por defecto UN)",
    "posiciones[0].precio_unitario": "solicitud",
    "posiciones[0].centro_costo": "solicitud (validado en maestro.centros-costo)",
    "posiciones[0].subarea": "solicitud (validado en maestro.centros-costo)",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud (validado en maestro.indicadores-iva)" : `derivado (${v.derivados.indicador_iva?.fuente})`,
    excepciones: "oc_validar (confirmaciones)",
  }
  return { orden: parsed.data, trazabilidad }
}

async function escribirEvidencia(ctx: ToolContext, caso: string, p: Paquete): Promise<{ ruta: string; ruta_pdf: string; sha256: string } | null> {
  const ev = evidenciaTexto(p)
  if (!ev) return null
  const hash = sha256(ev)
  const ruta = outPath(ctx.directory, caso, "aprobacion.txt")
  writeOut(ruta, `${ev}\n---\nsha256 (contenido anterior a esta línea): ${hash}\n`)
  const pdf = await renderPdf({
    titulo: `Evidencia de aprobación — ${p.solicitud.solicitud_id}`,
    secciones: [
      { filas: [{ etiqueta: "De", valor: p.aprobacion?.de ?? "" }, { etiqueta: "Para", valor: p.aprobacion?.para ?? "" }, { etiqueta: "Fecha", valor: p.aprobacion?.fecha ?? "" }, { etiqueta: "Asunto", valor: p.aprobacion?.asunto ?? "" }] },
      { titulo: "Cuerpo del correo", parrafos: (p.aprobacion?.texto ?? "").split("\n") },
      { titulo: "Integridad", parrafos: [`SHA-256: ${hash}`], monoespaciado: true },
    ],
    pie: "Generado por el agente a partir del correo de aprobación. El hash corresponde al texto normalizado (de, para, fecha, asunto, cuerpo).",
  })
  const rutaPdf = outPath(ctx.directory, caso, "aprobacion.pdf")
  writeOut(rutaPdf, pdf)
  return { ruta: rel(ctx.directory, ruta), ruta_pdf: rel(ctx.directory, rutaPdf), sha256: hash }
}

// ---------------------------------------------------------------- log de control (HU-5)
function control(ctx: ToolContext, fila: { solicitud_id: string; resultado: string; numero_oc: string; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] }): void {
  const p = outPath(ctx.directory, "control.csv")
  const header = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"
  const prev = existsSync(p) ? readFileSync(p, "utf8") : header
  const cell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const line = [fila.solicitud_id, fila.resultado, fila.numero_oc, String(fila.retroactiva), fila.bloqueos.join(";"), fila.confirmaciones.join(";"), new Date().toISOString()].map(cell).join(",")
  writeOut(p, `${prev}${line}\n`)
}

const codigos = (xs: Array<{ codigo: string }>): string[] => [...new Set(xs.map((x) => x.codigo))]

/** Campos del payload que el modelo no puede alterar respecto al validado. */
function diferenciasPayload(a: OrdenCompra, b: Record<string, unknown>): string[] {
  const pick = (o: unknown, path: string): string | undefined => JSON.stringify(path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o))
  const paths = ["proveedor.codigo_sap", "moneda", "condiciones_pago", "referencia.solicitud_id", "posiciones.0.cantidad", "posiciones.0.precio_unitario", "posiciones.0.centro_costo", "posiciones.0.subarea", "posiciones.0.indicador_iva", "aprobador.email"]
  return paths.filter((p) => pick(b, p) !== undefined && pick(a, p) !== pick(b, p))
}

// ================================================================= HERRAMIENTAS
const CASO = z.string().min(1).max(64).describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)")
const PAQUETE = z.record(z.string(), z.unknown()).optional().describe("Paquete devuelto por oc_leer_paquete (opcional: los controles se ejecutan siempre sobre la lectura canónica del caso)")

export const leer_paquete = defineTool({
  description: "Lee y normaliza el paquete de compra de un caso: correo, solicitud, cotización, aprobación y factura (si existe).",
  args: { caso: CASO },
  async execute({ caso }, ctx) {
    return safe(() => {
      const r = leerPaquete(ctx, caso)
      if (!r.ok) return fail(r.error)
      const p = r.value
      return ok({ ...p, cotizacion: p.cotizacion ? { ...p.cotizacion, texto: undefined } : null, resumen: `${p.solicitud.solicitud_id} · ${p.solicitud.proveedor_nombre} · ${cop(p.solicitud.valor_total)} ${p.solicitud.moneda}${p.faltantes.length ? ` · faltan: ${p.faltantes.join(", ")}` : ""}${p.factura ? " · trae factura" : ""}` })
    })
  },
})

export const validar = defineTool({
  description: "Aplica los controles RC1–RC10 contra los maestros y devuelve apta, bloqueos, confirmaciones, derivados y si es retroactiva.",
  args: { caso: CASO, paquete: PAQUETE },
  async execute({ caso, paquete }, ctx) {
    return safe(async () => {
      const r = leerPaquete(ctx, caso)
      if (!r.ok) return fail(r.error)
      const v = await validarPaquete(ctx, r.value)
      const alterado = paquete && typeof paquete.solicitud === "object" && paquete.solicitud !== null && (paquete.solicitud as Record<string, unknown>).valor_total !== undefined && (paquete.solicitud as Record<string, unknown>).valor_total !== r.value.solicitud.valor_total
      if (alterado) v.confirmaciones.push({ codigo: "PAQUETE", detalle: "el paquete recibido difiere de la lectura del caso; se validó la lectura canónica" })
      return ok({ ...v, pide_confirmacion: v.apta && v.confirmaciones.length > 0, resumen: `${v.apta ? "apta" : "NO apta"} · bloqueos: ${codigos(v.bloqueos).join(", ") || "ninguno"} · confirmaciones: ${codigos(v.confirmaciones).join(", ") || "ninguna"}${v.retroactiva ? " · RETROACTIVA" : ""}` })
    })
  },
})

export const construir_payload = defineTool({
  description: "Construye la orden de compra exactamente como quedaría en SAP (validada con zod) y guarda su trazabilidad por campo.",
  args: { caso: CASO, paquete: PAQUETE, derivados: z.record(z.string(), z.unknown()).optional().describe("Derivados de oc_validar (opcional: se recalculan desde los maestros)") },
  async execute({ caso }, ctx) {
    return safe(async () => {
      const r = leerPaquete(ctx, caso)
      if (!r.ok) return fail(r.error)
      const v = await validarPaquete(ctx, r.value)
      const b = construir(ctx, r.value, v)
      if ("error" in b) return fail(b.error)
      writeOut(outPath(ctx.directory, caso, "payload.json"), JSON.stringify(b.orden, null, 2))
      writeOut(outPath(ctx.directory, caso, "trazabilidad.json"), JSON.stringify(b.trazabilidad, null, 2))
      const total = b.orden.posiciones.reduce((acc, x) => acc + x.cantidad * x.precio_unitario, 0)
      return ok({
        orden: b.orden,
        total,
        ruta_payload: `out/${caso}/payload.json`,
        ruta_trazabilidad: `out/${caso}/trazabilidad.json`,
        confirmaciones_pendientes: v.confirmaciones,
        pide_confirmacion: v.confirmaciones.length > 0,
        resumen: `OC ${b.orden.proveedor.nombre} · ${b.orden.posiciones.length} posición(es) · ${cop(total)} ${b.orden.moneda} · IVA ${b.orden.posiciones[0]?.indicador_iva} · pago ${b.orden.condiciones_pago}`,
      })
    })
  },
})

export const generar_evidencia = defineTool({
  description: "Genera la evidencia de aprobación (aprobacion.txt con sha256 y aprobacion.pdf) en out/<caso>/.",
  args: { caso: CASO },
  async execute({ caso }, ctx) {
    return safe(async () => {
      const r = leerPaquete(ctx, caso)
      if (!r.ok) return fail(r.error)
      const e = await escribirEvidencia(ctx, caso, r.value)
      if (!e) return fail("el caso no tiene correo de aprobación; no hay evidencia que generar. Solicitar la aprobación al líder.")
      return ok({ ...e, resumen: `${e.ruta} y ${e.ruta_pdf} · sha256 ${e.sha256.slice(0, 12)}…` })
    })
  },
})

export const crear = defineTool({
  description: "Crea la OC en el SAP simulado si es apta y está confirmada cuando hace falta; idempotente por solicitud_id y registra cada intento en out/control.csv.",
  args: {
    caso: CASO,
    payload: z.record(z.string(), z.unknown()).optional().describe("Payload de oc_construir_payload (opcional; si difiere del validado se rechaza)"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
  },
  async execute({ caso, payload, confirmado }, ctx) {
    return safe(async () => {
      const r = leerPaquete(ctx, caso)
      if (!r.ok) return fail(r.error)
      const p = r.value
      const sid = p.solicitud.solicitud_id
      const v = await validarPaquete(ctx, p)
      const base = { solicitud_id: sid, retroactiva: v.retroactiva, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones) }

      const existente = await sap(ctx).buscarOrdenPorReferencia(sid)
      if (existente) {
        control(ctx, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, idempotente: true, retroactiva: v.retroactiva, resumen: `ya existía la OC ${existente.numero_oc} para ${sid} (no se creó otra)` })
      }
      if (!v.apta) {
        control(ctx, { ...base, resultado: "bloqueada", numero_oc: "" })
        return fail(`bloqueada: ${v.bloqueos.map((b) => `${b.codigo} — ${b.detalle}. Acción: ${b.accion_sugerida}`).join(" | ")}`)
      }
      if (v.confirmaciones.length && confirmado !== true) {
        control(ctx, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
        return fail(`requiere confirmación: ${v.confirmaciones.map((c) => `${c.codigo} — ${c.detalle}`).join(" | ")}`)
      }
      const b = construir(ctx, p, v)
      if ("error" in b) {
        control(ctx, { ...base, resultado: "error_payload", numero_oc: "" })
        return fail(b.error)
      }
      if (payload) {
        const dif = diferenciasPayload(b.orden, payload)
        if (dif.length) {
          control(ctx, { ...base, resultado: "rechazada_payload_alterado", numero_oc: "" })
          return fail(`el payload enviado difiere del validado en: ${dif.join(", ")}. Usa el de oc_construir_payload sin modificar.`)
        }
      }
      const orden: OrdenCompra = { ...b.orden, excepciones: b.orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesión ${ctx.sessionId})` })) }
      const evidencia = await escribirEvidencia(ctx, caso, p)
      const creada = await sap(ctx).crearOrden(orden)
      writeOut(outPath(ctx.directory, caso, "orden.json"), JSON.stringify({ ...creada, orden }, null, 2))
      writeOut(outPath(ctx.directory, caso, "trazabilidad.json"), JSON.stringify(b.trazabilidad, null, 2))
      control(ctx, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
      return ok({ ...creada, idempotente: false, retroactiva: v.retroactiva, evidencia, excepciones_confirmadas: codigos(v.confirmaciones), resumen: `OC ${creada.numero_oc} creada (${creada.fecha})${v.retroactiva ? " · marcada RETROACTIVA" : ""}` })
    })
  },
})
