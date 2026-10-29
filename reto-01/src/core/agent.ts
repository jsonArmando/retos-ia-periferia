import { LlmError, type Block, type LlmAdapter, type Message, type ToolResultBlock, type ToolSpec } from "../llm/adapter"
import { detectsConfirmationRequest, isAffirmative, toolAsksConfirmation } from "./confirmation"
import { runTool, type Registry } from "./registry"
import type { Session, ToolCallView } from "./session"

export type AgentConfig = {
  directory: string
  systemPrompt: string
  registry: Registry
  llm: LlmAdapter
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensRespuesta: number
  timeoutMs: number
  perCaseLog: boolean
}

export type TurnResult = {
  reply: string
  toolCalls: ToolCallView[]
  needsConfirmation: boolean
  error?: string
  usage: { inputTokens: number; outputTokens: number; tokensSesion: number }
}

const GUARD_ERROR =
  "requiere confirmación explícita: el usuario no confirmó en su último mensaje. Termina el turno preguntando y espera su respuesta."

/**
 * Un turno del agente: prompt → modelo → herramientas → … → respuesta.
 * Con tope de iteraciones (CA1), guarda de confirmación (CA3) y errores en lenguaje claro (CA5).
 */
export async function runTurn(cfg: AgentConfig, session: Session, userMessage: string): Promise<TurnResult> {
  const confirmadoPorUsuario = session.esperandoConfirmacion && isAffirmative(userMessage)
  const tools: ToolSpec[] = [...cfg.registry.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
  const toolCalls: ToolCallView[] = []
  const usage = { inputTokens: 0, outputTokens: 0 }
  let toolSignals = false
  let reply = ""
  let error: string | undefined

  pushUser(session.messages, [{ type: "text", text: userMessage }])

  let iter = 0
  for (; iter < cfg.maxIteraciones; iter++) {
    if (session.tokensUsados >= cfg.maxTokensSesion) {
      error = `Se alcanzó el tope de tokens de la sesión (${cfg.maxTokensSesion}). Abre una sesión nueva.`
      break
    }
    let response
    try {
      response = await cfg.llm.enviar(cfg.systemPrompt, session.messages, tools, {
        timeoutMs: cfg.timeoutMs,
        maxTokens: cfg.maxTokensRespuesta,
      })
    } catch (e) {
      error = e instanceof LlmError ? e.message : `Error inesperado del proveedor: ${String(e)}`
      break
    }
    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    session.tokensUsados += response.usage.inputTokens + response.usage.outputTokens

    const nonEmpty = response.content.filter((b) => b.type !== "text" || b.text.trim() !== "")
    const content = nonEmpty.length ? nonEmpty : [{ type: "text" as const, text: "(sin respuesta)" }]
    session.messages.push({ role: "assistant", content })
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
    const uses = content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
    if (uses.length === 0) {
      reply = text
      break
    }

    const results: ToolResultBlock[] = []
    for (const use of uses) {
      const call = await executeToolUse(cfg, session, use, confirmadoPorUsuario)
      toolCalls.push(call)
      if (call.bloqueadaPorGuarda || toolAsksConfirmation(call.resultado)) toolSignals = true
      results.push({ type: "tool_result", toolUseId: use.id, content: call.resultado, isError: !call.ok })
    }
    pushUser(session.messages, results)
  }

  if (!reply && !error && iter >= cfg.maxIteraciones) {
    reply = limitReply(cfg.maxIteraciones, toolCalls)
  }
  if (error) {
    reply = `⚠️ ${error}${toolCalls.length ? `\n\nAlcancé a ejecutar ${toolCalls.length} herramienta(s): ${toolCalls.map((t) => t.name).join(", ")}.` : ""}\nPuedes repetir tu mensaje; la sesión sigue activa.`
  }

  const needsConfirmation = !error && detectsConfirmationRequest(reply, toolSignals)
  session.esperandoConfirmacion = needsConfirmation
  return {
    reply,
    toolCalls,
    needsConfirmation,
    error,
    usage: { ...usage, tokensSesion: session.tokensUsados },
  }
}

async function executeToolUse(
  cfg: AgentConfig,
  session: Session,
  use: Extract<Block, { type: "tool_use" }>,
  confirmadoPorUsuario: boolean,
): Promise<ToolCallView> {
  const ctx = { directory: cfg.directory, sessionId: session.id }
  if (use.input.confirmado === true && !confirmadoPorUsuario) {
    const raw = JSON.stringify({ ok: false, error: GUARD_ERROR })
    return { id: use.id, name: use.name, args: use.input, ok: false, resumen: GUARD_ERROR, bloqueadaPorGuarda: true, resultado: raw }
  }
  const run = await runTool(cfg.registry, use.name, use.input, ctx, { perCaseLog: cfg.perCaseLog })
  return {
    id: use.id,
    name: run.name,
    args: run.args,
    ok: run.ok,
    resumen: run.resumen,
    bloqueadaPorGuarda: false,
    resultado: run.raw,
  }
}

/** Mantiene la alternancia user/assistant que exigen los proveedores. */
function pushUser(messages: Message[], blocks: Block[]): void {
  const last = messages[messages.length - 1]
  if (last && last.role === "user") last.content.push(...blocks)
  else messages.push({ role: "user", content: blocks })
}

function limitReply(max: number, calls: ToolCallView[]): string {
  const hechas = calls.filter((c) => c.ok).map((c) => `- ${c.name}: ${c.resumen}`)
  const fallidas = calls.filter((c) => !c.ok).map((c) => `- ${c.name}: ${c.resumen}`)
  return [
    `Alcancé el tope de ${max} iteraciones en este turno. Esto es lo que tengo:`,
    hechas.length ? hechas.join("\n") : "- (ninguna herramienta exitosa)",
    fallidas.length ? `\nPendiente o con error:\n${fallidas.join("\n")}` : "",
    "\nEscribe «continúa» para seguir desde aquí.",
  ].join("\n")
}
