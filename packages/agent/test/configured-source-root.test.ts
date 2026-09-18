import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { transform } from "esbuild"
import { expect, it } from "vitest"

import { getAgentLayerOptions, inheritAgentLayerOptions } from "../src/agent-layers.ts"
import { defineAgent } from "../src/index.ts"
import { hubAgent } from "../src/vite.ts"
import { workspaceAgentWithSourceRoot, workspaceDefinitionFromOptions } from "../src/workspace-agent.ts"

function checkReconfiguredRoot(decorate: typeof workspaceAgentWithSourceRoot) {
  const preset = defineAgent({
    options: { customRoot: true },
    configure: options => defineAgent({
      driver: "codex",
      workspace: options.customRoot ? { sourceRootDir: "/configured" } : {},
    }),
  })
  const discovered = decorate(preset, "/discovered", "Repository instructions.")
  expect(getAgentLayerOptions(discovered)?.workspace).toHaveProperty("sourceRootDir", "/configured")

  const child = defineAgent({ extends: discovered, options: { customRoot: false } })
  expect(getAgentLayerOptions(child)?.workspace).toMatchObject({
    sourceRootDir: "/discovered",
    sources: { __vitehubAgentInstructions: { content: "Repository instructions." } },
  })
  expect(getAgentLayerOptions(discovered)?.workspace).toHaveProperty("sourceRootDir", "/configured")
}

it("restores the discovered source root when a configured runtime root is removed", () => {
  checkReconfiguredRoot(workspaceAgentWithSourceRoot)
})

it("restores the discovered source root through the generated deployment helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-configured-source-root-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), "export default defineAgent({ workspace: {} })")
    const plugin = hubAgent({ runtime: "deno" })
    if (typeof plugin.configResolved !== "function") throw new Error("Expected configResolved hook")
    // SAFETY: The generation hook only needs the fixture's project root here.
    await plugin.configResolved.call({} as never, { root } as never)

    const generated = await readFile(join(root, ".vitehub", "agent", "deno-server.ts"), "utf8")
    const helper = generated.match(/function withWorkspaceSourceRoot[\s\S]*?\n}/)?.[0]
    if (!helper) throw new Error("Expected generated Workspace source-root helper")
    const { code } = await transform(helper, { loader: "ts", format: "esm" })
    // SAFETY: Execute the generated helper with the same runtime dependencies as production.
    const decorate = new Function("inheritAgentLayerOptions", "workspaceDefinitionFromOptions", `${code}\nreturn withWorkspaceSourceRoot`)(
      inheritAgentLayerOptions,
      workspaceDefinitionFromOptions,
    ) as typeof workspaceAgentWithSourceRoot
    checkReconfiguredRoot(decorate)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
