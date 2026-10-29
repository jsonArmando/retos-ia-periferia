/** Fecha de referencia: FECHA_REFERENCIA (YYYY-MM-DD) o la fecha actual en Bogotá. */
export function fechaReferencia(env: NodeJS.ProcessEnv = process.env): string {
  const f = env.FECHA_REFERENCIA
  if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) return f
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" })
}
