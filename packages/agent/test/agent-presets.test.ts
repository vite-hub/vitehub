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
