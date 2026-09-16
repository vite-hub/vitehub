import { expectTypeOf, it } from "vitest"
import { codexDriver, defineAgent, defineCapability, runAgentInline } from "../src/index.ts"
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

it("exposes only the outer configuration when configure returns a configured Agent", () => {
  const inner = defineAgent({ options: { inner: true }, configure: () => defineAgent({ driver: "codex", workspace: {} }) })
  const outer = defineAgent({ options: { outer: true }, configure: () => defineAgent({ extends: inner }) })
  expectTypeOf(outer.options.outer).toEqualTypeOf<boolean>()
  expectTypeOf(outer.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  // @ts-expect-error The outer preset replaces the inner option contract.
  void outer.options.inner
  // @ts-expect-error Inner options cannot be passed to the outer preset.
  defineAgent({ extends: outer, options: { inner: false } })
})

it("infers Workspace access contributed to configured presets", () => {
  const plain = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: "codex" }) })
  const capability = defineCapability({ id: "workspace", workspace: {} })
  const selected = defineAgent({ preset: "plain", presets: { plain }, capabilities: [capability] })
  expectTypeOf(selected.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  expectTypeOf(selected.options.enabled).toEqualTypeOf<boolean>()
  const extended = defineAgent({ extends: plain, capabilities: [capability] })
  expectTypeOf(extended.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const channel = defineAgent({ preset: "plain", presets: { plain }, channels: { custom: { kind: "custom", capabilities: [capability] } } })
  expectTypeOf(channel.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const child = defineAgent({ extends: channel, options: { enabled: false } })
  expectTypeOf(child.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const noWorkspace = defineCapability({ id: "plain", metadata: {} })
  const unchanged = defineAgent({ extends: plain, capabilities: [noWorkspace] })
  // @ts-expect-error Capabilities without Workspace access do not promote the definition.
  void unchanged.__vitehubWorkspaceAgent
})

it("accepts interface options and rejects non-record roots", () => {
  interface PresetOptions { enabled: boolean }
  const options: PresetOptions = { enabled: true }
  const preset = defineAgent({ options, configure: value => {
    expectTypeOf(value).toEqualTypeOf<PresetOptions>()
    return defineAgent({ driver: "codex" })
  } })
  expectTypeOf(defineAgent({ extends: preset, options: { enabled: false } }).options.enabled).toEqualTypeOf<boolean>()
  // @ts-expect-error The root options value must be a record, not an array.
  defineAgent({ options: [], configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Callback values may only be nested in a record.
  defineAgent({ options: () => true, configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Built-in instances may only be nested in a record.
  defineAgent({ options: new Date(), configure: () => defineAgent({ driver: "codex" }) })
})

it("rejects option unions with non-record members and accepts record unions", () => {
  type RecordOptions = { enabled: boolean }
  function checkOptions(
    dateOptions: RecordOptions | Date,
    arrayOptions: RecordOptions | readonly string[],
    callbackOptions: RecordOptions | (() => boolean),
    recordOptions: RecordOptions | { mode: string },
  ) {
    // @ts-expect-error Every union member must be a record, excluding Date roots.
    defineAgent({ options: dateOptions, configure: () => defineAgent({ driver: "codex" }) })
    // @ts-expect-error Every union member must be a record, excluding array roots.
    defineAgent({ options: arrayOptions, configure: () => defineAgent({ driver: "codex" }) })
    // @ts-expect-error Every union member must be a record, excluding callback roots.
    defineAgent({ options: callbackOptions, configure: () => defineAgent({ driver: "codex" }) })
    defineAgent({ options: recordOptions, configure: value => {
      expectTypeOf(value).toEqualTypeOf<RecordOptions | { mode: string }>()
      return defineAgent({ driver: "codex" })
    } })
  }
  void checkOptions
})

it("recomputes contributed Workspace types after channel and capability replacement", () => {
  const plain = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: "codex" }) })
  const workspaceCapability = defineCapability({ id: "workspace", workspace: {} })
  const replacementCapability = defineCapability({ id: "workspace", metadata: {} })
  const channel = defineAgent({ extends: plain, channels: { custom: { kind: "custom", capabilities: [workspaceCapability] } } })
  const removedChannel = defineAgent({ extends: channel, channels: { custom: { kind: "custom" } } })
  // @ts-expect-error Replacing the only contributing channel removes Workspace access.
  void removedChannel.__vitehubWorkspaceAgent
  const capability = defineAgent({ extends: plain, capabilities: [workspaceCapability] })
  const removedCapability = defineAgent({ preset: "capability", presets: { capability }, capabilities: [replacementCapability] })
  // @ts-expect-error Replacing the only contributing capability removes Workspace access.
  void removedCapability.__vitehubWorkspaceAgent
  const retainedChannel = defineAgent({ extends: channel, channels: { other: { kind: "custom" } } })
  expectTypeOf(retainedChannel.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const otherCapability = defineCapability({ id: "other", metadata: {} })
  const retainedCapability = defineAgent({ extends: capability, capabilities: [otherCapability] })
  expectTypeOf(retainedCapability.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const explicit = defineAgent({ extends: channel, workspace: {} })
  const retainedExplicit = defineAgent({ extends: explicit, channels: { custom: { kind: "custom" } } })
  expectTypeOf(retainedExplicit.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const baseWorkspace = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", workspace: {} }) })
  const retainedBase = defineAgent({ extends: baseWorkspace, channels: {}, capabilities: [] })
  expectTypeOf(retainedBase.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
})

it("removes Workspace contributed by a configured callback result", () => {
  const plain = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex" }) })
  const capability = defineCapability({ id: "workspace", workspace: {} })
  const preset = defineAgent({ options: { enabled: true }, configure: () => defineAgent({
    extends: plain, channels: { custom: { kind: "custom", capabilities: [capability] } },
  }) })
  expectTypeOf(preset.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const child = defineAgent({ extends: preset, channels: { custom: { kind: "custom" } } })
  // @ts-expect-error The callback's only Workspace contribution was replaced.
  void child.__vitehubWorkspaceAgent
})

it("recomputes Workspace contributions returned directly by configure", () => {
  const capability = defineCapability({ id: "workspace", workspace: {} })
  const replacement = defineCapability({ id: "workspace", metadata: {} })
  const capabilityPreset = defineAgent({ options: {}, configure: () => defineAgent({
    driver: "codex", capabilities: [capability],
  }) })
  expectTypeOf(capabilityPreset.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const replacedCapability = defineAgent({ extends: capabilityPreset, capabilities: [replacement] })
  // @ts-expect-error Replacing the callback's only Capability removes Workspace access.
  void replacedCapability.__vitehubWorkspaceAgent
  const customPreset = defineAgent({ options: {}, configure: () => defineAgent({
    driver: { run: () => ({ text: "custom" }) }, capabilities: [capability],
  }) })
  expectTypeOf(customPreset.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const replacedCustom = defineAgent({ extends: customPreset, capabilities: [replacement] })
  // @ts-expect-error Custom Drivers use the same Capability replacement contract.
  void replacedCustom.__vitehubWorkspaceAgent
  const channelPreset = defineAgent({ options: {}, configure: () => defineAgent({
    driver: "codex", channels: { custom: { kind: "custom", capabilities: [capability] } },
  }) })
  expectTypeOf(channelPreset.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const replacedChannel = defineAgent({ preset: "channel", presets: { channel: channelPreset }, channels: { custom: { kind: "custom" } } })
  // @ts-expect-error Replacing the callback's only Channel removes Workspace access.
  void replacedChannel.__vitehubWorkspaceAgent
  const retained = defineAgent({ extends: channelPreset, channels: { other: { kind: "custom" } } })
  expectTypeOf(retained.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const explicitPreset = defineAgent({ options: {}, configure: () => defineAgent({
    driver: "codex", workspace: {}, capabilities: [capability],
  }) })
  const explicit = defineAgent({ extends: explicitPreset, capabilities: [replacement] })
  expectTypeOf(explicit.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
})

it("replaces the whole Capability value when either layer uses a resolver", () => {
  const workspace = defineCapability({ id: "workspace", workspace: {} })
  const plain = defineCapability({ id: "plain", metadata: {} })
  const preset = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", capabilities: [workspace] }) })
  const retained = defineAgent({ extends: preset, capabilities: [] })
  expectTypeOf(retained.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const replaced = defineAgent({ extends: preset, capabilities: () => [plain] })
  // @ts-expect-error A resolver replaces all inherited Capabilities regardless of ID.
  void replaced.__vitehubWorkspaceAgent
  const asyncReplaced = defineAgent({ preset: "base", presets: { base: preset }, capabilities: async () => [plain] })
  // @ts-expect-error Async resolvers use the same whole-value replacement.
  void asyncReplaced.__vitehubWorkspaceAgent
  const resolver = defineAgent({ extends: preset, capabilities: () => [workspace] })
  // @ts-expect-error Resolver results do not statically promote the definition.
  void resolver.__vitehubWorkspaceAgent
  const unchanged = defineAgent({ extends: resolver })
  // @ts-expect-error Preserving a resolver does not restore removed Workspace access.
  void unchanged.__vitehubWorkspaceAgent
  const array = defineAgent({ extends: unchanged, capabilities: [plain] })
  // @ts-expect-error A static list replaces an inherited resolver instead of merging IDs.
  void array.__vitehubWorkspaceAgent
  const explicit = defineAgent({ extends: preset, workspace: {}, capabilities: () => [plain] })
  expectTypeOf(explicit.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
})
