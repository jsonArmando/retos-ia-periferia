# SOLUCIÓN — Reto 02 · Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase
El maestro de contratos está congelado desde el 2026-05-30 y solo llegan contratos con póliza; le duele a **gerencia** (no sabe qué vence), a la **analista administrativa** (pólizas sin seguimiento) y a la empresa (el proceso murió con la rotación de una persona).

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
                                                                     src/tools/contratos.ts                 agent/prompt.md + src/knowledge/*
                                                                             │
                                                        fixtures/ (solo lectura) ───▶ out/ (escritura)
```

| Capa | Dónde vive | Qué cambia ahí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Tono, flujo, reglas de interacción |
| Conocimiento | `src/knowledge/*.md` (al prompt) y `src/knowledge/reglas.json` (lo leen las herramientas) | Reglas de negocio y umbrales: cambiarlos **no toca el servidor** |
| Ejecución | `src/tools/contratos.ts` | Única fuente de valores; deterministas, nunca lanzan |
| Plataforma | `src/core`, `src/llm`, `src/server.ts` | Idéntica en los tres retos |

Despliegue: imagen Docker (`oven/bun`) → ECR → **ECS Express Mode** (Fargate + ALB HTTPS público, 1 tarea) con **rol de tarea** limitado a `bedrock:InvokeModel` sobre modelos Anthropic. No hay claves de LLM en ningún lado: Bedrock autentica con el rol.

SharePoint simulado: `out/sharepoint/` (maestro CSV copiado del fixture en la primera ejecución, `Contratos/<año>/<cliente>/`, `historial.jsonl`); `out/procesados.json`; `out/alertas.md`.

## 3. Ciclo del agente
- `runTurn` (`src/core/agent.ts`): agrega el mensaje del usuario → llama `llm.enviar(system, mensajes, herramientas)` → si el modelo pide herramientas, valida los argumentos con `zod` (error de validación vuelve al modelo como `tool_result` de error), ejecuta, registra en `out/log.jsonl` y en el historial visible → repite hasta que el modelo responde sin herramientas.
- **Tope (CA1):** `MAX_ITERACIONES` (25) por turno; al alcanzarlo responde con lo hecho y lo pendiente. `MAX_TOKENS_SESION` corta el gasto por sesión; `RATE_LIMIT_POR_MINUTO` por IP; `LLM_TIMEOUT_MS` con `AbortController`.
- **Confirmación humana (CA3) en dos capas:**
  1. *Prompt*: el agente termina el turno con una pregunta y la línea `CONFIRMACIÓN REQUERIDA:`; el backend lo detecta (marcador, señal de las herramientas o pregunta de confirmación) y devuelve `needsConfirmation: true`; el front pinta el mensaje en ámbar y muestra el banner con "Sí, confirmo / No".
  2. *Guarda en el backend*: cualquier llamada con `confirmado: true` se **rechaza** si el turno anterior no pidió confirmación o si el mensaje actual del usuario no es una afirmación explícita (`core/confirmation.ts`, con negaciones que ganan: "no, todavía no"). Así la regla no depende de que el modelo obedezca. La tarjeta de la herramienta se marca "BLOQUEADA · requiere confirmación".
- **Errores (CA5):** las herramientas devuelven `{ ok:false, error }` y nunca lanzan; los errores del proveedor (timeout, permisos, throttling) se traducen a lenguaje claro, la sesión sigue y el historial mantiene la alternancia user/assistant que exigen los proveedores (probado en `tests/agent.test.ts`).
- **Trazabilidad (CA4):** cada llamada queda en el chat (nombre, argumentos, resumen, resultado expandible) y en `out/log.jsonl`.

Acción protegida: `contratos_registrar` con campos en revisión exige `confirmado: true` (RN5) y la guarda del backend exige que el usuario lo haya confirmado.

## 4. Elección del modelo
| | Decisión |
|---|---|
| Proveedor | **Amazon Bedrock** (Converse API) — ya disponible en la cuenta AWS; autenticación por rol IAM, sin secretos que custodiar; datos dentro de AWS. Alternativa conmutable: Anthropic API (`LLM_PROVIDER=anthropic`). |
| Modelo | **Claude Sonnet 4.5** (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), `temperature 0`. Buen uso de herramientas en español y seguimiento estricto de instrucciones; configurable por `BEDROCK_MODEL_ID` (p. ej. Haiku 4.5 para bajar costo ~3×). |
| Por qué no más barato por defecto | El riesgo del reto es que el modelo afirme valores o se salte la confirmación; se prioriza obediencia. Como las herramientas hacen el trabajo determinista, el modelo solo orquesta y redacta. |

**Costo estimado** (precio de lista Sonnet 4.5: USD 3 / M tokens de entrada, USD 15 / M de salida; verificar en la consola de Bedrock):
- Lote de 6 mensajes en un turno: ~14 llamadas, ~150 k tokens de entrada acumulada, ~6 k de salida ≈ **USD 0,55 por lote (≈ USD 0,09 por mensaje)**; confirmación de msg-006 ≈ USD 0,05.

Infraestructura: 1 tarea Fargate 0.5 vCPU / 1 GB + ALB compartido de ECS Express ≈ USD 20–35/mes por reto encendido; `destroy-aws.sh` lo apaga tras la defensa.

## 5. Estrategia de extracción
Determinista (`src/lib/extraccion.ts`), sin modelo; el modelo solo orquesta y explica.
| Campo | Cómo | Confianza |
|---|---|---|
| id_contrato | patrón `XX-AAAA-NNN` (en un otrosí, el contrato modificado) | 0,95 |
| cliente / NIT | primera parte "Entre … identificada con NIT/RUC/RTN …" que no es Periferia; razón social en mayúsculas → forma correcta tomada del bloque de firmas; NIT sin puntos ni DV | 0,95 (0,85 si se capitaliza) |
| país | tipo/longitud del identificador (NIT→CO, RTN→HN, RUC 13→EC, 11→PE) cruzado con el domicilio | 0,95 (0,7 si no coinciden) |
| objeto | cláusula OBJETO, sin "EL CONTRATISTA se obliga a…", ≤ 200 | 0,9 (0,8 truncado) |
| valor / moneda | código ISO + cifra en la cláusula VALOR (separadores es/en); "no tiene valor determinado" → 0 e indeterminado; moneda desconocida → error | 0,95 / 0,6 por demanda |
| fechas | fechas "(dd) de mes de aaaa" en PLAZO con "desde/hasta"; plazo en meses + firma; firma sin día → último día posible | 0,95 / 0,85 / 0,6 |
| póliza | cláusula de garantías: tipos por palabra clave; condicional ("para cada orden…") → 0,8; otrosí que obliga a ampliar → `estado_poliza = pendiente` | 0,8–0,95 |

Validación: < 0,8 → `requiere_revision`; todo valor que el modelo envíe distinto a lo extraído también entra a revisión (el modelo puede **proponer**, no registrar). Duplicado/actualización: por `id_contrato`, luego NIT + similitud de objeto ≥ 0,9.

Resultado sobre el buzón (demo): msg-001 nuevo/pendiente, msg-002 nuevo/no_aplica, msg-003 actualización (valor 350.000→520.000 PEN, fin 2027-05-01→2027-11-01, póliza vigente→pendiente), msg-004 duplicado, msg-005 rechazado (cotización), msg-006 nuevo con revisión (valor, fecha_inicio, fecha_fin) registrado solo tras confirmar (0 y 2027-08-31).

## 6. Regla de gobierno (propuesta de una página)
1. **Canal único:** `contratos@periferia.com` (buzón compartido). Dueño: Analista administrativa (titular) con suplente de Gerencia Administrativa; el agente lo procesa a diario. Es el dueño del maestro mientras no exista área legal.
2. **Obligación del comercial:** enviar **todo** contrato firmado (con o sin póliza), otrosí, acta de inicio/terminación, en PDF firmado, dentro de **3 días hábiles** desde la firma. Asunto: `[CONTRATO|OTROSI|ACTA] <Cliente> – <No. contrato>`.
3. **Acuse automático:** en < 1 hora hábil el agente responde al comercial: clasificación (nuevo/actualización/duplicado/rechazado), id asignado, ruta en SharePoint y campos pendientes de revisión.
4. **Excepciones y escalamiento:** sin firma o sin valor/plazo identificable → se rechaza con motivo y se devuelve al comercial; segunda devolución o > 5 días sin respuesta → escala al Director Comercial. Póliza pendiente > 10 días desde inicio → alerta a Gerencia y corredor.
5. **Cierre del gap jun–ago 2026:** campaña de 2 semanas: Finanzas lista los clientes facturados jun–ago; cada comercial reenvía al buzón sus contratos de esa lista; el agente procesa en lote (`fuente = migracion`) y el reporte "facturado sin contrato" se revisa semanalmente hasta llegar a cero.
6. **Indicador mensual:** % de clientes facturados en el mes con contrato vigente en el maestro (meta ≥ 98 %) + nº de pólizas `pendiente` > 10 días (meta 0). Incumplimiento repetido de un comercial → se reporta en su evaluación.

## 7. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista con confianza calibrada por regla | Extraer con el LLM | El riesgo del PRD es que el modelo redondee o infiera; la regla es auditable y reproducible |
| `registrar` revalida todo desde el documento (no confía en el JSON del modelo) | Registrar el objeto que envía el modelo | Cambios del modelo se vuelven revisión humana |
| Rechazados y duplicados también pasan por `registrar` (marca `procesados.json`, sin escribir el maestro) | Dejarlos sin marcar | El buzón queda limpio y el acuse es completo |
| Otrosí archivado como `<id>-otrosi-<n>` sin cambiar la ruta del contrato original | Sobrescribir la ruta | Conserva el documento principal y el historial |
| Firma sin día → último día posible del mes (≤ fecha del correo), confianza 0,6 | Primer día del mes | Es el supuesto conservador y, de todos modos, va a revisión |

## 8. Supuestos
- `fecha_registro` = fecha de referencia (`FECHA_REFERENCIA` o hoy); la demo usa 2026-09-03.
- El valor de msg-006 se registra como 0 (contrato marco) y la moneda local (COP) con confianza 0,8.
- "Registrados desde el corte" incluye altas con `fecha_registro` > 2026-05-30 y actualizaciones del historial.
- Se agregó un anexo en alertas con contratos ya vencidos sin acta de cierre (CT-2025-018, CT-2026-002).
- La póliza condicional del contrato marco se registra `requiere_poliza = true` (cumplimiento), estado `pendiente`.

## 9. Cobertura
| HU | Estado | Falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Conector Exchange/Graph |
| HU-2 Extraer | Hecho (P0 texto; PDF nativo P1 no hecho) | OCR (Textract) y PDF |
| HU-3 Validar | Hecho (RN1–RN5) | Catálogo de clientes por NIT |
| HU-4 Registrar y archivar | Hecho (`historial.jsonl`, rutas, `procesados.json`) | SharePoint/Graph real, Excel en lugar de CSV |
| HU-5 Alertas | Hecho (`hoy` como argumento) | Envío programado (EventBridge) |
| HU-6 Errores | Hecho (vacío, moneda, fecha inválida, inexistente) | — |
| Bonus módulo | Hecho | — |

Pruebas: `bun test` → 22 pruebas (los 6 casos de la sección 7.4, cero duplicados, revisión, alertas, guarda, módulo). `tsc --strict` limpio.

## 10. Uso de IA
| Asistente | Para qué | Qué descarté y por qué |
|---|---|---|
| Claude (Anthropic) como asistente de código | Estructura del proyecto, borradores de herramientas, pruebas, front y documentación; revisé y ajusté cada archivo y corrí `demo.ts`, `bun test` y `tsc --strict` | **App Runner** como destino (AWS dejó de aceptar clientes nuevos desde el 30-abr-2026) → ECS Express Mode. **exceljs** (dependencia pesada) → escritor OOXML propio de ~90 líneas con jszip. Extraer valores con el modelo → extracción determinista con confianza. Un mapeo difuso al 0.5 que proponía "Número de cuenta" para "Número de contribuyente especial" → umbral 0.7 y el campo queda `faltante`. |

Puedo explicar cada línea: la plataforma (`src/core`, `src/llm`, `web`) es la misma en los tres retos y lo específico vive en `src/tools`, `src/knowledge` y `agent/prompt.md`.

## 11. Riesgos
| Riesgo | Mitigación |
|---|---|
| Contratos escaneados o con formatos nuevos | OCR + campos a revisión; ampliar reglas con cada caso fallido |
| Falsos duplicados por nombre del cliente | Deduplicación por NIT/id, nunca por nombre |
| El comercial no envía | Regla de gobierno + indicador "facturado sin contrato" |
| Concurrencia sobre el CSV | 1 tarea; en producción, lista de SharePoint/DynamoDB con escritura condicional |
| Datos personales en contratos | Acceso privado autenticado y logs sin texto del contrato |

`modulo/` (bonus): `agent.md` (frontmatter `description`, `mode: primary`, `permission {edit: deny, bash: deny}` + el mismo `agent/prompt.md`), `tools/contratos.ts` (re-export de `src/tools/contratos.ts`, no una copia) y `skill/<nombre>/SKILL.md` (el mismo `src/knowledge/<nombre>.md`). Se regenera con `bun run build:modulo` y `tests/modulo.test.ts` falla si diverge.
