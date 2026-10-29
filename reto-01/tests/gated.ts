export const gated = {
  name: "proveedor_simular_envio",
  args: { caso: "co-industrias-delta" },
  prepare: [{ name: "proveedor_armar_paquete", args: { caso: "co-industrias-delta", fecha_ejecucion: "2026-09-03" } }],
  firstMessage: "Procesa co-industrias-delta",
  expectOkAfterConfirm: true,
}
