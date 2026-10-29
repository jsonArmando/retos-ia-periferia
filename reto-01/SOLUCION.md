# SOLUCIÓN — Reto 01 · Agente "Registro como Proveedor"

## 1. Problema en una frase
Cada registro de Periferia como proveedor (8–12/mes) se transcribe a mano desde un repositorio que ya existe; le duele a la **analista administrativa** (retrabajo y errores en NIT/cuentas), al **representante legal** (recibe paquetes incompletos) y a **facturación** (el registro tarda días y retrasa el cobro).

## 2. Arquitectura
```
┌────────────── web/ (HTML+JS) ──────────────┐   HTTP/JSON   ┌──────────────────── src/server.ts ────────────────────┐
│ historial · tarjetas de herramientas        │ ───────────▶ │ /api/chat → core/agent.ts (runTurn)                    │
│ banner "espera tu confirmación"             │ ◀─────────── │   ├─ llm/ (LlmAdapter: Bedrock | Anthropic)            │
│ panel de archivos generados en out/         │              │   ├─ core/registry.ts (zod → JSON Schema, validación,  │
└─────────────────────────────────────────────┘              │   │   ejecución, out/log.jsonl)                        │
                                                             │   ├─ core/confirmation.ts (guarda humana)              │
                                                             │   └─ core/session.ts (memoria + out/sessions/*.json)   │
                                                             └───────────────┬───────────────────────┬────────────────┘
                                                                     src/tools/proveedor.ts                 agent/prompt.md + src/knowledge/*
                                                                             │
                                                        fixtures/ (solo lectura) ───▶ out/ (escritura)
```

| Capa | Dónde vive | Qué cambia ahí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Tono, flujo, reglas de interacción |
| Conocimiento | `src/knowledge/*.md` (al prompt) y `src/knowledge/reglas.json` (lo leen las herramientas) | Reglas de negocio y umbrales: cambiarlos **no toca el servidor** |
| Ejecución | `src/tools/proveedor.ts` | Única fuente de valores; deterministas, nunca lanzan |
| Plataforma | `src/core`, `src/llm`, `src/server.ts` | Idéntica en los tres retos |

Despliegue: imagen Docker (`oven/bun`) → ECR → **ECS Express Mode** (Fargate + ALB HTTPS público, 1 tarea) con **rol de tarea** limitado a `bedrock:InvokeModel` sobre modelos Anthropic. No hay claves de LLM en ningún lado: Bedrock autentica con el rol.

## 3. Ciclo del agente
- `runTurn` (`src/core/agent.ts`): agrega el mensaje del usuario → llama `llm.enviar(system, mensajes, herramientas)` → si el modelo pide herramientas, valida los argumentos con `zod` (error de validación vuelve al modelo como `tool_result` de error), ejecuta, registra en `out/log.jsonl` y en el historial visible → repite hasta que el modelo responde sin herramientas.
- **Tope (CA1):** `MAX_ITERACIONES` (25) por turno; al alcanzarlo responde con lo hecho y lo pendiente. `MAX_TOKENS_SESION` corta el gasto por sesión; `RATE_LIMIT_POR_MINUTO` por IP; `LLM_TIMEOUT_MS` con `AbortController`.
- **Confirmación humana (CA3) en dos capas:**
  1. *Prompt*: el agente termina el turno con una pregunta y la línea `CONFIRMACIÓN REQUERIDA:`; el backend lo detecta (marcador, señal de las herramientas o pregunta de confirmación) y devuelve `needsConfirmation: true`; el front pinta el mensaje en ámbar y muestra el banner con "Sí, confirmo / No".
  2. *Guarda en el backend*: cualquier llamada con `confirmado: true` se **rechaza** si el turno anterior no pidió confirmación o si el mensaje actual del usuario no es una afirmación explícita (`core/confirmation.ts`, con negaciones que ganan: "no, todavía no"). Así la regla no depende de que el modelo obedezca. La tarjeta de la herramienta se marca "BLOQUEADA · requiere confirmación".
- **Errores (CA5):** las herramientas devuelven `{ ok:false, error }` y nunca lanzan; los errores del proveedor (timeout, permisos, throttling) se traducen a lenguaje claro, la sesión sigue y el historial mantiene la alternancia user/assistant que exigen los proveedores (probado en `tests/agent.test.ts`).
- **Trazabilidad (CA4):** cada llamada queda en el chat (nombre, argumentos, resumen, resultado expandible) y en `out/log.jsonl`.

En este reto la acción externa es `proveedor_simular_envio`: sin `confirmado: true` devuelve exactamente `requiere confirmación explícita`; con `confirmado: true` y sin confirmación del usuario la bloquea la guarda; con confirmación escribe **solo** `out/<caso>/ENVIO-SIMULADO.md`.

## 4. Elección del modelo
| | Decisión |
|---|---|
| Proveedor | **Amazon Bedrock** (Converse API) — ya disponible en la cuenta AWS; autenticación por rol IAM, sin secretos que custodiar; datos dentro de AWS. Alternativa conmutable: Anthropic API (`LLM_PROVIDER=anthropic`). |
| Modelo | **Claude Sonnet 4.5** (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), `temperature 0`. Buen uso de herramientas en español y seguimiento estricto de instrucciones; configurable por `BEDROCK_MODEL_ID` (p. ej. Haiku 4.5 para bajar costo ~3×). |
| Por qué no más barato por defecto | El riesgo del reto es que el modelo afirme valores o se salte la confirmación; se prioriza obediencia. Como las herramientas hacen el trabajo determinista, el modelo solo orquesta y redacta. |

**Costo estimado** (precio de lista Sonnet 4.5: USD 3 / M tokens de entrada, USD 15 / M de salida; verificar en la consola de Bedrock):
- Un caso completo ("procesa el caso X" → 4 herramientas + resumen): ~5 llamadas al modelo, ~30–40 k tokens de entrada acumulada (prompt + esquemas ~3,5 k por llamada + resultados) y ~2,5 k de salida ≈ **USD 0,13–0,16 por caso**.
- Confirmación de envío: ~1 llamada extra ≈ USD 0,03. A 12 casos/mes: **< USD 3/mes** de modelo.

Infraestructura: 1 tarea Fargate 0.5 vCPU / 1 GB + ALB compartido de ECS Express ≈ USD 20–35/mes por reto encendido; `destroy-aws.sh` lo apaga tras la defensa.

## 5. Diseño del portal web (7.4)
**Estrategia.** El agente **no** opera portales en esta fase: `proveedor_generar_formulario` devuelve "formato no soportado" y produce `valores-portal.md` (campo | valor | estado) para copiar. Fase 2 propuesta: un navegador controlado por el agente (Playwright en un contenedor aislado o "Claude in Chrome" en el equipo de la analista) que **solo rellena** campos a partir de `mapeo.json`, con sesión ya autenticada por la persona.

| Paso | Agente | Humano |
|---|---|---|
| Abrir portal e iniciar sesión (usuario, contraseña, MFA, CAPTCHA) | — | ✔ |
| Mapear campos del formulario web a etiquetas del glosario | ✔ (lee el DOM, propone mapeo) | confirma mapeos < 0,8 |
| Escribir valores del maestro | ✔ (solo valores de `mapeo.json`) | revisa en pantalla |
| Cargar soportes | ✔ (desde `paquete/soportes`) | verifica |
| Clic en **Enviar** / aceptar términos | — | ✔ |

**Credenciales.** Nunca en el repositorio, el prompt, el contexto del modelo ni los logs. Viven en el gestor de contraseñas corporativo o AWS Secrets Manager con acceso del rol humano; las ingresa la persona en el navegador. El agente trabaja sobre una sesión ya iniciada y la herramienta enmascara cualquier campo `password` en sus capturas y logs.

**Límites.** CAPTCHA/MFA (siempre humanos), cambios de layout (selectores por etiqueta visible + verificación de que cada campo quedó con el valor esperado; si falla, vuelve a `valores-portal.md`), sesiones que expiran, términos legales que no puede aceptar el agente. RPA clásico se descarta: frágil y costoso de mantener para 5 países y plantillas que cambian.

## 6. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Mapeo determinista (glosario exacto → normalizado → clave del maestro → similitud de bigramas ≥ 0,7) con confianza; el modelo nunca produce valores | Que el LLM mapee y rellene | CA2: un valor plausible inventado (cuenta, NIT) es el peor error; así es reproducible en `demo.ts` |
| `generar_formulario` acepta ajustes **solo de rutas** (`{etiqueta, ruta}`), nunca valores | Aceptar el mapeo con valores del modelo | Permite corregir el mapeo conversando sin abrir la puerta a valores inventados |
| PDF generado (pdf-lib) y XLSX escrito con OOXML mínimo + jszip, con colores por estado (amarillo = confirmar, rojo = faltante) | AcroForm rellenado / exceljs | El PRD acepta PDF generado; menos dependencias, salida determinista |
| Guarda de confirmación en el backend además del prompt | Confiar solo en el prompt | RN4 no puede depender de que el modelo obedezca |
| Soportes emitidos en CO para clientes de otros países: advertencia, no bloqueo | Bloquear | El PRD solo bloquea por vencido/ausente; la aceptación es decisión del cliente |

## 7. Supuestos
- "Fecha de ejecución" = argumento `fecha_ejecucion` o `FECHA_REFERENCIA`; si no, la fecha de hoy en Bogotá. `demo.ts` usa 2026-09-03 (fecha del PRD) para que sea determinista. Con la fecha real (oct-2026) la Cámara de Comercio (vence 2026-09-30) también bloquea, lo cual es correcto.
- El `certificado_cumplimiento_tributario` que exige Ecuador no existe en el repositorio → `ausente`.
- "Identificación tributaria"/RUC/RTN se llenan con el NIT y quedan `requiere_confirmacion`; un ajuste explícito de la analista los pasa a `lleno`.
- "Ingresos anuales" se escribe como número (98000000000) con nota "COP, año 2025"; "País" como código ISO del maestro (`CO`).
- Los campos `faltante` no bloquean `listo_para_firma` (RN3) pero aparecen en `checklist.md`. El envío simulado se permite con pendientes, dejándolos registrados en `ENVIO-SIMULADO.md`.

## 8. Cobertura
| HU | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer solicitud | Hecho | `leer_solicitud`, ambigüedades por país | Lectura de correo real (Graph API) y de plantillas binarias |
| HU-2 Mapear campos | Hecho | 3 estados, rutas, nunca inventa; prueba de "Identificación tributaria" | Dueño del dato del maestro y versionado |
| HU-3 Formulario | Hecho xlsx (P0) y pdf (P1); portal P2 con valores copiables | `formulario.xlsx` en celdas exactas (prueba lee el XML) | Escribir sobre la plantilla original del cliente conservando su formato |
| HU-4 Paquete | Hecho | `paquete/` con soportes, checklist (presente/ausente/vencido), borrador sin datos bancarios | Integración con firma electrónica |
| HU-5 Errores | Hecho | Plantilla corrupta, caso inexistente, args inválidos → mensajes claros | Alertas operativas |
| RN5 Log por caso | Hecho | `out/<caso>/log.jsonl` `{ts, herramienta, ok, resumen}` | Centralizar en CloudWatch |
| Bonus módulo | Hecho | `modulo/` verificado por prueba | — |

Pruebas: `bun test` → 24 pruebas (herramientas por HU, guarda de confirmación, tope de iteraciones, error de proveedor, módulo). `tsc --strict` sin errores; sin `any` en el código de la aplicación (solo en el tipado laxo de aserciones de pruebas).

## 9. Uso de IA
| Asistente | Para qué | Qué descarté y por qué |
|---|---|---|
| Claude (Anthropic) como asistente de código | Estructura del proyecto, borradores de herramientas, pruebas, front y documentación; revisé y ajusté cada archivo y corrí `demo.ts`, `bun test` y `tsc --strict` | **App Runner** como destino (AWS dejó de aceptar clientes nuevos desde el 30-abr-2026) → ECS Express Mode. **exceljs** (dependencia pesada) → escritor OOXML propio de ~90 líneas con jszip. Extraer valores con el modelo → extracción determinista con confianza. Un mapeo difuso al 0.5 que proponía "Número de cuenta" para "Número de contribuyente especial" → umbral 0.7 y el campo queda `faltante`. |

Puedo explicar cada línea: la plataforma (`src/core`, `src/llm`, `web`) es la misma en los tres retos y lo específico vive en `src/tools`, `src/knowledge` y `agent/prompt.md`.

## 10. Riesgos en producción
| Riesgo | Mitigación |
|---|---|
| Maestro desactualizado (dato bancario viejo) | Dueño del dato, fecha de actualización por campo, alerta si > 90 días |
| Plantillas de clientes más sucias que los fixtures | Etiquetas no reconocidas → `faltante`/`requiere_confirmacion`, nunca relleno; ampliar glosario con cada caso |
| Fuga de datos sensibles (cuenta, cédula) | RN2 en código; logs sin valores; despliegue privado con autenticación corporativa (Cognito/IdP) en lugar de `ACCESS_KEY` |
| Sesiones en memoria de una sola tarea | Para varias réplicas: sesiones en DynamoDB y `out/` en S3 |
| Costo del modelo | Topes por turno, sesión y tasa; Haiku para casos simples |
| Prompt injection desde el correo del cliente | El texto del correo solo se muestra; las acciones externas dependen de la guarda humana, no del modelo |

`modulo/` (bonus): `agent.md` (frontmatter `description`, `mode: primary`, `permission {edit: deny, bash: deny}` + el mismo `agent/prompt.md`), `tools/proveedor.ts` (re-export de `src/tools/proveedor.ts`, no una copia) y `skill/<nombre>/SKILL.md` (el mismo `src/knowledge/<nombre>.md`). Se regenera con `bun run build:modulo` y `tests/modulo.test.ts` falla si diverge.
