import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = resolve(packageRoot, "../runtime")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

it("publishes the Workflow error contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    for (const [name, sourceRoot] of [["workflow", packageRoot], ["runtime", runtimeRoot]] as const) {
      const installedPackageRoot = join(root, "node_modules", "@vite-hub", name)
      await mkdir(installedPackageRoot, { recursive: true })
      await copyFile(join(sourceRoot, "package.json"), join(installedPackageRoot, "package.json"))
      await cp(join(sourceRoot, "dist"), join(installedPackageRoot, "dist"), { recursive: true })
    }

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("keeps Effect internals out of published Workflow artifacts", async () => {
  const dist = resolve(packageRoot, "dist")
  const files = (await readdir(dist, { recursive: true }))
    .filter(path => /\.(?:[cm]?js|d\.ts)$/.test(path))
  const output = (await Promise.all(files.map(path => readFile(join(dist, path), "utf8")))).join("\n")
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>

  expect(output).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']effect(?:\/[^"']*)?["']/)
  expect(output).not.toContain("FiberFailure")
  expect(manifest.dependencies?.effect).toBeUndefined()
  expect(manifest.devDependencies?.effect).toBeUndefined()
  expect(manifest.optionalDependencies?.effect).toBeUndefined()
  expect(manifest.peerDependencies?.effect).toBeUndefined()
})

it("keeps built Workflow error boundaries safe for hostile inputs and mutation", async () => {
  const { ApplicationWorkflowError, WorkflowError } = await import("../dist/index.js")
  const secret = "https://user:token@example.com/private"
  const builtIn = new WorkflowError({
    code: "WORKFLOW_DISABLED",
    details: { token: secret, value: 1n },
    message: secret,
  } as never)
  const application = new ApplicationWorkflowError({
    code: "CUSTOM_WORKFLOW_FAILURE",
    details: { context: { operation: "start" } },
    message: "Custom workflow failure.",
  })
  class DerivedWorkflowError extends WorkflowError<"WORKFLOW_DISABLED"> {
    readonly metadata = "consumer-owned"
  }
  const derived = new DerivedWorkflowError({ code: "WORKFLOW_DISABLED" })

  expect(Reflect.set(builtIn, "message", secret)).toBe(false)
  expect(Reflect.set(application.details!.context, "operation", secret)).toBe(false)
  expect(derived.metadata).toBe("consumer-owned")
  expect(derived.toJSON()).toEqual({ code: "WORKFLOW_DISABLED", message: "Workflow is disabled." })
  expect(Object.getOwnPropertyDescriptor(derived, "toJSON")).toMatchObject({
    configurable: false,
    enumerable: false,
    writable: false,
  })
  expect(JSON.stringify(builtIn)).not.toContain(secret)
  expect(JSON.stringify(application)).not.toContain(secret)
  expect(() => new ApplicationWorkflowError({
    code: "CUSTOM_WORKFLOW_FAILURE",
    details: { value: 1n } as never,
    message: "Custom workflow failure.",
  })).toThrow("ApplicationWorkflowError details")
})
