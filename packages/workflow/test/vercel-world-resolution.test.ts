import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { resolveVercelWorkflowWorld } from "../src/internal/vite-build.ts"

it("resolves the Vercel world owned by core in an isolated dependency layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-world-"))
  try {
    const workflow = join(root, "node_modules/workflow")
    const core = join(workflow, "node_modules/@workflow/core")
    const world = join(core, "node_modules/@workflow/world-vercel")
    const unrelatedWorld = join(root, "node_modules/@workflow/world-vercel")
    for (const directory of [workflow, core, world, unrelatedWorld]) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "package.json"), JSON.stringify({ main: "index.js" }))
      await writeFile(join(directory, "index.js"), "module.exports = {}\n")
    }

    expect(resolveVercelWorkflowWorld(join(workflow, "index.js"))).toBe(join(world, "index.js"))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
