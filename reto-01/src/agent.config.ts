import * as proveedor from "./tools/proveedor"

export const agentConfig = {
  id: "reto-01",
  titulo: "Agente · Registro como Proveedor",
  subtitulo: "Lee la solicitud, llena el formulario desde el maestro y arma el paquete para firma",
  toolModules: { proveedor } as Record<string, Record<string, unknown>>,
  perCaseLog: true,
  ejemplos: [
    'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.',
    'Procesa el caso "co-industrias-delta" con fecha de ejecución 2026-09-03 y arma el paquete.',
    "¿Qué casos hay pendientes? Procesa el de Honduras.",
    'Procesa el caso "pa-logistica-istmo".',
  ],
}
