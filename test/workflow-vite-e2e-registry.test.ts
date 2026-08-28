import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { prepareFeatureArtifacts } from "../playground/vite/build/vite-e2e.ts"

const workflowPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/workflow")
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

it("preserves folder steps in Vite e2e compatibility artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-vite-e2e-registry-"))
  directories.push(root)
  const workflowDirectory = join(root, "server", "workflows", "release")
  await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
  await mkdir(workflowDirectory, { recursive: true })
  await symlink(workflowPackageRoot, join(root, "node_modules", "@vite-hub", "workflow"), "dir")
  await writeFile(join(workflowDirectory, "index.mjs"), "export default { handler: async ({ payload, steps }) => await steps.add(payload) }\n", "utf8")
  await writeFile(join(workflowDirectory, "01.add.mjs"), "export default async function add(value) { return value + 1 }\n", "utf8")

  const artifacts = await prepareFeatureArtifacts({
    clientOutDir: join(root, "dist", "client"),
    hosting: "cloudflare",
    rootDir: root,
    workflow: { provider: "cloudflare" },
  })

  expect(artifacts.workflowRegistryFile).toBeDefined()
  const contents = await readFile(artifacts.workflowRegistryFile!, "utf8")
  expect(contents).toContain("createWorkflowSteps")
  const generated = await import(`${pathToFileURL(artifacts.workflowRegistryFile!).href}?test=vite-e2e-owner`)
  const definition = await generated.default.release()
  await expect(definition.handler({ name: "release", payload: 1, provider: "cloudflare" })).resolves.toBe(2)
})
