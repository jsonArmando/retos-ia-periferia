import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export { fechaReferencia } from "./fecha"

/**
 * System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md).
 * Cambiar reglas de negocio no toca el servidor: se editan estos Markdown o las herramientas.
 */
export function loadSystemPrompt(root: string, fechaReferencia: string): string {
  const behaviour = readFileSync(join(root, "agent", "prompt.md"), "utf8")
  const knowledgeDir = join(root, "src", "knowledge")
  const knowledge = existsSync(knowledgeDir)
    ? readdirSync(knowledgeDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => stripFrontmatter(readFileSync(join(knowledgeDir, f), "utf8")).trim())
        .join("\n\n")
    : ""
  return [
    stripFrontmatter(behaviour).trim(),
    knowledge ? `\n\n---\n# Conocimiento del proceso\n\n${stripFrontmatter(knowledge).trim()}` : "",
    `\n\n---\nFecha de referencia del sistema: ${fechaReferencia}.`,
  ].join("")
}

function stripFrontmatter(md: string): string {
  return md.startsWith("---") ? md.replace(/^---[\s\S]*?\n---\n?/, "") : md
}
