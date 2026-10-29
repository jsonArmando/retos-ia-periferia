export const gated = {
  name: "contratos_registrar",
  args: { mensaje_id: "msg-006" },
  prepare: [{ name: "contratos_validar", args: { mensaje_id: "msg-006" } }],
  firstMessage: "Procesa msg-006",
  expectOkAfterConfirm: true,
}
