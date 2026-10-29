/**
 * Interfaz propia del proveedor de lenguaje. El ciclo del agente solo conoce
 * estos tipos; cambiar de proveedor = escribir otra implementación de LlmAdapter.
 */
export type TextBlock = { type: "text"; text: string }
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
export type Block = TextBlock | ToolUseBlock | ToolResultBlock

export type Message = { role: "user" | "assistant"; content: Block[] }

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }

export type LlmUsage = { inputTokens: number; outputTokens: number }

export type LlmResponse = { content: Block[]; stopReason: string; usage: LlmUsage }

export type LlmOptions = { timeoutMs: number; maxTokens: number }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(system: string, mensajes: Message[], herramientas: ToolSpec[], opts: LlmOptions): Promise<LlmResponse>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "auth" | "rate_limit" | "provider" | "config",
  ) {
    super(message)
  }
}
