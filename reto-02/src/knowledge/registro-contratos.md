---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia (buzón único, maestro en SharePoint, pólizas y alertas).
---
## Contexto
- El maestro (Excel en SharePoint) quedó congelado el 2026-05-30. Hoy solo llegan contratos con póliza; el objetivo es registrar TODOS.
- Simulación: SharePoint = `out/sharepoint/`; el maestro se copia desde el fixture (solo lectura) en la primera ejecución.

## Clasificación
| Clase | Regla |
|---|---|
| duplicado | mismo id_contrato con mismo valor, fecha_inicio y fecha_fin → no se escribe |
| actualizacion | mismo id (o mismo NIT + objeto con similitud ≥ 0.9) con algún cambio, u otrosí → se actualiza la fila y se registra en historial.jsonl |
| nuevo | sin coincidencia → se inserta |
| rechazado | sin adjunto de contrato (cotizaciones, preguntas) o sin partes/objeto identificables |

## Campos y confianza
- Umbral 0.8: por debajo el campo va a `requiere_revision` y el registro exige `confirmado = true`.
- Valor por demanda (contrato marco) → valor 0, `valor_indeterminado`, confianza 0.6.
- Plazo en meses sin fecha de inicio explícita → se deriva de la firma; si la firma no tiene día, se asume el último día posible (confianza 0.6).
- NIT sin puntos ni dígito de verificación. País: NIT→CO, RTN→HN, RUC de 13 dígitos→EC, de 11→PE.
- Póliza: nuevo con póliza → `pendiente`; sin póliza → `no_aplica`. Un otrosí que obliga a ampliar garantías pasa la póliza a `pendiente`.
- Remitente fuera de comerciales.json: se reporta, no bloquea.

## Archivo
`out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`; los otrosíes como `<id>-otrosi-<n>.<ext>`.

## Alertas (out/alertas.md)
1. Vencen en ≤ 60 días. 2. requiere_poliza = true y estado_poliza ≠ vigente. 3. Registrados/actualizados desde el corte 2026-05-30.
