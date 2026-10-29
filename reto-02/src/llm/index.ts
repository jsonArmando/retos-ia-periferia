import { LlmError, type LlmAdapter } from "./adapter"
import { AnthropicAdapter } from "./anthropic"
import { BedrockAdapter } from "./bedrock"

/** Selecciona el proveedor por variable de entorno. El ciclo del agente no cambia. */
export function createLlm(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  const provider = (env.LLM_PROVIDER ?? "bedrock").toLowerCase()
  if (provider === "bedrock") {
    const model = env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    return new BedrockAdapter(model, env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1")
  }
  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY
    if (!key) throw new LlmError("Falta ANTHROPIC_API_KEY para LLM_PROVIDER=anthropic.", "config")
    return new AnthropicAdapter(env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5", key)
  }
  throw new LlmError(`LLM_PROVIDER no soportado: ${provider} (usa bedrock | anthropic)`, "config")
}
