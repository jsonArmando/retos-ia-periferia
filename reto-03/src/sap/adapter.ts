import { z } from "zod/v4"

/** Payload de la OC (sección 7.4), validado con zod antes de llegar a cualquier adaptador SAP. */
export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string().min(1), correo_id: z.string().min(1), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().regex(/^Z\d{3}$/),
  aprobador: z.object({ email: z.email(), fecha_aprobacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive().multipleOf(10),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

/** Interfaz obligatoria (7.4). mock.ts la implementa sobre out/sap/; producción la implementaría sobre OData/BAPI. */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
