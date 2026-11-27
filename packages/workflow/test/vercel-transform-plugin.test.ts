import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createVercelWorkflowTransformPlugin } from "../src/internal/vite-build.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function loadHook(rootDir: string, mode?: "step"): Promise<(id: string) => Promise<unknown>> {
  const plugin = await createVercelWorkflowTransformPlugin(rootDir, undefined, undefined, mode)
  if (!plugin) throw new Error("@workflow/builders is not installed")
  const load = plugin.load
  if (typeof load !== "function") throw new TypeError("Expected the transform plugin to have a load hook.")
  // SAFETY: The hook reads no member of the plugin context.
  return async id => await load.call({} as never, id)
}

describe("Vercel Workflow transform plugin", () => {
  it("creates a startable Workflow reference without replay globals", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-transform-"))
    roots.push(rootDir)
    const workflow = join(rootDir, "welcome.mjs")
    await writeFile(workflow, `
      async function greet() {
        "use step"
        return "hello"
      }
      export async function welcome() {
        "use workflow"
        return await greet()
      }
    `)
    const load = await loadHook(rootDir, "step")

    const result = await load(workflow)
    expect(result).toMatchObject({ code: expect.stringContaining('welcome.workflowId = "workflow//./welcome//welcome"') })
    expect(result).not.toMatchObject({ code: expect.stringContaining("WORKFLOW_USE_STEP") })
  })

  it("transforms only files with Workflow code", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-transform-"))
    roots.push(rootDir)
    const plain = join(rootDir, "plain.ts")
    const steps = join(rootDir, "steps.ts")
    await writeFile(plain, "export const value: number = 1\n")
    await writeFile(steps, "export async function sendEmail() {\n  \"use step\"\n  return 1\n}\n")
    const load = await loadHook(rootDir)

    await expect(load(plain)).resolves.toBeUndefined()
    await expect(load(steps)).resolves.toMatchObject({ code: expect.any(String), moduleType: "js" })
  })
})
