/**
 * Genera modulo/ (bonus 9.4) desde las MISMAS fuentes que usa la app:
 *  - agent.md          ← agent/prompt.md (+ frontmatter)
 *  - tools/<x>.ts      ← re-export de src/tools/<x>.ts (no es copia)
 *  - skill/<n>/SKILL.md ← src/knowledge/<n>.md
 * tests/modulo.test.ts verifica que no diverjan.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { agentConfig } from "../src/agent.config"

export function expectedModulo(root: string): Record<string, string> {
  const prompt = readFileSync(join(root, "agent", "prompt.md"), "utf8").trim()
  const files: Record<string, string> = {
    "agent.md": `---\ndescription: ${agentConfig.subtitulo}\nmode: primary\npermission:\n  edit: deny\n  bash: deny\n---\n\n${prompt}\n`,
  }
  for (const name of Object.keys(agentConfig.toolModules))
    files[`tools/${name}.ts`] = `// Mismas herramientas que usa la aplicación (re-export, sin copias divergentes)\nexport * from "../../src/tools/${name}"\n`
  for (const f of readdirSync(join(root, "src", "knowledge")).filter((x) => x.endsWith(".md")))
    files[`skill/${f.replace(/\.md$/, "")}/SKILL.md`] = readFileSync(join(root, "src", "knowledge", f), "utf8")
  return files
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const out = join(root, "modulo")
  if (existsSync(out)) rmSync(out, { recursive: true })
  for (const [rel, content] of Object.entries(expectedModulo(root))) {
    mkdirSync(join(out, rel, ".."), { recursive: true })
    writeFileSync(join(out, rel), content)
  }
  console.log(`modulo/ generado: ${Object.keys(expectedModulo(root)).join(", ")}`)
}
