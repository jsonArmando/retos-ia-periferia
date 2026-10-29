import { z } from "zod/v4"

/** Contexto que el backend (o demo.ts) entrega a cada herramienta. */
export type ToolContext = {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
}

export type ArgsShape = Record<string, z.ZodType>

export type ToolDef<S extends ArgsShape = ArgsShape> = {
  description: string
  args: S
  execute: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Ayuda de tipado: devuelve el mismo objeto { description, args, execute }. */
export function defineTool<S extends ArgsShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}

export function ok<T>(data: T): string {
  return JSON.stringify({ ok: true, data })
}

export function fail(error: string): string {
  return JSON.stringify({ ok: false, error })
}

/** Ejecuta el cuerpo de una herramienta garantizando que nunca lance. */
export async function safe(fn: () => Promise<string> | string): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`error interno de la herramienta: ${msg}`)
  }
}

export function isToolDef(value: unknown): value is ToolDef {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.description === "string" && typeof v.args === "object" && typeof v.execute === "function"
}
