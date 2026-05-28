import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { listViteHubDevtoolsFeatures } from "@vitehub/devtools"
import { discoverAgentDefinitions } from "../src/discovery.ts"
import { discoverChatDefinitions } from "../src/chat/discovery.ts"

import type { ConfigPluginContext } from "vite"

async function createTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function resolveChatViteConfig(input: Record<string, unknown> = {}) {
  const plugin = (await import("../src/chat/vite.ts")).hubChat()
  if (typeof plugin.config !== "function") {
    throw new TypeError("hubChat config hook is not callable")
  }

  return await plugin.config.call({} as ConfigPluginContext, input, {
    command: "serve",
    isPreview: false,
    isSsrBuild: false,
    mode: "development",
  }) as { resolve?: { alias?: Record<string, string> } }
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

  it("ignores server agent aggregate files", async () => {
    const root = await createTempRoot("vitehub-agent-deprecated-")
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "server", "agent.ts"), "export const support = {}", "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([])
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
    await module.setup({
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
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    } as never)

    const registryFile = join(root, buildDir, ".vitehub", "nitro-runtime", "agent", "nitro-registry.ts")
    const routeFile = join(root, buildDir, ".vitehub", "nitro-runtime", "agent", "route-handler.ts")

    await expect(readFile(registryFile, "utf8")).resolves.toContain("server/agents/docs/config.ts")
    await expect(readFile(routeFile, "utf8")).resolves.toContain("./nitro-registry.ts")
    expect(hooks).toHaveLength(2)
  })
})

describe("agent chat discovery", () => {
  it("discovers agents that expose chat only through capabilities", async () => {
    const root = await createTempRoot("vitehub-agent-chat-capability-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      "import { chat, defineAgent } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")

    expect(discoverChatDefinitions({
      mode: "nitro-server-chats",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({
        name: "support",
        source: "nitro-server-agent-chat",
      }),
    ])
  })

  it("uses Agent file and folder identity for discovered Agent Chat definitions", async () => {
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

    expect(discoverChatDefinitions({
      mode: "nitro-server-chats",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "nitro-server-agent-chat", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "nitro-server-agent-chat" }),
    ])
  })

  it("generates package imports for workspace chat agents", async () => {
    const root = await createTempRoot("vitehub-agent-chat-runtime-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })], model })", "utf8")

    const module = (await import("../src/chat/nitro/module.ts")).default
    await module.setup({
      hooks: {
        hook() {},
      },
      options: {
        buildDir,
        chat: { webhook: true },
        handlers: [],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    } as never)

    const routeFile = join(root, buildDir, ".vitehub", "nitro-runtime", "chat", "webhook-handler.ts")

    await expect(readFile(routeFile, "utf8")).resolves.toContain('from "@vitehub/agent"')
  })

  it("registers the chat devtools bridge through hubChat by default", async () => {
    const root = await createTempRoot("vitehub-agent-chat-devtools-")
    const buildDir = ".nitro"
    const plugin = (await import("../src/chat/vite.ts")).hubChat()
    const hooks: Array<() => Promise<void> | void> = []
    const nitro = {
      hooks: {
        hook(_name: string, handler: () => Promise<void> | void) {
          hooks.push(handler)
        },
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
    expect(hooks.length).toBeGreaterThan(0)
  })

  it("generates the Nitro chat devtools bridge from the discovered chat registry", async () => {
    const root = await createTempRoot("vitehub-agent-chat-nitro-devtools-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), [
      "import { chat, defineAgent } from '@vitehub/agent'",
      "export default defineAgent({",
      "  workspace: {},",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "  provider: 'ai-sdk',",
      "})",
    ].join("\n"), "utf8")

    const module = (await import("../src/chat/nitro/module.ts")).default
    const hooks: Array<() => Promise<void> | void> = []
    const nitro = {
      hooks: {
        hook(_name: string, handler: () => Promise<void> | void) {
          hooks.push(handler)
        },
      },
      options: {
        buildDir,
        chat: {},
        dev: true,
        handlers: [],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await module.setup?.(nitro as never)
    for (const hook of hooks) await hook()

    const devtoolsFile = join(root, buildDir, ".vitehub", "nitro-runtime", "chat", "devtools-handler.ts")
    await expect(readFile(devtoolsFile, "utf8")).resolves.toContain("defineChatDevtoolsRegistryHandler")
    await expect(readFile(devtoolsFile, "utf8")).resolves.toContain("./nitro-registry.ts")
    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        handler: devtoolsFile,
        method: "POST",
        route: "/__vitehub/agent/chat/devtools",
      }),
    ]))
  })

  it("does not register the generated chat devtools bridge outside Nitro dev mode", async () => {
    const root = await createTempRoot("vitehub-agent-chat-nitro-prod-devtools-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), [
      "import { chat, defineAgent } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "  provider: 'ai-sdk',",
      "})",
    ].join("\n"), "utf8")

    const module = (await import("../src/chat/nitro/module.ts")).default
    const hooks: Array<() => Promise<void> | void> = []
    const nitro = {
      hooks: {
        hook(_name: string, handler: () => Promise<void> | void) {
          hooks.push(handler)
        },
      },
      options: {
        buildDir,
        chat: {},
        dev: false,
        handlers: [],
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await module.setup?.(nitro as never)
    for (const hook of hooks) await hook()

    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "/__vitehub/agent/chat/devtools",
      }),
    ]))
  })

  it("deduplicates chat devtools bridge handlers by method and route", async () => {
    const root = await createTempRoot("vitehub-agent-chat-devtools-dedupe-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })] })", "utf8")

    const module = (await import("../src/chat/nitro/module.ts")).default
    const hooks: Array<() => Promise<void> | void> = []
    const nitro = {
      hooks: {
        hook(_name: string, handler: () => Promise<void> | void) {
          hooks.push(handler)
        },
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

    await module.setup?.(nitro as never)
    for (const hook of hooks) await hook()

    expect(nitro.options.handlers.filter(handler => handler.method === "POST" && handler.route === "/__vitehub/agent/chat/devtools")).toHaveLength(1)
  })

  it("registers the chat devtools feature through hubChat by default", async () => {
    const plugin = (await import("../src/chat/vite.ts")).hubChat()
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

  it("keeps the dev config scoped to runtime aliases", async () => {
    const config = await resolveChatViteConfig({
      resolve: {
        alias: {
          vue: "/app/vue.js",
        },
      },
    })

    expect(config.resolve?.alias?.vue).toBeUndefined()
    expect(config.resolve?.alias?.["cloudflare:workers"]).toContain("cloudflare-workers-dev")
  })

  it("skips chat devtools feature and bridge when package-local devtools are disabled", async () => {
    const root = await createTempRoot("vitehub-agent-chat-devtools-disabled-")
    const buildDir = ".nitro"
    const plugin = (await import("../src/chat/vite.ts")).hubChat({ devtools: false })
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

  it("exports chat presets from the agent package build", async () => {
    const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "../package.json"), "utf8"))
    const tsdownConfig = await readFile(join(import.meta.dirname, "../tsdown.config.ts"), "utf8")

    expect(packageJson.exports["./chat/presets"]).toBe("./dist/chat/presets.js")
    expect(tsdownConfig).toContain('"src/chat/presets.ts"')
  })
})
