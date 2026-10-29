import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

/** Lectura/escritura acotada: fixtures/ solo lectura, out/ escritura. Rutas siempre relativas a la raíz. */

export type Read<T> = { ok: true; value: T } | { ok: false; error: string }

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id)
}

export function readJsonFile<T>(path: string, label: string): Read<T> {
  if (!existsSync(path)) return { ok: false, error: `no existe ${label}` }
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as T }
  } catch (e) {
    return { ok: false, error: `${label} está corrupto (JSON inválido: ${e instanceof Error ? e.message.slice(0, 80) : "?"})` }
  }
}

export function readTextFile(path: string, label: string): Read<string> {
  if (!existsSync(path)) return { ok: false, error: `no existe ${label}` }
  try {
    return { ok: true, value: readFileSync(path, "utf8") }
  } catch {
    return { ok: false, error: `no se pudo leer ${label}` }
  }
}

export function writeOut(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Borra un directorio solo si está dentro de <root>/out. */
export function cleanOutDir(root: string, path: string): void {
  const out = resolve(root, "out")
  const target = resolve(path)
  if (target === out || target.startsWith(out + sep)) rmSync(target, { recursive: true, force: true })
}

export function rel(root: string, path: string): string {
  const r = resolve(path).slice(resolve(root).length + 1)
  return r.split(sep).join("/")
}

export function outPath(root: string, ...parts: string[]): string {
  return join(root, "out", ...parts)
}
