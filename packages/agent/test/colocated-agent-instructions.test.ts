import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { agentWithColocatedInstructions, defineAgent } from "../src/index.ts"
import { loadViteAgent } from "../src/vite/runtime-adapter.ts"

import type { ViteDevServer } from "vite"
import type { DiscoveredAgentDefinition } from "../src/index.ts"

function settings(agent: unknown) {
  return (agent as { __vitehubAgentSettings?: { driver?: { execution?: unknown, instructions?: unknown, permissions?: unknown } } }).__vitehubAgentSettings
}

describe("colocated Agent instructions", () => {
  const model = {} as never

  it("adds instructions to model Agents without a Workspace", () => {
    const agent = defineAgent({ driver: { model }, runtime: false })
    const resolved = agentWithColocatedInstructions(agent, "Estimate the meal.")

    expect(resolved).not.toBe(agent)
    expect(settings(resolved)?.driver?.instructions).toBe("Estimate the meal.")
  })

  it("keeps explicit model Driver instructions", () => {
    const agent = defineAgent({
      driver: { instructions: "Use explicit instructions.", model },
      runtime: false,
    })

    expect(agentWithColocatedInstructions(agent, "Use colocated instructions.")).toBe(agent)
  })

  it("adds instructions to provider Agents without a Workspace", () => {
    const agent = defineAgent({ driver: { execution: { attachments: { maxBytes: 1024 } }, kind: "codex" }, runtime: false })
    const resolved = agentWithColocatedInstructions(agent, "Review the local invocation.")

    expect(resolved).not.toBe(agent)
    expect(settings(resolved)?.driver?.instructions).toBe("Review the local invocation.")
    expect(settings(resolved)?.driver?.execution).toEqual({ attachments: { maxBytes: 1024 } })
    expect(settings(resolved)?.driver?.permissions).toBe("ask")
  })

  it("preserves properties and descriptors added to an Agent Definition", () => {
    const agent = defineAgent({ driver: { model }, runtime: false })
    const resolve = async () => ({ generate: async () => ({ text: "decorated" }) })
    const prototype = {
      get pluginName() {
        return "review"
      },
    }
    Object.setPrototypeOf(agent, prototype)
    Object.defineProperties(agent, {
      pluginMetadata: {
        configurable: false,
        enumerable: false,
        value: { plugin: "review" },
        writable: false,
      },
      resolve: {
        configurable: true,
        enumerable: true,
        value: resolve,
        writable: true,
      },
    })

    const decorated = agentWithColocatedInstructions(agent, "Use colocated instructions.") as typeof agent & {
      pluginMetadata: { plugin: string }
      pluginName: string
    }

    expect(Object.getPrototypeOf(decorated)).toBe(prototype)
    expect(decorated.pluginName).toBe("review")
    expect(decorated.resolve).toBe(resolve)
    expect(decorated.pluginMetadata).toEqual({ plugin: "review" })
    expect(Object.getOwnPropertyDescriptor(decorated, "pluginMetadata")).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    })
    expect(settings(decorated)?.driver?.instructions).toBe("Use colocated instructions.")
  })

  it("leaves Workspace and custom-run Agents to their existing instruction surfaces", () => {
    const workspaceAgent = defineAgent({ driver: { model }, runtime: false, workspace: {} })
    const runAgent = defineAgent({ driver: { run: () => "done" }, runtime: false })

    expect(agentWithColocatedInstructions(workspaceAgent, "Workspace instructions.")).toBe(workspaceAgent)
    expect(agentWithColocatedInstructions(runAgent, "Run instructions.")).toBe(runAgent)
  })

  it("loads instructions in the Vite Agent Dev Loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-colocated-instructions-"))
    const handler = join(root, "reviewer", "agent.ts")
    try {
      await mkdir(join(root, "reviewer"), { recursive: true })
      await writeFile(handler, "export default {}", "utf8")
      await writeFile(join(root, "reviewer", "instructions.md"), "Review the local invocation.\n", "utf8")
      const agent = defineAgent({ driver: { model }, runtime: false })
      const server = {
        ssrLoadModule: async () => ({ default: agent }),
      } as unknown as ViteDevServer

      const loaded = await loadViteAgent(server, {
        handler,
        name: "reviewer",
      } as DiscoveredAgentDefinition)

      expect(settings(loaded?.agent)?.driver?.instructions).toBe("Review the local invocation.\n")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
