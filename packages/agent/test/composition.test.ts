import { expect, it, vi } from "vitest"

import { activeProviderSandbox, agentSettings, defineAgent, withoutForgeAccess } from "../src/index.ts"
import { github } from "../src/channels.ts"
import { readForgeAccess } from "../src/internal/forge-access.ts"
import { setActiveProviderSandbox } from "../src/internal/provider-box.ts"
import type { AgentInvocationContextStore } from "../src/types.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

it("agentSettings() returns a copy of the resolved settings with extends applied", () => {
  const decoration = Symbol("decoration")
  const parent = defineAgent({ driver: { model: "parent" }, description: "parent" })
  const child = defineAgent({ extends: parent, driver: { model: "child" } })
  Object.defineProperty(child, decoration, { enumerable: true, value: "kept" })

  const settings = agentSettings(child)
  expect(settings).toMatchObject({ description: "parent", driver: { model: "child" } })
  expect(settings && Object.getOwnPropertyDescriptor(settings, decoration)?.value).toBe("kept")

  settings!.description = "changed"
  settings!.driver = { model: "worker" }
  expect(agentSettings(child)).toMatchObject({ description: "parent", driver: { model: "child" } })
  expect(agentSettings({} as typeof child)).toBeUndefined()
})

it("withoutForgeAccess() removes the host GitHub access and keeps the rest of the Channel", () => {
  const channel = github({ app: { token: "host-token" } })
  expect(readForgeAccess(channel)).toBeTypeOf("function")

  const copy = withoutForgeAccess(channel)
  expect(readForgeAccess(copy)).toBeUndefined()
  expect(copy.kind).toBe("github")
  expect(readForgeAccess(channel)).toBeTypeOf("function")
})

it("activeProviderSandbox() reads the Sandbox of the current Invocation only", () => {
  const context = {} as AgentInvocationContextStore
  expect(activeProviderSandbox(context)).toBeUndefined()
  const session = { home: "/home/agent" } as Parameters<typeof setActiveProviderSandbox>[1]
  const clear = setActiveProviderSandbox(context, session)
  expect(activeProviderSandbox(context)).toBe(session)
  expect(activeProviderSandbox({} as AgentInvocationContextStore)).toBeUndefined()
  clear()
  expect(activeProviderSandbox(context)).toBeUndefined()
})
