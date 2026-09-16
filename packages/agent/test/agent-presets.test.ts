import { describe, expect, it, vi } from "vitest"
import { agentWithColocatedInstructions, defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { getAgentLayerOptions } from "../src/agent-layers.ts"
import { colocatedAgentSkillsSymbol, withColocatedAgentSkills } from "../src/internal/colocated-agent-skills.ts"
import { workspaceAgentWithSourceRoot } from "../src/workspace-agent.ts"

describe("named Agent presets", () => {
  it("runs a selected published definition with local overrides", async () => {
    const run = vi.fn(() => ({ text: "notes" }))
    const unused = vi.fn(() => ({ text: "unused" }))
    const notetaker = defineAgent({ name: "published-notetaker", driver: { run } })
    const agent = defineAgent({
      preset: "notetaker",
      presets: { notetaker, other: defineAgent({ driver: { run: unused } }) },
      description: "Local notes",
    })
    await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "Summarize this" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(unused).not.toHaveBeenCalled()
    expect(agent.name).toBeUndefined()
    expect(agent.description).toBe("Local notes")
    expect(notetaker.name).toBe("published-notetaker")
    expect(agent.resolve).not.toBe(notetaker.resolve)
  })

  it("keeps registries local and composes named presets through multiple generations", () => {
    const first = defineAgent({ driver: { kind: "codex", model: "first" }, workspace: {} })
    const second = defineAgent({ preset: "notes", presets: { notes: first }, driver: { model: "second" } })
    const third = defineAgent({ preset: "notes", presets: { notes: second }, description: "third" })
    expect(second.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ model: "second" })
    expect(third.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ model: "second" })
    expect(third.__vitehubWorkspaceAgentOptions).not.toHaveProperty("presets")
    expect(third.__vitehubWorkspaceAgentOptions).not.toHaveProperty("preset")
    expect(first.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ model: "first" })
  })

  it.each([undefined, null, false, 42, {}, [], "", " "])("rejects malformed preset %j without a registry", (preset) => {
    expect(() => defineAgent({ preset } as never)).toThrow("requires a non-empty preset name")
  })

  it("rejects missing, inherited, invalid and ambiguous selections", () => {
    const base = defineAgent({ driver: "codex" })
    expect(() => defineAgent({ preset: "missing", presets: { notes: base } } as never)).toThrow('preset "missing" is not defined')
    expect(() => defineAgent({ preset: "toString", presets: {} } as never)).toThrow('preset "toString" is not defined')
    expect(() => defineAgent({ presets: { notes: base } } as never)).toThrow("requires a non-empty preset name")
    expect(() => defineAgent({ preset: "notes", presets: { notes: {} } } as never)).toThrow("requires an Agent Definition")
    expect(() => defineAgent({ preset: "notes", presets: { notes: base }, extends: base } as never)).toThrow("Select one Agent parent")
  })
})

describe("configured Agent presets", () => {
  it("runs with merged options and preserves overrides through multiple generations", async () => {
    const defaults = { filter: { author: { allow: ["original"] }, labels: { deny: ["blocked"] } }, autoMerge: true }
    const factory = vi.fn((options: typeof defaults) => defineAgent({
      driver: { run: () => ({ text: JSON.stringify(options) }) },
      description: "factory",
    }))
    const preset = defineAgent({ options: defaults, configure: factory })
    const second = defineAgent({
      preset: "repair", presets: { repair: preset },
      options: { filter: { author: { allow: ["replacement"] } }, autoMerge: false },
      description: "application",
      name: "second",
    })
    const third = defineAgent({ extends: second, options: { filter: { labels: { deny: [] } } } })
    expect(factory.mock.lastCall?.[0]).toEqual({ filter: { author: { allow: ["replacement"] }, labels: { deny: [] } }, autoMerge: false })
    expect(third.description).toBe("application")
    expect(second.name).toBe("second")
    expect(third.name).toBeUndefined()
    expect(third.options.autoMerge).toBe(false)
    expect(defaults.filter.author.allow).toEqual(["original"])
    const result = await runAgent(third, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "repair" })
    expect(result).toMatchObject({ text: expect.stringContaining('"autoMerge":false') })
    expect(third.resolve).not.toBe(second.resolve)
  })

  it("does not merge callbacks or add preset configuration to runtime settings", () => {
    const original = vi.fn(() => true)
    const replacement = vi.fn(() => false)
    const preset = defineAgent({
      options: { filter: { when: original } },
      configure: options => defineAgent({ driver: "codex", workspace: {}, description: String(options.filter.when()) }),
    })
    const agent = defineAgent({ preset: "repair", presets: { repair: preset }, options: { filter: { when: replacement } } })
    expect(agent.description).toBe("false")
    expect(agent.__vitehubWorkspaceAgentOptions).not.toHaveProperty("options")
    expect(agent.__vitehubWorkspaceAgentOptions).not.toHaveProperty("configure")
  })

  it("rejects malformed configuration and nonconfigurable parents", () => {
    const base = defineAgent({ driver: "codex" })
    const preset = defineAgent({ options: { autoMerge: false }, configure: () => defineAgent({ driver: "codex" }) })
    expect(() => defineAgent({ options: {}, configure: () => ({}) } as never)).toThrow("configure must return an Agent Definition")
    expect(() => defineAgent({ options: {}, configure: false } as never)).toThrow("configure callback")
    expect(() => defineAgent({ options: {}, driver: "codex" } as never)).toThrow("options require a preset")
    expect(() => defineAgent({ extends: base, options: {} } as never)).toThrow("options require a preset")
    expect(() => defineAgent({ extends: preset, options: false } as never)).toThrow("options must be an object")
  })
})

it("keeps shared definitions separate when configure returns the same parent", () => {
  const base = defineAgent({ driver: "codex" })
  const first = defineAgent({ options: { enabled: true }, configure: () => base })
  const second = defineAgent({ options: { enabled: false }, configure: () => base })
  expect(first).not.toBe(base)
  expect(second).not.toBe(first)
  expect(first.options.enabled).toBe(true)
  expect(second.options.enabled).toBe(false)
  expect(base).not.toHaveProperty("options")
})

it("isolates plain objects inside option arrays from callback mutations", () => {
  const defaults = { steps: [{ name: "original", nested: [{ enabled: true }] }] }
  const preset = defineAgent({ options: defaults, configure: options => {
    options.steps[0]!.name = "changed"
    options.steps[0]!.nested[0]!.enabled = false
    return defineAgent({ driver: "codex" })
  } })
  const child = defineAgent({ extends: preset })
  expect(defaults.steps[0]).toEqual({ name: "original", nested: [{ enabled: true }] })
  expect(preset.options.steps).toEqual(defaults.steps)
  expect(child.options.steps).toEqual(defaults.steps)
})

it("keeps configured presets extendable after colocated Skills and Workspace discovery", () => {
  const preset = defineAgent({ options: { autoMerge: false }, configure: options => defineAgent({
    driver: "codex", workspace: {}, description: String(options.autoMerge),
  }) })
  const skills = { review: { content: "Review the change.", mount: "review", workspacePath: "SKILL.md" } }
  const discovered = workspaceAgentWithSourceRoot(withColocatedAgentSkills(preset, skills), "/app/agents/repair/workspace")
  expect(getAgentLayerOptions(discovered)?.workspace).toHaveProperty("sourceRootDir", "/app/agents/repair/workspace")
  const child = defineAgent({ extends: discovered, options: { autoMerge: true } })
  expect(child.description).toBe("true")
  expect(child.options.autoMerge).toBe(true)
  expect(getAgentLayerOptions(child)?.workspace).toHaveProperty("sourceRootDir", "/app/agents/repair/workspace")
  expect(Object.getOwnPropertyDescriptor(child, colocatedAgentSkillsSymbol)?.value).toBe(skills)
  expect(preset.options.autoMerge).toBe(false)
  expect(getAgentLayerOptions(preset)?.workspace).not.toHaveProperty("sourceRootDir")
})

it("keeps plain Agents extendable after colocated Skills discovery", () => {
  const base = defineAgent({ driver: "codex" })
  const skills = { review: { content: "Review.", workspacePath: "SKILL.md" } }
  const discovered = withColocatedAgentSkills(base, skills)
  expect(getAgentLayerOptions(discovered)?.driver).toBe("codex")
  const child = defineAgent({ extends: discovered, description: "Child" })
  expect(child.description).toBe("Child")
  expect(Object.getOwnPropertyDescriptor(child, colocatedAgentSkillsSymbol)?.value).toBe(skills)
  expect(Object.getOwnPropertyDescriptor(base, colocatedAgentSkillsSymbol)).toBeUndefined()
})

it("keeps configured options and discovered instructions through further extension", () => {
  const preset = defineAgent({ options: { enabled: false }, configure: options => defineAgent({ driver: "codex", description: String(options.enabled) }) })
  const discovered = agentWithColocatedInstructions(preset, "Check migration safety.")
  const child = defineAgent({ extends: discovered, options: { enabled: true } })
  expect(child.description).toBe("true")
  expect(getAgentLayerOptions(child)?.driver).toHaveProperty("instructions", "Check migration safety.")
  expect(preset.options.enabled).toBe(false)
})

it("reconfigures driver options after discovering instructions", () => {
  const preset = defineAgent({ options: { model: "first" }, configure: options => defineAgent({ driver: { kind: "codex", model: options.model } }) })
  const discovered = agentWithColocatedInstructions(preset, "Check the repository.")
  const child = defineAgent({ extends: discovered, options: { model: "second" } })
  expect(getAgentLayerOptions(child)?.driver).toMatchObject({ model: "second", instructions: "Check the repository." })
})

it("keeps discovery defaults below reconfigured workspace values", () => {
  const preset = defineAgent({ options: { mode: "read" as "read" | "write", sourceRootDir: undefined as string | undefined }, configure: options => defineAgent({
    driver: "codex", workspace: { mode: options.mode, ...(options.sourceRootDir ? { sourceRootDir: options.sourceRootDir } : {}) },
  }) })
  const discovered = workspaceAgentWithSourceRoot(preset, "/discovered", "Repository context.")
  const child = defineAgent({ extends: discovered, options: { mode: "write", sourceRootDir: "/configured" } })
  expect(getAgentLayerOptions(child)?.workspace).toMatchObject({ mode: "write", sourceRootDir: "/configured", sources: { __vitehubAgentInstructions: { content: "Repository context." } } })
  expect(getAgentLayerOptions(discovered)?.workspace).toMatchObject({ mode: "read", sourceRootDir: "/discovered" })
})

it("does not restore discovered Workspace access when configure returns a plain Agent", () => {
  const preset = defineAgent({ options: { workspace: true }, configure: options => options.workspace
    ? defineAgent({ driver: "codex", workspace: {} })
    : defineAgent({ driver: "codex" }) })
  const discovered = workspaceAgentWithSourceRoot(preset, "/discovered", "Repository context.")
  const plain = defineAgent({ extends: discovered, options: { workspace: false } })
  expect(plain).not.toHaveProperty("__vitehubWorkspaceAgent")
  expect(getAgentLayerOptions(plain)?.workspace).toBeUndefined()
  expect(defineAgent({ extends: plain })).not.toHaveProperty("__vitehubWorkspaceAgent")
  const restored = defineAgent({ extends: plain, options: { workspace: true } })
  expect(restored).toHaveProperty("__vitehubWorkspaceAgent", true)
  expect(getAgentLayerOptions(restored)?.workspace).toMatchObject({ sourceRootDir: "/discovered", sources: { __vitehubAgentInstructions: { content: "Repository context." } } })
  const explicit = defineAgent({ extends: discovered, options: { workspace: false }, workspace: { mode: "write" } })
  expect(explicit).toHaveProperty("__vitehubWorkspaceAgent", true)
  expect(getAgentLayerOptions(explicit)?.workspace).toMatchObject({ mode: "write", sourceRootDir: "/discovered" })
})

it.each(["capability", "channel", "channel factory"])("preserves discovered defaults when a plain callback gains Workspace through a %s", (kind) => {
  const preset = defineAgent({ options: { workspace: true }, configure: options => options.workspace
    ? defineAgent({ driver: "codex", workspace: {} })
    : defineAgent({ driver: "codex" }) })
  const discovered = workspaceAgentWithSourceRoot(preset, "/discovered", "Repository context.")
  const capability = defineCapability({ id: "storage", workspace: {} })
  const channel = { kind: "custom" as const, capabilities: [capability] }
  let factoryCalls = 0
  const extension = kind === "capability"
    ? { capabilities: [capability] }
    : { channels: { custom: kind === "channel factory" ? () => { factoryCalls++; return channel } : channel } }
  const child = defineAgent({ extends: discovered, options: { workspace: false }, ...extension })
  expect(child).toHaveProperty("__vitehubWorkspaceAgent", true)
  expect(getAgentLayerOptions(child)?.workspace).toMatchObject({ sourceRootDir: "/discovered", sources: { __vitehubAgentInstructions: { content: "Repository context." } } })
  expect(factoryCalls).toBe(kind === "channel factory" ? 1 : 0)
  // SAFETY: The parameterized fixture varies contributor types; this checks their runtime replacement.
  const removed = defineAgent({ extends: child, capabilities: [defineCapability({ id: "storage" })], channels: { custom: { kind: "custom" } } } as never)
  expect(removed).not.toHaveProperty("__vitehubWorkspaceAgent")
})

it("promotes configured presets when capabilities or channels contribute Workspace access", () => {
  const plain = defineAgent({ options: { enabled: true }, configure: () => defineAgent({ driver: "codex" }) })
  const capability = defineCapability({ id: "workspace", workspace: {} })
  const selected = defineAgent({ preset: "plain", presets: { plain }, capabilities: [capability] })
  const extended = defineAgent({ extends: plain, capabilities: [capability] })
  const channel = defineAgent({ preset: "plain", presets: { plain }, channels: { custom: { kind: "custom", capabilities: [capability] } } })
  for (const agent of [selected, extended, channel, defineAgent({ extends: channel })]) {
    expect(agent.__vitehubWorkspaceAgent).toBe(true)
    expect(agent.options).toEqual({ enabled: true })
  }
})

it("removes contributed Workspace access when its last channel or capability is replaced", () => {
  const plain = defineAgent({ options: {}, configure: () => defineAgent({ driver: "codex" }) })
  const capability = defineCapability({ id: "workspace", workspace: {} })
  const replacement = defineCapability({ id: "workspace", metadata: {} })
  const channel = defineAgent({ extends: plain, channels: { custom: { kind: "custom", capabilities: [capability] } } })
  const removedChannel = defineAgent({ extends: channel, channels: { custom: { kind: "custom" } } })
  expect(removedChannel).not.toHaveProperty("__vitehubWorkspaceAgent")
  const decoratedChannel = defineAgent({ extends: channel, name: "callback-default" })
  const decoration = Symbol("published-metadata")
  Object.defineProperty(decoratedChannel, decoration, { value: { published: true } })
  Object.defineProperty(decoratedChannel, "publishedMetadata", { value: { published: true } })
  const callbackPreset = defineAgent({ options: { enabled: true }, configure: () => decoratedChannel })
  expect(callbackPreset.__vitehubWorkspaceAgent).toBe(true)
  const callbackChild = defineAgent({ extends: callbackPreset, channels: { custom: { kind: "custom" } } })
  expect(callbackChild).not.toHaveProperty("__vitehubWorkspaceAgent")
  expect(callbackChild.name).toBeUndefined()
  expect(callbackChild).toHaveProperty("publishedMetadata", { published: true })
  expect(Object.getOwnPropertyDescriptor(callbackChild, decoration)?.value).toEqual({ published: true })
  expect(defineAgent({ extends: callbackPreset, workspace: {} })).toHaveProperty("publishedMetadata", { published: true })
  const withCapability = defineAgent({ extends: plain, capabilities: [capability] })
  const removedCapability = defineAgent({ preset: "base", presets: { base: withCapability }, capabilities: [replacement] })
  expect(removedCapability).not.toHaveProperty("__vitehubWorkspaceAgent")
  const explicit = defineAgent({ extends: channel, workspace: {} })
  expect(defineAgent({ extends: explicit, channels: { custom: { kind: "custom" } } }).__vitehubWorkspaceAgent).toBe(true)
})

it.each([[], () => true, new Date()])("rejects non-record configured option roots", options => {
  expect(() => defineAgent({ options, configure: () => defineAgent({ driver: "codex" }) } as never)).toThrow("requires only options defaults and a configure callback")
})
