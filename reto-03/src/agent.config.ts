import * as oc from "./tools/oc"

export const agentConfig = {
  id: "reto-03",
  titulo: "Agente · Órdenes de Compra SAP",
  subtitulo: "Lee el paquete de compra, valida controles RC1–RC10 y crea la OC en un SAP simulado",
  toolModules: { oc } as Record<string, Record<string, unknown>>,
  perCaseLog: true,
  ejemplos: [
    'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
    'Procesa la solicitud "sol-001" y crea la OC si pasa todos los controles.',
    "Revisa sol-002 y sol-003: ¿por qué no se pueden crear?",
    'Procesa "sol-005". ¿Es retroactiva?',
  ],
}
