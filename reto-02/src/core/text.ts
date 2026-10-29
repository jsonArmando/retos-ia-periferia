/** Utilidades de texto deterministas (sin modelo). */

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function slug(s: string): string {
  return normalize(s).replace(/\s+/g, "-")
}

const STOP = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "en", "por", "para", "a", "con", "un", "una"])

export function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t && !STOP.has(t))
}

/** Coeficiente de Dice sobre bigramas de caracteres: 0..1 */
export function similarity(a: string, b: string): number {
  const x = normalize(a).replace(/\s+/g, " ")
  const y = normalize(b).replace(/\s+/g, " ")
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(x)
  const gb = grams(y)
  let inter = 0
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0)
  const total = x.length - 1 + (y.length - 1)
  return total > 0 ? (2 * inter) / total : 0
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(n)
}

/** Convierte "265.000.000", "120,000.00" o "1.234,5" en número. */
export function parseMonto(raw: string): number | null {
  const s = raw.replace(/[.,]$/, "")
  const lastDot = s.lastIndexOf(".")
  const lastComma = s.lastIndexOf(",")
  let n: string
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ","
    n = s.replace(dec === "." ? /,/g : /\./g, "").replace(dec, ".")
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ","
    const parts = s.split(sep)
    const miles = parts.slice(1).every((p) => p.length === 3)
    n = miles ? parts.join("") : parts.slice(0, -1).join("") + "." + parts[parts.length - 1]
  } else n = s
  const v = Number(n)
  return Number.isFinite(v) ? v : null
}
