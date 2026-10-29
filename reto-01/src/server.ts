import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { agentConfig } from "./agent.config"
import { runTurn, type AgentConfig } from "./core/agent"
import { fechaReferencia, loadSystemPrompt } from "./core/prompt"
import { buildRegistry } from "./core/registry"
import { isValidSessionId, SessionStore } from "./core/session"
import { createLlm } from "./llm"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const env = process.env
const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d)

const PORT = num(env.PORT, 8080)
const ACCESS_KEY = env.ACCESS_KEY ?? ""
const RATE_PER_MIN = num(env.RATE_LIMIT_POR_MINUTO, 20)
const MAX_MSG = 4000

const registry = buildRegistry(agentConfig.toolModules)
const llm = createLlm(env)
const sessions = new SessionStore(ROOT)

function agentCfg(): AgentConfig {
  return {
    directory: ROOT,
    systemPrompt: loadSystemPrompt(ROOT, fechaReferencia(env)),
    registry,
    llm,
    maxIteraciones: num(env.MAX_ITERACIONES, 25),
    maxTokensSesion: num(env.MAX_TOKENS_SESION, 400_000),
    maxTokensRespuesta: num(env.MAX_TOKENS_RESPUESTA, 4096),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 90_000),
    perCaseLog: agentConfig.perCaseLog,
  }
}

// ---------- utilidades HTTP ----------
function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(data)
}

async function readJson(req: IncomingMessage, limit = 32_768): Promise<Record<string, unknown> | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const b = chunk as Buffer
    size += b.length
    if (size > limit) return null
    chunks.push(b)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const hits = new Map<string, number[]>()
function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > RATE_PER_MIN
}

function authorized(req: IncomingMessage): boolean {
  if (!ACCESS_KEY) return true
  return req.headers["x-access-key"] === ACCESS_KEY
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".svg": "image/svg+xml",
}

function serveFile(res: ServerResponse, path: string, download = false): void {
  const headers: Record<string, string> = { "content-type": MIME[extname(path)] ?? "application/octet-stream" }
  if (download) headers["content-disposition"] = `inline; filename="${encodeURIComponent(path.split(sep).pop() ?? "archivo")}"`
  res.writeHead(200, headers)
  createReadStream(path).pipe(res)
}

/** Resuelve una ruta dentro de `base` impidiendo salir de ella. */
function safeJoin(base: string, rel: string): string | null {
  const target = resolve(base, normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, ""))
  return target === base || target.startsWith(base + sep) ? target : null
}

function listOut(): string[] {
  const base = join(ROOT, "out")
  if (!existsSync(base)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relative(base, full).split(sep).join("/")
      if (rel.startsWith("sessions")) continue
      if (statSync(full).isDirectory()) walk(full)
      else out.push(rel)
    }
  }
  walk(base)
  return out.sort()
}

// ---------- rutas ----------
const locks = new Map<string, Promise<unknown>>()

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress ?? "?").trim()
  if (rateLimited(ip)) return send(res, 429, { error: "Demasiadas solicitudes; espera un minuto." })
  const body = await readJson(req)
  if (!body) return send(res, 400, { error: "Cuerpo JSON inválido o demasiado grande." })
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!isValidSessionId(sessionId)) return send(res, 400, { error: "sessionId inválido (6-64 caracteres alfanuméricos)." })
  if (!message || message.length > MAX_MSG) return send(res, 400, { error: `Mensaje vacío o mayor a ${MAX_MSG} caracteres.` })

  const prev = locks.get(sessionId) ?? Promise.resolve()
  const work = prev.then(async () => {
    const session = sessions.getOrCreate(sessionId)
    session.transcript.push({ role: "user", text: message, ts: new Date().toISOString() })
    const result = await runTurn(agentCfg(), session, message)
    session.transcript.push({
      role: "assistant",
      text: result.reply,
      ts: new Date().toISOString(),
      toolCalls: result.toolCalls,
      needsConfirmation: result.needsConfirmation,
      ...(result.error ? { error: result.error } : {}),
    })
    sessions.save(session)
    return result
  })
  locks.set(sessionId, work.catch(() => undefined))
  try {
    const r = await work
    send(res, 200, {
      sessionId,
      reply: r.reply,
      toolCalls: r.toolCalls.map(({ resultado, ...rest }) => ({ ...rest, resultado: resultado.slice(0, 6000) })),
      needsConfirmation: r.needsConfirmation,
      error: r.error ?? null,
      usage: r.usage,
    })
  } catch (e) {
    send(res, 500, { error: `Error interno: ${e instanceof Error ? e.message : String(e)}` })
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = url.pathname
  void (async () => {
    try {
      if (path === "/api/health" && req.method === "GET")
        return send(res, 200, { ok: true, agente: agentConfig.id, provider: llm.provider, model: llm.model })
      if (path === "/api/config" && req.method === "GET")
        return send(res, 200, {
          id: agentConfig.id,
          titulo: agentConfig.titulo,
          subtitulo: agentConfig.subtitulo,
          ejemplos: agentConfig.ejemplos,
          requiereClave: Boolean(ACCESS_KEY),
          herramientas: [...registry.keys()],
        })
      if (path.startsWith("/api/")) {
        if (!authorized(req)) return send(res, 401, { error: "Clave de acceso inválida." })
        if (path === "/api/chat" && req.method === "POST") return await handleChat(req, res)
        const sm = path.match(/^\/api\/sessions\/([^/]+)$/)
        if (sm && req.method === "GET") {
          const s = sessions.get(sm[1] ?? "")
          return s ? send(res, 200, { id: s.id, tokensUsados: s.tokensUsados, transcript: s.transcript }) : send(res, 404, { error: "Sesión no encontrada." })
        }
        if (path === "/api/files" && req.method === "GET") return send(res, 200, { archivos: listOut() })
        if (path.startsWith("/api/files/") && req.method === "GET") {
          const file = safeJoin(join(ROOT, "out"), path.slice("/api/files/".length))
          if (!file || file.includes(`${sep}sessions${sep}`) || !existsSync(file) || statSync(file).isDirectory())
            return send(res, 404, { error: "Archivo no encontrado." })
          return serveFile(res, file, true)
        }
        return send(res, 404, { error: "Ruta no encontrada." })
      }
      // front estático
      const webRoot = join(ROOT, "web")
      const file = path === "/" ? join(webRoot, "index.html") : safeJoin(webRoot, path)
      if (file && existsSync(file) && !statSync(file).isDirectory()) return serveFile(res, file)
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("No encontrado")
    } catch (e) {
      send(res, 500, { error: `Error interno: ${e instanceof Error ? e.message : String(e)}` })
    }
  })()
})

server.listen(PORT, () => {
  const promptBytes = readFileSync(join(ROOT, "agent", "prompt.md")).length
  console.log(
    `[${agentConfig.id}] escuchando en :${PORT} · proveedor=${llm.provider} modelo=${llm.model} · herramientas=${registry.size} · prompt=${promptBytes}B · clave_acceso=${ACCESS_KEY ? "sí" : "no"}`,
  )
})
