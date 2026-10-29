---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia en SAP (paquete de compra, controles RC1–RC10, evidencia y log de control).
---
## Proceso
Cada compra llega por correo con solicitud (Excel), cotización (PDF) y correo de aprobación del líder. La analista crea la OC en SAP y adjunta la aprobación en PDF. Desvío conocido: muchas OC se crean después de la factura (retroactivas), saltándose la cotización.

## Controles
| Regla | Qué valida | Tipo |
|---|---|---|
| RC1 | proveedor existe (por NIT; si no, por nombre) y está activo | bloqueo |
| RC2 | aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo | bloqueo |
| RC3 | valor_total ≤ tope del aprobador | bloqueo |
| RC4 | subárea pertenece al centro de costo | bloqueo |
| RC5 | cotización vs solicitud ≤ 2 % (sin cotización también confirma) | confirmación |
| RC6 | IVA ausente → se deriva del proveedor | confirmación + derivado |
| RC7 | condición de pago ausente → se deriva del proveedor | derivado informativo |
| RC8 | factura anterior a la solicitud → retroactiva | confirmación + marca |
| RC9 | aprobación anterior a la solicitud | confirmación |
| RC10 | cantidad × valor unitario = total (± 1) | bloqueo |

## Payload SAP
Sociedad y organización de compras "1000"; descripción ≤ 40 caracteres; unidad UN/H/MES (de la cotización); posiciones 10, 20…; la OC usa los valores de la solicitud (la cotización solo se contrasta). Cada campo es trazable en `out/<caso>/trazabilidad.json`.

## Evidencia y control
- `out/<caso>/aprobacion.txt` (+ `.pdf`) con SHA-256 del texto; el hash va en `aprobador.evidencia_sha256`.
- `oc_crear` es idempotente por solicitud_id. Números desde 4500000001.
- `out/control.csv`: una fila por intento (creada, idempotente, bloqueada, pendiente_confirmacion, rechazada_payload_alterado).
