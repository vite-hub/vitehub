import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

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

  it("discovers Nitro aggregate named exports and server agent files", async () => {
    const root = await createTempRoot("vitehub-agent-nitro-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agent.ts"), [
      "export const triager = {}",
      "const helper = {}",
      "export { helper as reviewer }",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "nitro-server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ exportName: "reviewer", name: "reviewer" }),
      expect.objectContaining({ name: "support", source: "nitro-server-agents" }),
      expect.objectContaining({ exportName: "triager", name: "triager" }),
    ])
  })

  it("uses literal name overrides for colocated workspace agents", async () => {
    const root = await createTempRoot("vitehub-agent-workspace-name-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, name: 'context', model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "context", source: "nitro-server-agent-workspace", workspace: "docs" }),
    ])
  })

  it("ignores deprecated server agents aggregate files", async () => {
    const root = await createTempRoot("vitehub-agent-deprecated-")
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "server", "agents.ts"), "export const support = {}", "utf8")

    expect(discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([])
  })

  it("throws on duplicate Nitro agent names", async () => {
    const root = await createTempRoot("vitehub-agent-duplicate-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agent.ts"), "export const support = {}", "utf8")
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    expect(() => discoverAgentDefinitions({
      mode: "nitro-server-agents",
      scanDirs: [join(root, "server")],
    })).toThrow("Duplicate agent name")
  })
})
