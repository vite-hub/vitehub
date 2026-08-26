import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { createWorkflowRegistryContents } from "../src/internal/vite-build.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("Workflow registry", () => {
  it("renders, caches, and executes step-aware definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-registry-"))
    directories.push(root)
    const workflowDirectory = join(root, "server", "workflows", "release")
    const registryFile = join(root, ".vitehub", "workflow", "registry.mjs")
    const handler = join(workflowDirectory, "index.mjs")
    const step = join(workflowDirectory, "01.add.mjs")
    await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
    await mkdir(dirname(registryFile), { recursive: true })
    await mkdir(workflowDirectory, { recursive: true })
    await symlink(packageRoot, join(root, "node_modules", "@vite-hub", "workflow"), "dir")
    await writeFile(handler, "export default { handler: async ({ payload, steps }) => await steps.add(payload), options: { owner: 'workflow' } }\n", "utf8")
    await writeFile(step, "export default async function add(value) { return value + 1 }\n", "utf8")

    const contents = createWorkflowRegistryContents(registryFile, [{
      handler,
      name: "release",
      source: "server-workflows",
      steps: [step],
    }])

    expect(contents).toBe([
      'import { createWorkflowSteps } from "@vite-hub/workflow/runtime/execute"',
      'import { takeInlineWorkflowDefinitionForModule } from "@vite-hub/workflow/runtime/state"',
      "",
      "const registryEntryCache = new Map()",
      "",
      "const registry = {",
      '  "release": async () => {',
      '    const cached = registryEntryCache.get("release")',
      "    if (cached) return cached",
      '    const index = await import("../../server/workflows/release/index.mjs")',
      '    const steps = [{ name: "01.add.mjs", run: (await import("../../server/workflows/release/01.add.mjs")).default }]',
      '    const definition = index.default?.handler ? index.default : takeInlineWorkflowDefinitionForModule("release", index) || { handler: index.default }',
      "    const entry = {",
      "      ...definition,",
      "      options: { ...definition.options, rootStep: false },",
      "      handler: async (context) => {",
      "        const workflowSteps = createWorkflowSteps(context, steps)",
      "        return await definition.handler({ ...context, steps: workflowSteps })",
      "      },",
      "    }",
      '    registryEntryCache.set("release", entry)',
      "    return entry",
      "  },",
      "}",
      "",
      "export default registry",
      "",
    ].join("\n"))

    await writeFile(registryFile, contents, "utf8")
    const generated = await import(`${pathToFileURL(registryFile).href}?test=workflow-owner`)
    const registry = generated.default as Record<string, () => Promise<{
      handler: (context: { name: string, payload: number, provider: "openworkflow" }) => Promise<number>
      options: { owner: string, rootStep: false }
    }>>
    const definition = await registry.release!()
    await expect(definition.handler({ name: "release", payload: 1, provider: "openworkflow" })).resolves.toBe(2)
    expect(definition.options).toEqual({ owner: "workflow", rootStep: false })
    await expect(registry.release!()).resolves.toBe(definition)
  })
})
