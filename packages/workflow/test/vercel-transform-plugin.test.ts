import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createVercelWorkflowTransformPlugin } from "../src/internal/vite-build.ts"

import type { OnLoadArgs, OnLoadResult, PluginBuild } from "esbuild"

type LoadCallback = (args: OnLoadArgs) => Promise<OnLoadResult | null | undefined>

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function loadCallback(rootDir: string): Promise<LoadCallback> {
  const plugin = await createVercelWorkflowTransformPlugin(rootDir)
  if (!plugin) throw new Error("@workflow/builders is not installed")
  const callbacks: LoadCallback[] = []
  // SAFETY: The plugin reads only these members of the esbuild build object.
  const build = {
    initialOptions: { absWorkingDir: rootDir },
    onEnd: () => {},
    onLoad: (_options: unknown, callback: LoadCallback) => { callbacks.push(callback) },
    onResolve: () => {},
    onStart: () => {},
  } as unknown as PluginBuild
  await plugin.setup(build)
  expect(callbacks).toHaveLength(1)
  return callbacks[0]!
}

function loadArgs(path: string): OnLoadArgs {
  return { path, namespace: "file", suffix: "", pluginData: undefined, with: {} }
}

describe("Vercel Workflow transform plugin", () => {
  it("transforms only files with Workflow code", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-transform-"))
    roots.push(rootDir)
    const plain = join(rootDir, "plain.ts")
    const steps = join(rootDir, "steps.ts")
    await writeFile(plain, "export const value: number = 1\n")
    await writeFile(steps, "export async function sendEmail() {\n  \"use step\"\n  return 1\n}\n")
    const load = await loadCallback(rootDir)

    await expect(load(loadArgs(plain))).resolves.toBeUndefined()
    const transformed = await load(loadArgs(steps))
    expect(transformed?.contents).toBeTypeOf("string")
    expect(transformed?.errors).toBeUndefined()
  })
})
