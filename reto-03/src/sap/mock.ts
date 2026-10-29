import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fechaReferencia } from "../core/fecha"
import { writeOut } from "../core/files"
import { OrdenCompraSchema, type OrdenCompra, type SapAdapter } from "./adapter"

type Registro = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }
const PRIMER_NUMERO = 4500000001

/** SAP simulado: maestro de proveedores desde fixtures y órdenes en out/sap/ordenes.jsonl. */
export class SapMock implements SapAdapter {
  constructor(private readonly root: string) {}

  private get archivo(): string {
    return join(this.root, "out", "sap", "ordenes.jsonl")
  }

  private ordenes(): Registro[] {
    if (!existsSync(this.archivo)) return []
    return readFileSync(this.archivo, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const lista = JSON.parse(readFileSync(join(this.root, "fixtures", "reto-03", "maestros", "proveedores.json"), "utf8")) as Array<{ nit: string; codigo_sap: string; activo: boolean }>
    const p = lista.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = this.ordenes().find((o) => o.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const valida = OrdenCompraSchema.parse(orden)
    const existentes = this.ordenes()
    const previa = existentes.find((o) => o.solicitud_id === valida.referencia.solicitud_id)
    if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha } // idempotencia también en el "SAP"
    const numero_oc = String(PRIMER_NUMERO + existentes.length)
    const fecha = fechaReferencia()
    const prev = existsSync(this.archivo) ? readFileSync(this.archivo, "utf8") : ""
    writeOut(this.archivo, `${prev}${JSON.stringify({ numero_oc, fecha, solicitud_id: valida.referencia.solicitud_id, orden: valida })}\n`)
    return { numero_oc, fecha }
  }
}
