import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod/v4"
import { fechaReferencia } from "../core/fecha"
import { cleanOutDir, isSafeId, outPath, readJsonFile, rel, writeOut } from "../core/files"
import { renderPdf } from "../core/pdf"
import { normalize, similarity } from "../core/text"
import { defineTool, fail, ok, safe, type ToolContext } from "../core/tool"
import { writeXlsx, type Cell, type Sheet } from "../lib/xlsx"

// ---------------------------------------------------------------- tipos
type Solicitud = {
  id: string
  de: string
  para?: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  formato: string
  cuerpo: string
  adjuntos: string[]
}
type EntradaCelda = { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
type EntradaCampo = { etiqueta: string; obligatorio: boolean }
type Campo = { etiqueta: string; obligatorio: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string }
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string }
type Reglas = {
  umbral_confianza: number
  identificador_tributario_por_pais: Record<string, string>
  pais_maestro: string
  rutas_sensibles_prefijo: string[]
  formatos_soportados: string[]
}
type Estado = "lleno" | "faltante" | "requiere_confirmacion"
export type CampoMapeado = {
  etiqueta: string
  estado: Estado
  ruta: string | null
  valor: string | null
  confianza: number
  sensible: boolean
  nota?: string
}
type Mapeo = { llenos: CampoMapeado[]; faltantes: CampoMapeado[]; requiere_confirmacion: CampoMapeado[] }
type Ajuste = { etiqueta: string; ruta: string | null }

// ---------------------------------------------------------------- lectura de fixtures
const FIX = (ctx: ToolContext, ...p: string[]): string => join(ctx.directory, "fixtures", "reto-01", ...p)

function reglas(ctx: ToolContext): Reglas {
  return JSON.parse(readFileSync(join(ctx.directory, "src", "knowledge", "reglas.json"), "utf8")) as Reglas
}

type CasoLeido = {
  solicitud: Solicitud
  campos: Campo[]
  plantillaError: string | null
  soportes: string[]
  soportesError: string | null
}

function leerCaso(ctx: ToolContext, caso: string): { ok: true; value: CasoLeido } | { ok: false; error: string } {
  if (!isSafeId(caso)) return { ok: false, error: `nombre de caso inválido: "${caso}"` }
  if (!existsSync(FIX(ctx, "casos", caso))) {
    const disponibles = listarCasos(ctx).join(", ")
    return { ok: false, error: `el caso "${caso}" no existe. Casos disponibles: ${disponibles}` }
  }
  const sol = readJsonFile<Solicitud>(FIX(ctx, "casos", caso, "solicitud.json"), "solicitud.json")
  if (!sol.ok) return { ok: false, error: sol.error }
  const solicitud = sol.value

  let campos: Campo[] = []
  let plantillaError: string | null = null
  if (solicitud.formato === "xlsx") {
    const p = readJsonFile<EntradaCelda[]>(FIX(ctx, "casos", caso, "plantilla-celdas.json"), "plantilla-celdas.json")
    if (!p.ok) plantillaError = p.error
    else if (!Array.isArray(p.value) || p.value.some((e) => !e.etiqueta || !e.hoja || !e.celda_valor || !e.celda_etiqueta))
      plantillaError = "plantilla-celdas.json está corrupta (faltan hoja/celda/etiqueta en alguna entrada)"
    else campos = p.value.map((e) => ({ etiqueta: e.etiqueta, obligatorio: true, hoja: e.hoja, celda_etiqueta: e.celda_etiqueta, celda_valor: e.celda_valor }))
  } else {
    const p = readJsonFile<EntradaCampo[]>(FIX(ctx, "casos", caso, "plantilla-campos.json"), "plantilla-campos.json")
    if (!p.ok) plantillaError = p.error
    else if (!Array.isArray(p.value) || p.value.some((e) => typeof e.etiqueta !== "string"))
      plantillaError = "plantilla-campos.json está corrupta (entradas sin etiqueta)"
    else campos = p.value.map((e) => ({ etiqueta: e.etiqueta, obligatorio: e.obligatorio !== false }))
  }

  const sop = readJsonFile<string[]>(FIX(ctx, "casos", caso, "soportes-exigidos.json"), "soportes-exigidos.json")
  return {
    ok: true,
    value: {
      solicitud,
      campos,
      plantillaError,
      soportes: sop.ok && Array.isArray(sop.value) ? sop.value : [],
      soportesError: sop.ok ? null : sop.error,
    },
  }
}

function listarCasos(ctx: ToolContext): string[] {
  const dir = FIX(ctx, "casos")
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "solicitud.json"))).sort() : []
}

// ---------------------------------------------------------------- mapeo determinista
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj)
}

function escalar(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join("; ")
  return null
}

function rutasMaestro(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : []
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => rutasMaestro(v, prefix ? `${prefix}.${k}` : k))
}

type Resolucion = { ruta: string; confianza: number; metodo: string }

function resolverEtiqueta(etiqueta: string, glosario: Record<string, string>, maestro: unknown): Resolucion | null {
  if (glosario[etiqueta]) return { ruta: glosario[etiqueta], confianza: 1, metodo: "glosario" }
  const n = normalize(etiqueta)
  for (const [k, ruta] of Object.entries(glosario)) if (normalize(k) === n) return { ruta, confianza: 0.95, metodo: "glosario (normalizado)" }
  const directa = rutasMaestro(maestro).find((r) => normalize(r.replace(/[._]/g, " ")) === n)
  if (directa) return { ruta: directa, confianza: 0.9, metodo: "clave del maestro" }
  let mejor: Resolucion | null = null
  for (const [k, ruta] of Object.entries(glosario)) {
    const s = similarity(etiqueta, k)
    if (!mejor || s > mejor.confianza) mejor = { ruta, confianza: Math.round(s * 100) / 100, metodo: `similar a "${k}"` }
  }
  return mejor && mejor.confianza >= 0.7 ? mejor : null
}

function mapear(ctx: ToolContext, pais: string, etiquetas: string[], ajustes: Ajuste[] = []): Mapeo {
  const r = reglas(ctx)
  const glosario = JSON.parse(readFileSync(FIX(ctx, "glosario-campos.json"), "utf8")) as Record<string, string>
  const maestro: unknown = JSON.parse(readFileSync(FIX(ctx, "repositorio", "maestro.json"), "utf8"))
  const idPais = r.identificador_tributario_por_pais[pais] ?? "identificador tributario"
  const out: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  const sensible = (ruta: string | null): boolean => !!ruta && r.rutas_sensibles_prefijo.some((p) => ruta.startsWith(p))

  for (const etiqueta of etiquetas) {
    const ajuste = ajustes.find((a) => normalize(a.etiqueta) === normalize(etiqueta))
    let item: CampoMapeado
    if (ajuste) {
      const valor = ajuste.ruta ? escalar(getPath(maestro, ajuste.ruta)) : null
      item = valor
        ? { etiqueta, estado: "lleno", ruta: ajuste.ruta, valor, confianza: 1, sensible: sensible(ajuste.ruta), nota: "mapeo ajustado por la analista" }
        : { etiqueta, estado: "faltante", ruta: ajuste.ruta, valor: null, confianza: 0, sensible: false, nota: ajuste.ruta ? `la ruta ${ajuste.ruta} no tiene valor en el maestro` : "marcado sin fuente por la analista" }
    } else {
      const res = resolverEtiqueta(etiqueta, glosario, maestro)
      if (!res) {
        item = { etiqueta, estado: "faltante", ruta: null, valor: null, confianza: 0, sensible: false, nota: "no existe en el glosario ni en el maestro" }
      } else {
        const valor = escalar(getPath(maestro, res.ruta))
        if (valor === null) {
          item = { etiqueta, estado: "faltante", ruta: res.ruta, valor: null, confianza: res.confianza, sensible: false, nota: `la clave ${res.ruta} no tiene valor en el maestro` }
        } else if (res.confianza < r.umbral_confianza) {
          item = { etiqueta, estado: "requiere_confirmacion", ruta: res.ruta, valor, confianza: res.confianza, sensible: sensible(res.ruta), nota: `mapeo con confianza ${res.confianza} (${res.metodo})` }
        } else {
          item = { etiqueta, estado: "lleno", ruta: res.ruta, valor, confianza: res.confianza, sensible: sensible(res.ruta) }
          const padre = res.ruta.endsWith(".valor") ? getPath(maestro, res.ruta.slice(0, -6)) : null
          if (padre && typeof padre === "object") {
            const p = padre as Record<string, unknown>
            if (p.moneda) item.nota = `valor en ${String(p.moneda)}${p.ano ? `, año ${String(p.ano)}` : ""}`
          }
        }
        // RN1: identificador tributario según país
        if (res.ruta === "nit" && item.estado !== "faltante") {
          if (pais !== r.pais_maestro) {
            item = { ...item, estado: "requiere_confirmacion", nota: `identificador extranjero: el cliente (${pais}) pide ${idPais}; Periferia solo tiene NIT colombiano` }
          } else if (normalize(etiqueta) !== normalize(idPais)) {
            item = { ...item, estado: "requiere_confirmacion", nota: `etiqueta ambigua; en ${pais} el equivalente es ${idPais}` }
          }
        }
      }
    }
    const key = item.estado === "lleno" ? "llenos" : item.estado === "faltante" ? "faltantes" : "requiere_confirmacion"
    out[key].push(item)
  }
  return out
}

function guardarMapeo(ctx: ToolContext, caso: string, mapeo: Mapeo, ajustes: Ajuste[]): void {
  writeOut(outPath(ctx.directory, caso, "mapeo.json"), JSON.stringify({ ...mapeo, ajustes }, null, 2))
}

function leerAjustesPrevios(ctx: ToolContext, caso: string): Ajuste[] {
  const r = readJsonFile<{ ajustes?: Ajuste[] }>(outPath(ctx.directory, caso, "mapeo.json"), "mapeo.json")
  return r.ok && Array.isArray(r.value.ajustes) ? r.value.ajustes : []
}

// ---------------------------------------------------------------- generación de formularios
type Generado = { ruta: string; formato: string; soportado: boolean; advertencia?: string }

async function generar(ctx: ToolContext, caso: string, datos: CasoLeido, mapeo: Mapeo): Promise<Generado> {
  const { solicitud, campos } = datos
  const todos = [...mapeo.llenos, ...mapeo.faltantes, ...mapeo.requiere_confirmacion]
  const porEtiqueta = new Map(todos.map((m) => [m.etiqueta, m]))
  const dir = outPath(ctx.directory, caso)

  if (solicitud.formato === "xlsx") {
    const hojas = new Map<string, Cell[]>()
    for (const c of campos) {
      const m = porEtiqueta.get(c.etiqueta)
      const cells = hojas.get(c.hoja ?? "Hoja1") ?? []
      cells.push({ ref: c.celda_etiqueta ?? "A1", value: c.etiqueta, style: "label" })
      const style = !m || m.estado === "faltante" ? "missing" : m.estado === "requiere_confirmacion" ? "confirm" : "value"
      cells.push({ ref: c.celda_valor ?? "B1", value: m?.valor ?? "", style })
      hojas.set(c.hoja ?? "Hoja1", cells)
    }
    const sheets: Sheet[] = [...hojas.entries()].map(([name, cells]) => ({ name, cells }))
    const ruta = join(dir, "formulario.xlsx")
    writeOut(ruta, await writeXlsx(sheets))
    return { ruta: rel(ctx.directory, ruta), formato: "xlsx", soportado: true }
  }

  if (solicitud.formato === "pdf") {
    const bytes = await renderPdf({
      titulo: `Formulario de registro de proveedor — ${solicitud.cliente}`,
      subtitulo: `Proveedor: Periferia IT Group S.A.S. · Solicitud ${solicitud.id} del ${solicitud.fecha} · País del cliente: ${solicitud.pais}`,
      secciones: [
        {
          titulo: "Datos del proveedor",
          filas: campos.map((c) => {
            const m = porEtiqueta.get(c.etiqueta)
            const marca = !m || m.estado === "faltante" ? ("faltante" as const) : m.estado === "requiere_confirmacion" ? ("confirmar" as const) : null
            return { etiqueta: `${c.etiqueta}${c.obligatorio ? " *" : ""}`, valor: m?.valor ?? "", marca }
          }),
        },
        { titulo: "Firma", parrafos: ["", "______________________________", "Representante legal", "Fecha: ____________"] },
      ],
      pie: "* Campo obligatorio. Documento preparado por el agente; requiere revisión y firma del representante legal.",
    })
    const ruta = join(dir, "formulario.pdf")
    writeOut(ruta, bytes)
    return { ruta: rel(ctx.directory, ruta), formato: "pdf", soportado: true }
  }

  // P2 — portal web: no se automatiza, se dejan valores copiables
  const filas = campos.map((c) => {
    const m = porEtiqueta.get(c.etiqueta)
    const estado = !m || m.estado === "faltante" ? "FALTANTE" : m.estado === "requiere_confirmacion" ? "POR CONFIRMAR" : "lleno"
    return `| ${c.etiqueta} | ${m?.valor ?? ""} | ${estado}${m?.nota ? ` — ${m.nota}` : ""} |`
  })
  const md = [
    `# Valores para portal — ${solicitud.cliente}`,
    "",
    `Formato **portal web** no soportado para llenado automático. Copie estos valores en el portal.`,
    `Las credenciales las ingresa una persona; el agente no las conoce ni las solicita. El clic en "Enviar" es humano.`,
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
  ].join("\n")
  const ruta = join(dir, "valores-portal.md")
  writeOut(ruta, md)
  return { ruta: rel(ctx.directory, ruta), formato: "portal", soportado: false, advertencia: "formato no soportado: portal web — se generaron valores listos para copiar" }
}

function formularioExistente(ctx: ToolContext, caso: string): string | null {
  for (const f of ["formulario.xlsx", "formulario.pdf", "valores-portal.md"]) {
    const p = outPath(ctx.directory, caso, f)
    if (existsSync(p)) return p
  }
  return null
}

// ---------------------------------------------------------------- soportes y paquete
type EstadoSoporte = { tipo: string; estado: "presente" | "ausente" | "vencido"; archivo: string | null; vigencia_hasta: string | null; nota?: string }

function evaluarSoportes(ctx: ToolContext, exigidos: string[], fecha: string, pais: string): EstadoSoporte[] {
  const idx = readJsonFile<Soporte[]>(FIX(ctx, "repositorio", "soportes", "index.json"), "index.json de soportes")
  const lista = idx.ok ? idx.value : []
  return exigidos.map((tipo) => {
    const s = lista.find((x) => x.tipo === tipo)
    if (!s || !existsSync(FIX(ctx, "repositorio", "soportes", s.archivo)))
      return { tipo, estado: "ausente", archivo: null, vigencia_hasta: null, nota: "no existe en el repositorio" }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < fecha
    const nota = [vencido ? `venció el ${s.vigencia_hasta}` : "", s.pais_emisor !== pais ? `emitido en ${s.pais_emisor}; validar que el cliente (${pais}) lo acepte` : ""]
      .filter(Boolean)
      .join("; ")
    return { tipo, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta, ...(nota ? { nota } : {}) }
  })
}

function checklistMd(caso: string, sol: Solicitud, fecha: string, soportes: EstadoSoporte[], mapeo: Mapeo, listo: boolean, formulario: string): string {
  const icon = { presente: "✅ presente", ausente: "❌ ausente", vencido: "⛔ vencido" }
  return [
    `# Checklist — ${sol.cliente} (${caso})`,
    "",
    `- Fecha de ejecución: ${fecha}`,
    `- Formulario: \`${formulario}\``,
    `- Estado: **${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
    "",
    "## Soportes exigidos",
    "| Soporte | Estado | Vigencia hasta | Nota |",
    "|---|---|---|---|",
    ...soportes.map((s) => `| ${s.tipo} | ${icon[s.estado]} | ${s.vigencia_hasta ?? "no aplica"} | ${s.nota ?? ""} |`),
    "",
    "## Campos faltantes (no bloquean, deben gestionarse)",
    ...(mapeo.faltantes.length ? mapeo.faltantes.map((f) => `- ${f.etiqueta} — ${f.nota ?? "sin fuente"}`) : ["- Ninguno"]),
    "",
    "## Campos por confirmar",
    ...(mapeo.requiere_confirmacion.length ? mapeo.requiere_confirmacion.map((f) => `- ${f.etiqueta} = \`${f.valor}\` — ${f.nota ?? ""}`) : ["- Ninguno"]),
    "",
  ].join("\n")
}

function borradorMd(sol: Solicitud, soportes: EstadoSoporte[], formulario: string, maestro: Record<string, unknown>): string {
  // RN2: nunca datos bancarios en el correo
  const rep = getPath(maestro, "representante_legal.nombre")
  const firma = getPath(maestro, "contacto_financiero.nombre")
  const cargo = getPath(maestro, "contacto_financiero.cargo")
  const adj = [formulario.split("/").pop() ?? formulario, ...soportes.filter((s) => s.estado === "presente").map((s) => s.archivo ?? s.tipo)]
  return [
    `**Para:** ${sol.de}`,
    `**Asunto:** RE: ${sol.asunto}`,
    "",
    "Cordial saludo,",
    "",
    `En respuesta a su solicitud del ${sol.fecha}, remitimos el formulario de registro de Periferia IT Group S.A.S. como proveedor de ${sol.cliente}, firmado por nuestro representante legal${rep ? `, ${String(rep)}` : ""}, junto con los siguientes soportes:`,
    "",
    ...adj.map((a) => `- ${a}`),
    "",
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Atentamente,",
    `${firma ? String(firma) : "Área administrativa"}${cargo ? `\n${String(cargo)}` : ""}`,
    "Periferia IT Group S.A.S.",
    "",
  ].join("\n")
}

// ================================================================= HERRAMIENTAS
const CASO = z.string().min(1).max(64).describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/ (ej. co-industrias-delta)")

export const listar_casos = defineTool({
  description: "Lista los casos de registro de proveedor disponibles en la carpeta de entrada.",
  args: {},
  async execute(_args, ctx) {
    return safe(() => {
      const casos = listarCasos(ctx)
      return ok({ casos, resumen: `${casos.length} caso(s): ${casos.join(", ")}` })
    })
  },
})

export const leer_solicitud = defineTool({
  description: "Lee la solicitud de un caso: país, cliente, formato de salida, campos pedidos por la plantilla y soportes exigidos.",
  args: { caso: CASO },
  async execute({ caso }, ctx) {
    return safe(() => {
      const r = leerCaso(ctx, caso)
      if (!r.ok) return fail(r.error)
      const { solicitud: s, campos, plantillaError, soportes, soportesError } = r.value
      const reg = reglas(ctx)
      const idPais = reg.identificador_tributario_por_pais[s.pais] ?? "desconocido"
      const glosario = JSON.parse(readFileSync(FIX(ctx, "glosario-campos.json"), "utf8")) as Record<string, string>
      const ambiguos = campos
        .filter((c) => glosario[c.etiqueta] === "nit" && normalize(c.etiqueta) !== normalize(idPais))
        .map((c) => ({ etiqueta: c.etiqueta, propuesta: idPais }))
      const formatoSoportado = reg.formatos_soportados.includes(s.formato)
      const advertencias = [
        plantillaError ? `plantilla no utilizable: ${plantillaError}` : "",
        soportesError ? `soportes exigidos no legibles: ${soportesError}` : "",
        formatoSoportado ? "" : `formato no soportado: ${s.formato} (se prepararán valores copiables)`,
      ].filter(Boolean)
      return ok({
        caso,
        cliente: s.cliente,
        pais: s.pais,
        formato: s.formato,
        formato_soportado: formatoSoportado,
        de: s.de,
        asunto: s.asunto,
        fecha: s.fecha,
        identificador_tributario_pais: idPais,
        campos,
        soportes,
        ambiguos,
        advertencias,
        resumen: `${s.cliente} (${s.pais}) · formato ${s.formato} · ${campos.length} campos · ${soportes.length} soportes${advertencias.length ? ` · ${advertencias.length} advertencia(s)` : ""}`,
      })
    })
  },
})

export const mapear_campos = defineTool({
  description: "Cruza las etiquetas solicitadas con el repositorio maestro y clasifica cada campo en lleno, faltante o requiere_confirmacion (nunca inventa valores).",
  args: {
    caso: CASO,
    campos: z.array(z.string().min(1).max(200)).min(1).max(200).describe("Etiquetas exactas de los campos solicitados (salen de leer_solicitud)"),
  },
  async execute({ caso, campos }, ctx) {
    return safe(() => {
      const r = leerCaso(ctx, caso)
      if (!r.ok) return fail(r.error)
      const ajustes = leerAjustesPrevios(ctx, caso)
      const mapeo = mapear(ctx, r.value.solicitud.pais, campos, ajustes)
      guardarMapeo(ctx, caso, mapeo, ajustes)
      return ok({
        ...mapeo,
        resumen: `${mapeo.llenos.length} llenos · ${mapeo.faltantes.length} faltantes · ${mapeo.requiere_confirmacion.length} por confirmar`,
      })
    })
  },
})

export const generar_formulario = defineTool({
  description: "Genera el formulario lleno en el formato del cliente (xlsx o pdf; portal → valores copiables) leyendo los valores siempre del maestro.",
  args: {
    caso: CASO,
    mapeo: z
      .array(
        z.object({
          etiqueta: z.string().describe("Etiqueta del campo a ajustar"),
          ruta: z.string().nullable().describe("Ruta del maestro (ej. contacto_financiero.email) o null para dejarlo sin fuente"),
        }),
      )
      .max(100)
      .optional()
      .describe("Opcional: ajustes de mapeo confirmados por la analista. Solo rutas, nunca valores: los valores se leen del maestro."),
  },
  async execute({ caso, mapeo }, ctx) {
    return safe(async () => {
      const r = leerCaso(ctx, caso)
      if (!r.ok) return fail(r.error)
      if (r.value.plantillaError) return fail(`no se puede generar el formulario: ${r.value.plantillaError}. Puedes armar el paquete para ver el checklist de soportes.`)
      const ajustes = [...leerAjustesPrevios(ctx, caso).filter((a) => !mapeo?.some((m) => normalize(m.etiqueta) === normalize(a.etiqueta))), ...(mapeo ?? [])]
      const m = mapear(ctx, r.value.solicitud.pais, r.value.campos.map((c) => c.etiqueta), ajustes)
      guardarMapeo(ctx, caso, m, ajustes)
      const g = await generar(ctx, caso, r.value, m)
      return ok({
        ...g,
        campos_llenos: m.llenos.length,
        faltantes: m.faltantes.map((f) => f.etiqueta),
        por_confirmar: m.requiere_confirmacion.map((f) => f.etiqueta),
        resumen: `${g.soportado ? "Formulario" : "Formato no soportado — valores copiables"} en ${g.ruta} (${m.llenos.length} llenos, ${m.faltantes.length} faltantes, ${m.requiere_confirmacion.length} por confirmar)`,
      })
    })
  },
})

export const armar_paquete = defineTool({
  description: "Arma out/<caso>/paquete/ con formulario, soportes vigentes, checklist.md y borrador-correo.md, y calcula si queda listo para firma.",
  args: {
    caso: CASO,
    fecha_ejecucion: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Fecha YYYY-MM-DD para evaluar vigencias; por defecto la fecha de referencia del sistema"),
  },
  async execute({ caso, fecha_ejecucion }, ctx) {
    return safe(async () => {
      const r = leerCaso(ctx, caso)
      if (!r.ok) return fail(r.error)
      const { solicitud: sol } = r.value
      const fecha = fecha_ejecucion ?? fechaReferencia()
      const dir = outPath(ctx.directory, caso, "paquete")
      cleanOutDir(ctx.directory, dir)

      let formulario = formularioExistente(ctx, caso)
      const advertencias: string[] = []
      const ajustes = leerAjustesPrevios(ctx, caso)
      const mapeo = mapear(ctx, sol.pais, r.value.campos.map((c) => c.etiqueta), ajustes)
      if (!formulario && !r.value.plantillaError) {
        await generar(ctx, caso, r.value, mapeo)
        guardarMapeo(ctx, caso, mapeo, ajustes)
        formulario = formularioExistente(ctx, caso)
      }
      if (r.value.plantillaError) advertencias.push(`sin formulario: ${r.value.plantillaError}`)
      const nombreForm = formulario ? (formulario.split(/[\\/]/).pop() ?? "") : "(sin formulario)"
      if (formulario) writeOut(join(dir, nombreForm), readFileSync(formulario))
      const soportes = evaluarSoportes(ctx, r.value.soportes, fecha, sol.pais)
      for (const s of soportes.filter((x) => x.estado === "presente" && x.archivo)) {
        writeOut(join(dir, "soportes", s.archivo ?? ""), readFileSync(FIX(ctx, "repositorio", "soportes", s.archivo ?? "")))
      }
      const bloqueos = soportes.filter((s) => s.estado !== "presente").map((s) => `${s.tipo}: ${s.estado}${s.nota ? ` (${s.nota})` : ""}`)
      if (!formulario) bloqueos.push("formulario no generado")
      const listo = bloqueos.length === 0
      const maestro = JSON.parse(readFileSync(FIX(ctx, "repositorio", "maestro.json"), "utf8")) as Record<string, unknown>
      writeOut(join(dir, "checklist.md"), checklistMd(caso, sol, fecha, soportes, mapeo, listo, nombreForm))
      writeOut(join(dir, "borrador-correo.md"), borradorMd(sol, soportes, nombreForm, maestro))
      return ok({
        ruta: rel(ctx.directory, dir),
        listo_para_firma: listo,
        fecha_ejecucion: fecha,
        checklist: {
          soportes,
          campos_faltantes: mapeo.faltantes.map((f) => f.etiqueta),
          campos_por_confirmar: mapeo.requiere_confirmacion.map((f) => ({ etiqueta: f.etiqueta, nota: f.nota })),
        },
        bloqueos,
        advertencias,
        pide_confirmacion: true,
        siguiente_paso: "Resumir y preguntar explícitamente si se autoriza el envío simulado. No llamar simular_envio sin confirmación.",
        resumen: `${listo ? "LISTO para firma" : `NO listo (${bloqueos.length} bloqueo(s))`} · ${soportes.filter((s) => s.estado === "presente").length}/${soportes.length} soportes vigentes · ${mapeo.faltantes.length} campos faltantes`,
      })
    })
  },
})

export const simular_envio = defineTool({
  description: "Simula el envío del paquete escribiendo out/<caso>/ENVIO-SIMULADO.md; solo con confirmación explícita del usuario.",
  args: {
    caso: CASO,
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
  },
  async execute({ caso, confirmado }, ctx) {
    return safe(() => {
      if (!confirmado) return fail("requiere confirmación explícita")
      if (!isSafeId(caso)) return fail(`nombre de caso inválido: "${caso}"`)
      const check = outPath(ctx.directory, caso, "paquete", "checklist.md")
      if (!existsSync(check)) return fail("no hay paquete armado para este caso; ejecuta armar_paquete primero")
      const r = leerCaso(ctx, caso)
      if (!r.ok) return fail(r.error)
      const checklist = readFileSync(check, "utf8")
      const listo = checklist.includes("LISTO PARA FIRMA") && !checklist.includes("NO LISTO")
      const adjuntos = readdirSync(outPath(ctx.directory, caso, "paquete"), { recursive: true }).map(String).filter((f) => f.includes("."))
      const ruta = outPath(ctx.directory, caso, "ENVIO-SIMULADO.md")
      writeOut(
        ruta,
        [
          `# Envío simulado — ${r.value.solicitud.cliente}`,
          "",
          `- Fecha/hora: ${new Date().toISOString()}`,
          `- Confirmado por: usuario de la sesión ${ctx.sessionId}`,
          `- Destinatario: ${r.value.solicitud.de}`,
          `- Asunto: RE: ${r.value.solicitud.asunto}`,
          `- Estado del paquete: ${listo ? "listo para firma" : "NO listo para firma (se envió con pendientes)"}`,
          "",
          "## Adjuntos",
          ...adjuntos.sort().map((a) => `- ${a}`),
          "",
          "> Simulación: no se envió ningún correo real. La firma del representante legal y el envío real son humanos.",
          "",
        ].join("\n"),
      )
      return ok({
        ruta: rel(ctx.directory, ruta),
        advertencia: listo ? null : "el paquete no estaba listo para firma; quedó registrado en el envío simulado",
        resumen: `Envío simulado escrito en ${rel(ctx.directory, ruta)}`,
      })
    })
  },
})
