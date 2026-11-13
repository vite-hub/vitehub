import { chatgpt, openai } from "@vite-hub/gateways"
import { github } from "@vite-hub/workspace"
import { normalizeWorkspaceSourcesMetadata } from "@vite-hub/workspace/source-metadata"
import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, it, vi } from "vitest"
import { resolveAgentInstructions } from "../src/agent-instructions.ts"
import { agentWithSkills, claudeCodeDriver, codexDriver, defineAgent } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"
import { withColocatedAgentSkills } from "../src/internal/colocated-agent-skills.ts"

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
    await runAgentWithContext(base, runtime, { prompt: "hello" })
    await runAgentWithContext(development, runtime, { prompt: "hello" })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(added).toHaveBeenCalledTimes(1)
    expect(base.name).toBe("bot")
    expect(development.name).toBe("bot-dev")
    expect(base.capabilities).toHaveLength(1)
  })

  it("merges driver configuration but replaces source definitions by key", () => {
    const base = defineAgent({
      driver: codexDriver({ model: "base", reasoningEffort: "high" }),
      workspace: { mode: "read", sources: { docs: github({ repo: "owner/base", mount: "docs", root: "documentation" }) } },
    })
    const source = github({ repo: "owner/development" })
    const development = defineAgent({
      extends: base,
      driver: { model: "development" },
      workspace: { mode: "write", sources: { docs: source } },
    })
    const options = development.__vitehubWorkspaceAgentOptions
    expect(options.driver).toMatchObject(codexDriver({ model: "development", reasoningEffort: "high" }))
    expect(options.workspace).toMatchObject({ mode: "write" })
    expect((options.workspace as { sources: { docs: object } }).sources.docs).toBe(source)
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ model: "base" })
  })

  it("supports multiple generations without inheriting a registered name", () => {
    const base = defineAgent({ name: "base", driver: codexDriver({ model: "base" }) })
    const second = defineAgent({ extends: base, driver: { model: "second" } })
    const third = defineAgent({ extends: second, description: "third" })
    expect(second.name).toBeUndefined()
    expect(third.name).toBeUndefined()
    expect(third.description).toBe("third")
    expect(third.resolve).not.toBe(base.resolve)
  })

  it("runs a parent hook before the child hook with the same name and keeps other hooks", async () => {
    const order: string[] = []
    const finish = vi.fn()
    const base = defineAgent({
      driver: { run: () => ({ text: "ok" }) },
      hooks: { "agent:input": () => void order.push("parent"), "agent:finish": finish },
    })
    const child = defineAgent({ extends: base, hooks: { "agent:input": () => void order.push("child") } })
    const grandchild = defineAgent({ extends: child, hooks: { "agent:input": () => void order.push("grandchild") } })
    await runAgentWithContext(grandchild, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "hello" })
    expect(order).toEqual(["parent", "child", "grandchild"])
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs the finish hook of a configured preset when an extension adds its own", async () => {
    const order: string[] = []
    const preset = defineAgent({
      options: { label: "preset" },
      configure: options => defineAgent({
        driver: { run: () => ({ text: "ok" }) },
        hooks: { "agent:finish": () => void order.push(String(options.label)) },
      }),
    })
    const app = defineAgent({ extends: preset, options: { label: "app" } })
    const replay = defineAgent({ extends: app, hooks: { "agent:finish": () => void order.push("replay") } })
    await runAgentWithContext(replay, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "hello" })
    expect(order).toEqual(["app", "replay"])
  })

  it("returns the delivery effects of both finish hooks", async () => {
    const parentEffect = { kind: "status", payload: { state: "done" } } as const
    const childEffect = { kind: "reply", payload: "done" } as const
    const base = defineAgent({ driver: { run: () => ({ text: "ok" }) }, hooks: { "agent:finish": () => parentEffect } })
    const child = defineAgent({ extends: base, hooks: { "agent:finish": () => childEffect } })
    const quiet = defineAgent({ extends: base, hooks: { "agent:finish": () => undefined } })
    const finish = (agent: typeof child) => agent.hooks?.["agent:finish"]?.({} as never)
    await expect(finish(child)).resolves.toEqual([parentEffect, childEffect])
    await expect(finish(quiet)).resolves.toBe(parentEffect)
  })

  it("runs a hook once when a child passes the inherited hook again", async () => {
    const finish = vi.fn()
    const base = defineAgent({ driver: { run: () => ({ text: "ok" }) }, hooks: { "agent:finish": finish } })
    const child = defineAgent({ extends: base, hooks: { "agent:finish": finish } })
    await runAgentWithContext(child, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "hello" })
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("keeps the hook observers of every layer", async () => {
    const parent = vi.fn()
    const child = vi.fn()
    const base = defineAgent({ driver: { run: () => ({ text: "ok" }) }, hooks: { "hook:observe": parent, "agent:input": vi.fn() } })
    const extension = defineAgent({ extends: base, hooks: { "hook:observe": [child] } })
    await runAgentWithContext(extension, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "hello" })
    expect(parent).toHaveBeenCalledWith(expect.objectContaining({ name: "agent:input" }))
    expect(child).toHaveBeenCalledWith(expect.objectContaining({ name: "agent:input" }))
  })

  it("merges partial driver overrides and replaces a different driver variant", () => {
    const base = defineAgent({ driver: codexDriver(), workspace: {} })
    const child = defineAgent({ extends: base, driver: { model: "development" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual(codexDriver({ model: "development" }))
    const run = () => ({ text: "custom" })
    const custom = defineAgent({ extends: child, driver: { run } })
    expect(custom.__vitehubWorkspaceAgentOptions.driver).toEqual({ run })
    const claude = defineAgent({ extends: child, driver: claudeCodeDriver() })
    expect(claude.__vitehubWorkspaceAgentOptions.driver).toEqual(claudeCodeDriver())
  })

  it("replaces an inherited gateway as a whole", () => {
    const base = defineAgent({ workspace: {}, driver: codexDriver({ gateway: chatgpt() }) })
    const gateway = openai()
    const child = defineAgent({ extends: base, driver: { gateway, model: "gpt-5.1-mini" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual(codexDriver({ gateway, model: "gpt-5.1-mini" }))
  })

  it.each([
    { command: "child" },
    { command: "child", onExit: undefined },
    { command: "child", onExit: vi.fn() },
    () => ({ command: "child" }),
  ])("replaces the complete provider launch when a child supplies one (%j)", (launch) => {
    const parentLaunch = { command: "parent", args: ["parent-only"], onExit: vi.fn() }
    const base = defineAgent({ workspace: {}, driver: codexDriver({ launch: parentLaunch }) })
    const child = defineAgent({ extends: base, driver: { launch } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual(codexDriver({ launch }))
    expect(base.__vitehubWorkspaceAgentOptions.driver).toEqual(codexDriver({ launch: parentLaunch }))
  })

  it("inherits the provider launch when a child only changes the model", () => {
    const launch = { command: "parent", onExit: vi.fn() }
    const base = defineAgent({ workspace: {}, driver: codexDriver({ launch }) })
    const child = defineAgent({ extends: base, driver: { model: "child" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual(codexDriver({ model: "child", launch }))
  })

  it("replaces registered workspace references without leaking inline sources", () => {
    const base = defineAgent({ driver: codexDriver(), workspace: { sources: { docs: github({ repo: "owner/base" }) } } })
    const child = defineAgent({ extends: base, workspace: { name: "registered" } })
    expect(child.__vitehubWorkspaceAgentOptions.workspace).toEqual({ name: "registered" })
  })

  it.each(["parent", "child"] as const)("inherits owned Workspace fields when the %s has an inherited name", (layer) => {
    const source = github({ repo: "owner/base" })
    const parentWorkspace = { mode: "write" as const, sourceRootDir: "/parent/source", sources: { docs: source } }
    const childWorkspace = { mode: "read" as const }
    Object.setPrototypeOf(layer === "parent" ? parentWorkspace : childWorkspace, { name: "inherited" })
    const base = defineAgent({ driver: codexDriver(), workspace: parentWorkspace })
    const child = defineAgent({ extends: base, workspace: childWorkspace })

    expect(child.__vitehubWorkspaceAgentOptions.workspace).toMatchObject({
      mode: "read", sourceRootDir: "/parent/source", sources: { docs: source },
    })
    expect(child.__vitehubWorkspaceAgentOptions.workspace).not.toHaveProperty("name")
  })

  it("resolves colocated Skills that discovery attaches after a child extends the parent", async () => {
    const seen: unknown[] = []
    const base = defineAgent({
      name: "bot",
      driver: { run: ({ context }) => { seen.push(context.get("agent.colocatedSkills")); return { text: "ok" } } },
    })
    // Schedules and other modules can extend a definition before the discovery registry decorates it.
    const development = defineAgent({ extends: base, name: "bot-dev" })
    const changelog = defineAgent({ extends: development, description: "changelog" })
    const review = { content: "# Review", materialize: "startup", mount: "", workspacePath: ".agents/skills/review/SKILL.md" }
    withColocatedAgentSkills(base, { "__vitehubAgentSkill:.agents/skills/review/SKILL.md": review } as never)
    // Empty discovery decoration must preserve the inherited getter.
    withColocatedAgentSkills(development, undefined)
    const withChangelog = agentWithSkills(changelog, { "customer-changelog": "# Changelog" })

    const runtime = { runtime: "unknown" as const, memo: vi.fn(), waitUntil: vi.fn() }
    await runAgentWithContext(changelog, runtime, { prompt: "hello" })
    await runAgentWithContext(withChangelog, runtime, { prompt: "hello" })
    expect(seen[0]).toEqual({ "__vitehubAgentSkill:.agents/skills/review/SKILL.md": review })
    expect(seen[1]).toEqual({
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": review,
      "__vitehubAgentSkill:.agents/skills/customer-changelog/SKILL.md": { content: "# Changelog", materialize: "startup", mount: "", workspacePath: ".agents/skills/customer-changelog/SKILL.md" },
    })
    expect(Reflect.get(changelog, Symbol.for("vitehub.agent.colocatedSkills"))).toEqual(seen[0])
    expect(() => agentWithSkills(changelog, { "../escape": "x" })).toThrow(/Invalid Skill name/)
  })

  it("passes inherited driver requirements to a child function and replaces them with an array", () => {
    const base = defineAgent({ workspace: {}, driver: codexDriver({ requirements: ["git", "gh"] }) })
    const appended = defineAgent({ extends: base, driver: { requirements: inherited => [...inherited, "kubectl"] } })
    const grandchild = defineAgent({ extends: appended, driver: { requirements: inherited => inherited.filter(command => command !== "gh") } })
    const replaced = defineAgent({ extends: base, driver: { requirements: ["unzip"] } })
    const standalone = defineAgent({ workspace: {}, driver: codexDriver({ requirements: inherited => [...inherited, "git"] }) })
    expect(appended.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ requirements: ["git", "gh", "kubectl"] })
    expect(grandchild.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ requirements: ["git", "kubectl"] })
    expect(replaced.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ requirements: ["unzip"] })
    expect(standalone.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ requirements: ["git"] })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ requirements: ["git", "gh"] })
  })

  it("combines a child Capability with the inherited one through extend()", () => {
    const parent = { id: "notes", metadata: { tags: ["parent"] } }
    const base = defineAgent({ driver: { run: () => ({ text: "ok" }) }, capabilities: [parent] })
    const child = defineAgent({
      extends: base,
      capabilities: [{ id: "notes", extend: inherited => ({ id: "notes", metadata: { tags: [...(inherited.metadata?.tags as string[] ?? []), "child"] } }) }],
    })
    expect(child.capabilities?.find(capability => capability.id === "notes")?.metadata).toEqual({ tags: ["parent", "child"] })
    const invalid = { id: "notes", extend: () => ({ id: "other" }) }
    expect(() => defineAgent({ extends: base, capabilities: [invalid] })).toThrow("must return a Capability with the same id")
  })

  it("applies workspace.materialize to every Source without its own mode, including inherited Sources", () => {
    const base = defineAgent({
      driver: codexDriver(),
      workspace: {
        materialize: "startup",
        sources: {
          docs: github({ repo: "owner/docs" }),
          pinned: github({ repo: "owner/pinned", materialize: "lazy" }),
        },
      },
    })
    const child = defineAgent({
      extends: base,
      workspace: { materialize: "none", sources: { extra: github({ repo: "owner/extra" }) } },
    })
    const modes = (agent: { sources?: Record<string, unknown> }) => Object.fromEntries(
      normalizeWorkspaceSourcesMetadata(agent.sources as never).map(source => [source.key, source.materialize]),
    )
    expect(modes(base)).toEqual({ docs: "startup", pinned: "lazy" })
    expect(modes(child)).toEqual({ docs: "none", extra: "none", pinned: "lazy" })
    expect(() => defineAgent({ driver: codexDriver(), workspace: { materialize: "eager" as never } })).toThrow("materialize must be one of")
  })

  it("rejects arbitrary parents instead of copying a live agent runtime", () => {
    expect(() => defineAgent({ extends: {} as never })).toThrow("requires an Agent Definition")
  })
})


describe("Agent instruction layers", () => {
  it("retains instruction templates with provider Driver overrides", () => {
    const template = "Before\n{{{ instructions }}}\nAfter"
    const base = defineAgent({ workspace: {}, driver: codexDriver({ instructions: { template, content: "Default" } }) })
    const codex = defineAgent({ extends: base, driver: codexDriver() })
    expect(codex.__vitehubWorkspaceAgentOptions.driver).toEqual({ ...codexDriver(), instructions: { template, content: "Default" } })
    const claude = defineAgent({ extends: base, driver: claudeCodeDriver() })
    expect(claude.__vitehubWorkspaceAgentOptions.driver).toEqual({ ...claudeCodeDriver(), instructions: { template, content: "Default" } })
  })

  it("retains instruction templates across providers without leaking provider options", () => {
    const template = "Before\n{{{ instructions }}}\nAfter"
    const base = defineAgent({ workspace: {}, driver: codexDriver({ model: "base", reasoningEffort: "high", instructions: { template, content: "Default" } }) })
    const inherited = defineAgent({ extends: base, driver: claudeCodeDriver() })
    expect(inherited.__vitehubWorkspaceAgentOptions.driver).toEqual(claudeCodeDriver({ instructions: { template, content: "Default" } }))
    const child = defineAgent({ extends: base, driver: claudeCodeDriver({ instructions: "Child" }) })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toEqual(claudeCodeDriver({ instructions: { template, content: "Child" } }))
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
    const base = defineAgent({ workspace: {}, driver: codexDriver({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Default" } }) })
    const child = defineAgent({ extends: base, driver: { instructions: "Child" } })
    const grandchild = defineAgent({ extends: child, driver: { instructions: "Grandchild" } })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { content: "Default" } })
    expect(child.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Child" } })
    expect(grandchild.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Grandchild" } })
    const replacement = defineAgent({ extends: child, driver: { instructions: { mode: "replace", value: "Replacement" } } })
    expect(replacement.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: { mode: "replace", value: "Replacement" } })
  })

  it("passes the inherited instructions to a child extend function", () => {
    const base = defineAgent({ workspace: {}, driver: codexDriver({ instructions: ["Base rules.", "Answer {{{ context.customInstructions }}}"] }) })
    const appended = defineAgent({ extends: base, driver: { instructions: { extend: inherited => `${inherited}\n\nDevelopment rules.` } } })
    const edited = defineAgent({ extends: appended, driver: { instructions: { extend: inherited => inherited.replace("Base rules.", "Edited rules.") } } })
    const replaced = defineAgent({ extends: appended, driver: { instructions: "Replacement." } })
    const standalone = defineAgent({ workspace: {}, driver: codexDriver({ instructions: { extend: inherited => `${inherited}Standalone.` } }) })
    expect(appended.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: "Base rules.\n\nAnswer {{{ context.customInstructions }}}\n\nDevelopment rules." })
    expect(edited.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: "Edited rules.\n\nAnswer {{{ context.customInstructions }}}\n\nDevelopment rules." })
    expect(replaced.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: "Replacement." })
    expect(standalone.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: "Standalone." })
    expect(base.__vitehubWorkspaceAgentOptions.driver).toMatchObject({ instructions: ["Base rules.", "Answer {{{ context.customInstructions }}}"] })
  })

  it("passes per-Invocation and template instructions to a child extend function when the Driver resolves them", async () => {
    const parentCallback = vi.fn(({ context }: { context: { get: (key: string) => unknown } }) => `Reply to ${String(context.get("customer"))}.`)
    const dynamic = defineAgent({ workspace: {}, driver: codexDriver({ instructions: ["Base rules.", parentCallback] }) })
    const template = defineAgent({ workspace: {}, driver: codexDriver({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Default" } }) })
    const extend = { extend: (inherited: string) => `${inherited}\n\nChild rules.` }
    const dynamicChild = defineAgent({ extends: dynamic, driver: { instructions: extend } })
    const templateChild = defineAgent({ extends: template, driver: { instructions: extend } })
    const context = { context: new Map([["customer", "Ada"]]) }
    // SAFETY: Instruction callbacks in this test read only the Invocation context.
    const resolve = (agent: typeof dynamicChild) => resolveAgentInstructions(agent.__vitehubWorkspaceAgentOptions.driver.instructions, context as never)
    await expect(resolve(dynamicChild)).resolves.toBe("Base rules.\n\nReply to Ada.\n\nChild rules.")
    expect(parentCallback).toHaveBeenCalledWith(context)
    await expect(resolve(templateChild)).resolves.toBe("Before\nDefault\nAfter\n\nChild rules.")
  })

  it("passes the complete document of a configured preset chain to a child extend function", async () => {
    const preset = defineAgent({
      options: {},
      configure: () => defineAgent({ workspace: {}, driver: codexDriver({ instructions: { template: "Before\n{{{ instructions }}}\nAfter", content: "Default" } }) }),
    })
    const middle = defineAgent({ extends: preset, driver: { instructions: "Middle" } })
    const child = defineAgent({ extends: middle, driver: { instructions: { extend: inherited => `${inherited}\nChild` } } })
    const replaced = defineAgent({ extends: child, driver: { instructions: "Replaced" } })
    // SAFETY: These instructions read no Invocation context.
    const resolve = (agent: typeof child) => resolveAgentInstructions(agent.__vitehubWorkspaceAgentOptions.driver.instructions, { context: new Map() } as never)
    await expect(resolve(middle)).resolves.toBe("Before\nMiddle\nAfter")
    await expect(resolve(child)).resolves.toBe("Before\nMiddle\nAfter\nChild")
    await expect(resolve(replaced)).resolves.toBe("Replaced")
  })

  it("gives a model Driver the instructions that a child extend function returns", async () => {
    const model = new MockLanguageModelV3({ doGenerate: {
      content: [{ type: "text", text: "done" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
      warnings: [],
    } })
    const base = defineAgent({ driver: { model, instructions: "Base rules." }, runtime: false })
    const child = defineAgent({ extends: base, driver: { instructions: { extend: inherited => `${inherited}\n\nChild rules.` } } })
    await runAgentWithContext(child, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Hello" })
    const system = model.doGenerateCalls[0]!.prompt.filter(message => message.role === "system")
    expect(system).toEqual([expect.objectContaining({ content: expect.stringMatching(/^Base rules\.\n\nChild rules\./) })])
  })

  it("rejects a child extend function that does not return a string", () => {
    const base = defineAgent({ workspace: {}, driver: codexDriver({ instructions: "Base rules." }) })
    expect(() => defineAgent({ extends: base, driver: { instructions: { extend: () => undefined as never } } }))
      .toThrow("driver.instructions extend() must return a string")
  })
})
