import { LlmError, type Block, type LlmAdapter, type LlmOptions, type LlmResponse, type Message, type ToolSpec } from "./adapter"

/**
 * Amazon Bedrock (Converse API). Credenciales por la cadena estándar de AWS:
 * rol de tarea en ECS, perfil/SSO en local o variables AWS_*. Nunca se leen ni
 * se registran en este código.
 */

type ConverseContent =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }>; status: "success" | "error" } }

type ConverseOutput = {
  output?: { message?: { role: string; content?: ConverseContent[] } }
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

type BedrockSdk = {
  BedrockRuntimeClient: new (cfg: { region: string; maxAttempts?: number }) => {
    send(cmd: unknown, opts: { abortSignal: AbortSignal }): Promise<ConverseOutput>
  }
  ConverseCommand: new (input: Record<string, unknown>) => unknown
}

const SDK_MODULE = "@aws-sdk/client-bedrock-runtime"

export class BedrockAdapter implements LlmAdapter {
  readonly provider = "bedrock"
  private client: InstanceType<BedrockSdk["BedrockRuntimeClient"]> | null = null
  private sdk: BedrockSdk | null = null

  constructor(
    readonly model: string,
    private readonly region: string,
  ) {}

  async enviar(system: string, mensajes: Message[], herramientas: ToolSpec[], opts: LlmOptions): Promise<LlmResponse> {
    const { client, sdk } = await this.ensureClient()
    const command = new sdk.ConverseCommand({
      modelId: this.model,
      system: [{ text: system }],
      messages: mensajes.map(toConverse),
      toolConfig: herramientas.length
        ? {
            tools: herramientas.map((t) => ({
              toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } },
            })),
          }
        : undefined,
      inferenceConfig: { maxTokens: opts.maxTokens, temperature: 0 },
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const out = await client.send(command, { abortSignal: controller.signal })
      return {
        content: (out.output?.message?.content ?? []).map(fromConverse).filter((b): b is Block => b !== null),
        stopReason: out.stopReason ?? "end_turn",
        usage: { inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 },
      }
    } catch (e) {
      throw mapError(e, controller.signal.aborted, opts.timeoutMs)
    } finally {
      clearTimeout(timer)
    }
  }

  private async ensureClient(): Promise<{ client: InstanceType<BedrockSdk["BedrockRuntimeClient"]>; sdk: BedrockSdk }> {
    if (this.client && this.sdk) return { client: this.client, sdk: this.sdk }
    try {
      const sdk = (await import(SDK_MODULE)) as BedrockSdk
      this.sdk = sdk
      this.client = new sdk.BedrockRuntimeClient({ region: this.region, maxAttempts: 3 })
      return { client: this.client, sdk }
    } catch {
      throw new LlmError(`No está instalado ${SDK_MODULE}. Ejecuta "bun install".`, "config")
    }
  }
}

function toConverse(m: Message): { role: string; content: ConverseContent[] } {
  return {
    role: m.role,
    content: m.content.map((b): ConverseContent => {
      if (b.type === "text") return { text: b.text }
      if (b.type === "tool_use") return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } }
      return {
        toolResult: { toolUseId: b.toolUseId, content: [{ text: b.content }], status: b.isError ? "error" : "success" },
      }
    }),
  }
}

function fromConverse(c: ConverseContent): Block | null {
  if ("text" in c) return { type: "text", text: c.text }
  if ("toolUse" in c) return { type: "tool_use", id: c.toolUse.toolUseId, name: c.toolUse.name, input: c.toolUse.input ?? {} }
  return null
}

function mapError(e: unknown, aborted: boolean, timeoutMs: number): LlmError {
  if (aborted) return new LlmError(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s.`, "timeout")
  const name = e instanceof Error ? e.name : ""
  const msg = e instanceof Error ? e.message : String(e)
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException")
    return new LlmError("Bedrock limitó la tasa de solicitudes; intenta de nuevo en unos segundos.", "rate_limit")
  if (name === "AccessDeniedException" || name === "UnrecognizedClientException" || name === "CredentialsProviderError")
    return new LlmError("Sin permisos/credenciales para invocar el modelo en Bedrock.", "auth")
  if (name === "ResourceNotFoundException" || name === "ValidationException")
    return new LlmError(`Bedrock rechazó la solicitud (${name}): ${msg.slice(0, 200)}`, "config")
  return new LlmError(`Error del proveedor (${name || "desconocido"}): ${msg.slice(0, 200)}`, "provider")
}
