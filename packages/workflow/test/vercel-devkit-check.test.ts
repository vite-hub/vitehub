import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { workflowErrorDiagnostics } from "../src/error-diagnostics.ts"
import { hasVercelNativeWorkflowEntry } from "../src/internal/vite-build.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function hidePackage(packageName: string) {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) return nextResolve(specifier, context)
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" })
    },
  })
  return () => hooks.deregister()
}

async function folderWorkflow() {
  const rootDir = await createTempDir("vitehub-workflow-devkit-check-")
  const workflowDir = join(rootDir, "server", "workflows", "recap")
  await mkdir(workflowDir, { recursive: true })
  await writeFile(join(workflowDir, "01-collect.ts"), "export default async (input: { month: string }) => input\n")
  const nativeFile = join(rootDir, ".vitehub", "workflow", "vercel-native", "recap.mjs")
  await mkdir(join(nativeFile, ".."), { recursive: true })
  await writeFile(nativeFile, `export async function RecapNative(context) {\n  "use workflow"\n  return context.payload\n}\n`)
  return { definitions: [{ handler: workflowDir, name: "recap", source: "vite-suffix" as const, steps: [join(workflowDir, "01-collect.ts")] }], nativeFile, rootDir }
}

it("stops a native Vercel Workflow with a coded error when the app did not install the Workflow DevKit", async () => {
  const { definitions, nativeFile, rootDir } = await folderWorkflow()
  const restore = hidePackage("workflow")
  let error: unknown
  try {
    hasVercelNativeWorkflowEntry(rootDir, definitions, {}, [nativeFile])
  }
  catch (caught) {
    error = caught
  }
  finally {
    restore()
  }
  expect(workflowErrorDiagnostics.WORKFLOW_R0006.is(error)).toBe(true)
  expect(error).toHaveProperty("message", expect.stringContaining("Install them in your app with: pnpm add workflow @workflow/builders"))
})

it("detects the native Vercel Workflow when the Workflow DevKit is installed", async () => {
  const { definitions, nativeFile, rootDir } = await folderWorkflow()
  expect(hasVercelNativeWorkflowEntry(rootDir, definitions, {}, [nativeFile])).toBe(true)
})

it("does not ask for the Workflow DevKit when no Workflow is native", async () => {
  const rootDir = await createTempDir("vitehub-workflow-devkit-inline-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `export default defineWorkflow({ handler: async () => "inline" })\n`)
  const restore = hidePackage("workflow")
  try {
    expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(false)
  }
  finally {
    restore()
  }
})
