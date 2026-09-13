import { describe, expect, it, vi } from "vitest"
import { defineAgent, runAgent } from "../src/index.ts"

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
    expect(result.text).toContain('"autoMerge":false')
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
