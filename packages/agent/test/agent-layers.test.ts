import { github } from "@vite-hub/workspace"
import { describe, expect, it, vi } from "vitest"
import { defineAgent, runAgent } from "../src/index.ts"

describe("Agent definition layers", () => {
  it("inherits runnable behavior and composes fresh capabilities without changing the base", async () => {
    const prepare = vi.fn()
    const replaced = vi.fn()
    const added = vi.fn()
    const base = defineAgent({
      name: "bot",
      driver: { run: () => ({ text: "base answer" }) },
      capabilities: [{ id: "shared", prepare }],
    })
    const development = defineAgent({
      extends: base,
      name: "bot-dev",
      capabilities: [{ id: "shared", prepare: replaced }, { id: "development", prepare: added }],
    })
    const runtime = { runtime: "unknown" as const, memo: vi.fn(), waitUntil: vi.fn() }
    await runAgent(base, runtime, { prompt: "hello" })
    await runAgent(development, runtime, { prompt: "hello" })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(added).toHaveBeenCalledTimes(1)
    expect(base.name).toBe("bot")
    expect(development.name).toBe("bot-dev")
    expect(base.capabilities).toHaveLength(1)
  })

  it("merges driver configuration but replaces source definitions by key", () => {
    const base = defineAgent({
      driver: { kind: "codex", model: "base", reasoningEffort: "high" },
      workspace: { mode: "read", sources: { docs: github({ repo: "owner/base", mount: "docs", root: "documentation" }) } },
    })
    const source = github({ repo: "owner/development" })
    const development = defineAgent({
      extends: base,
      driver: { model: "development" },
      workspace: { mode: "write", sources: { docs: source } },
    })
    const options = development.__vitehubWorkspaceAgentOptions
    expect(options.driver).toMatchObject({ kind: "codex", model: "development", reasoningEffort: "high" })
    expect(options.workspace).toMatchObject({ mode: "write" })
    expect((options.workspace as { sources: { docs: object } }).sources.docs).toBe(source)
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ model: "base" })
  })

  it("supports multiple generations without inheriting a registered name", () => {
    const base = defineAgent({ name: "base", driver: { kind: "codex", model: "base" } })
    const second = defineAgent({ extends: base, driver: { model: "second" } })
    const third = defineAgent({ extends: second, description: "third" })
    expect(second.name).toBeUndefined()
    expect(third.name).toBeUndefined()
    expect(third.description).toBe("third")
    expect(third.resolve).not.toBe(base.resolve)
  })

  it("replaces hooks by name and keeps other hooks", async () => {
    const parentInput = vi.fn()
    const childInput = vi.fn()
    const finish = vi.fn()
    const base = defineAgent({ driver: { run: () => ({ text: "ok" }) }, hooks: { "agent:input": parentInput, "agent:finish": finish } })
    const child = defineAgent({ extends: base, hooks: { "agent:input": childInput } })
    await runAgent(child, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "hello" })
    expect(parentInput).not.toHaveBeenCalled()
    expect(childInput).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("normalizes shorthand drivers and replaces a different driver variant", () => {
    const base = defineAgent({ driver: "codex", workspace: {} })
    const child = defineAgent({ extends: base, driver: { model: "development" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "codex", model: "development" })
    const run = () => ({ text: "custom" })
    const custom = defineAgent({ extends: child, driver: { run } })
    expect(custom.__vitehubWorkspaceAgentOptions.driver).toEqual({ run })
    const claude = defineAgent({ extends: child, driver: { kind: "claude-code" } })
    expect(claude.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "claude-code" })
  })

  it.each([
    { command: "child" },
    { command: "child", onExit: undefined },
    { command: "child", onExit: vi.fn() },
    () => ({ command: "child" }),
  ])("replaces the complete provider launch when a child supplies one (%j)", (launch) => {
    const parentLaunch = { command: "parent", args: ["parent-only"], onExit: vi.fn() }
    const base = defineAgent({ workspace: {}, driver: { kind: "codex", launch: parentLaunch } })
    const child = defineAgent({ extends: base, driver: { launch } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "codex", launch })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "codex", launch: parentLaunch })
  })

  it("inherits the provider launch when a child only changes the model", () => {
    const launch = { command: "parent", onExit: vi.fn() }
    const base = defineAgent({ workspace: {}, driver: { kind: "codex", launch } })
    const child = defineAgent({ extends: base, driver: { model: "child" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "codex", model: "child", launch })
  })

  it("replaces registered workspace references without leaking inline sources", () => {
    const base = defineAgent({ driver: "codex", workspace: { sources: { docs: github({ repo: "owner/base" }) } } })
    const child = defineAgent({ extends: base, workspace: { name: "registered" } })
    expect(child.__vitehubWorkspaceAgentOptions.workspace).toEqual({ name: "registered" })
  })

  it("rejects arbitrary parents instead of copying a live agent runtime", () => {
    expect(() => defineAgent({ extends: {} as never })).toThrow("requires an Agent Definition")
  })
})


describe("Agent instruction layers", () => {
  it.each(["codex", "claude-code"] as const)("retains instruction templates with shorthand %s overrides", (kind) => {
    const template = "Before\n{{{ instructions }}}\nAfter"
    const base = defineAgent({ workspace: {}, driver: { kind: "codex", instructions: { template, content: "Default" } } })
    const child = defineAgent({ extends: base, driver: kind })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind, instructions: { template, content: "Default" } })
  })

  it("retains instruction templates across providers without leaking provider options", () => {
    const template = "Before\n{{{ instructions }}}\nAfter"
    const base = defineAgent({ workspace: {}, driver: { kind: "codex", model: "base", reasoningEffort: "high", instructions: { template, content: "Default" } } })
    const inherited = defineAgent({ extends: base, driver: { kind: "claude-code" } })
    expect(inherited.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "claude-code", instructions: { template, content: "Default" } })
    const child = defineAgent({ extends: base, driver: { kind: "claude-code", instructions: "Child" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual({ kind: "claude-code", instructions: { template, content: "Child" } })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { content: "Default" } })
  })

  it("preserves model preset templates with object-model overrides", () => {
    const base = defineAgent({ workspace: {}, driver: { model: {} as never, instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Default" } } })
    const model = {} as never
    const child = defineAgent({ extends: base, driver: { model, instructions: "Child" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ model, instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Child" } })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { content: "Default" } })
  })

  it("fills an inherited instruction template across generations without mutating its defaults", () => {
    const base = defineAgent({ workspace: {}, driver: { kind: "codex", instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Default" } } })
    const child = defineAgent({ extends: base, driver: { instructions: "Child" } })
    const grandchild = defineAgent({ extends: child, driver: { instructions: "Grandchild" } })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { content: "Default" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Child" } })
    expect(grandchild.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Grandchild" } })
    const replacement = defineAgent({ extends: child, driver: { instructions: { mode: "replace", value: "Replacement" } } })
    expect(replacement.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { mode: "replace", value: "Replacement" } })
  })
})
