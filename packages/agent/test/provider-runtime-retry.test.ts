import { describe, expect, it, vi } from "vitest"

import { codexDriver, defineAgent } from "../src/index.ts"

// The provider runtime fails to load once, and then fails to create one adapter, as an import or a provider SDK can
// fail once during a development rebuild.
const provider = vi.hoisted(() => ({ adapterFailures: 0, importFailures: 1 }))

vi.mock("#vitehub/agent/provider-agent", () => {
  if (provider.importFailures > 0) {
    provider.importFailures--
    throw new Error("transient provider runtime import failure")
  }
  return {
    createProviderAgentAdapter: () => {
      if (provider.adapterFailures > 0) {
        provider.adapterFailures--
        throw new Error("transient provider adapter failure")
      }
      return { kind: "provider-adapter" }
    },
    inspectAgentProvider: () => ({ readiness: "ready" }),
  }
})

describe("provider Agent Drivers", () => {
  it("loads the provider runtime again after a failed load, and creates the adapter again after a failed creation", async () => {
    const agent = defineAgent({ driver: codexDriver() })

    await expect(agent.status!({} as never)).rejects.toThrow()
    await expect(agent.status!({} as never)).resolves.toEqual({ readiness: "ready" })

    provider.adapterFailures = 1
    await expect(agent.resolve!({} as never)).rejects.toThrow("transient provider adapter failure")
    await expect(agent.resolve!({} as never)).resolves.toMatchObject({ kind: "provider-adapter" })
  })
})
