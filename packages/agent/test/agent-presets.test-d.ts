import { expectTypeOf, it } from "vitest"
import { defineAgent } from "../src/index.ts"

it("infers the selected preset and rejects unknown names", () => {
  const notes = defineAgent({ driver: "codex", workspace: {} })
  const other = defineAgent({ driver: { run: () => ({ text: "other" }) } })
  const agent = defineAgent({ preset: "notes", presets: { notes, other }, driver: { model: "custom" } })
  expectTypeOf(agent.__vitehubWorkspaceAgent).toEqualTypeOf<true>()

  // @ts-expect-error The selected name must exist in the local registry.
  defineAgent({ preset: "missing", presets: { notes } })
  // @ts-expect-error Presets must be Agent Definitions.
  defineAgent({ preset: "notes", presets: { notes: { driver: "codex" } } })
  // @ts-expect-error The composition has exactly one parent.
  defineAgent({ preset: "notes", presets: { notes }, extends: notes })
})
