import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { workflowRuntimeModule } from "../src/internal/runtime-modules.ts"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { discoverWorkflowDefinitions } from "../src/discovery.ts"
import { createWorkflowRegistryContents } from "../src/internal/vite-build.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("Workflow registry", () => {
  it("loads a discovered index-only folder as an orchestrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-registry-index-"))
    directories.push(root)
    const server = join(root, "server")
    const folder = join(server, "workflows", "approval")
    const registryFile = join(root, "registry.mjs")
    await mkdir(folder, { recursive: true })
    await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
    await symlink(packageRoot, join(root, "node_modules", "@vite-hub", "workflow"), "dir")
    await writeFile(join(folder, "index.ts"), "export default async ({ createSignal }) => await createSignal().wait()\n")
    await writeFile(registryFile, createWorkflowRegistryContents(registryFile, discoverWorkflowDefinitions({ mode: "server-workflows", scanDirs: [server] })))

    const { default: registry } = await import(pathToFileURL(registryFile).href)
    const definition = await registry.approval()
    expect(definition.rootStep).toBe(false)
    await expect(definition.handler({ createSignal: () => ({ wait: async () => "approved" }) })).resolves.toBe("approved")
  })

  it.each(["plain", "steps", "agent"] as const)("preserves prototype-like names for %s definitions", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-registry-name-"))
    directories.push(root)
    const registryFile = join(root, "registry.mjs")
    const handler = join(root, "definition.mjs")
    const step = join(root, "step.mjs")
    await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
    await symlink(packageRoot, join(root, "node_modules", "@vite-hub", "workflow"), "dir")
    await symlink(resolve(packageRoot, "../agent"), join(root, "node_modules", "@vite-hub", "agent"), "dir")
    await writeFile(handler, "export default { handler: async () => 'ok' }\n", "utf8")
    await writeFile(step, "export default async function step(value) { return value }\n", "utf8")
    await writeFile(registryFile, createWorkflowRegistryContents(registryFile, [{
      handler,
      name: "__proto__",
      source: kind === "agent" ? "agent-workflow" : "server-workflows",
      ...(kind === "steps" ? { steps: [step] } : {}),
    }], {
      agent: {
        index: resolve(packageRoot, "../agent/dist/index.js"),
        runtimeWorkflow: resolve(packageRoot, "../agent/dist/runtime/workflow.js"),
        serverInternal: resolve(packageRoot, "../agent/dist/server/internal.js"),
      },
    }), "utf8")

    const generated = await import(pathToFileURL(registryFile).href)
    expect(Object.keys(generated.default)).toEqual(["__proto__"])
    expect(Object.hasOwn(generated.default, "__proto__")).toBe(true)
  }, 15_000)

  // A Workflow-only app does not install `@vite-hub/workspace`, so an import with no loaders breaks its build.
  it("imports the Workspace runtime only for the Shell loader", () => {
    const definitions = [{ handler: "/app/server/workflows/hello.ts", name: "hello", source: "server-workflows" as const }]
    const workspaceRuntime = "vite-hub/workspace/runtime"

    const withoutLoaders = createWorkflowRegistryContents("/app/.vitehub/workflow/registry.mjs", definitions, {
      workspaceDependencies: {},
      workspaceRuntime,
    })
    const withShell = createWorkflowRegistryContents("/app/.vitehub/workflow/registry.mjs", definitions, {
      workspaceDependencies: { shellWorkspace: "vite-hub/shell/workspace" },
      workspaceRuntime,
    })
    // `vitehub()` hands the Workflow the same loader object as the Agent, which can name Sandbox Task modules.
    const frameworkLoaders: { sandboxTask: string, sandboxTaskRuntimeState: string, shellWorkspace?: string } = {
      sandboxTask: "vite-hub/sandbox/task",
      sandboxTaskRuntimeState: "/sandbox/dist/task/runtime/state.js",
    }
    const withSandboxTask = createWorkflowRegistryContents("/app/.vitehub/workflow/registry.mjs", definitions, {
      workspaceDependencies: frameworkLoaders,
      workspaceRuntime,
    })

    expect(withoutLoaders).not.toContain(workspaceRuntime)
    expect(withoutLoaders).not.toContain("setWorkspaceDependencyRuntimeLoaders")
    expect(withSandboxTask).not.toContain(workspaceRuntime)
    expect(withSandboxTask).not.toContain("sandbox")
    expect(withShell).toContain(`import { setWorkspaceDependencyRuntimeLoaders } from ${JSON.stringify(workspaceRuntime)}`)
    expect(withShell).toContain("  shellWorkspace: () => import(\"vite-hub/shell/workspace\"),")
  })

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
    await writeFile(handler, "export default { handler: async ({ payload, steps }) => await steps.add(payload), owner: 'workflow' }\n", "utf8")
    await writeFile(step, "export default async function add(value) { return value + 1 }\n", "utf8")

    const contents = createWorkflowRegistryContents(registryFile, [{
      handler,
      name: "release",
      source: "server-workflows",
      steps: [step],
    }])

    expect(contents).toBe([
      `import { createWorkflowSteps } from ${JSON.stringify(workflowRuntimeModule("execute"))}`,
      `import { takeInlineWorkflowDefinitionForModule } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
      "",
      "const registryEntryCache = new Map()",
      "",
      "const registry = {",
      '  ["release"]: async () => {',
      '    const cached = registryEntryCache.get("release")',
      "    if (cached) return cached",
      `    const index = await import(${JSON.stringify(pathToFileURL(handler).href)})`,
      `    const steps = [{ name: "01.add.mjs", ...await import(${JSON.stringify(pathToFileURL(step).href)}).then(step => ({ options: { retries: step.retries, timeout: step.timeout }, run: step.default })) }]`,
      '    const definition = index.default?.handler ? index.default : takeInlineWorkflowDefinitionForModule("release", index) || { handler: index.default }',
      "    const entry = {",
      "      ...definition,",
      "      rootStep: false,",
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
    // SAFETY: The generated fixture above exports this exact Workflow registry contract.
    const registry = generated.default as Record<string, () => Promise<{
      handler: (context: { name: string, payload: number, provider: "openworkflow" }) => Promise<number>
      owner: string
      rootStep: false
    }>>
    const definition = await registry.release!()
    await expect(definition.handler({ name: "release", payload: 1, provider: "openworkflow" })).resolves.toBe(2)
    expect(definition).toMatchObject({ owner: "workflow", rootStep: false })
    await expect(registry.release!()).resolves.toBe(definition)
  })
})
