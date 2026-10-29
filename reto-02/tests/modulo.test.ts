import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expectedModulo } from "../scripts/build-modulo"

test("modulo/ usa las mismas piezas que la aplicación", async () => {
  const root = join(import.meta.dir, "..")
  for (const [rel, content] of Object.entries(expectedModulo(root))) expect(readFileSync(join(root, "modulo", rel), "utf8")).toBe(content)
  const app = await import("../src/agent.config")
  for (const name of Object.keys(app.agentConfig.toolModules)) {
    const mod = (await import(join(root, "modulo", "tools", `${name}.ts`))) as Record<string, unknown>
    expect(Object.keys(mod).sort()).toEqual(Object.keys(app.agentConfig.toolModules[name] ?? {}).sort())
  }
})
