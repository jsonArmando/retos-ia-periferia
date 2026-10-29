import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib"

/** Generador de PDF de texto (pdf-lib, fuentes estándar). Determinista salvo metadatos de fecha. */

export type PdfRow = { etiqueta: string; valor: string; marca?: "faltante" | "confirmar" | null }
export type PdfSection = { titulo?: string; filas?: PdfRow[]; parrafos?: string[]; monoespaciado?: boolean }
export type PdfDoc = { titulo: string; subtitulo?: string; secciones: PdfSection[]; pie?: string }

const A4: [number, number] = [595.28, 841.89]
const M = 50

/** Las fuentes estándar usan WinAnsi: se reemplazan caracteres fuera de ese juego. */
function winAnsi(s: string): string {
  return s
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=")
    .replace(/[→]/g, "->")
    .replace(/[‐-‒]/g, "-")
    .replace(/\t/g, "  ")
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…€]/g, "?")
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  for (const para of winAnsi(text).split("\n")) {
    let line = ""
    for (const word of para.split(" ")) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate
      else {
        if (line) out.push(line)
        line = word
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
          let cut = line.length - 1
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--
          out.push(line.slice(0, cut))
          line = line.slice(cut)
        }
      }
    }
    out.push(line)
  }
  return out
}

export async function renderPdf(doc: PdfDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(winAnsi(doc.titulo))
  pdf.setProducer("agente-periferia")
  pdf.setCreator("agente-periferia")
  const fixed = new Date("2026-01-01T00:00:00Z")
  pdf.setCreationDate(fixed)
  pdf.setModificationDate(fixed)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.Courier)
  const width = A4[0] - 2 * M

  let page: PDFPage = pdf.addPage(A4)
  let y = A4[1] - M
  const ensure = (h: number): void => {
    if (y - h < M + 20) {
      page = pdf.addPage(A4)
      y = A4[1] - M
    }
  }
  const text = (s: string, font: PDFFont, size: number, x = M, color = rgb(0.1, 0.1, 0.1)): void => {
    page.drawText(s, { x, y, size, font, color })
  }

  for (const l of wrap(doc.titulo, bold, 16, width)) {
    ensure(22)
    text(l, bold, 16)
    y -= 22
  }
  if (doc.subtitulo) {
    for (const l of wrap(doc.subtitulo, regular, 10, width)) {
      ensure(14)
      text(l, regular, 10, M, rgb(0.35, 0.35, 0.35))
      y -= 14
    }
  }
  y -= 8

  for (const s of doc.secciones) {
    if (s.titulo) {
      ensure(30)
      y -= 6
      text(winAnsi(s.titulo), bold, 12)
      y -= 6
      page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.6, color: rgb(0.7, 0.7, 0.7) })
      y -= 14
    }
    for (const f of s.filas ?? []) {
      const labelW = 190
      const valueLines = wrap(f.valor || " ", regular, 10, width - labelW - 8)
      const labelLines = wrap(f.etiqueta, bold, 10, labelW - 8)
      const h = Math.max(valueLines.length, labelLines.length) * 13 + 6
      ensure(h)
      if (f.marca) {
        const color = f.marca === "faltante" ? rgb(1, 0.88, 0.88) : rgb(1, 0.96, 0.8)
        page.drawRectangle({ x: M - 4, y: y - h + 10, width: width + 8, height: h, color })
      }
      let yy = y
      for (const l of labelLines) {
        page.drawText(l, { x: M, y: yy, size: 10, font: bold })
        yy -= 13
      }
      yy = y
      for (const l of valueLines) {
        page.drawText(l, { x: M + labelW, y: yy, size: 10, font: regular })
        yy -= 13
      }
      y -= h
    }
    for (const p of s.parrafos ?? []) {
      const font = s.monoespaciado ? mono : regular
      const size = s.monoespaciado ? 9 : 10
      for (const l of wrap(p, font, size, width)) {
        ensure(13)
        text(l, font, size)
        y -= 13
      }
      y -= 4
    }
  }
  if (doc.pie) {
    for (const l of wrap(doc.pie, regular, 9, width)) {
      ensure(12)
      y -= 2
      text(l, regular, 9, M, rgb(0.4, 0.4, 0.4))
      y -= 12
    }
  }
  return pdf.save({ useObjectStreams: false })
}
