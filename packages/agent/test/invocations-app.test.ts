import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, getAgentInvocations } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"
import { agentInvocationsDisabledKey, agentInvocationsFallbackKey, installAgentInvocations, installAgentInvocationsOverride, resolveDefaultAgentInvocations } from "../src/invocations/app.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

const driver = { run: () => "done" }
const context = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })

afterEach(() => {
  installAgentInvocations({})
  installAgentInvocationsOverride(undefined)
})

describe("defineAgent() and the app-wide journal", () => {
  it("records an Agent without its own journal in the app-wide journal", async () => {
    installAgentInvocations({ default: "memory" })
    const agent = defineAgent({ driver, name: "support" })
    expect(agent.invocations).toBe(getAgentInvocations())
    expect(Reflect.get(agent, agentInvocationsFallbackKey)).toBe(true)
    await runAgentWithContext(agent, context("app-wide"), { prompt: "Hello" })
    await expect(getAgentInvocations().getByRunId("app-wide", "support")).resolves.toMatchObject({ status: "completed" })
  })

  it("resolves the journal when it runs, so a journal installed later applies", () => {
    const agent = defineAgent({ driver, name: "early" })
    expect(agent.invocations).toBeUndefined()
    installAgentInvocations({ default: "memory" })
    expect(agent.invocations).toBe(resolveDefaultAgentInvocations())
  })

  it("accepts journal names, and false turns the journal off", async () => {
    installAgentInvocations({ default: "memory" })
    const named = defineAgent({ driver, invocations: "memory", name: "named" })
    expect(named.invocations).not.toBe(resolveDefaultAgentInvocations())
    await runAgentWithContext(named, context("named"), { prompt: "Hello" })
    await expect(named.invocations!.getByRunId("named", "named")).resolves.toMatchObject({ status: "completed" })

    const off = defineAgent({ driver, invocations: false, name: "off" })
    expect(off.invocations).toBeUndefined()
    expect(Reflect.get(off, agentInvocationsDisabledKey)).toBe(true)
    expect(defineAgent({ extends: off, name: "child" }).invocations).toBeUndefined()
  })

  it("lets a development override replace the app-wide journal, and an assigned journal wins", () => {
    installAgentInvocations({ default: "memory" })
    const fixture = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installAgentInvocationsOverride(() => fixture)
    const agent = defineAgent({ driver, name: "fixture" })
    expect(agent.invocations).toBe(fixture)

    const assigned = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    agent.invocations = assigned
    expect(agent.invocations).toBe(assigned)
    expect(Reflect.get(agent, agentInvocationsFallbackKey)).toBe(false)
  })

  it("preserves journal opt-outs when configured Agents are rebuilt", async () => {
    installAgentInvocations({ default: "memory" })
    const preset = defineAgent({
      options: {},
      configure: () => defineAgent({ driver, invocations: false, name: "off" }),
    })
    const extended = defineAgent({ extends: preset, name: "child" })
    const nested = defineAgent({ options: {}, configure: () => extended })

    for (const [index, agent] of [preset, extended, nested].entries()) {
      expect(Reflect.get(agent, agentInvocationsDisabledKey)).toBe(true)
      expect(agent.invocations).toBeUndefined()
      const runId = `configured-off-${index}`
      await runAgentWithContext(agent, context(runId), { prompt: "Hello" })
      await expect(getAgentInvocations().getByRunId(runId, agent.name)).resolves.toBeUndefined()
    }
  })

  it("lets an explicit journal override an inherited opt-out", async () => {
    installAgentInvocations({ default: "memory" })
    const preset = defineAgent({
      options: {},
      configure: () => defineAgent({ driver, invocations: false }),
    })
    const enabled = defineAgent({ extends: preset, invocations: "memory", name: "enabled" })
    const child = defineAgent({ extends: enabled, name: "child" })

    expect(Reflect.get(enabled, agentInvocationsDisabledKey)).toBeUndefined()
    expect(Reflect.get(child, agentInvocationsDisabledKey)).toBeUndefined()
    expect(Reflect.get(enabled, agentInvocationsFallbackKey)).not.toBe(true)
    expect(Reflect.get(child, agentInvocationsFallbackKey)).not.toBe(true)
    expect(child.invocations).toBe(enabled.invocations)
    expect(child.invocations).not.toBe(getAgentInvocations())
    await runAgentWithContext(child, context("enabled-child"), { prompt: "Hello" })
    await expect(enabled.invocations!.getByRunId("enabled-child", "child")).resolves.toMatchObject({ status: "completed" })
    await expect(getAgentInvocations().getByRunId("enabled-child", "child")).resolves.toBeUndefined()
  })
})
