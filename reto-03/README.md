# Reto 03 — Agente conversacional "Órdenes de Compra SAP"

Agente completo en TypeScript (Bun): front de chat, backend con ciclo de agente, herramientas tipadas con `zod` y adaptador LLM (Amazon Bedrock por defecto; Anthropic API como alternativa). El planteamiento está en [`SOLUCION.md`](SOLUCION.md).

**Link de prueba:** `<URL que imprime ./scripts/deploy-aws.sh>` · Clave de acceso: `<ACCESS_KEY si se configuró; vacía = link abierto>`

## Levantar en local (un comando)

```bash
cp .env.example .env        # credenciales AWS con acceso a Bedrock (perfil/SSO) o ANTHROPIC_API_KEY
bun install && bun run dev  # http://localhost:8080
```

Con Docker: `docker build -t reto-03 . && docker run -p 8080:8080 --env-file .env -v ~/.aws:/home/bun/.aws:ro reto-03`

| Variable | Uso |
|---|---|
| `LLM_PROVIDER` | `bedrock` (defecto) o `anthropic` |
| `AWS_REGION`, `BEDROCK_MODEL_ID` | Región y modelo/perfil de inferencia de Bedrock (defecto Claude Sonnet 4.5, `us.` cross-region) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Solo si `LLM_PROVIDER=anthropic` |
| `MAX_ITERACIONES`, `MAX_TOKENS_SESION`, `MAX_TOKENS_RESPUESTA`, `LLM_TIMEOUT_MS`, `RATE_LIMIT_POR_MINUTO` | Topes de costo y robustez |
| `ACCESS_KEY` | Opcional: protege el link (el front la pide una vez) |
| `FECHA_REFERENCIA` | Opcional `AAAA-MM-DD`; por defecto la fecha de hoy en Bogotá |

Las claves solo se leen en el backend; nunca llegan al front, al repositorio, a los logs ni a las respuestas de la API.

## Verificación sin modelo

```bash
bun run demo.ts   # 6 solicitudes, idempotencia de sol-001 y confirmación explícita de sol-004 y sol-005
bun test          # pruebas de herramientas, ciclo del agente, guarda de confirmación y módulo
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, error, usage }` |
| `GET` | `/api/sessions/:id` | Historial completo (mensajes, herramientas, confirmaciones) |
| `GET` | `/api/health` | `{ ok, agente, provider, model }` sin claves |
| `GET` | `/api/config` | Título, ejemplos y herramientas para el front |
| `GET` | `/api/files`, `/api/files/<ruta>` | Lista y descarga de lo generado en `out/` |

Si `ACCESS_KEY` está definida, las rutas `/api/*` (salvo health/config) exigen el header `x-access-key`.

## Prueba sugerida

1. `Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.`
2. `confirmo`

## Despliegue en AWS

`./scripts/deploy-aws.sh` construye la imagen (linux/amd64), la sube a ECR, crea los roles IAM y publica un servicio **ECS Express Mode** (Fargate + ALB HTTPS) con un rol de tarea que solo puede invocar modelos Anthropic en Bedrock. Imprime la URL pública. `./scripts/destroy-aws.sh` lo elimina.

## Estructura

```
agent/prompt.md            comportamiento (system prompt)
src/knowledge/             conocimiento del proceso (.md) y reglas parametrizables (reglas.json)
src/tools/oc.ts            ejecución: herramientas zod (cada export → nombre visible al modelo)
src/core/                  ciclo del agente, registro de herramientas, confirmación, sesiones
src/llm/                   adaptador LLM (interfaz + Bedrock + Anthropic)
src/server.ts              API HTTP + front estático
web/                       chat (HTML/JS sin dependencias)
modulo/                    agente empaquetado (bonus), generado con `bun run build:modulo`
demo.ts · tests/           verificación sin modelo
```
