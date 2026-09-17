import { expectTypeOf, it } from "vitest"
import { codexDriver, defineAgent, defineCapability, runAgentInline } from "../src/index.ts"
import { github } from "../src/channels.ts"
import type { AgentRuntimeContext, WorkspaceAgentWorkspaceConfig } from "../src/index.ts"
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

it("does not guarantee Workspace access from optional configured preset overrides", () => {
  const plain = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex" }) })
  const workspaceCapability = defineCapability({ id: "workspace", workspace: {} })
  function checkWorkspace(workspace: WorkspaceAgentWorkspaceConfig | undefined) {
    const extended = defineAgent({ extends: plain, workspace })
    const selected = defineAgent({ preset: "plain", presets: { plain }, workspace })
    // @ts-expect-error An optional Workspace override may leave the definition without Workspace access.
    void extended.__vitehubWorkspaceAgent
    // @ts-expect-error Named selection preserves the same uncertainty.
    void selected.__vitehubWorkspaceAgent
    const child = defineAgent({ extends: extended })
    // @ts-expect-error Extending the uncertain definition does not guarantee Workspace access.
    void child.__vitehubWorkspaceAgent
    const explicit = defineAgent({ extends: extended, workspace: {} })
    expectTypeOf(explicit.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
    const inherited = defineAgent({ extends: explicit, workspace })
    expectTypeOf(inherited.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
    const contributed = defineAgent({ extends: extended, capabilities: [workspaceCapability] })
    expectTypeOf(contributed.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
    // @ts-expect-error Inferring the Workspace property must not accept unknown settings.
    defineAgent({ extends: plain, workspace, unknownSetting: true })
  }
  void checkWorkspace
  function checkOptionalProperty(settings: { workspace?: WorkspaceAgentWorkspaceConfig }) {
    const extended = defineAgent({ extends: plain, ...settings })
    const selected = defineAgent({ preset: "plain", presets: { plain }, ...settings })
    // @ts-expect-error An optional property may be absent.
    void extended.__vitehubWorkspaceAgent
    // @ts-expect-error Named selection also accepts optional properties without promising Workspace access.
    void selected.__vitehubWorkspaceAgent
  }
  void checkOptionalProperty
})

it("rejects unsupported settings in every union spread member", () => {
  const plain = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: "codex" }) })
  function checkSettings(settings: { workspace?: WorkspaceAgentWorkspaceConfig } | { unknownSetting: true }) {
    // @ts-expect-error A possible spread member contains an unsupported Agent setting.
    defineAgent({ extends: plain, ...settings })
    // @ts-expect-error Named selection validates every possible spread member too.
    defineAgent({ preset: "plain", presets: { plain }, ...settings })
  }
  void checkSettings
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

it("preserves built-in GitHub Workspace contributions through configured extensions", () => {
  const plain = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: "codex" }) })
  const extended = defineAgent({ extends: plain, channels: { github: github({ pullRequest: true }) } })
  expectTypeOf(extended.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const selected = defineAgent({ preset: "plain", presets: { plain }, channels: { github: () => github({ pullRequest: {} }) } })
  expectTypeOf(selected.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const configured = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", channels: { github: github({ pullRequest: { workspace: { mount: "repo" } } }) } }) })
  expectTypeOf(defineAgent({ extends: configured }).__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const disabled = defineAgent({ extends: extended, channels: { github: github({ pullRequest: { workspace: false } }) } })
  // @ts-expect-error Replacing the contributing Channel with disabled Workspace access removes it.
  void disabled.__vitehubWorkspaceAgent
  const noPullRequest = defineAgent({ extends: plain, channels: { github: github() } })
  // @ts-expect-error A GitHub Channel without pullRequest does not contribute a Workspace.
  void noPullRequest.__vitehubWorkspaceAgent
  const disabledPullRequest = defineAgent({ extends: plain, channels: { github: github({ pullRequest: false }) } })
  // @ts-expect-error A disabled pullRequest Channel does not contribute a Workspace.
  void disabledPullRequest.__vitehubWorkspaceAgent
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
  // @ts-expect-error Promise roots are not plain option records.
  defineAgent({ options: Promise.resolve({ enabled: true }), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Callback values may only be nested in a record.
  defineAgent({ options: () => true, configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error WeakMap roots are not plain option records.
  defineAgent({ options: new WeakMap(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error WeakSet roots are not plain option records.
  defineAgent({ options: new WeakSet(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Error roots are not plain option records.
  defineAgent({ options: new Error(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error AbortController roots are not plain option records.
  defineAgent({ options: new AbortController(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error AbortSignal roots are not plain option records.
  defineAgent({ options: new AbortController().signal, configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Blob roots are not plain option records.
  defineAgent({ options: new Blob([]), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error File roots inherit Blob and are not plain option records.
  defineAgent({ options: new File([], "input"), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Request roots are not plain option records.
  defineAgent({ options: new Request("https://example.com"), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Response roots are not plain option records.
  defineAgent({ options: new Response(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error Headers roots are not plain option records.
  defineAgent({ options: new Headers(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error FormData roots are not plain option records.
  defineAgent({ options: new FormData(), configure: () => defineAgent({ driver: "codex" }) })
  // @ts-expect-error URLSearchParams roots are not plain option records.
  defineAgent({ options: new URLSearchParams(), configure: () => defineAgent({ driver: "codex" }) })
  defineAgent({ options: { headers: new Headers(), form: new FormData(), blob: new Blob([]), request: new Request("https://example.com"), response: new Response() }, configure: value => {
    expectTypeOf(value.request).toEqualTypeOf<Request>()
    expectTypeOf(value.response).toEqualTypeOf<Response>()
    expectTypeOf(value.blob).toEqualTypeOf<Blob>()
    expectTypeOf(value.headers).toEqualTypeOf<Headers>()
    expectTypeOf(value.form).toEqualTypeOf<FormData>()
    return defineAgent({ driver: "codex" })
  } })
  // @ts-expect-error Built-in instances may only be nested in a record.
  defineAgent({ options: new Date(), configure: () => defineAgent({ driver: "codex" }) })
})

it("rejects option unions with non-record members and accepts record unions", () => {
  type RecordOptions = { enabled: boolean }
  function checkOptions(
    dateOptions: RecordOptions | Date,
    controllerOptions: RecordOptions | AbortController,
    headersOptions: RecordOptions | Headers,
    formOptions: RecordOptions | FormData,
    arrayOptions: RecordOptions | readonly string[],
    callbackOptions: RecordOptions | (() => boolean),
    recordOptions: RecordOptions | { mode: string },
  ) {
    // @ts-expect-error Every union member must be a record, excluding AbortController roots.
    defineAgent({ options: controllerOptions, configure: () => defineAgent({ driver: "codex" }) })
    // @ts-expect-error Every union member must be a record, excluding Headers roots.
    defineAgent({ options: headersOptions, configure: () => defineAgent({ driver: "codex" }) })
    // @ts-expect-error Every union member must be a record, excluding FormData roots.
    defineAgent({ options: formOptions, configure: () => defineAgent({ driver: "codex" }) })
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

it("requires complete method-bearing option values", () => {
  class Client {
    constructor(public endpoint: string) {}
    connect() { return this.endpoint }
  }
  const preset = defineAgent({
    options: { client: new Client("default"), nested: { client: new Client("nested"), enabled: true }, callback: (): boolean => true },
    configure: options => {
      expectTypeOf(options.client.connect()).toEqualTypeOf<string>()
      return defineAgent({ driver: "codex" })
    },
  })
  defineAgent({ extends: preset, options: { client: new Client("override") } })
  defineAgent({ extends: preset, options: { nested: { client: new Client("override") } } })
  defineAgent({ extends: preset, options: { callback: () => false } })
  // @ts-expect-error Class replacements must include their methods.
  defineAgent({ extends: preset, options: { client: { endpoint: "override" } } })
  // @ts-expect-error Nested class replacements must include their methods.
  defineAgent({ extends: preset, options: { nested: { client: { endpoint: "override" } } } })
  // @ts-expect-error Named preset selection uses the same complete instance contract.
  defineAgent({ preset: "client", presets: { client: preset }, options: { client: { endpoint: "override" } } })
})

it("does not retain Workspace access when widened Capability IDs can overlap", () => {
  const id: string = "workspace"
  const workspace = defineCapability({ id, workspace: {} })
  const plain = defineCapability({ id: "workspace", metadata: {} })
  const preset = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", capabilities: [workspace] }) })
  expectTypeOf(preset.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const replaced = defineAgent({ extends: preset, capabilities: [plain] })
  // @ts-expect-error The literal child ID can replace the widened parent ID.
  void replaced.__vitehubWorkspaceAgent
  const named = defineAgent({ preset: "base", presets: { base: preset }, capabilities: [plain] })
  // @ts-expect-error Named selection uses the same conservative replacement rule.
  void named.__vitehubWorkspaceAgent
  const retained = defineAgent({ extends: preset, capabilities: [] })
  expectTypeOf(retained.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const explicit = defineAgent({ extends: preset, workspace: {}, capabilities: [plain] })
  expectTypeOf(explicit.__vitehubWorkspaceAgent).toEqualTypeOf<true>()

  const unionWorkspace = defineCapability({ id: id as "workspace" | "other", workspace: {} })
  const unionPreset = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", capabilities: [unionWorkspace] }) })
  const unionReplaced = defineAgent({ extends: unionPreset, capabilities: [plain] })
  // @ts-expect-error A partially overlapping ID union cannot guarantee Workspace access.
  void unionReplaced.__vitehubWorkspaceAgent
  const unrelated = defineCapability({ id: "unrelated", metadata: {} })
  const disjoint = defineAgent({ extends: unionPreset, capabilities: [unrelated] })
  expectTypeOf(disjoint.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
})

it("removes Workspace access for equal branded and enum Capability IDs", () => {
  const workspace = defineCapability({ id: "workspace" as string & { brand: "parent" }, workspace: {} })
  const plain = defineCapability({ id: "workspace" as string & { brand: "child" }, metadata: {} })
  const preset = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", capabilities: [workspace] }) })
  const replaced = defineAgent({ extends: preset, capabilities: [plain] })
  // @ts-expect-error Distinct brands can have the same runtime string.
  void replaced.__vitehubWorkspaceAgent
  enum ParentId { Workspace = "workspace" }
  enum ChildId { Workspace = "workspace" }
  const enumWorkspace = defineCapability({ id: ParentId.Workspace, workspace: {} })
  const enumPlain = defineCapability({ id: ChildId.Workspace, metadata: {} })
  const enumPreset = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", capabilities: [enumWorkspace] }) })
  const enumReplaced = defineAgent({ extends: enumPreset, capabilities: [enumPlain] })
  // @ts-expect-error Distinct enums can have the same runtime string.
  void enumReplaced.__vitehubWorkspaceAgent
})

it("retains Workspace access for disjoint branded literal Capability IDs", () => {
  const workspace = defineCapability({ id: "workspace" as "workspace" & { brand: "parent" }, workspace: {} })
  const unrelated = defineCapability({ id: "unrelated" as "unrelated" & { brand: "child" }, metadata: {} })
  const same = defineCapability({ id: "workspace" as "workspace" & { brand: "child" }, metadata: {} })
  const preset = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex", capabilities: [workspace] }) })
  const retained = defineAgent({ extends: preset, capabilities: [unrelated] })
  expectTypeOf(retained.__vitehubWorkspaceAgent).toEqualTypeOf<true>()
  const replaced = defineAgent({ extends: preset, capabilities: [same] })
  // @ts-expect-error Equal literal values replace each other despite distinct brands.
  void replaced.__vitehubWorkspaceAgent
})
