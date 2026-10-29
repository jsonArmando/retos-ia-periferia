import * as contratos from "./tools/contratos"

export const agentConfig = {
  id: "reto-02",
  titulo: "Agente · Registro de Contratos Vigentes",
  subtitulo: "Punto único de recepción: clasifica correos, extrae contratos, alimenta el maestro y alerta vencimientos",
  toolModules: { contratos } as Record<string, Record<string, unknown>>,
  perCaseLog: false,
  ejemplos: [
    "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.",
    "¿Qué mensajes hay pendientes en el buzón?",
    "Genera el reporte de alertas con fecha 2026-09-03.",
  ],
}
