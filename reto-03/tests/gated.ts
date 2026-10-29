export const gated = {
  name: "oc_crear",
  args: { caso: "sol-004" },
  prepare: [{ name: "oc_validar", args: { caso: "sol-004" } }],
  firstMessage: "Procesa sol-004",
  expectOkAfterConfirm: true,
}
