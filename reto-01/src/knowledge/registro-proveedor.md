---
name: registro-proveedor
description: Conocimiento del proceso de registro de Periferia como proveedor ante clientes (Colombia, Ecuador, Perú, Panamá, Honduras).
---
## Proceso
- Volumen: 8–12 solicitudes al mes, llegan por correo a recepción.
- Formatos de salida: plantilla Excel (celdas exactas), formulario PDF (campos en orden) o portal web (no se automatiza: el humano ingresa credenciales y hace clic en "Enviar").
- Cierre: firma del representante legal (humana). El agente prepara; el humano decide.

## Identificador tributario por país
| País | Nombre | Nota |
|---|---|---|
| CO | NIT | Periferia tiene NIT colombiano con dígito de verificación |
| EC, PE, PA | RUC | Se llena con el NIT y queda `requiere_confirmacion` ("identificador extranjero") |
| HN | RTN | Igual que RUC |

## Estados de un campo
- `lleno`: valor leído del maestro (con su ruta).
- `faltante`: no existe en el glosario/maestro o no tiene valor. No bloquea la firma pero va en el checklist.
- `requiere_confirmacion`: mapeo con confianza < 0.8, etiqueta ambigua o regla de país.

## Soportes
- Tipos: camara_comercio (vigencia 30 días), rut, certificacion_bancaria, parafiscales, estados_financieros, certificado_iso_9001.
- `vencido` (vigencia_hasta < fecha de ejecución) o `ausente` bloquean `listo_para_firma`.
- Todos los soportes los emite Colombia; si el cliente es de otro país se advierte validar su aceptación.

## Salidas en out/<caso>/
formulario.xlsx | formulario.pdf | valores-portal.md, mapeo.json, log.jsonl, paquete/ (formulario, soportes/, checklist.md, borrador-correo.md) y ENVIO-SIMULADO.md solo tras confirmación.
