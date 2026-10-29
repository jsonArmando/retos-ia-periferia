# SOLUCIÓN — Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase
Cada factura exige digitar a mano una OC en SAP y validar de memoria proveedor, centro, aprobador y tope; le duele a la **analista** (tiempo y errores que se corrigen en el cierre), a **auditoría** (controles no sistemáticos) y a la **dirección** (no mide las OC retroactivas).

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
                                                                     src/tools/oc.ts                 agent/prompt.md + src/knowledge/*
                                                                             │
                                                        fixtures/ (solo lectura) ───▶ out/ (escritura)
```

| Capa | Dónde vive | Qué cambia ahí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Tono, flujo, reglas de interacción |
| Conocimiento | `src/knowledge/*.md` (al prompt) y `src/knowledge/reglas.json` (lo leen las herramientas) | Reglas de negocio y umbrales: cambiarlos **no toca el servidor** |
| Ejecución | `src/tools/oc.ts` | Única fuente de valores; deterministas, nunca lanzan |
| Plataforma | `src/core`, `src/llm`, `src/server.ts` | Idéntica en los tres retos |

Despliegue: imagen Docker (`oven/bun`) → ECR → **ECS Express Mode** (Fargate + ALB HTTPS público, 1 tarea) con **rol de tarea** limitado a `bedrock:InvokeModel` sobre modelos Anthropic. No hay claves de LLM en ningún lado: Bedrock autentica con el rol.

SAP: `src/sap/adapter.ts` (interfaz `SapAdapter` + esquema zod `OrdenCompra`) y `src/sap/mock.ts` (proveedores desde maestros; órdenes en `out/sap/ordenes.jsonl`, numeración desde 4500000001, idempotencia también en el "SAP").

## 3. Ciclo del agente
- `runTurn` (`src/core/agent.ts`): agrega el mensaje del usuario → llama `llm.enviar(system, mensajes, herramientas)` → si el modelo pide herramientas, valida los argumentos con `zod` (error de validación vuelve al modelo como `tool_result` de error), ejecuta, registra en `out/log.jsonl` y en el historial visible → repite hasta que el modelo responde sin herramientas.
- **Tope (CA1):** `MAX_ITERACIONES` (25) por turno; al alcanzarlo responde con lo hecho y lo pendiente. `MAX_TOKENS_SESION` corta el gasto por sesión; `RATE_LIMIT_POR_MINUTO` por IP; `LLM_TIMEOUT_MS` con `AbortController`.
- **Confirmación humana (CA3) en dos capas:**
  1. *Prompt*: el agente termina el turno con una pregunta y la línea `CONFIRMACIÓN REQUERIDA:`; el backend lo detecta (marcador, señal de las herramientas o pregunta de confirmación) y devuelve `needsConfirmation: true`; el front pinta el mensaje en ámbar y muestra el banner con "Sí, confirmo / No".
  2. *Guarda en el backend*: cualquier llamada con `confirmado: true` se **rechaza** si el turno anterior no pidió confirmación o si el mensaje actual del usuario no es una afirmación explícita (`core/confirmation.ts`, con negaciones que ganan: "no, todavía no"). Así la regla no depende de que el modelo obedezca. La tarjeta de la herramienta se marca "BLOQUEADA · requiere confirmación".
- **Errores (CA5):** las herramientas devuelven `{ ok:false, error }` y nunca lanzan; los errores del proveedor (timeout, permisos, throttling) se traducen a lenguaje claro, la sesión sigue y el historial mantiene la alternancia user/assistant que exigen los proveedores (probado en `tests/agent.test.ts`).
- **Trazabilidad (CA4):** cada llamada queda en el chat (nombre, argumentos, resumen, resultado expandible) y en `out/log.jsonl`.

Acción protegida: `oc_crear`. Solo crea si `apta` y (sin confirmaciones o `confirmado: true` confirmado por el usuario); cada intento deja fila en `out/control.csv`.

## 4. Elección del modelo
| | Decisión |
|---|---|
| Proveedor | **Amazon Bedrock** (Converse API) — ya disponible en la cuenta AWS; autenticación por rol IAM, sin secretos que custodiar; datos dentro de AWS. Alternativa conmutable: Anthropic API (`LLM_PROVIDER=anthropic`). |
| Modelo | **Claude Sonnet 4.5** (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), `temperature 0`. Buen uso de herramientas en español y seguimiento estricto de instrucciones; configurable por `BEDROCK_MODEL_ID` (p. ej. Haiku 4.5 para bajar costo ~3×). |
| Por qué no más barato por defecto | El riesgo del reto es que el modelo afirme valores o se salte la confirmación; se prioriza obediencia. Como las herramientas hacen el trabajo determinista, el modelo solo orquesta y redacta. |

**Costo estimado** (precio de lista Sonnet 4.5: USD 3 / M tokens de entrada, USD 15 / M de salida; verificar en la consola de Bedrock):
- Un caso ("procesa sol-004": leer, validar, payload, evidencia + resumen): ~5–6 llamadas, ~35 k tokens de entrada acumulada y ~3 k de salida ≈ **USD 0,15 por caso**; confirmación ≈ USD 0,04.

Infraestructura: 1 tarea Fargate 0.5 vCPU / 1 GB + ALB compartido de ECS Express ≈ USD 20–35/mes por reto encendido; `destroy-aws.sh` lo apaga tras la defensa.

## 5. Matriz de controles
| Regla | Implementación | Tipo | Casos |
|---|---|---|---|
| RC1 | `SapAdapter.consultarProveedor(NIT)`; sin NIT, nombre normalizado; `activo` | bloqueo | sol-002 |
| RC2 | Aprobación existe, regex "aprobad[oa]" (sin "no aprobado"), remitente ∈ aprobadores del centro | bloqueo | sol-003 (Felipe Vargas es aprobador de CC-3030, no de CC-2020) |
| RC3 | `valor_total ≤ tope` del aprobador válido | bloqueo | — (sol-003 además supera el único tope de CC-2020: se sugiere escalar) |
| RC4 | subárea ∈ centro | bloqueo | — |
| RC5 | `|cot − sol| / sol ≤ 2 %`; sin cotización → confirmación; NIT cotización ≠ solicitud | confirmación | sol-004 (26,5 M vs 25 M = 6 %; la aprobación dice "25 millones") |
| RC6 | IVA ausente → `indicador_iva_default` | confirmación + derivado | sol-006 (C1) |
| RC7 | condición ausente → default del proveedor | derivado | sol-006 (Z030) |
| RC8 | `factura.fecha < fecha_solicitud` → retroactiva | confirmación + marca | sol-005 |
| RC9 | aprobación < solicitud | confirmación | — |
| RC10 | `|cant × unit − total| ≤ 1` | bloqueo | — |
| extra | moneda ∈ COP/USD; IVA y condición deben existir en maestros; payload enviado por el modelo ≠ validado → rechazo | bloqueo | prueba de payload alterado |

Más difícil: **RC2/RC3**, porque un aprobador "real" de otro centro parece válido; se resolvió exigiendo pertenencia al centro y, si falla, calculando quién sí tiene tope para sugerir la acción. Cada bloqueo trae `accion_sugerida`.

Resultado (demo): sol-001 OC 4500000001 sin intervención; sol-002/003 bloqueadas; sol-004/005/006 piden confirmación; tras confirmar, sol-004 → 4500000002 y sol-005 → 4500000003 `retroactiva=true`; sol-001 repetida → mismo número, `idempotente: true`.

## 6. Diseño del adaptador SAP real
- **Opción elegida:** OData V2 `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA) expuesta por **SAP Integration Suite / API Management** (o SAP Cloud Connector si es on-premise). Es la API liberada para OC, con validación propia de SAP y sin RFC directo desde la nube. Si el sistema es ECC: `BAPI_PO_CREATE1` vía RFC desde un servicio intermedio en la red corporativa (SAP JCo/NCo), nunca desde el agente.
- **Mapeo:** `proveedor.codigo_sap→Supplier`, `sociedad→CompanyCode`, `organizacion_compras→PurchasingOrganization` (+ `PurchasingGroup` por configuración), `moneda→DocumentCurrency`, `condiciones_pago→PaymentTerms`, `posiciones[]→to_PurchaseOrderItem` (`numero→PurchaseOrderItem`, `descripcion→PurchaseOrderItemText`, `cantidad→OrderQuantity`, `unidad→PurchaseOrderQuantityUnit`, `precio_unitario→NetPriceAmount`, `indicador_iva→TaxCode`, `AccountAssignmentCategory="K"` con `to_AccountAssignment.CostCenter=centro_costo`), `referencia.solicitud_id→PurchaseOrder text/YourReference` (clave de idempotencia), evidencia → adjunto vía `API_CV_ATTACHMENT_SRV` con el PDF y su SHA-256. Subárea → texto de cabecera o campo de imputación (CO-PA/orden interna) según configuración.
- **Autenticación:** OAuth2 client credentials (Integration Suite) o certificado X.509; secretos en **AWS Secrets Manager** leídos por el adaptador con su rol IAM. Ni el agente ni el prompt ven credenciales; usuario técnico SAP con rol mínimo (crear OC, sin liberar).
- **Idempotencia:** antes de crear, `buscarOrdenPorReferencia` (GET filtrando por `YourReference`); además tabla de idempotencia (DynamoDB, escritura condicional por `solicitud_id`) que marca "en curso" antes de llamar a SAP. Error/timeout → reconsulta por referencia antes de reintentar (backoff). Error parcial (cabecera creada, adjunto falla) → OC queda registrada con estado `adjunto_pendiente` y una tarea reintenta solo el adjunto; si SAP rechaza el documento completo, se devuelve el mensaje de SAP como bloqueo legible y nada queda creado.
- **Plan B (si no hay conexión):** el mismo payload validado sirve para (a) una vista "lista para pegar" ordenada como la transacción ME21N con todos los campos y la evidencia PDF; (b) un archivo de carga masiva (CSV/LSMW o plantilla de "Migration Cockpit") generado por lote; (c) tras crearla a mano, la analista dicta el número y el agente lo registra en `control.csv`. El ahorro principal (validación de controles, derivados, evidencia, trazabilidad) se conserva.

## 7. Lectura del proceso — OC retroactivas
Una OC creada después de la factura no controla el gasto: lo **legaliza**. El compromiso ya se adquirió sin cotización vigente ni aprobación previa, el tope del aprobador se valida cuando ya no hay marcha atrás y se pierde poder de negociación. El caso sol-005 lo ilustra: factura del 10-ago, solicitud del 27-ago, aprobación "ya llegó la factura, por favor crear la OC".

Propuesta a la dirección: (1) **medir** — el agente marca `retroactiva` en `control.csv`; reportar mensualmente % de OC retroactivas por centro de costo y aprobador (línea base en 1 mes); (2) **política**: sin OC no se radica factura (*no PO, no pay*) para proveedores recurrentes, con excepción formal solo para urgencias aprobadas por un nivel superior; (3) **facilitar el camino correcto**: el agente reduce la creación de OC a minutos, así que el argumento de "no hay tiempo" desaparece; (4) contratos marco/OC abiertas para gastos recurrentes (papelería, licencias) que hoy generan retroactivas. Meta sugerida: < 5 % retroactivas en 6 meses. La decisión de tolerarlas con marca o rechazarlas sigue siendo de la dirección; el agente las mide.

## 8. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Los controles se ejecutan siempre sobre la lectura canónica del caso; `paquete`/`payload` del modelo se comparan, no se usan | Confiar en el JSON que manda el modelo | Riesgo del PRD: que el modelo "arregle" un monto. Payload alterado → rechazo y fila en control |
| La OC usa los valores de la **solicitud** (aprobados); la cotización solo se contrasta (RC5) | Usar la cotización | El aprobador aprobó la solicitud ("por 25 millones") |
| `oc_crear` revalida y es idempotente por `solicitud_id` en dos niveles (herramienta y mock SAP) | Confiar en `apta` de una llamada previa | Reintentos del modelo no duplican OC |
| Unidad derivada del ítem de la cotización (Hora→H) | Pedirla siempre | Es trazable (`trazabilidad.json`) y evita una pregunta |
| SHA-256 del texto normalizado del correo de aprobación en el payload | Hash del PDF | El PDF lleva metadatos; el texto es reproducible y verificable (prueba lo recalcula) |

## 9. Supuestos
- Un ítem por solicitud (fixtures); el esquema soporta N posiciones.
- `fecha` de creación de la OC = fecha de referencia (determinista en la demo).
- Validez de la cotización se informa (`validez_hasta`) pero no bloquea.
- sol-003 se reporta como RC2 (aprobador fuera del centro); RC3 no se evalúa sin aprobador válido, pero la acción sugerida indica que ningún aprobador de CC-2020 tiene tope para 74 M.

## 10. Cobertura
| HU | Estado | Falta para producción |
|---|---|---|
| HU-1 Leer paquete | Hecho (JSON/TXT normalizados); `oc_leer_excel` P1 no hecho | Lectura de .xlsx/.pdf/.eml reales |
| HU-2 Validar | Hecho RC1–RC10 | Maestros en tiempo real desde SAP |
| HU-3 Payload | Hecho (zod + trazabilidad) | Campos de configuración SAP (grupo de compras, centro logístico) |
| HU-4 Evidencia | Hecho txt (P0) y pdf (P1) | Adjuntar a la OC real |
| HU-5 Crear | Hecho (idempotente, control.csv) | Adaptador OData/BAPI (sección 6) |
| HU-6 Errores | Hecho (JSON malformado, monto no numérico, caso inexistente, con acción sugerida) | — |
| Bonus módulo | Hecho | — |

Pruebas: `bun test` → 26 pruebas (matriz completa por caso, idempotencia, payload alterado, sha verificable, control.csv, guarda). `tsc --strict` limpio.

## 11. Uso de IA
| Asistente | Para qué | Qué descarté y por qué |
|---|---|---|
| Claude (Anthropic) como asistente de código | Estructura del proyecto, borradores de herramientas, pruebas, front y documentación; revisé y ajusté cada archivo y corrí `demo.ts`, `bun test` y `tsc --strict` | **App Runner** como destino (AWS dejó de aceptar clientes nuevos desde el 30-abr-2026) → ECS Express Mode. **exceljs** (dependencia pesada) → escritor OOXML propio de ~90 líneas con jszip. Extraer valores con el modelo → extracción determinista con confianza. Un mapeo difuso al 0.5 que proponía "Número de cuenta" para "Número de contribuyente especial" → umbral 0.7 y el campo queda `faltante`. |

Puedo explicar cada línea: la plataforma (`src/core`, `src/llm`, `web`) es la misma en los tres retos y lo específico vive en `src/tools`, `src/knowledge` y `agent/prompt.md`.

## 12. Riesgos
| Riesgo | Mitigación |
|---|---|
| Conexión SAP no viable | Plan B (sección 6) |
| Maestros desactualizados | Consultar SAP en línea vía adaptador |
| Correo de aprobación falsificado | Validar cabeceras DKIM/remitente interno; firma digital si auditoría lo exige |
| Doble creación por reintentos | Idempotencia en dos niveles + referencia en SAP |
| Modelo altera montos | Revalidación canónica y rechazo de payload alterado |

`modulo/` (bonus): `agent.md` (frontmatter `description`, `mode: primary`, `permission {edit: deny, bash: deny}` + el mismo `agent/prompt.md`), `tools/oc.ts` (re-export de `src/tools/oc.ts`, no una copia) y `skill/<nombre>/SKILL.md` (el mismo `src/knowledge/<nombre>.md`). Se regenera con `bun run build:modulo` y `tests/modulo.test.ts` falla si diverge.
