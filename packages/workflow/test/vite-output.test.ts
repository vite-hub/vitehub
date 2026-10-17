import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, it } from "vitest"

import { createWorkflowRegistryContents, hasVercelNativeWorkflowEntry, writeWorkflowNitroEntries } from "../src/internal/vite-build.ts"

const tempDirs: string[] = []

async function createWorkspaceTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

it("attaches startup Skills before deriving the generated Agent Workflow workspace", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-startup-skills-")
  const agentRoot = join(rootDir, "server", "agents", "review")
  const handler = join(agentRoot, "agent.ts")
  await mkdir(join(agentRoot, "skills", "review"), { recursive: true })
  await writeFile(handler, "export default {}\n")
  await writeFile(join(agentRoot, "skills", "review", "SKILL.md"), "# Review\n")

  const registry = createWorkflowRegistryContents(join(rootDir, "registry.mjs"), [
    { handler, name: "review", source: "agent-workflow" },
  ])

  expect(registry).toContain("workspaceAgentWithSourceRoot(agentWithColocatedSkills(agentWithColocatedInstructions(")
  expect(registry).toContain('"__vitehubAgentSkill:.agents/skills/review/SKILL.md":{"content":"IyBSZXZpZXcK","encoding":"base64","materialize":"startup","mount":"","workspacePath":".agents/skills/review/SKILL.md"}')
})

it("detects user-authored native Vercel workflow entries", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-native-entry-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.workflow.ts")
  const nativeFile = join(rootDir, "server", "workflows", "durable.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `import { durable } from "./durable.js"\nexport default defineWorkflow(async () => "inline", { native: durable })\n`)
  await writeFile(nativeFile, `export async function durable() {\n  "use workflow"\n}\n`)

  expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(true)
})

it("detects compact user-authored native Vercel workflow directives", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-compact-native-entry-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.workflow.ts")
  const nativeFile = join(rootDir, "server", "workflows", "durable.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `import { durable } from "./durable.js"\nexport default defineWorkflow(async () => "inline", { native: durable })\n`)
  await writeFile(nativeFile, `export async function durable() { /* durable prologue */ "use workflow"; return "durable" }\n`)

  expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(true)
})

it("detects shorthand user-authored native Vercel workflow options", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-shorthand-native-option-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.workflow.ts")
  const nativeFile = join(rootDir, "server", "workflows", "durable.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `import { durable as native } from "./durable.js"\nexport default defineWorkflow(async () => "inline", { native })\n`)
  await writeFile(nativeFile, `export async function durable() {\n  "use workflow"\n}\n`)

  expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(true)
})

it("ignores workflow directive examples in comments", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-commented-native-entry-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.workflow.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `/*\n"use workflow"\n*/\nexport default defineWorkflow(async () => "inline")\n`)

  expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(false)
})

it("ignores native entries imported only in comments", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-commented-native-import-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.workflow.ts")
  const nativeFile = join(rootDir, "server", "durable.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `// import { durable } from "../durable.js"\nexport default defineWorkflow(async () => "inline")\n`)
  await writeFile(nativeFile, `export async function durable() {\n  "use workflow"\n}\n`)

  expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(false)
})

it("ignores unrelated native functions imported by inline workflows", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-unrelated-native-import-")
  const workflowFile = join(rootDir, "server", "workflows", "welcome.workflow.ts")
  const nativeFile = join(rootDir, "server", "workflows", "durable.ts")
  await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
  await writeFile(workflowFile, `import "./durable.js"\nexport default defineWorkflow(async () => "inline")\n`)
  await writeFile(nativeFile, `export async function durable() { "use workflow" }\n`)

  expect(hasVercelNativeWorkflowEntry(rootDir, [{ handler: workflowFile, name: "welcome", source: "vite-suffix" }])).toBe(false)
})

it("keeps generated native step imports scoped to each directory Workflow", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-native-isolation-")
  for (const name of ["alpha", "beta"]) {
    const workflowDir = join(rootDir, "server", "workflows", name)
    await mkdir(workflowDir, { recursive: true })
    await writeFile(join(workflowDir, `01-${name}.ts`), `export default async function ${name}(input) { return input }\n`)
  }

  const artifacts = await writeWorkflowNitroEntries(rootDir, { provider: "vercel" })
  const nativeContents = await Promise.all(artifacts.vercelNativeFiles.map(file => readFile(file, "utf8")))

  expect(nativeContents).toHaveLength(2)
  expect(nativeContents.filter(contents => contents.includes("01-alpha.ts"))).toHaveLength(1)
  expect(nativeContents.filter(contents => contents.includes("01-beta.ts"))).toHaveLength(1)
  expect(nativeContents.every(contents => !(contents.includes("01-alpha.ts") && contents.includes("01-beta.ts")))).toBe(true)
})

it("keeps generated native module paths stable when discovery order changes", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-native-identity-")
  const betaDir = join(rootDir, "server", "workflows", "beta")
  await mkdir(betaDir, { recursive: true })
  await writeFile(join(betaDir, "01-beta.ts"), "export default async function beta(input) { return input }\n")

  const before = await writeWorkflowNitroEntries(rootDir, { provider: "vercel" })
  const [betaFile] = before.vercelNativeFiles

  const alphaDir = join(rootDir, "server", "workflows", "alpha")
  await mkdir(alphaDir, { recursive: true })
  await writeFile(join(alphaDir, "01-alpha.ts"), "export default async function alpha(input) { return input }\n")
  const after = await writeWorkflowNitroEntries(rootDir, { provider: "vercel" })

  expect(betaFile).toMatch(/\/vercel-native\/[a-f0-9]{64}\.mjs$/)
  expect(after.vercelNativeFiles).toContain(betaFile)
})

it("keeps astral Unicode native module identities distinct", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-native-unicode-")
  for (const name of ["😀", "😁"]) {
    const workflowDir = join(rootDir, "server", "workflows", name)
    await mkdir(workflowDir, { recursive: true })
    await writeFile(join(workflowDir, "01-step.ts"), "export default async function step(input) { return input }\n")
  }

  const artifacts = await writeWorkflowNitroEntries(rootDir, { provider: "vercel" })

  expect(artifacts.vercelNativeFiles).toHaveLength(2)
  expect(new Set(artifacts.vercelNativeFiles)).toHaveLength(2)
})

it("keeps suffix Workflow discovery relative to a nested Vite root", async () => {
  const projectRoot = await createWorkspaceTempDir("vitehub-workflow-project-root-")
  const viteRoot = join(projectRoot, "apps", "web")
  await mkdir(join(viteRoot, "src"), { recursive: true })
  await mkdir(join(projectRoot, "apps", "sibling", "src"), { recursive: true })
  await writeFile(join(viteRoot, "src", "cleanup.workflow.ts"), "export default defineWorkflow(async () => undefined)\n")
  await writeFile(join(projectRoot, "apps", "sibling", "src", "noise.workflow.ts"), "export default defineWorkflow(async () => undefined)\n")

  const entries = await writeWorkflowNitroEntries(projectRoot, { provider: "cloudflare" }, { definitionRootDir: viteRoot })

  expect(entries.definitions.map(definition => definition.name)).toEqual(["cleanup"])
})

it("writes a Nitro plugin that installs the registry and the Vercel Workflow modules", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-nitro-plugin-")
  await mkdir(join(rootDir, "server", "workflows", "onboard"), { recursive: true })
  await writeFile(join(rootDir, "server", "workflows", "onboard", "01-greet.ts"), "export default async function greet(input) { return input }\n")

  const entries = await writeWorkflowNitroEntries(rootDir, { provider: "vercel" }, { importBases: { workflow: "vite-hub/_internal/workflow" } })
  const plugin = await readFile(entries.pluginFile, "utf8")

  expect(entries.vercelNative).toBe(true)
  expect(entries.cloudflareEntryFile).toBeUndefined()
  expect(plugin).toContain(`from "vite-hub/_internal/workflow/runtime/vercel"`)
  expect(plugin).toContain(`setWorkflowRuntimeConfig({"provider":"vercel"})`)
  expect(plugin).toContain("setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)")
  await expect(readFile(entries.middlewareFile, "utf8")).resolves.toContain("enterWorkflowRuntimeEvent(event)")
})
