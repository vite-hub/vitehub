import { expectTypeOf, it } from "vitest"
import { codexDriver, defineAgent, runAgentInline } from "../src/index.ts"
import type { AgentRuntimeContext } from "../src/index.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

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

it("types preset options, nested overrides and chained definitions", () => {
  const preset = defineAgent({
    options: { autoMerge: false, filter: {} as { author?: { allow?: string[] }, when?: (value: string) => boolean } },
    configure: options => {
      expectTypeOf(options.autoMerge).toEqualTypeOf<boolean>()
      return defineAgent({ driver: "codex", workspace: {} })
    },
  })
  const configured = defineAgent({ preset: "repair", presets: { repair: preset, plain: defineAgent({ driver: "codex" }) }, options: { autoMerge: true, filter: { author: { allow: ["me"] } } } })
  // @ts-expect-error A configured registry still rejects missing names.
  defineAgent({ preset: "missing", presets: { repair: preset }, options: {} })
  expectTypeOf(configured.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const child = defineAgent({ extends: configured, options: { autoMerge: false } })
  expectTypeOf(child.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  // @ts-expect-error Option names come from the preset.
  defineAgent({ preset: "repair", presets: { repair: preset }, options: { repairs: true } })
  // @ts-expect-error Nested options retain the declared types.
  defineAgent({ extends: child, options: { filter: { author: { allow: "me" } } } })
  // @ts-expect-error Callbacks retain their parameter types.
  defineAgent({ extends: child, options: { filter: { when: (value: number) => value > 0 } } })
  // @ts-expect-error A configure callback must return a definition.
  defineAgent({ options: {}, configure: () => ({ driver: "codex" }) })
})

it("preserves workspace overrides on configurable presets", () => {
  const plain = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: "codex" }) })
  const workspace = defineAgent({ preset: "plain", presets: { plain }, workspace: {}, options: { enabled: false } })
  expectTypeOf(workspace.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  expectTypeOf(workspace.options.enabled).toEqualTypeOf<boolean>()
  const child = defineAgent({ extends: workspace, workspace: { mode: "read" }, options: { enabled: true } })
  expectTypeOf(child.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
})

it("preserves structured output from configure through selection and extension", () => {
  const schema = {} as StandardSchemaV1<unknown, { summary: string }>
  const preset = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: codexDriver({ output: { schema } }) }) })
  const selected = defineAgent({ preset: "notes", presets: { notes: preset }, options: { enabled: false } })
  const extended = defineAgent({ extends: selected, workspace: {}, hooks: { "agent:finish": event => {
    expectTypeOf(event.result).toEqualTypeOf<{ summary: string } | undefined>()
  } } })
  expectTypeOf(runAgentInline(extended, {} as AgentRuntimeContext, {})).resolves.toEqualTypeOf<Response | { summary: string }>()
})
