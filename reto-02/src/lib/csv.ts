/** CSV mínimo RFC 4180 (comillas dobles, comas y saltos dentro de campos). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") { row.push(field); field = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field); field = ""
      if (row.some((x) => x !== "")) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row) }
  const [header, ...data] = rows
  if (!header) return []
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])))
}

export function toCsv(header: string[], rows: Array<Record<string, string>>): string {
  const cell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h] ?? "")).join(","))].join("\n") + "\n"
}
