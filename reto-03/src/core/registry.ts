import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod/v4"
import { isToolDef, type ToolContext, type ToolDef } from "./tool"

export type RegisteredTool = {
  /** Nombre que ve el modelo: <archivo>_<export> */
  name: string
  description: string
  schema: z.ZodObject
  inputSchema: Record<string, unknown>
  def: ToolDef
}

export type Registry = Map<string, RegisteredTool>

export type ToolRun = {
  name: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  /** JSON devuelto por la herramienta (lo que ve el modelo). */
  raw: string
}

/**
 * Construye el registro a partir de módulos de herramientas.
 * `{ proveedor: modulo }` → cada export `x` se publica como `proveedor_x`.
 */
export function buildRegistry(modules: Record<string, Record<string, unknown>>): Registry {
  const registry: Registry = new Map()
  for (const [file, mod] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isToolDef(value)) continue
      const name = `${file}_${exportName}`
      const schema = z.object(value.args)
      const json = z.toJSONSchema(schema) as Record<string, unknown>
      delete json.$schema
      registry.set(name, { name, description: value.description, schema, inputSchema: json, def: value })
    }
  }
  return registry
}

/** Valida argumentos con zod, ejecuta y registra en out/log.jsonl. Nunca lanza. */
export async function runTool(
  registry: Registry,
  name: string,
  input: unknown,
  ctx: ToolContext,
  opts: { perCaseLog?: boolean } = {},
): Promise<ToolRun> {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
  const tool = registry.get(name)
  if (!tool) return finish(ctx, name, args, errorJson(`herramienta desconocida: ${name}`), opts)

  const parsed = tool.schema.safeParse(args)
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    return finish(ctx, name, args, errorJson(`argumentos inválidos — ${detalle}`), opts)
  }

  let raw: string
  try {
    const exec = tool.def.execute as (a: unknown, c: ToolContext) => Promise<string>
    raw = await exec(parsed.data, ctx)
  } catch (e) {
    raw = errorJson(`la herramienta falló: ${e instanceof Error ? e.message : String(e)}`)
  }
  return finish(ctx, name, args, raw, opts)
}

function errorJson(error: string): string {
  return JSON.stringify({ ok: false, error })
}

function finish(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  raw: string,
  opts: { perCaseLog?: boolean },
): ToolRun {
  const { ok, resumen } = summarize(raw)
  const entry = {
    ts: new Date().toISOString(),
    sesion: ctx.sessionId,
    herramienta: name,
    ...(typeof args.caso === "string" ? { caso: args.caso } : {}),
    ...(typeof args.mensaje_id === "string" ? { mensaje_id: args.mensaje_id } : {}),
    ok,
    resumen,
  }
  appendLog(join(ctx.directory, "out", "log.jsonl"), entry)
  if (opts.perCaseLog && typeof args.caso === "string" && /^[a-z0-9-]+$/i.test(args.caso)) {
    const { sesion: _s, caso: _c, ...perCase } = entry
    appendLog(join(ctx.directory, "out", args.caso, "log.jsonl"), perCase)
  }
  return { name, args, ok, resumen, raw }
}

function summarize(raw: string): { ok: boolean; resumen: string } {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; data?: { resumen?: unknown } }
    if (parsed.ok === true) {
      const r = parsed.data?.resumen
      return { ok: true, resumen: typeof r === "string" ? r : raw.slice(0, 160) }
    }
    return { ok: false, resumen: parsed.error ?? "error sin detalle" }
  } catch {
    return { ok: false, resumen: "la herramienta devolvió una respuesta no JSON" }
  }
}

function appendLog(path: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // el log nunca debe tumbar la ejecución
  }
}
