import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { listViteHubDevtoolsFeatures } from "@vite-hub/devtools"
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

  it("discovers server agent files and colocated workspace configs", async () => {
    const root = await createTempRoot("vitehub-agent-server-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "server-agents" }),
    ])
  })

  it("ignores eval definitions during server agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-server-eval-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "support", "config.eval.ts"), "export default defineEval({})", "utf8")
    await writeFile(join(root, "server", "agents", "support", "eval.ts"), "export default defineEval({})", "utf8")
    await writeFile(join(root, "server", "agents", "support.eval.ts"), "export default defineEval({})", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "support", source: "server-agent-workspace", workspace: "support" }),
    ])
  })

  it("uses folder identity for colocated workspace agents", async () => {
    const root = await createTempRoot("vitehub-agent-workspace-name-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, name: 'context', model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
    ])
  })

  it("throws on duplicate server agent names", async () => {
    const root = await createTempRoot("vitehub-agent-duplicate-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "support.js"), "export default {}", "utf8")

    expect(() => discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toThrow("Duplicate agent name")
  })
})

describe("agent chat capability discovery", () => {
  it("discovers chat-capable agents through normal Agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-chat-identity-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export default defineAgent({",
      "  name: 'renamed-support',",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export default defineAgent({",
      "  name: 'renamed-docs',",
      "  workspace: {},",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agent.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export const legacy = defineAgent({ capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })] })",
    ].join("\n"), "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "server-agents" }),
    ])
  })

  it("registers the chat devtools feature through hubAgent by default", async () => {
    const plugin = (await import("../src/vite.ts")).hubAgent()
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
        packageName: "@vite-hub/agent",
        title: "Chat",
      },
    ])
    expect(ctx.rpc.register).toHaveBeenCalledTimes(3)
  })

  it("skips chat devtools feature and bridge when package-local devtools are disabled", async () => {
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    const ctx = {
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    }

    await plugin.devtools?.setup?.(ctx as never)

    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([])
    expect(ctx.rpc.register).not.toHaveBeenCalled()
  })

})
