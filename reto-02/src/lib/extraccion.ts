import { normalize, parseMonto } from "../core/text"

export { parseMonto }

/** Extracción determinista (regex + heurísticas) sobre el texto del contrato. Cada campo lleva confianza 0..1. */

export type Campo<T> = { valor: T | null; confianza: number; fuente: string }
export type Pais = "CO" | "EC" | "PE" | "PA" | "HN"

export type Extraccion = {
  tipo_documento: "contrato" | "otrosi"
  numero_otrosi: number | null
  id_contrato: Campo<string>
  cliente: Campo<string>
  nit_cliente: Campo<string>
  pais: Campo<Pais>
  objeto: Campo<string>
  valor: Campo<number>
  valor_indeterminado: boolean
  moneda: Campo<string>
  fecha_inicio: Campo<string>
  fecha_fin: Campo<string>
  requiere_poliza: Campo<boolean>
  tipo_poliza: Campo<string>
  ampliar_polizas: boolean
}

export type Opciones = { monedas: string[]; monedaLocal: Record<string, string>; tiposPoliza: Record<string, string>; fechaCorreo: string }

export class ExtraccionError extends Error {}

const nada = <T>(fuente = "no encontrado en el texto"): Campo<T> => ({ valor: null, confianza: 0, fuente })

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}
const ORDINALES = ["PRIMERA", "SEGUNDA", "TERCERA", "CUARTA", "QUINTA", "SEXTA", "SÉPTIMA", "SEPTIMA", "OCTAVA", "NOVENA", "DÉCIMA", "DECIMA"]

export const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`

export function fechaValida(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function addMonths(isoDate: string, n: number, minusOneDay = false): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  const dt = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)))
  if (minusOneDay) dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

/** Divide el texto por cláusulas ("PRIMERA. OBJETO. …"). */
function clausulas(texto: string): string[] {
  const re = new RegExp(`(?:^|\\n)\\s*(?:${ORDINALES.join("|")})\\.\\s*`, "g")
  return texto.split(re).slice(1).map((c) => c.trim())
}

function clausula(texto: string, palabra: RegExp): string | null {
  return clausulas(texto).find((c) => palabra.test(c.slice(0, 70))) ?? null
}

type FechaEncontrada = { iso: string; previo: string }

function fechasEn(texto: string): FechaEncontrada[] {
  const re = /(?:\((\d{1,2})\)|\b(\d{1,2})\b)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/gi
  const out: FechaEncontrada[] = []
  for (const m of texto.matchAll(re)) {
    const d = Number(m[1] ?? m[2])
    const mes = MESES[normalize(m[3] ?? "")]
    const y = Number(m[4])
    if (!mes) continue
    if (!fechaValida(y, mes, d)) throw new ExtraccionError(`fecha inválida en el texto: "${m[0]}"`)
    out.push({ iso: iso(y, mes, d), previo: normalize(texto.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0)) })
  }
  return out
}

function nombreCorrecto(texto: string, mayus: string): Campo<string> {
  const objetivo = normalize(mayus)
  for (const linea of texto.split("\n"))
    for (const seg of linea.split(/\s{2,}/)) if (normalize(seg) === objetivo && seg !== seg.toUpperCase()) return { valor: seg.trim(), confianza: 0.95, fuente: "bloque de firmas" }
  const titulo = mayus.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
  return { valor: titulo, confianza: 0.85, fuente: "encabezado (capitalizado)" }
}

export function extraer(texto: string, op: Opciones): Extraccion {
  if (!texto.trim()) throw new ExtraccionError("el documento está vacío")
  const t = texto.replace(/\r/g, "")
  const esOtrosi = /^\s*OTROS[IÍ]/i.test(t)

  // id del contrato: patrón XX-AAAA-NNN (en un otrosí es el contrato modificado)
  const idm = t.match(/\b([A-Z]{2,4}-\d{4}-\d{1,4})\b/)
  const id_contrato: Campo<string> = idm?.[1] ? { valor: idm[1], confianza: 0.95, fuente: "número del documento" } : nada()
  const numero_otrosi = esOtrosi ? Number(t.match(/OTROS[IÍ]\s+No\.\s*(\d+)/i)?.[1] ?? 1) : null

  // contraparte: primera parte que no es Periferia
  const partes = [...t.matchAll(/(?:Entre\s+(?:los suscritos,\s*)?|y\s+)([A-ZÁÉÍÓÚÑ][^,\n]{2,90}?),\s*(?:identificada con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+)/g)]
  const contraparte = partes.find((p) => !/PERIFERIA/i.test(p[1] ?? ""))
  let cliente: Campo<string> = nada()
  let nit_cliente: Campo<string> = nada()
  let pais: Campo<Pais> = nada()
  if (contraparte?.[1] && contraparte[2] && contraparte[3]) {
    cliente = nombreCorrecto(t, contraparte[1].trim())
    const tipoId = contraparte[2].toUpperCase()
    const digits = tipoId === "NIT" ? contraparte[3].replace(/-\d$/, "").replace(/\D/g, "") : contraparte[3].replace(/\D/g, "")
    nit_cliente = { valor: digits, confianza: 0.95, fuente: `${tipoId} en el encabezado` }
    const zona = normalize(t.slice(contraparte.index ?? 0, (contraparte.index ?? 0) + 250))
    const porTexto: Pais | null = /ecuador/.test(zona) ? "EC" : /peru/.test(zona) ? "PE" : /panama/.test(zona) ? "PA" : /honduras/.test(zona) ? "HN" : /colombia|bogota|medellin|barranquilla|cali/.test(zona) ? "CO" : null
    const porId: Pais | null = tipoId === "NIT" ? "CO" : tipoId === "RTN" ? "HN" : digits.length === 13 ? "EC" : digits.length === 11 ? "PE" : null
    const valor = porId ?? porTexto
    pais = valor ? { valor, confianza: porId && (!porTexto || porTexto === porId) ? 0.95 : 0.7, fuente: porId ? `tipo/longitud de ${tipoId}` : "domicilio en el texto" } : nada()
  }

  // objeto
  let objeto: Campo<string> = nada(esOtrosi ? "el otrosí no modifica el objeto" : "no se encontró cláusula OBJETO")
  const cObj = clausula(t, /OBJETO/)
  if (cObj) {
    let s = cObj.replace(/^OBJETO\.\s*/i, "").replace(/\s+/g, " ").trim()
    s = s.replace(/^EL CONTRATISTA\s+(se obliga a\s+)?(ejecutar\s+|prestará\s+)?((el|la|los|las)\s+)?/i, "").replace(/\.$/, "")
    s = s.charAt(0).toUpperCase() + s.slice(1)
    const truncado = s.length > 200
    if (truncado) s = s.slice(0, 200).replace(/\s+\S*$/, "")
    objeto = { valor: s, confianza: truncado ? 0.8 : 0.9, fuente: `cláusula OBJETO${truncado ? " (truncado a 200)" : ""}` }
  }

  // valor y moneda
  let valor: Campo<number> = nada()
  let moneda: Campo<string> = nada()
  let valor_indeterminado = false
  const cVal = clausula(t, /VALOR/)
  if (cVal) {
    if (/no tiene (un )?valor determinado|valor indeterminado|por demanda|seg[uú]n las tarifas/i.test(cVal)) {
      valor_indeterminado = true
      valor = { valor: 0, confianza: 0.6, fuente: "contrato sin valor determinado (por demanda)" }
      const local = pais.valor ? op.monedaLocal[pais.valor] : undefined
      moneda = local ? { valor: local, confianza: 0.8, fuente: `moneda local de ${pais.valor} (valor indeterminado)` } : nada()
    } else {
      const m = cVal.match(/\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*)/)
      if (m?.[1] && m[2]) {
        if (!op.monedas.includes(m[1])) throw new ExtraccionError(`moneda desconocida: ${m[1]} (soportadas: ${op.monedas.join(", ")})`)
        const v = parseMonto(m[2])
        valor = v !== null ? { valor: v, confianza: 0.95, fuente: "cláusula VALOR (cifra)" } : nada("cifra ilegible")
        moneda = { valor: m[1], confianza: 0.95, fuente: "código de moneda en VALOR" }
      } else {
        const palabras = normalize(cVal)
        const mon = /pesos/.test(palabras) ? "COP" : /dolares/.test(palabras) ? "USD" : /soles/.test(palabras) ? "PEN" : /lempiras/.test(palabras) ? "HNL" : /balboas/.test(palabras) ? "PAB" : null
        moneda = mon ? { valor: mon, confianza: 0.7, fuente: "moneda en letras" } : nada()
      }
    }
  }

  // plazo
  let fecha_inicio: Campo<string> = nada(esOtrosi ? "el otrosí no modifica la fecha de inicio" : "no encontrado")
  let fecha_fin: Campo<string> = nada()
  const cPlazo = clausula(t, /PLAZO/) ?? ""
  const fechas = fechasEn(cPlazo)
  const meses = Number(cPlazo.match(/\((\d{1,3})\)\s*mes(es)?/i)?.[1] ?? NaN)
  const ini = fechas.find((f) => /desde|a partir/.test(f.previo.slice(-25)))
  const fin = fechas.find((f) => /hasta/.test(f.previo.slice(-25)))
  if (ini) fecha_inicio = { valor: ini.iso, confianza: 0.95, fuente: "PLAZO (desde)" }
  if (fin) fecha_fin = { valor: fin.iso, confianza: 0.95, fuente: "PLAZO (hasta)" }
  if (!ini && !fin && fechas.length >= 2 && fechas[0] && fechas[1]) {
    fecha_inicio = { valor: fechas[0].iso, confianza: 0.85, fuente: "PLAZO (primera fecha)" }
    fecha_fin = { valor: fechas[1].iso, confianza: 0.85, fuente: "PLAZO (segunda fecha)" }
  }
  if (!esOtrosi && !fecha_inicio.valor && /fecha de (su )?firma/i.test(cPlazo)) {
    const firma = t.match(/a los .*?\((\d{1,2})\) d[ií]as del mes de ([a-záéíóú]+) de (\d{4})/i)
    const soloMes = t.match(/en el mes de ([a-záéíóú]+) de (\d{4})/i)
    if (firma?.[1] && firma[2] && firma[3] && MESES[normalize(firma[2])]) {
      fecha_inicio = { valor: iso(Number(firma[3]), MESES[normalize(firma[2])] ?? 1, Number(firma[1])), confianza: 0.85, fuente: "fecha de firma" }
    } else if (soloMes?.[1] && soloMes[2] && MESES[normalize(soloMes[1])]) {
      const y = Number(soloMes[2])
      const mm = MESES[normalize(soloMes[1])] ?? 1
      const ultimo = iso(y, mm, new Date(Date.UTC(y, mm, 0)).getUTCDate())
      const valorIni = op.fechaCorreo && op.fechaCorreo < ultimo && op.fechaCorreo.startsWith(ultimo.slice(0, 7)) ? op.fechaCorreo : ultimo
      fecha_inicio = { valor: valorIni, confianza: 0.6, fuente: "firma sin día (mes de firma); se asume el último día posible" }
    }
  }
  if (!fecha_fin.valor && fecha_inicio.valor && Number.isFinite(meses)) {
    const derivada = fecha_inicio.confianza >= 0.8
    fecha_fin = derivada
      ? { valor: addMonths(fecha_inicio.valor, meses, true), confianza: 0.85, fuente: `inicio + ${meses} meses` }
      : { valor: addMonths(fecha_inicio.valor, meses), confianza: 0.6, fuente: `inicio estimado + ${meses} meses` }
  }

  // pólizas
  const cGar = clausula(t, /GARANT/) ?? (esOtrosi ? (clausulas(t).find((c) => /garant[ií]as|p[oó]liza/i.test(c)) ?? null) : null)
  let requiere_poliza: Campo<boolean> = { valor: false, confianza: 0.9, fuente: "sin cláusula de garantías" }
  let tipo_poliza: Campo<string> = { valor: "", confianza: 0.9, fuente: "no aplica" }
  let ampliar_polizas = false
  if (cGar && /p[oó]liza|garant[ií]as/i.test(cGar)) {
    const n = normalize(cGar)
    const tipos = Object.entries(op.tiposPoliza).filter(([k]) => n.includes(normalize(k))).map(([, v]) => v)
    const condicional = /para cada orden|cuyo valor supere|en caso de/i.test(cGar)
    ampliar_polizas = esOtrosi && /ampliar/i.test(cGar)
    requiere_poliza = { valor: true, confianza: condicional ? 0.8 : 0.95, fuente: condicional ? "garantía condicionada a órdenes de servicio" : "cláusula de garantías" }
    tipo_poliza = tipos.length ? { valor: tipos.join(";"), confianza: 0.9, fuente: "tipos nombrados en garantías" } : { valor: null, confianza: 0.5, fuente: "póliza sin tipo identificable" }
  }

  return { tipo_documento: esOtrosi ? "otrosi" : "contrato", numero_otrosi, id_contrato, cliente, nit_cliente, pais, objeto, valor, valor_indeterminado, moneda, fecha_inicio, fecha_fin, requiere_poliza, tipo_poliza, ampliar_polizas }
}
