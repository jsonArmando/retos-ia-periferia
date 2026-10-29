import { describe, expect, test } from "bun:test"
import { mkdtempSync, cpSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentConfig } from "../src/agent.config"
import { runTurn, type AgentConfig } from "../src/core/agent"
import { isAffirmative } from "../src/core/confirmation"
import { buildRegistry } from "../src/core/registry"
import { SessionStore } from "../src/core/session"
import { LlmError } from "../src/llm/adapter"
import { gated } from "./gated"
import { ScriptedLlm, text, use } from "./helpers"

const ROOT = join(import.meta.dir, "..")
function setup(llm: ScriptedLlm, maxIteraciones = 25): { cfg: AgentConfig; store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agente-"))
  cpSync(join(ROOT, "fixtures"), join(dir, "fixtures"), { recursive: true })
  cpSync(join(ROOT, "src", "knowledge"), join(dir, "src", "knowledge"), { recursive: true })
  const cfg: AgentConfig = {
    directory: dir, systemPrompt: "test", registry: buildRegistry(agentConfig.toolModules), llm,
    maxIteraciones, maxTokensSesion: 1_000_000, maxTokensRespuesta: 1000, timeoutMs: 5000, perCaseLog: agentConfig.perCaseLog,
  }
  return { cfg, store: new SessionStore(dir), dir }
}

describe("confirmación", () => {
  test("detecta afirmaciones y negaciones", () => {
    for (const s of ["sí", "Sí, confirmo. Procede.", "confirmo el valor 0 y la fecha fin 2027-08-31", "envía", "dale", "ok, créala"]) expect(isAffirmative(s)).toBe(true)
    for (const s of ["no", "No, no procedas todavía.", "espera", "cancela", "¿qué falta?", "procesa el caso x"]) expect(isAffirmative(s)).toBe(false)
  })
})

describe("ciclo del agente", () => {
  test("la guarda bloquea confirmado:true sin confirmación del usuario y lo permite tras 'sí'", async () => {
    const llm = new ScriptedLlm([
      ...gated.prepare.map((p) => use(p.name, p.args)),
      use(gated.name, { ...gated.args, confirmado: true }),
      text("Listo. ¿Confirmas que proceda?"),
      use(gated.name, { ...gated.args, confirmado: true }),
      text("Hecho."),
    ])
    const { cfg, store } = setup(llm)
    const s = store.getOrCreate("sesion-test-1")
    const t1 = await runTurn(cfg, s, gated.firstMessage)
    const bloqueada = t1.toolCalls.find((c) => c.name === gated.name)
    expect(bloqueada?.bloqueadaPorGuarda).toBe(true)
    expect(bloqueada?.ok).toBe(false)
    expect(t1.needsConfirmation).toBe(true)
    const t2 = await runTurn(cfg, s, "Sí, confirmo")
    expect(t2.toolCalls[0]?.bloqueadaPorGuarda).toBe(false)
    expect(t2.toolCalls[0]?.ok).toBe(gated.expectOkAfterConfirm)
    expect(t2.needsConfirmation).toBe(false)
  })

  test("una respuesta negativa no habilita la acción", async () => {
    const llm = new ScriptedLlm([text("¿Confirmas que proceda?"), use(gated.name, { ...gated.args, confirmado: true }), text("Entendido.")])
    const { cfg, store } = setup(llm)
    const s = store.getOrCreate("sesion-test-2")
    await runTurn(cfg, s, gated.firstMessage)
    const t2 = await runTurn(cfg, s, "No, todavía no")
    expect(t2.toolCalls[0]?.bloqueadaPorGuarda).toBe(true)
  })

  test("tope de iteraciones responde con lo que tiene", async () => {
    const steps = Array.from({ length: 5 }, () => use(gated.prepare[0]?.name ?? gated.name, gated.prepare[0]?.args ?? {}))
    const { cfg, store } = setup(new ScriptedLlm(steps), 3)
    const r = await runTurn(cfg, store.getOrCreate("sesion-test-3"), "hola")
    expect(r.toolCalls.length).toBe(3)
    expect(r.reply).toContain("tope de 3 iteraciones")
  })

  test("error del proveedor no mata la sesión y la conversación sigue válida", async () => {
    const llm = new ScriptedLlm([new LlmError("El modelo no respondió en 5 s.", "timeout"), text("ya respondo")])
    const { cfg, store } = setup(llm)
    const s = store.getOrCreate("sesion-test-4")
    const r1 = await runTurn(cfg, s, "hola")
    expect(r1.error).toContain("no respondió")
    const r2 = await runTurn(cfg, s, "¿sigues?")
    expect(r2.reply).toBe("ya respondo")
    const roles = s.messages.map((m) => m.role)
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1])
  })

  test("argumentos inválidos se devuelven al modelo sin lanzar y quedan en out/log.jsonl", async () => {
    const llm = new ScriptedLlm([use(gated.name, { basura: 1 }), text("ok")])
    const { cfg, store, dir } = setup(llm)
    const r = await runTurn(cfg, store.getOrCreate("sesion-test-5"), "x")
    expect(r.toolCalls[0]?.ok).toBe(false)
    expect(r.toolCalls[0]?.resumen).toContain("argumentos inválidos")
    expect(existsSync(join(dir, "out", "log.jsonl"))).toBe(true)
  })
})
