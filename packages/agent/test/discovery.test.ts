import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { listViteHubDevtoolsFeatures } from "@vitehub/devtools"
import { discoverAgentDefinitions } from "../src/discovery.ts"

async function createTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix))
}

describe("agent discovery", () => {
  it("discovers Vite suffix agents without scanning server files", async () => {
    const root = await createTempRoot("vitehub-agent-vite-")
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "src", "triager.agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "ignored.agent.ts"), "export default {}", "utf8")

    expect(discoverAgentDefinitions({ rootDir: root })).toEqual([
      expect.objectContaining({
        name: "triager",
        source: "vite-suffix",
      }),
    ])
  })

  it("discovers Nitro server agent files and colocated workspace configs", async () => {
    const root = await createTempRoot("vitehub-agent-nitro-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "nitro-server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "nitro-server-agents" }),
    ])
  })

  it("uses folder identity for colocated workspace agents", async () => {
    const root = await createTempRoot("vitehub-agent-workspace-name-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, name: 'context', model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "nitro-server-agent-workspace", workspace: "docs" }),
    ])
  })

  it("throws on duplicate Nitro agent names", async () => {
    const root = await createTempRoot("vitehub-agent-duplicate-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "support.js"), "export default {}", "utf8")

    expect(() => discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toThrow("Duplicate agent name")
  })
})

describe("agent Nitro runtime files", () => {
  it("generates TypeScript runtime files so discovered TypeScript agents stay in the TS build graph", async () => {
    const root = await createTempRoot("vitehub-agent-nitro-runtime-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    const module = (await import("../src/nitro/module.ts")).default
    const hooks: Array<() => Promise<void> | void> = []
    const nitro = {
      hooks: {
        hook(_name: string, handler: () => Promise<void> | void) {
          hooks.push(handler)
        },
      },
      options: {
        agent: { route: true },
        buildDir,
        handlers: [],
        imports: {},
        alias: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }
    await module.setup(nitro as never)

    const registryFile = join(root, buildDir, ".vitehub", "nitro-runtime", "agent", "nitro-registry.ts")
    const routeFile = join(root, buildDir, ".vitehub", "nitro-runtime", "agent", "route-handler.ts")

    await expect(readFile(registryFile, "utf8")).resolves.toContain("server/agents/docs/config.ts")
    await expect(readFile(routeFile, "utf8")).resolves.toContain("./nitro-registry.ts")
    expect((nitro.options.alias as Record<string, string>)["@vitehub/agent/capabilities"]).toContain("/packages/agent/src/capabilities.ts")
    expect((nitro.options.alias as Record<string, string>)["@vitehub/agent/eval"]).toContain("/packages/agent/src/eval.ts")
    expect(hooks).toHaveLength(2)
  })
})

describe("agent chat capability discovery", () => {
  it("discovers chat-capable agents through normal Agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-chat-identity-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      "import { chat, defineAgent } from '@vitehub/agent'",
      "export default defineAgent({",
      "  name: 'renamed-support',",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), [
      "import { chat, defineAgent } from '@vitehub/agent'",
      "export default defineAgent({",
      "  name: 'renamed-docs',",
      "  workspace: {},",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agent.ts"), [
      "import { chat, defineAgent } from '@vitehub/agent'",
      "export const legacy = defineAgent({ capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })] })",
    ].join("\n"), "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "nitro-server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "nitro-server-agents" }),
    ])
  })

  it("registers the chat devtools bridge through hubChatDevtools by default", async () => {
    const root = await createTempRoot("vitehub-agent-chat-devtools-")
    const buildDir = ".nitro"
    const plugin = (await import("../src/vite.ts")).hubChatDevtools()
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
      options: {
        buildDir,
        dev: true,
        handlers: [],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await plugin.nitro.setup?.(nitro as never)

    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "POST",
        route: "/__vitehub/agent/chat/devtools",
      }),
    ]))
  })

  it("deduplicates chat devtools bridge handlers by method and route", async () => {
    const root = await createTempRoot("vitehub-agent-chat-devtools-dedupe-")
    const buildDir = ".nitro"
    const plugin = (await import("../src/vite.ts")).hubChatDevtools()
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
      options: {
        buildDir,
        chat: {},
        dev: true,
        handlers: [{
          handler: "/existing/chat-devtools-handler.ts",
          method: "POST",
          route: "/__vitehub/agent/chat/devtools",
        }],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await plugin.nitro.setup?.(nitro as never)

    expect(nitro.options.handlers.filter(handler => handler.method === "POST" && handler.route === "/__vitehub/agent/chat/devtools")).toHaveLength(1)
  })

  it("registers the chat devtools feature through hubChatDevtools by default", async () => {
    const plugin = (await import("../src/vite.ts")).hubChatDevtools()
    const ctx = {
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    }

    await plugin.devtools?.setup?.(ctx as never)

    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([
      {
        bridge: "/__vitehub/agent/chat/devtools",
        icon: "ph:chat-circle-duotone",
        id: "agent.chat",
        packageName: "@vitehub/agent",
        title: "Chat",
      },
    ])
    expect(ctx.rpc.register).toHaveBeenCalledTimes(3)
  })

  it("skips chat devtools feature and bridge when package-local devtools are disabled", async () => {
    const root = await createTempRoot("vitehub-agent-chat-devtools-disabled-")
    const buildDir = ".nitro"
    const plugin = (await import("../src/vite.ts")).hubChatDevtools({ devtools: false })
    const ctx = {
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    }
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
      options: {
        buildDir,
        dev: true,
        handlers: [],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await plugin.devtools?.setup?.(ctx as never)
    await plugin.nitro.setup?.(nitro as never)

    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([])
    expect(ctx.rpc.register).not.toHaveBeenCalled()
    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "/__vitehub/agent/chat/devtools",
      }),
    ]))
  })

})
