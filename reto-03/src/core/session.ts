import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Message } from "../llm/adapter"

export type ToolCallView = {
  id: string
  name: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  /** true si la guarda de confirmación humana bloqueó la llamada */
  bloqueadaPorGuarda: boolean
  resultado: string
}

export type TranscriptEntry =
  | { role: "user"; text: string; ts: string }
  | { role: "assistant"; text: string; ts: string; toolCalls: ToolCallView[]; needsConfirmation: boolean; error?: string }

export type Session = {
  id: string
  createdAt: string
  /** Conversación en formato neutro del adaptador LLM */
  messages: Message[]
  /** Vista para el front */
  transcript: TranscriptEntry[]
  tokensUsados: number
  esperandoConfirmacion: boolean
}

const SESSION_ID = /^[a-zA-Z0-9_-]{6,64}$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id)
}

/** Sesiones en memoria con respaldo en out/sessions/<id>.json. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly dir: string

  constructor(root: string) {
    this.dir = join(root, "out", "sessions")
  }

  get(id: string): Session | null {
    if (!isValidSessionId(id)) return null
    const cached = this.sessions.get(id)
    if (cached) return cached
    const file = join(this.dir, `${id}.json`)
    if (!existsSync(file)) return null
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as Session
      this.sessions.set(id, s)
      return s
    } catch {
      return null
    }
  }

  getOrCreate(id: string): Session {
    const existing = this.get(id)
    if (existing) return existing
    const s: Session = {
      id,
      createdAt: new Date().toISOString(),
      messages: [],
      transcript: [],
      tokensUsados: 0,
      esperandoConfirmacion: false,
    }
    this.sessions.set(id, s)
    return s
  }

  save(s: Session): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, `${s.id}.json`), JSON.stringify(s), "utf8")
    } catch {
      // la sesión sigue en memoria aunque falle el disco
    }
  }
}
