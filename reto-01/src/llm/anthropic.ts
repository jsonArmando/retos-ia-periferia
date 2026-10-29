import { LlmError, type Block, type LlmAdapter, type LlmOptions, type LlmResponse, type Message, type ToolSpec } from "./adapter"

/** API directa de Anthropic (Messages). La clave viene de ANTHROPIC_API_KEY y nunca sale del backend. */

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }

type AnthropicResponse = {
  content?: AnthropicContent[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async enviar(system: string, mensajes: Message[], herramientas: ToolSpec[], opts: LlmOptions): Promise<LlmResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens,
          temperature: 0,
          system,
          messages: mensajes.map(toAnthropic),
          tools: herramientas.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        }),
      })
      const body = (await res.json()) as AnthropicResponse
      if (!res.ok) throw httpError(res.status, body)
      return {
        content: (body.content ?? []).map(fromAnthropic).filter((b): b is Block => b !== null),
        stopReason: body.stop_reason ?? "end_turn",
        usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
      }
    } catch (e) {
      if (e instanceof LlmError) throw e
      if (controller.signal.aborted)
        throw new LlmError(`El modelo no respondió en ${Math.round(opts.timeoutMs / 1000)} s.`, "timeout")
      throw new LlmError(`No se pudo contactar a Anthropic: ${e instanceof Error ? e.message : String(e)}`, "provider")
    } finally {
      clearTimeout(timer)
    }
  }
}

function toAnthropic(m: Message): { role: string; content: AnthropicContent[] } {
  return {
    role: m.role,
    content: m.content.map((b): AnthropicContent => {
      if (b.type === "text") return { type: "text", text: b.text }
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input }
      return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError }
    }),
  }
}

function fromAnthropic(c: AnthropicContent): Block | null {
  if (c.type === "text") return { type: "text", text: c.text }
  if (c.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} }
  return null
}

function httpError(status: number, body: AnthropicResponse): LlmError {
  const detail = body.error?.message?.slice(0, 200) ?? `HTTP ${status}`
  if (status === 401 || status === 403) return new LlmError("Clave de Anthropic inválida o sin permisos.", "auth")
  if (status === 429) return new LlmError("Anthropic limitó la tasa de solicitudes; intenta de nuevo.", "rate_limit")
  return new LlmError(`Anthropic respondió ${status}: ${detail}`, "provider")
}
