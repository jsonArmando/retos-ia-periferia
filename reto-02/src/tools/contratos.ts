import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { z } from "zod/v4"
import { fechaReferencia } from "../core/fecha"
import { isSafeId, outPath, readJsonFile, readTextFile, writeOut } from "../core/files"
import { normalize, similarity } from "../core/text"
import { defineTool, fail, ok, safe, type ToolContext } from "../core/tool"
import { parseCsv, toCsv } from "../lib/csv"
import { extraer as extraerTexto, ExtraccionError, fechaValida, type Campo, type Extraccion } from "../lib/extraccion"

// ---------------------------------------------------------------- tipos y rutas
type Correo = { id: string; de: string; para: string; asunto: string; fecha: string; cuerpo: string; adjuntos: string[] }
type Comercial = { email: string; nombre: string; region: string }
type Reglas = {
  umbral_confianza: number
  similitud_objeto_actualizacion: number
  dias_alerta_vencimiento: number
  fecha_corte_maestro: string
  monedas: string[]
  moneda_local: Record<string, string>
  tipos_poliza: Record<string, string>
}
type Fila = Record<string, string>
type Procesado = { mensaje_id: string; clasificacion: string; accion: string; id_contrato: string | null; ts: string }

const HEADER = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente"]
const CAMPOS_REGISTRO = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const
type CampoRegistro = (typeof CAMPOS_REGISTRO)[number]

const FIX = (ctx: ToolContext, ...p: string[]): string => join(ctx.directory, "fixtures", "reto-02", ...p)
const SP = (ctx: ToolContext, ...p: string[]): string => outPath(ctx.directory, "sharepoint", ...p)
const reglas = (ctx: ToolContext): Reglas => JSON.parse(readFileSync(join(ctx.directory, "src", "knowledge", "reglas.json"), "utf8")) as Reglas

// ---------------------------------------------------------------- maestro (copia en out/sharepoint)
function maestroPath(ctx: ToolContext): string {
  const p = SP(ctx, "maestro-contratos.csv")
  if (!existsSync(p)) writeOut(p, readFileSync(FIX(ctx, "maestro-contratos.csv"))) // RN6
  return p
}
const leerMaestro = (ctx: ToolContext): Fila[] => parseCsv(readFileSync(maestroPath(ctx), "utf8"))
const guardarMaestro = (ctx: ToolContext, filas: Fila[]): void => writeOut(maestroPath(ctx), toCsv(HEADER, filas))

function procesados(ctx: ToolContext): Procesado[] {
  const r = readJsonFile<Procesado[]>(outPath(ctx.directory, "procesados.json"), "procesados.json")
  return r.ok && Array.isArray(r.value) ? r.value : []
}
function marcarProcesado(ctx: ToolContext, p: Procesado): void {
  writeOut(outPath(ctx.directory, "procesados.json"), JSON.stringify([...procesados(ctx).filter((x) => x.mensaje_id !== p.mensaje_id), p], null, 2))
}
function historial(ctx: ToolContext, entry: Record<string, unknown>): void {
  const p = SP(ctx, "historial.jsonl")
  const prev = existsSync(p) ? readFileSync(p, "utf8") : ""
  writeOut(p, `${prev}${JSON.stringify({ ts: new Date().toISOString(), fecha: fechaReferencia(), ...entry })}\n`)
}

// ---------------------------------------------------------------- buzón
type Mensaje = { correo: Correo; adjunto: string | null; texto: string | null; tiene_contrato: boolean; motivo: string | null }

function leerMensaje(ctx: ToolContext, id: string): { ok: true; value: Mensaje } | { ok: false; error: string } {
  if (!isSafeId(id)) return { ok: false, error: `mensaje_id inválido: "${id}"` }
  const c = readJsonFile<Correo>(FIX(ctx, "buzon", id, "correo.json"), `correo.json de ${id}`)
  if (!c.ok) return { ok: false, error: existsSync(FIX(ctx, "buzon", id)) ? c.error : `el mensaje ${id} no existe en el buzón` }
  const adj = (c.value.adjuntos ?? []).find((a) => /contrato|otros[ií]/i.test(a)) ?? null
  if (!adj) {
    const otros = c.value.adjuntos?.length ? `adjunto(s): ${c.value.adjuntos.join(", ")}` : "sin adjuntos"
    return { ok: true, value: { correo: c.value, adjunto: null, texto: null, tiene_contrato: false, motivo: `no trae contrato (${otros})` } }
  }
  const t = readTextFile(FIX(ctx, "buzon", id, adj), adj)
  if (!t.ok) return { ok: true, value: { correo: c.value, adjunto: adj, texto: null, tiene_contrato: false, motivo: t.error } }
  const esContrato = /\b(CONTRATO|OTROS[IÍ])\b/.test(t.value.slice(0, 300))
  return { ok: true, value: { correo: c.value, adjunto: adj, texto: t.value, tiene_contrato: esContrato, motivo: esContrato ? null : `el adjunto ${adj} no es un contrato` } }
}

function extraerMensaje(ctx: ToolContext, m: Mensaje): Extraccion {
  const r = reglas(ctx)
  return extraerTexto(m.texto ?? "", { monedas: r.monedas, monedaLocal: r.moneda_local, tiposPoliza: r.tipos_poliza, fechaCorreo: m.correo.fecha.slice(0, 10) })
}

// ---------------------------------------------------------------- validación (RN1–RN5)
type Valores = Partial<Record<CampoRegistro, string | number | boolean | null>>
type Revision = { campo: string; motivo: string; valor: string | number | boolean | null }
type Evaluacion = {
  clasificacion: "nuevo" | "actualizacion" | "duplicado" | "rechazado"
  motivo: string | null
  id_contrato_existente: string | null
  requiere_revision: Revision[]
  diferencias: Record<string, { antes: string; despues: string }>
  propuesta: Valores
  comercial: string | null
  advertencias: string[]
  extraccion: Extraccion | null
}

const str = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? "" : String(v))

function valoresExtraidos(x: Extraccion): Valores {
  return {
    id_contrato: x.id_contrato.valor, cliente: x.cliente.valor, nit_cliente: x.nit_cliente.valor, pais: x.pais.valor, objeto: x.objeto.valor,
    valor: x.valor.valor, moneda: x.moneda.valor, fecha_inicio: x.fecha_inicio.valor, fecha_fin: x.fecha_fin.valor,
    requiere_poliza: x.requiere_poliza.valor, tipo_poliza: x.tipo_poliza.valor,
  }
}

function evaluar(ctx: ToolContext, mensajeId: string, propuestos: Valores | undefined): { ok: true; value: Evaluacion } | { ok: false; error: string } {
  const lm = leerMensaje(ctx, mensajeId)
  if (!lm.ok) return lm
  const m = lm.value
  const r = reglas(ctx)
  const comerciales = readJsonFile<Comercial[]>(FIX(ctx, "comerciales.json"), "comerciales.json")
  const com = comerciales.ok ? comerciales.value.find((c) => c.email.toLowerCase() === m.correo.de.toLowerCase()) : undefined
  const advertencias = com ? [] : [`remitente ${m.correo.de} no está en comerciales.json (no bloquea)`]
  const base: Evaluacion = { clasificacion: "rechazado", motivo: null, id_contrato_existente: null, requiere_revision: [], diferencias: {}, propuesta: {}, comercial: com?.nombre ?? null, advertencias, extraccion: null }
  if (!m.tiene_contrato) return { ok: true, value: { ...base, motivo: m.motivo } }

  let x: Extraccion
  try {
    x = extraerMensaje(ctx, m)
  } catch (e) {
    if (e instanceof ExtraccionError) return { ok: false, error: e.message }
    throw e
  }
  if ((!x.cliente.valor && !x.objeto.valor && x.tipo_documento === "contrato") || (x.tipo_documento === "otrosi" && !x.id_contrato.valor))
    return { ok: true, value: { ...base, extraccion: x, motivo: "el texto no tiene partes ni objeto identificables" } }

  // Valores finales: extracción + propuestas (las propuestas distintas a lo extraído van a revisión)
  const extraidos = valoresExtraidos(x)
  const finales: Valores = { ...extraidos }
  const revision: Revision[] = []
  for (const k of CAMPOS_REGISTRO) {
    const p = propuestos?.[k]
    if (p === undefined || str(p) === str(extraidos[k])) continue
    finales[k] = p
    revision.push({ campo: k, motivo: `valor distinto al extraído (${str(extraidos[k]) || "vacío"})`, valor: p })
  }
  const conf = (k: CampoRegistro): number => (x[k] as Campo<unknown>).confianza

  const maestro = leerMaestro(ctx)
  let existente = finales.id_contrato ? maestro.find((f) => f.id_contrato === str(finales.id_contrato)) : undefined
  if (!existente && finales.nit_cliente && finales.objeto)
    existente = maestro.find((f) => f.nit_cliente === str(finales.nit_cliente) && similarity(f.objeto ?? "", str(finales.objeto)) >= r.similitud_objeto_actualizacion)

  const ev: Evaluacion = { ...base, extraccion: x, propuesta: finales }
  if (!existente) {
    ev.clasificacion = "nuevo"
    for (const k of CAMPOS_REGISTRO) {
      if (k === "id_contrato" && !finales.id_contrato) continue // se generará AUTO-<año>-<n>
      if (revision.some((rv) => rv.campo === k)) continue
      if (conf(k) < r.umbral_confianza) revision.push({ campo: k, motivo: `confianza ${conf(k)} < ${r.umbral_confianza} (${(x[k] as Campo<unknown>).fuente})`, valor: finales[k] ?? null })
    }
    if (x.valor_indeterminado && !revision.some((rv) => rv.campo === "valor")) revision.push({ campo: "valor", motivo: "contrato por demanda: se registra 0", valor: 0 })
  } else {
    ev.id_contrato_existente = existente.id_contrato ?? null
    const comparables: CampoRegistro[] = ["cliente", "nit_cliente", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"]
    for (const k of comparables) {
      const v = finales[k]
      if (v === null || v === undefined || (x.tipo_documento === "otrosi" && ["cliente", "objeto", "tipo_poliza", "requiere_poliza"].includes(k))) continue
      if (k === "cliente" || k === "objeto") continue // variaciones de redacción no son cambios
      const antes = existente[k] ?? ""
      const despues = k === "valor" ? String(Number(v)) : str(v)
      if (normalize(antes) !== normalize(despues)) ev.diferencias[k] = { antes, despues }
    }
    if (x.ampliar_polizas && existente.estado_poliza === "vigente") ev.diferencias.estado_poliza = { antes: "vigente", despues: "pendiente" }
    if (ev.diferencias.nit_cliente) revision.push({ campo: "nit_cliente", motivo: `conflicto con el maestro (${ev.diferencias.nit_cliente.antes})`, valor: finales.nit_cliente ?? null })
    const soloFechasYValor = ["valor", "fecha_inicio", "fecha_fin"].every((k) => !ev.diferencias[k])
    if (x.tipo_documento === "contrato" && soloFechasYValor && existente.id_contrato === str(finales.id_contrato)) {
      ev.clasificacion = "duplicado" // RN1
      ev.motivo = `ya existe ${existente.id_contrato} con el mismo valor y fechas`
      ev.diferencias = {}
      revision.length = 0
    } else {
      ev.clasificacion = "actualizacion" // RN2
      for (const k of Object.keys(ev.diferencias)) {
        if (!(CAMPOS_REGISTRO as readonly string[]).includes(k) || revision.some((rv) => rv.campo === k)) continue
        const c = conf(k as CampoRegistro)
        if (c < r.umbral_confianza) revision.push({ campo: k, motivo: `confianza ${c} < ${r.umbral_confianza}`, valor: finales[k as CampoRegistro] ?? null })
      }
    }
  }
  ev.requiere_revision = revision
  return { ok: true, value: ev }
}

// ---------------------------------------------------------------- registro
function autoId(maestro: Fila[], anio: string): string {
  const n = maestro.filter((f) => f.id_contrato?.startsWith(`AUTO-${anio}-`)).length + 1
  return `AUTO-${anio}-${String(n).padStart(3, "0")}`
}
function slugCliente(nombre: string): string {
  return normalize(nombre).replace(/\b(s de r l|s a s|s a c|s a|ltda|sas|sac|inc|llc)\b/g, "").trim().replace(/\s+/g, "-")
}

// ================================================================= HERRAMIENTAS
const MENSAJE = z.string().min(1).max(64).describe("Id del mensaje del buzón (carpeta en fixtures/reto-02/buzon/, ej. msg-001)")
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const CONTRATO = z
  .object({
    id_contrato: z.string().nullable().optional(),
    cliente: z.string().nullable().optional(),
    nit_cliente: z.string().nullable().optional(),
    pais: z.enum(["CO", "EC", "PE", "PA", "HN"]).nullable().optional(),
    objeto: z.string().max(200).nullable().optional(),
    valor: z.number().nonnegative().nullable().optional(),
    moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]).nullable().optional(),
    fecha_inicio: fecha.nullable().optional(),
    fecha_fin: fecha.nullable().optional(),
    requiere_poliza: z.boolean().nullable().optional(),
    tipo_poliza: z.string().nullable().optional(),
  })
  .optional()
  .describe("Valores planos del contrato. Omítelo para usar la extracción tal cual; todo valor distinto a lo extraído queda en requiere_revision.")

export const leer_buzon = defineTool({
  description: "Lista los mensajes del buzón de contratos pendientes de procesar, indicando si traen contrato.",
  args: { incluir_procesados: z.boolean().optional().describe("true para incluir también los ya procesados") },
  async execute({ incluir_procesados }, ctx) {
    return safe(() => {
      const dir = FIX(ctx, "buzon")
      const hechos = new Map(procesados(ctx).map((p) => [p.mensaje_id, p]))
      const ids = existsSync(dir) ? readdirSync(dir).filter((d) => isSafeId(d)).sort() : []
      const mensajes = ids
        .filter((id) => incluir_procesados || !hechos.has(id))
        .map((id) => {
          const m = leerMensaje(ctx, id)
          if (!m.ok) return { id, error: m.error }
          const { correo, tiene_contrato, motivo } = m.value
          return {
            id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos, tiene_contrato,
            ...(tiene_contrato ? {} : { clasificacion: "rechazado", motivo }),
            ...(hechos.has(id) ? { procesado: hechos.get(id)?.accion } : {}),
          }
        })
      return ok({ mensajes, resumen: `${mensajes.length} mensaje(s); ${mensajes.filter((x) => "tiene_contrato" in x && x.tiene_contrato).length} con contrato` })
    })
  },
})

export const extraer = defineTool({
  description: "Extrae del contrato adjunto los campos del maestro con confianza por campo (null y confianza 0 si no aparecen).",
  args: { mensaje_id: MENSAJE },
  async execute({ mensaje_id }, ctx) {
    return safe(() => {
      const lm = leerMensaje(ctx, mensaje_id)
      if (!lm.ok) return fail(lm.error)
      if (!lm.value.tiene_contrato) return fail(`el mensaje ${mensaje_id} ${lm.value.motivo}; clasificación: rechazado`)
      try {
        const x = extraerMensaje(ctx, lm.value)
        const baja = CAMPOS_REGISTRO.filter((k) => (x[k] as Campo<unknown>).confianza < reglas(ctx).umbral_confianza)
        return ok({ mensaje_id, adjunto: lm.value.adjunto, ...x, campos_baja_confianza: baja, resumen: `${x.tipo_documento} ${x.id_contrato.valor ?? "(sin número)"} · ${x.cliente.valor ?? "?"} · baja confianza: ${baja.join(", ") || "ninguno"}` })
      } catch (e) {
        if (e instanceof ExtraccionError) return fail(`${mensaje_id}: ${e.message}`)
        throw e
      }
    })
  },
})

export const validar = defineTool({
  description: "Clasifica el contrato en nuevo, actualizacion, duplicado o rechazado frente al maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: MENSAJE, contrato: CONTRATO },
  async execute({ mensaje_id, contrato }, ctx) {
    return safe(() => {
      const ev = evaluar(ctx, mensaje_id, contrato)
      if (!ev.ok) return fail(ev.error)
      const v = ev.value
      return ok({
        mensaje_id, clasificacion: v.clasificacion, motivo: v.motivo, id_contrato_existente: v.id_contrato_existente,
        requiere_revision: v.requiere_revision.map((r) => r.campo), detalle_revision: v.requiere_revision,
        diferencias: v.diferencias, valores: v.propuesta, comercial: v.comercial, advertencias: v.advertencias,
        pide_confirmacion: v.requiere_revision.length > 0,
        resumen: `${v.clasificacion}${v.id_contrato_existente ? ` (${v.id_contrato_existente})` : ""}${v.requiere_revision.length ? ` · revisar: ${v.requiere_revision.map((r) => r.campo).join(", ")}` : ""}`,
      })
    })
  },
})

export const registrar = defineTool({
  description: "Registra o actualiza el contrato en el maestro de SharePoint simulado y archiva el documento; rechaza si hay campos en revisión sin confirmado=true.",
  args: {
    mensaje_id: MENSAJE,
    contrato: CONTRATO,
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
  },
  async execute({ mensaje_id, contrato, confirmado }, ctx) {
    return safe(() => {
      const previo = procesados(ctx).find((p) => p.mensaje_id === mensaje_id)
      if (previo) return fail(`el mensaje ${mensaje_id} ya fue procesado (${previo.accion}${previo.id_contrato ? ` ${previo.id_contrato}` : ""})`)
      const ev = evaluar(ctx, mensaje_id, contrato)
      if (!ev.ok) return fail(ev.error)
      const v = ev.value
      const ts = new Date().toISOString()
      const cerrar = (accion: string, id: string | null, ruta: string | null, extra: Record<string, unknown> = {}): string => {
        marcarProcesado(ctx, { mensaje_id, clasificacion: v.clasificacion, accion, id_contrato: id, ts })
        return ok({ id_contrato: id, accion, clasificacion: v.clasificacion, ruta_archivo: ruta, advertencias: v.advertencias, ...extra, resumen: `${accion}${id ? ` ${id}` : ""}${ruta ? ` → ${ruta}` : ""}` })
      }
      if (v.clasificacion === "rechazado") return cerrar("rechazado", null, null, { motivo: v.motivo })
      if (v.clasificacion === "duplicado") return cerrar("sin_cambios_duplicado", v.id_contrato_existente, null, { motivo: v.motivo })
      if (v.requiere_revision.length && confirmado !== true)
        return fail(`requiere revisión: ${v.requiere_revision.map((r) => `${r.campo} (${r.motivo}; valor propuesto: ${str(r.valor) || "vacío"})`).join("; ")}`)

      const maestro = leerMaestro(ctx)
      const lm = leerMensaje(ctx, mensaje_id)
      if (!lm.ok || !lm.value.adjunto || !v.extraccion) return fail("no se pudo releer el adjunto")
      const ext = extname(lm.value.adjunto) || ".txt"
      const p = v.propuesta
      const hoy = fechaReferencia()

      if (v.clasificacion === "nuevo") {
        const anio = str(p.fecha_inicio).slice(0, 4) || hoy.slice(0, 4)
        const id = str(p.id_contrato) || autoId(maestro, anio)
        if (maestro.some((f) => f.id_contrato === id)) return fail(`ya existe ${id} en el maestro`)
        const ruta = `Contratos/${anio}/${slugCliente(str(p.cliente))}/${id}${ext}`
        writeOut(SP(ctx, ruta), readFileSync(FIX(ctx, "buzon", mensaje_id, lm.value.adjunto)))
        const conPoliza = p.requiere_poliza === true
        const fila: Fila = {
          id_contrato: id, cliente: str(p.cliente), nit_cliente: str(p.nit_cliente), pais: str(p.pais), objeto: str(p.objeto).slice(0, 200),
          valor: String(Number(p.valor ?? 0)), moneda: str(p.moneda), fecha_inicio: str(p.fecha_inicio), fecha_fin: str(p.fecha_fin),
          requiere_poliza: String(conPoliza), tipo_poliza: conPoliza ? str(p.tipo_poliza) : "", estado_poliza: conPoliza ? "pendiente" : "no_aplica",
          comercial: v.comercial ?? "", ruta_sharepoint: ruta, fecha_registro: hoy, fuente: "buzon",
        }
        guardarMaestro(ctx, [...maestro, fila])
        historial(ctx, { id_contrato: id, accion: "alta", cambios: fila, mensaje_id, confirmado: confirmado === true, revisados: v.requiere_revision.map((r) => r.campo) })
        return cerrar("registrado", id, ruta, { estado_poliza: fila.estado_poliza })
      }

      // actualizacion
      const id = v.id_contrato_existente ?? ""
      const idx = maestro.findIndex((f) => f.id_contrato === id)
      const fila = maestro[idx]
      if (idx < 0 || !fila) return fail(`no se encontró ${id} en el maestro`)
      const sufijo = v.extraccion.tipo_documento === "otrosi" ? `-otrosi-${v.extraccion.numero_otrosi ?? 1}` : `-v${new Date().getTime()}`
      const carpeta = (fila.ruta_sharepoint ?? "").split("/").slice(0, -1).join("/") || `Contratos/${(fila.fecha_inicio ?? hoy).slice(0, 4)}/${slugCliente(fila.cliente ?? id)}`
      const ruta = `${carpeta}/${id}${sufijo}${ext}`
      writeOut(SP(ctx, ruta), readFileSync(FIX(ctx, "buzon", mensaje_id, lm.value.adjunto)))
      const actualizada: Fila = { ...fila }
      for (const [k, d] of Object.entries(v.diferencias)) actualizada[k] = d.despues
      maestro[idx] = actualizada
      guardarMaestro(ctx, maestro)
      historial(ctx, { id_contrato: id, accion: "actualizacion", cambios: v.diferencias, mensaje_id, documento: ruta, confirmado: confirmado === true })
      return cerrar("actualizado", id, ruta, { cambios: v.diferencias })
    })
  },
})

export const alertas = defineTool({
  description: "Genera out/alertas.md con contratos que vencen en ≤60 días, pólizas pendientes y contratos registrados desde el corte del maestro.",
  args: { hoy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha de referencia YYYY-MM-DD") },
  async execute({ hoy }, ctx) {
    return safe(() => {
      const [y, m, d] = hoy.split("-").map(Number) as [number, number, number]
      if (!fechaValida(y, m, d)) return fail(`fecha inválida: ${hoy}`)
      const r = reglas(ctx)
      const maestro = leerMaestro(ctx)
      const dias = (f: string): number => Math.round((Date.parse(`${f}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000)
      const conFin = maestro.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha_fin ?? ""))
      const vencen = conFin.filter((f) => dias(f.fecha_fin ?? "") >= 0 && dias(f.fecha_fin ?? "") <= r.dias_alerta_vencimiento)
        .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias: dias(f.fecha_fin ?? ""), comercial: f.comercial }))
        .sort((a, b) => a.dias - b.dias)
      const vencidos = conFin.filter((f) => dias(f.fecha_fin ?? "") < 0).map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin }))
      const polizas_pendientes = maestro.filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
        .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza }))
      const hist = existsSync(SP(ctx, "historial.jsonl")) ? readFileSync(SP(ctx, "historial.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ts: string; fecha?: string; id_contrato: string; accion: string; mensaje_id: string }) : []
      const registrados_desde_corte = [
        ...maestro.filter((f) => (f.fecha_registro ?? "") > r.fecha_corte_maestro).map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, accion: "alta", fecha: f.fecha_registro })),
        ...hist.filter((h) => h.accion === "actualizacion").map((h) => ({ id_contrato: h.id_contrato, cliente: maestro.find((f) => f.id_contrato === h.id_contrato)?.cliente, accion: "actualizacion", fecha: h.fecha ?? h.ts.slice(0, 10) })),
      ]
      const tabla = (cols: string[], filas: Array<Record<string, unknown>>): string[] =>
        filas.length ? [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...filas.map((f) => `| ${cols.map((c) => String(f[c] ?? "")).join(" | ")} |`)] : ["_Sin registros._"]
      const md = [
        `# Alertas de contratos — ${hoy}`, "",
        `## 1. Vencen en ≤ ${r.dias_alerta_vencimiento} días (${vencen.length})`, ...tabla(["id_contrato", "cliente", "fecha_fin", "dias", "comercial"], vencen), "",
        `## 2. Pólizas exigidas no vigentes (${polizas_pendientes.length})`, ...tabla(["id_contrato", "cliente", "tipo_poliza", "estado_poliza"], polizas_pendientes), "",
        `## 3. Registrados desde el corte ${r.fecha_corte_maestro} — gap cubierto (${registrados_desde_corte.length})`, ...tabla(["id_contrato", "cliente", "accion", "fecha"], registrados_desde_corte), "",
        `## Anexo: vencidos sin acta de cierre registrada (${vencidos.length})`, ...tabla(["id_contrato", "cliente", "fecha_fin"], vencidos), "",
      ].join("\n")
      writeOut(outPath(ctx.directory, "alertas.md"), md)
      return ok({ ruta: "out/alertas.md", vencen, polizas_pendientes, registrados_desde_corte, vencidos, resumen: `${vencen.length} por vencer · ${polizas_pendientes.length} pólizas pendientes · ${registrados_desde_corte.length} desde el corte` })
    })
  },
})
