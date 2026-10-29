// Front de chat sin dependencias. Muestra herramientas invocadas y resalta confirmaciones.
const $ = (id) => document.getElementById(id)
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* sin almacenamiento */ } },
}
const nuevoId = () => "s-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
let sessionId = store.get("sessionId") || nuevoId()
let accessKey = store.get("accessKey") || ""
let ocupado = false

function headers() {
  const h = { "content-type": "application/json" }
  if (accessKey) h["x-access-key"] = accessKey
  return h
}

// ---------- markdown mínimo (escapa HTML primero) ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
}
function md(text) {
  const lines = String(text || "").split("\n")
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
      const head = row(l)
      i += 2
      const body = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]))
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) { out.push(`<h3>${inline(h[2])}</h3>`); i++; continue }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""))
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`)
      continue
    }
    if (l.trim() === "") { i++; continue }
    const para = [l]
    i++
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|```|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${para.map(inline).join("<br>")}</p>`)
  }
  return out.join("")
}

// ---------- render ----------
function quitarVacio() { const v = $("vacio"); if (v) v.remove() }
function scroll() { const m = $("mensajes"); m.scrollTop = m.scrollHeight }

function renderUser(text) {
  quitarVacio()
  const d = document.createElement("div")
  d.className = "msg user"
  d.textContent = text
  $("mensajes").appendChild(d)
  scroll()
}

function toolCard(t) {
  const det = document.createElement("details")
  det.className = "tool"
  const estado = t.bloqueadaPorGuarda ? ["guard", "BLOQUEADA · requiere confirmación"] : t.ok ? ["ok", "OK"] : ["err", "ERROR"]
  let pretty = t.resultado
  try { pretty = JSON.stringify(JSON.parse(t.resultado), null, 2) } catch { /* texto plano */ }
  det.innerHTML = `<summary><span class="tool-name"></span><span class="tool-status ${estado[0]}">${estado[1]}</span><span class="tool-res"></span></summary><pre></pre>`
  det.querySelector(".tool-name").textContent = t.name
  det.querySelector(".tool-res").textContent = t.resumen
  det.querySelector("pre").textContent = `argumentos:\n${JSON.stringify(t.args, null, 2)}\n\nresultado:\n${pretty}`
  return det
}

function renderAssistant(entry) {
  quitarVacio()
  const d = document.createElement("div")
  d.className = "msg assistant" + (entry.needsConfirmation ? " confirm" : "") + (entry.error ? " error" : "")
  const label = document.createElement("div")
  label.className = "label"
  label.textContent = `Agente${entry.toolCalls?.length ? ` · ${entry.toolCalls.length} herramienta(s)` : ""}`
  if (entry.needsConfirmation) {
    const tag = document.createElement("span")
    tag.className = "tag-confirm"
    tag.textContent = "Requiere confirmación"
    label.appendChild(tag)
  }
  d.appendChild(label)
  if (entry.toolCalls?.length) {
    const box = document.createElement("div")
    box.className = "tools"
    entry.toolCalls.forEach((t) => box.appendChild(toolCard(t)))
    d.appendChild(box)
  }
  const body = document.createElement("div")
  body.className = "md"
  body.innerHTML = md(entry.text || entry.reply || "")
  d.appendChild(body)
  $("mensajes").appendChild(d)
  $("banner").hidden = !entry.needsConfirmation
  scroll()
}

function pensando(on) {
  let p = document.getElementById("pensando")
  if (on && !p) {
    p = document.createElement("div")
    p.id = "pensando"
    p.className = "pensando"
    p.textContent = "El agente está trabajando…"
    $("mensajes").appendChild(p)
    scroll()
  } else if (!on && p) p.remove()
}

// ---------- acciones ----------
async function enviar(texto) {
  if (ocupado || !texto.trim()) return
  ocupado = true
  $("enviar").disabled = true
  $("banner").hidden = true
  renderUser(texto)
  pensando(true)
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: headers(), body: JSON.stringify({ sessionId, message: texto }) })
    const data = await r.json()
    pensando(false)
    if (r.status === 401) { pedirClave(); renderAssistant({ text: "Clave de acceso inválida. Ingrésala y vuelve a enviar." , error: true }); return }
    if (!r.ok) { renderAssistant({ text: `⚠️ ${data.error || "Error"}`, error: true }); return }
    renderAssistant(data)
    cargarArchivos()
  } catch (e) {
    pensando(false)
    renderAssistant({ text: `⚠️ No hay conexión con el backend (${e.message}). La sesión sigue; intenta de nuevo.`, error: true })
  } finally {
    ocupado = false
    $("enviar").disabled = false
    $("entrada").focus()
  }
}

async function cargarArchivos() {
  try {
    const r = await fetch("/api/files", { headers: headers() })
    if (!r.ok) return
    const { archivos } = await r.json()
    const ul = $("archivos")
    ul.innerHTML = ""
    if (!archivos.length) { ul.innerHTML = '<li class="muted">Sin archivos todavía.</li>'; return }
    for (const f of archivos) {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.href = "#"
      a.textContent = f
      a.onclick = async (ev) => {
        ev.preventDefault()
        const res = await fetch("/api/files/" + f.split("/").map(encodeURIComponent).join("/"), { headers: headers() })
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        window.open(url, "_blank")
      }
      li.appendChild(a)
      ul.appendChild(li)
    }
  } catch { /* panel opcional */ }
}

async function cargarSesion() {
  try {
    const r = await fetch(`/api/sessions/${sessionId}`, { headers: headers() })
    if (!r.ok) return
    const s = await r.json()
    for (const e of s.transcript) e.role === "user" ? renderUser(e.text) : renderAssistant(e)
  } catch { /* sesión nueva */ }
}

function pedirClave() {
  const k = window.prompt("Este agente está protegido. Ingresa la clave de acceso:")
  if (k) { accessKey = k.trim(); store.set("accessKey", accessKey) }
}

async function init() {
  store.set("sessionId", sessionId)
  try {
    const cfg = await (await fetch("/api/config")).json()
    document.title = cfg.titulo
    $("titulo").textContent = cfg.titulo
    $("subtitulo").textContent = cfg.subtitulo
    const ej = $("ejemplos")
    if (ej) for (const t of cfg.ejemplos) {
      const b = document.createElement("button")
      b.type = "button"
      b.textContent = t
      b.onclick = () => enviar(t)
      ej.appendChild(b)
    }
    $("herramientas").innerHTML = cfg.herramientas.map((h) => `<li>${esc(h)}</li>`).join("")
    if (cfg.requiereClave && !accessKey) pedirClave()
    const h = await (await fetch("/api/health")).json()
    $("modelo").textContent = `${h.provider} · ${h.model}`
  } catch { /* backend caído: el envío mostrará el error */ }
  await cargarSesion()
  cargarArchivos()
}

$("form").addEventListener("submit", (e) => { e.preventDefault(); const t = $("entrada").value; $("entrada").value = ""; enviar(t) })
$("entrada").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit() } })
$("nueva").addEventListener("click", () => { sessionId = nuevoId(); store.set("sessionId", sessionId); location.reload() })
$("refrescar").addEventListener("click", cargarArchivos)
document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.quick)))
init()
