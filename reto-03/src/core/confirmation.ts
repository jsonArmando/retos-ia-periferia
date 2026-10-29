/**
 * Confirmación humana (CA3 / RN4). Dos piezas:
 *  1. Detectar que el agente terminó el turno pidiendo confirmación.
 *  2. Decidir si el mensaje siguiente del usuario es una confirmación explícita.
 * El backend usa (2) como guarda: una herramienta invocada con `confirmado: true`
 * se rechaza si el usuario no confirmó en el turno inmediatamente anterior,
 * aunque el modelo lo intente.
 */

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")

const NEGATIVE = /\b(no|cancela|cancelar|cancelo|espera|detente|alto|todavia no|aun no|mejor no|nada)\b/
const AFFIRMATIVE =
  /\b(si|confirmo|confirmado|confirma|confirmar|procede|proceder|procedo|adelante|dale|ok|okay|de acuerdo|autorizo|aprobado|apruebo|envia|enviar|envialo|registra|registrar|registralo|crea|crear|creala|hazlo|correcto|listo|yes)\b/

export function isAffirmative(message: string): boolean {
  const m = normalize(message).trim()
  if (!m) return false
  // "no" al inicio o expresiones negativas explícitas ganan sobre cualquier afirmación
  if (/^no\b/.test(m) || NEGATIVE.test(m.replace(/\bno hay (problema|lio)\b/g, ""))) return false
  return AFFIRMATIVE.test(m)
}

export const CONFIRMATION_MARKER = "CONFIRMACIÓN REQUERIDA"

/** ¿El turno del agente terminó pidiendo una confirmación explícita? */
export function detectsConfirmationRequest(reply: string, toolSignals: boolean): boolean {
  if (reply.toUpperCase().includes(CONFIRMATION_MARKER)) return true
  const tail = normalize(reply.slice(-600))
  const asksQuestion = /\?/.test(tail)
  const confirmWords = /(confirm|proced|envi|registr|crea|autoriz|aprueb)/.test(tail)
  return (asksQuestion && confirmWords) || (toolSignals && asksQuestion)
}

/** Señal de las herramientas: errores o datos que exigen confirmación humana. */
export function toolAsksConfirmation(raw: string): boolean {
  try {
    const p = JSON.parse(raw) as { ok?: boolean; error?: string; data?: Record<string, unknown> }
    if (p.ok === false && typeof p.error === "string") return /requiere (confirmaci|revisi)/i.test(p.error)
    return p.data?.pide_confirmacion === true
  } catch {
    return false
  }
}
