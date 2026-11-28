import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, it } from "vitest"

import { finalizeDeploymentPlanOutput } from "../src/build/deployment-plan-output.ts"
import { createSuffixDefinitionSource, discoverDefinitions, normalizeSuffixDefinitionName } from "../src/definition-catalog.ts"
import { assertDeploymentService, resolveDeploymentPlan } from "../src/deployment.ts"
import { internalErrorDiagnostics } from "../src/error-diagnostics.ts"

const fixedCodes = [
  "INTERNAL_B0015",
  "INTERNAL_B0025",
  "INTERNAL_B0026",
  "INTERNAL_B0027",
  "INTERNAL_B0040",
  "INTERNAL_B0043",
  "INTERNAL_C0001",
  "INTERNAL_C0002",
  "INTERNAL_R0001",
  "INTERNAL_R0002",
] as const

const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-internal-error-fixes-"))
  tempDirs.push(dir)
  return dir
}

async function writeJob(root: string, name: string) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${name}.job.ts`), "export default {}\n", "utf8")
}

function jobSource(source: string, roots: string[]) {
  return createSuffixDefinitionSource(source, roots, /\.job\.ts$/g, (root, file) => normalizeSuffixDefinitionName(root, file, /\.job\.ts$/))
}

it("gives each developer-facing Internal code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = internalErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to rename one of two files with the same Definition name", async () => {
  const dir = await createTempDir()
  await writeJob(join(dir, "app"), "report")
  await writeJob(join(dir, "layer"), "report")

  expect(() => discoverDefinitions("job", [jobSource("app", [join(dir, "app"), join(dir, "layer")])])).toThrow(expect.objectContaining({
    code: "INTERNAL_C0001",
    fix: expect.stringContaining("Rename or remove one of the two files"),
  }))
})

it("tells the developer to rename one of two files that two discovery sources name the same", async () => {
  const dir = await createTempDir()
  await writeJob(join(dir, "app"), "report")
  await writeJob(join(dir, "layer"), "report")

  expect(() => discoverDefinitions("job", [jobSource("app", [join(dir, "app")]), jobSource("layer", [join(dir, "layer")])])).toThrow(expect.objectContaining({
    code: "INTERNAL_C0002",
    fix: expect.stringContaining("Rename or remove one of the two files"),
  }))
})

it("names the host option when the host cannot provide a service", () => {
  expect(() => assertDeploymentService(resolveDeploymentPlan("netlify"), "rateLimit")).toThrow(expect.objectContaining({
    code: "INTERNAL_R0002",
    fix: expect.stringContaining("set `host` in `vitehub()`"),
  }))
})

it("names the Nitro serverDir option when the host entry is missing", async () => {
  const rootDir = await createTempDir()

  await expect(finalizeDeploymentPlanOutput({ plan: resolveDeploymentPlan("node"), rootDir })).rejects.toMatchObject({
    code: "INTERNAL_B0040",
    fix: expect.stringContaining("`output.serverDir`"),
  })
})
