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
})
