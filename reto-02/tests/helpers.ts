import type { Block, LlmAdapter, LlmResponse, Message } from "../src/llm/adapter"

/** LLM guionado para pruebas del ciclo del agente (no se usa en producción). */
export class ScriptedLlm implements LlmAdapter {
  readonly provider = "scripted"
  readonly model = "guion"
  calls: Message[][] = []
  constructor(private readonly steps: Array<Block[] | Error>) {}
  async enviar(_s: string, mensajes: Message[]): Promise<LlmResponse> {
    this.calls.push(structuredClone(mensajes))
    const step = this.steps.shift() ?? [{ type: "text", text: "fin" }]
    if (step instanceof Error) throw step
    return { content: step, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }
  }
}

export const text = (t: string): Block[] => [{ type: "text", text: t }]
export const use = (name: string, input: Record<string, unknown>, id = `t${Math.random().toString(36).slice(2, 8)}`): Block[] => [
  { type: "tool_use", id, name, input },
]
