import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"
import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"

import { getCloudflareWorkflowBindingName, getCloudflareWorkflowClassName, getCloudflareWorkflowName } from "../src/integrations/cloudflare.ts"
import { cleanVercelNativeWorkflowOutput, generateProviderOutputs, hasVercelNativeWorkflowEntry, installEmailDefinitionInVercelWorkflowOutput, writeProviderEntries } from "../src/internal/vite-build.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const buildOutputTestTimeout = 60_000
const tempNodeModuleBuildDirs = new Set([".vite-temp"])
const tempDirs: string[] = []

async function writeViteHubWorkflowOwnership(workflowRoot: string, files: string[], routes: unknown[]) {
  const ownership = {
    files: Object.fromEntries(await Promise.all(files.map(async file => [
      file,
      createHash("sha256").update(await readFile(join(workflowRoot, file))).digest("hex"),
    ]))),
    routes: routes.map(route => JSON.stringify(route)),
    version: 1,
  }
  await writeFile(join(workflowRoot, ".vitehub-owned"), `${JSON.stringify(ownership)}\n`)
}

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

it("keeps suffix Workflow discovery relative to a nested Vite root", async () => {
  const projectRoot = await createWorkspaceTempDir("vitehub-workflow-project-root-")
  const viteRoot = join(projectRoot, "apps", "web")
  await mkdir(join(viteRoot, "src"), { recursive: true })
  await mkdir(join(projectRoot, "apps", "sibling", "src"), { recursive: true })
  await writeFile(join(viteRoot, "src", "cleanup.workflow.ts"), "export default defineWorkflow(async () => undefined)\n")
  await writeFile(join(projectRoot, "apps", "sibling", "src", "noise.workflow.ts"), "export default defineWorkflow(async () => undefined)\n")

  const artifacts = await writeProviderEntries(projectRoot, false, {}, undefined, false, undefined, viteRoot)

  expect(artifacts.definitions.map(definition => definition.name)).toEqual(["cleanup"])
})

it("bundles only the host-inferred Cloudflare output with Cloudflare Email imports", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-cloudflare-email-")
  const workflowDir = join(rootDir, "server", "workflows", "recap")
  const emailDefinition = join(rootDir, "email-definition.mjs")
  await mkdir(workflowDir, { recursive: true })
  await writeFile(emailDefinition, "import { EmailMessage } from 'cloudflare:email'\nexport default EmailMessage\n")
  await writeFile(join(workflowDir, "01-email.ts"), "import email from '#vitehub/email/definition'\nexport default async function send() { return email }\n")

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist", "client"),
    hosting: "cloudflare-module",
    providerImportAliases: { "#vitehub/email/definition": emailDefinition },
    rootDir,
    workflow: undefined,
  })

  await expect(readFile(join(createDefaultCloudflareOutputRoot(rootDir), "worker.mjs"), "utf8")).resolves.toContain("cloudflare:email")
  expect(existsSync(join(rootDir, ".vercel", "output", "functions", "__server.func"))).toBe(false)
})

it("keeps generated native step imports scoped to each directory Workflow", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-native-isolation-")
  for (const name of ["alpha", "beta"]) {
    const workflowDir = join(rootDir, "server", "workflows", name)
    await mkdir(workflowDir, { recursive: true })
    await writeFile(join(workflowDir, `01-${name}.ts`), `export default async function ${name}(input) { return input }\n`)
  }

  const artifacts = await writeProviderEntries(rootDir, { provider: "vercel" })
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

  const before = await writeProviderEntries(rootDir, { provider: "vercel" })
  const [betaFile] = before.vercelNativeFiles

  const alphaDir = join(rootDir, "server", "workflows", "alpha")
  await mkdir(alphaDir, { recursive: true })
  await writeFile(join(alphaDir, "01-alpha.ts"), "export default async function alpha(input) { return input }\n")
  const after = await writeProviderEntries(rootDir, { provider: "vercel" })

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

  const artifacts = await writeProviderEntries(rootDir, { provider: "vercel" })

  expect(artifacts.vercelNativeFiles).toHaveLength(2)
  expect(new Set(artifacts.vercelNativeFiles)).toHaveLength(2)
})

it("preserves WDK optional externals while installing the Email definition", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-email-bootstrap-")
  const flowFile = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "flow.func", "index.mjs")
  const emailDefinitionFile = join(rootDir, "email-definition.mjs")
  await mkdir(resolve(flowFile, ".."), { recursive: true })
  await writeFile(flowFile, `import credentials from "@aws-sdk/credential-provider-web-identity"\nexport { credentials }\nexport default async function handler() {}\n`)
  await writeFile(emailDefinitionFile, "export default { handler: async () => undefined }\n")

  await installEmailDefinitionInVercelWorkflowOutput(rootDir, emailDefinitionFile)

  const combinedFlow = await readFile(flowFile, "utf8")
  expect(combinedFlow).toContain("@aws-sdk/credential-provider-web-identity")
  expect(combinedFlow).toMatch(/globalThis\[(?:\/\*.*?\*\/\s*)?Symbol\.for\(["']vitehub\.email\.definition["']\)\]\s*=/)
  expect(combinedFlow).toMatch(/export\s*\{[^}]*\s+as\s+default/)
})

it("installs the Email definition when the WDK flow has only named exports", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-email-named-flow-")
  const flowFile = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "flow.func", "index.mjs")
  const emailDefinitionFile = join(rootDir, "email-definition.mjs")
  await mkdir(resolve(flowFile, ".."), { recursive: true })
  await writeFile(flowFile, "export async function POST() {}\n")
  await writeFile(emailDefinitionFile, "export default { handler: async () => undefined }\n")

  await installEmailDefinitionInVercelWorkflowOutput(rootDir, emailDefinitionFile)

  const combinedFlow = await readFile(flowFile, "utf8")
  expect(combinedFlow).toContain("POST")
  expect(combinedFlow).toMatch(/globalThis\[(?:\/\*.*?\*\/\s*)?Symbol\.for\(["']vitehub\.email\.definition["']\)\]\s*=/)
})

it("restores prior owned native output when Email installation fails", { timeout: buildOutputTestTimeout }, async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-email-rollback-")
  const workflowDir = join(rootDir, "server", "workflows", "recap")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  const externalFile = join(workflowRoot, "v1", "flow.func", "index.mjs")
  const externalRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  await mkdir(workflowDir, { recursive: true })
  await mkdir(resolve(externalFile, ".."), { recursive: true })
  await writeFile(join(workflowDir, "01-collect.ts"), "export default async function collect(input) { return input }\n")
  await writeFile(externalFile, "prior owned flow\n")
  await writeViteHubWorkflowOwnership(workflowRoot, ["v1/flow.func/index.mjs"], [externalRoute])
  await writeFile(configFile, `${JSON.stringify({ routes: [externalRoute] })}\n`)

  await expect(generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    importBase: "@vite-hub/workflow",
    providerImportAliases: { "#vitehub/email/definition": join(rootDir, "missing-email-definition.mjs") },
    rootDir,
    workflow: { provider: "vercel" },
  })).rejects.toThrow()

  await expect(readFile(externalFile, "utf8")).resolves.toBe("prior owned flow\n")
  const routes = JSON.parse(await readFile(configFile, "utf8")).routes
  expect(routes).toContainEqual(externalRoute)
  expect(routes.filter((route: unknown) => JSON.stringify(route).includes("/.well-known/workflow/v1/"))).toEqual([externalRoute])
  const ownership = JSON.parse(await readFile(join(workflowRoot, ".vitehub-owned"), "utf8"))
  expect(ownership.files).toHaveProperty("v1/flow.func/index.mjs")
  expect(ownership.routes).toEqual([JSON.stringify(externalRoute)])
})

it("removes stale WDK functions and routes", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-clean-wdk-")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  await mkdir(workflowRoot, { recursive: true })
  await writeFile(join(workflowRoot, "stale.mjs"), "stale\n")
  const workflowRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  const userRoute = { src: "/user", dest: "/user" }
  await writeViteHubWorkflowOwnership(workflowRoot, ["stale.mjs"], [workflowRoute])
  await writeFile(configFile, `${JSON.stringify({ routes: [workflowRoute, userRoute] })}\n`)

  await cleanVercelNativeWorkflowOutput(rootDir)

  expect(existsSync(workflowRoot)).toBe(false)
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toEqual([{ src: "/user", dest: "/user" }])
})

it("preserves WDK output that replaced a prior ViteHub build", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-replaced-wdk-")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  const workflowRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  await mkdir(workflowRoot, { recursive: true })
  await writeFile(join(workflowRoot, "v1.mjs"), "vitehub\n")
  await writeFile(join(workflowRoot, "package.json"), "{}\n")
  await writeViteHubWorkflowOwnership(workflowRoot, ["v1.mjs", "package.json"], [workflowRoute])
  await writeFile(join(workflowRoot, "v1.mjs"), "external replacement\n")
  await writeFile(join(workflowRoot, "external.mjs"), "external\n")
  await writeFile(configFile, `${JSON.stringify({ routes: [workflowRoute] })}\n`)

  await cleanVercelNativeWorkflowOutput(rootDir)

  await expect(readFile(join(workflowRoot, "v1.mjs"), "utf8")).resolves.toBe("external replacement\n")
  await expect(readFile(join(workflowRoot, "package.json"), "utf8")).resolves.toBe("{}\n")
  await expect(readFile(join(workflowRoot, "external.mjs"), "utf8")).resolves.toBe("external\n")
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toEqual([workflowRoute])
  expect(existsSync(join(workflowRoot, ".vitehub-owned"))).toBe(false)
})

it("preserves the owned output unit when an external build removes one file", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-partial-wdk-")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  const workflowRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  await mkdir(workflowRoot, { recursive: true })
  await writeFile(join(workflowRoot, "flow.mjs"), "flow\n")
  await writeFile(join(workflowRoot, "package.json"), "{}\n")
  await writeViteHubWorkflowOwnership(workflowRoot, ["flow.mjs", "package.json"], [workflowRoute])
  await rm(join(workflowRoot, "flow.mjs"))
  await writeFile(configFile, `${JSON.stringify({ routes: [workflowRoute] })}\n`)

  await cleanVercelNativeWorkflowOutput(rootDir)

  await expect(readFile(join(workflowRoot, "package.json"), "utf8")).resolves.toBe("{}\n")
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toEqual([workflowRoute])
  expect(existsSync(join(workflowRoot, ".vitehub-owned"))).toBe(false)
})

it("retries route cleanup after an interrupted owned-output cleanup", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-retry-cleanup-")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  const workflowRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  await mkdir(workflowRoot, { recursive: true })
  await writeFile(join(workflowRoot, "v1.mjs"), "vitehub\n")
  await writeViteHubWorkflowOwnership(workflowRoot, ["v1.mjs"], [workflowRoute])
  await writeFile(configFile, "invalid json\n")

  await expect(cleanVercelNativeWorkflowOutput(rootDir)).rejects.toThrow()
  expect(existsSync(join(workflowRoot, "v1.mjs"))).toBe(false)
  expect(existsSync(join(workflowRoot, ".vitehub-owned"))).toBe(true)

  await writeFile(configFile, `${JSON.stringify({ routes: [workflowRoute] })}\n`)
  await cleanVercelNativeWorkflowOutput(rootDir)

  expect(existsSync(workflowRoot)).toBe(false)
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toEqual([])
})

it("preserves Workflow DevKit output not owned by ViteHub", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-unowned-wdk-")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  const externalRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  await mkdir(workflowRoot, { recursive: true })
  await writeFile(join(workflowRoot, "external.mjs"), "external\n")
  await writeFile(configFile, `${JSON.stringify({ routes: [externalRoute] })}\n`)

  await cleanVercelNativeWorkflowOutput(rootDir)

  await expect(readFile(join(workflowRoot, "external.mjs"), "utf8")).resolves.toBe("external\n")
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toContainEqual(externalRoute)
})

it("rejects native generation that would replace unowned canonical WDK output", { timeout: buildOutputTestTimeout }, async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-generate-with-unowned-wdk-")
  const workflowDir = join(rootDir, "server", "workflows", "recap")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  const externalRoute = { src: "/.well-known/workflow/v1/external", dest: "/.well-known/workflow/v1/external" }
  const canonicalRoute = { src: "/.well-known/workflow/v1/webhook/(?<token>.*)", dest: "/.well-known/workflow/v1/webhook/[token]" }
  const canonicalFlow = join(workflowRoot, "v1", "webhook", "[token].func", "index.mjs")
  await mkdir(workflowDir, { recursive: true })
  await mkdir(workflowRoot, { recursive: true })
  await mkdir(resolve(canonicalFlow, ".."), { recursive: true })
  await writeFile(join(workflowDir, "01-collect.ts"), "export default async function collect(input) { return input }\n")
  await writeFile(join(workflowRoot, "external.mjs"), "previous ViteHub output\n")
  await writeViteHubWorkflowOwnership(workflowRoot, ["external.mjs"], [])
  await writeFile(join(workflowRoot, "external.mjs"), "external\n")
  await writeFile(canonicalFlow, "external canonical flow\n")
  await mkdir(resolve(configFile, ".."), { recursive: true })
  await writeFile(configFile, `${JSON.stringify({ routes: [externalRoute, canonicalRoute] })}\n`)

  await expect(generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    importBase: "@vite-hub/workflow",
    rootDir,
    workflow: { provider: "vercel" },
  })).rejects.toThrow(/conflicts with existing unowned Workflow DevKit functions/)

  await expect(readFile(join(workflowRoot, "external.mjs"), "utf8")).resolves.toBe("external\n")
  await expect(readFile(canonicalFlow, "utf8")).resolves.toBe("external canonical flow\n")
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toEqual([externalRoute, canonicalRoute])
})

it("removes stale WDK output when the Vercel provider is disabled", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-disable-vercel-")
  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  await mkdir(workflowRoot, { recursive: true })
  await writeFile(join(workflowRoot, "stale.mjs"), "stale\n")
  const workflowRoute = { src: "/.well-known/workflow/v1/flow", dest: "/.well-known/workflow/v1/flow" }
  const userRoute = { src: "/user", dest: "/user" }
  await writeViteHubWorkflowOwnership(workflowRoot, ["stale.mjs"], [workflowRoute])
  await writeFile(configFile, `${JSON.stringify({ routes: [workflowRoute, userRoute] })}\n`)

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    rootDir,
    workflow: { provider: "openworkflow", sqlite: { path: ":memory:" } },
  })

  expect(existsSync(workflowRoot)).toBe(false)
  expect(JSON.parse(await readFile(configFile, "utf8")).routes).toEqual([{ src: "/user", dest: "/user" }])
})

it("removes only a prior Workflow-owned Vercel function when the active host changes", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-host-transition-")

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    hosting: "vercel",
    rootDir,
    workflow: {},
  })
  const functionsRoot = join(rootDir, ".vercel", "output", "functions")
  const workflowFunction = join(functionsRoot, "__server.func")
  expect(existsSync(workflowFunction)).toBe(true)

  const externalFunction = join(functionsRoot, "external.func")
  await mkdir(externalFunction, { recursive: true })
  await writeFile(join(externalFunction, "index.mjs"), "export default { external: true }\n")

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    hosting: "cloudflare-module",
    rootDir,
    workflow: {},
  })

  expect(existsSync(workflowFunction)).toBe(false)
  await expect(readFile(join(externalFunction, "index.mjs"), "utf8")).resolves.toBe("export default { external: true }\n")
})

it("discovers and removes a prior custom-named Workflow Vercel function", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-custom-function-transition-")
  const customFunction = "__custom-workflow.func"

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    hosting: "vercel",
    rootDir,
    serverFunctionName: customFunction,
    workflow: {},
  })
  const functionRoot = join(rootDir, ".vercel", "output", "functions", customFunction)
  expect(existsSync(functionRoot)).toBe(true)

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    hosting: "cloudflare-module",
    rootDir,
    workflow: {},
  })

  expect(existsSync(functionRoot)).toBe(false)
})

it("preserves a custom-named Vercel function after ownership changes", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-custom-function-replaced-")
  const customFunction = "__custom-workflow.func"

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    hosting: "vercel",
    rootDir,
    serverFunctionName: customFunction,
    workflow: {},
  })
  const functionFile = join(rootDir, ".vercel", "output", "functions", customFunction, "index.mjs")
  await writeFile(functionFile, "export default { external: true }\n")

  await generateProviderOutputs({
    clientOutDir: join(rootDir, "dist"),
    hosting: "cloudflare-module",
    rootDir,
    workflow: {},
  })

  await expect(readFile(functionFile, "utf8")).resolves.toBe("export default { external: true }\n")
  expect(existsSync(join(rootDir, ".vitehub", "workflow", "vercel-output.json"))).toBe(false)
})

it("serializes native Vercel generation with disabled-provider cleanup", async () => {
  const rootDir = await createWorkspaceTempDir("vitehub-workflow-concurrent-cleanup-")
  const workflowDir = join(rootDir, "server", "workflows", "recap")
  await mkdir(workflowDir, { recursive: true })
  await writeFile(join(workflowDir, "01-collect.ts"), "export default async function collect(input) { return input }\n")

  await Promise.all([
    generateProviderOutputs({
      clientOutDir: join(rootDir, "dist"),
      importBase: "@vite-hub/workflow",
      rootDir,
      workflow: { provider: "vercel" },
    }),
    generateProviderOutputs({
      clientOutDir: join(rootDir, "dist"),
      rootDir,
      workflow: { provider: "openworkflow", sqlite: { path: ":memory:" } },
    }),
  ])

  const workflowRoot = join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const configFile = join(rootDir, ".vercel", "output", "config.json")
  expect(existsSync(workflowRoot)).toBe(false)
  const routes = JSON.parse(await readFile(configFile, "utf8")).routes ?? []
  expect(routes.some((route: unknown) => JSON.stringify(route).includes("/.well-known/workflow/v1/"))).toBe(false)
}, buildOutputTestTimeout)

function resolvePlaygroundNodeModules() {
  const nodeModules = join(playgroundDir, "node_modules")
  return existsSync(nodeModules) ? nodeModules : resolve(playgroundDir, "../../node_modules")
}

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  const workspacePackagesDir = resolve(playgroundDir, "../../packages")
  await mkdir(baseDir, { recursive: true })
  if (!existsSync(join(baseDir, "packages"))) {
    await symlink(workspacePackagesDir, join(baseDir, "packages"), "dir")
  }
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

async function linkNodeModules(sourceDir: string, targetDir: string) {
  await mkdir(targetDir, { recursive: true })
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (tempNodeModuleBuildDirs.has(entry.name)) {
      continue
    }
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      await mkdir(target, { recursive: true })
      for (const scopedEntry of await readdir(source, { withFileTypes: true })) {
        await linkNodeModuleEntry(join(source, scopedEntry.name), join(target, scopedEntry.name))
      }
      continue
    }
    await linkNodeModuleEntry(source, target)
  }
}

async function linkNodeModuleEntry(source: string, target: string) {
  const resolved = await realpath(source)
  const info = await stat(resolved)
  await symlink(resolved, target, info.isDirectory() ? "dir" : "file")
}

async function createPlaygroundCopy(prefix: string) {
  const workspaceDir = await createWorkspaceTempDir(prefix)
  const rootDir = join(workspaceDir, "vite")
  const nodeModules = resolvePlaygroundNodeModules()

  await mkdir(rootDir, { recursive: true })
  await cp(resolve(playgroundDir, "../_shared"), join(workspaceDir, "_shared"), { recursive: true })
  await cp(join(playgroundDir, "build"), join(rootDir, "build"), { recursive: true })
  await cp(join(playgroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(playgroundDir, "vite.config.ts"), join(rootDir, "vite.config.ts"))
  await cp(join(playgroundDir, "src"), join(rootDir, "src"), { recursive: true })
  await cp(join(playgroundDir, "server"), join(rootDir, "server"), { recursive: true })
  await linkNodeModules(nodeModules, join(rootDir, "node_modules"))

  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite workflow provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel workflow outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vite-playground-")
    const agentDir = join(rootDir, "server", "agents", "nuxt")
    const boxedAgentDir = join(rootDir, "server", "agents", "boxed")
    const inlineAgentDir = join(rootDir, "server", "agents", "inline")
    const optionalDevtoolsFixture = join(rootDir, "node_modules", "optional-vite-devtools-fixture")
    const flatAgent = join(rootDir, "server", "agents", "flat.ts")
    await mkdir(agentDir, { recursive: true })
    await mkdir(boxedAgentDir, { recursive: true })
    await mkdir(join(agentDir, "workspace"), { recursive: true })
    await mkdir(join(agentDir, "skills", "review"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "skills", "shared"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "workspace"), { recursive: true })
    await mkdir(join(rootDir, "server", "templates"), { recursive: true })
    await mkdir(inlineAgentDir, { recursive: true })
    await mkdir(optionalDevtoolsFixture, { recursive: true })
    await writeFile(join(optionalDevtoolsFixture, "package.json"), JSON.stringify({ main: "index.js", name: "optional-vite-devtools-fixture", type: "module" }))
    await writeFile(join(optionalDevtoolsFixture, "index.js"), `export const optionalDevtools = import("@vitejs/devtools-vite")\n`)
    await writeFile(join(agentDir, "repository-host-context.md"), "Repository host context loaded through Vite raw semantics.\n")
    await writeFile(join(rootDir, "server", "templates", "review.md"), "Review {{ repository }} through a bundled Markdown template.\n")
    await writeFile(join(agentDir, "agent.ts"), [
      `import { defineAgent } from "@vite-hub/agent"`,
      `import repositoryHostContext from "./repository-host-context.md?raw"`,
      `import { renderTemplate } from "#vitehub/templates"`,
      `import { optionalDevtools } from "optional-vite-devtools-fixture"`,
      "",
      "export default defineAgent({",
      "  workspace: {},",
      `  run: async () => [repositoryHostContext, await renderTemplate("review", { repository: "ViteHub" }), optionalDevtools].join("\\n"),`,
      "})",
      "",
    ].join("\n"))
    await writeFile(join(agentDir, "instructions.md"), "Keep answers concise.\n@./shared.md\n`@./inline-example.md`\n```md\n@./fenced-example.md\n```\n    @./indented-example.md\n")
    await writeFile(join(agentDir, "shared.md"), "Use shared policy.\n")
    await writeFile(join(agentDir, "skills", "review", "SKILL.md"), "# Review skill\n")
    await writeFile(join(boxedAgentDir, "agent.ts"), [
      `import { defineAgent } from "@vite-hub/agent"`,
      "",
      "export default defineAgent({",
      `  driver: { run: () => "fixture" },`,
      "})",
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "server", "agents", "skills", "shared", "SKILL.md"), "# Shared directory must not leak\n")
    await writeFile(flatAgent, `export default defineAgent({ workspace: {}, run: () => "flat agent" })\n`)
    await writeFile(join(rootDir, "server", "agents", "instructions.md"), "Use flat Agent instructions.\n")
    await writeFile(join(inlineAgentDir, "agent.ts"), [
      `import { defineAgent } from "@vite-hub/agent"`,
      "",
      "export default defineAgent({",
      `  runtime: false,`,
      `  run: () => "inline agent",`,
      "})",
      "",
    ].join("\n"))

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareWorkerBundle = join(rootDir, "dist", "vite", "worker.mjs")
    const cloudflareConfig = join(rootDir, "dist", "vite", "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const wrangler = JSON.parse(await readFile(cloudflareConfig, "utf8"))
    const className = getCloudflareWorkflowClassName("welcome")
    const agentClassName = getCloudflareWorkflowClassName("nuxt")
    const agentRecoveryName = "vitehub-agent-invocation-recovery-nuxt"
    const agentRecoveryClassName = getCloudflareWorkflowClassName(agentRecoveryName)
    const boxedAgentClassName = getCloudflareWorkflowClassName("boxed")
    const cliDevAgentClassName = getCloudflareWorkflowClassName("cli-dev")
    const flatAgentClassName = getCloudflareWorkflowClassName("flat")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(existsSync(cloudflareWorkerBundle)).toBe(true)
    expect(wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: className,
      name: "workflow--77656c636f6d65",
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName("boxed"),
      class_name: boxedAgentClassName,
      name: getCloudflareWorkflowName("boxed"),
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName("nuxt"),
      class_name: agentClassName,
      name: getCloudflareWorkflowName("nuxt"),
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName(agentRecoveryName),
      class_name: agentRecoveryClassName,
      name: getCloudflareWorkflowName(agentRecoveryName),
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName("cli-dev"),
      class_name: cliDevAgentClassName,
      name: getCloudflareWorkflowName("cli-dev"),
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName("flat"),
      class_name: flatAgentClassName,
      name: getCloudflareWorkflowName("flat"),
    })
    expect(wrangler.workflows).toHaveLength(9)
    const cloudflareWorkerContents = await readFile(cloudflareWorker, "utf8")
    expect(cloudflareWorkerContents).toContain("waitUntil as viteHubWaitUntil")
    expect(cloudflareWorkerContents).toContain(`export class ${className} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${agentClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${agentRecoveryClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${boxedAgentClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${cliDevAgentClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${flatAgentClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain('runViteHubWorkflowDefinition("welcome"')
    expect(cloudflareWorkerContents).toContain('runViteHubWorkflowDefinition("nuxt"')
    expect(cloudflareWorkerContents).toContain(`runViteHubWorkflowDefinition(${JSON.stringify(agentRecoveryName)}`)
    expect(cloudflareWorkerContents).not.toContain('runViteHubWorkflowDefinition("inline"')
    const cloudflareWorkerBundleContents = await readFile(cloudflareWorkerBundle, "utf8")
    expect(cloudflareWorkerBundleContents).toContain("runViteHubWorkflowDefinition")
    expect(cloudflareWorkerBundleContents).toContain("NonRetryableError")
    expect(cloudflareWorkerBundleContents).toContain("cloudflare:workflows")
    expect(cloudflareWorkerBundleContents).toContain("Repository host context loaded through Vite raw semantics.")
    expect(cloudflareWorkerBundleContents).toContain("bundled Markdown template")
    expect(cloudflareWorkerBundleContents).not.toMatch(/\b(?:from\s*|import\s*\(\s*)["']@vite-hub\/workspace(?:\/[^"']*)?["']/)
    const registry = await readFile(join(rootDir, ".vitehub", "workflow", "registry.mjs"), "utf8")
    expect(registry).toContain("runAgentWorkflowDefinition")
    expect(registry).toContain("options: { rootStep: false }")
    expect(registry).toContain('agentIdentity: context.payload?.agentIdentity || { name: "nuxt" }')
    expect(registry).toContain(`${JSON.stringify(agentRecoveryName)}: async () => {`)
    expect(registry).toContain("workspaceAgentWithSourceRoot")
    expect(registry).toContain("agentWithColocatedSkills")
    expect(registry).toContain('agentWithColocatedInstructions("default" in loaded ? loaded.default : loaded, "Use flat Agent instructions.\\n")')
    expect(registry).toContain("__vitehubAgentSkill:skills/review/SKILL.md")
    expect(registry).toContain(JSON.stringify(join(agentDir, "workspace")))
    expect(registry).toContain("Keep answers concise")
    expect(registry).toContain("Use shared policy")
    expect(registry).toContain("Use flat Agent instructions.")
    expect(registry).toContain(JSON.stringify(join(rootDir, "server", "agents", "workspace")))
    expect(registry).not.toContain("@./shared.md")
    expect(registry).toContain("@./inline-example.md")
    expect(registry).toContain("@./fenced-example.md")
    expect(registry).toContain("@./indented-example.md")
    expect(registry).not.toContain("Shared directory must not leak")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(await readFile(vercelServer, "utf8")).toContain("Repository host context loaded through Vite raw semantics.")
    expect(await readFile(vercelServer, "utf8")).toContain("bundled Markdown template")
  }, buildOutputTestTimeout)

  it("does not emit Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vercel-override-")
    await linkNodeModuleEntry(join(playgroundDir, "../../packages/workflow/node_modules/workflow"), join(rootDir, "node_modules", "workflow"))
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(viteConfig, (await readFile(viteConfig, "utf8"))
      .replace("const baseConfig = {", `const baseConfig = {\n    resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },`)
      .replace("plugins: [hubMarkdownTemplate(), hubWorkflow()],", `plugins: [hubMarkdownTemplate(), { name: "email-definition-alias", config: () => ({ resolve: { alias: { "#vitehub/email/definition": resolve(import.meta.dirname, "server/email.ts") } } }) }, hubWorkflow(), { name: "nitro:main", config() {} }],`)
      .replaceAll("workflow: {},", "workflow: { provider: \"vercel\" },"))
    const generatedWorkflowDir = join(rootDir, "server", "workflows", "monthly-recap")
    await mkdir(generatedWorkflowDir, { recursive: true })
    await writeFile(join(rootDir, "server", "email.ts"), "export default { driver: () => ({ send: async () => ({}) }) }\n")
    await writeFile(join(generatedWorkflowDir, "01-collect.ts"), "export default async function collect(input) { return { ...input, collected: true } }\n")
    await writeFile(join(generatedWorkflowDir, "02-send.ts"), "import { email } from '@vite-hub/email/server'\nexport default async function send(input) { await email.send(input); return input }\n")
    await writeFile(join(rootDir, "server", "workflows", "durable.ts"), [
      `export async function durable() {`,
      `  "use workflow"`,
      `  return "durable"`,
      `}`,
    ].join("\n"))
    await writeFile(join(rootDir, "server", "workflows", "native.ts"), [
      `import { defineWorkflow } from "@vite-hub/workflow"`,
      `import { durable } from "@/server/workflows/durable.js"`,
      `export default defineWorkflow(async () => "inline", { native: durable })`,
    ].join("\n"))

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_HOSTING: "vercel", VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(rootDir, "dist", "vite"))).toBe(false)
    expect(existsSync(join(rootDir, ".vercel", "output", "config.json"))).toBe(true)
    const [generatedNativeFile] = await readdir(join(rootDir, ".vitehub", "workflow", "vercel-native"))
    const generatedNative = await readFile(join(rootDir, ".vitehub", "workflow", "vercel-native", generatedNativeFile), "utf8")
    expect(generatedNative).toContain('"use workflow"')
    expect(generatedNative).toContain('"use step"')
    expect(generatedNative).not.toContain("vitehub.email.definition")
    const registry = await readFile(join(rootDir, ".vitehub", "workflow", "registry.mjs"), "utf8")
    const nativeExport = `${getCloudflareWorkflowClassName("monthly-recap")}Native`
    expect(registry).toContain(nativeExport)
    expect(registry).toContain(`workflow//./.vitehub/workflow/vercel-native//${nativeExport}`)
    expect(await readFile(join(rootDir, ".vercel", "output", "functions", "__workflow.func", "index.mjs"), "utf8")).toContain("workflowId")
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "flow.func", "index.mjs"))).toBe(true)
    const combinedFlow = await readFile(join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "flow.func", "index.mjs"), "utf8")
    expect(combinedFlow).toMatch(/globalThis\[(?:\/\*.*?\*\/\s*)?Symbol\.for\(["']vitehub\.email\.definition["']\)\]\s*=/)
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "webhook", "[token].func", "index.mjs"))).toBe(true)
    expect(await readFile(join(rootDir, ".vercel", "output", "config.json"), "utf8")).toContain("/.well-known/workflow/v1/webhook/")

    await rm(generatedWorkflowDir, { recursive: true })
    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_HOSTING: "vercel", VITEHUB_VITE_MODE: "workflow" },
    })
    expect(existsSync(join(rootDir, ".vitehub", "workflow", "vercel-native"))).toBe(false)
    await expect(readFile(join(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "flow.func", "index.mjs"), "utf8"))
      .resolves.toMatch(/globalThis\[(?:\/\*.*?\*\/\s*)?Symbol\.for\(["']vitehub\.email\.definition["']\)\]\s*=/)
    const rebuiltRoutes = JSON.parse(await readFile(join(rootDir, ".vercel", "output", "config.json"), "utf8")).routes as unknown[]
    const workflowRoutes = rebuiltRoutes.filter(route => JSON.stringify(route).includes("/.well-known/workflow/v1/"))
    expect(workflowRoutes).toEqual([...new Set(workflowRoutes.map(route => JSON.stringify(route)))].map(route => JSON.parse(route)))

  }, buildOutputTestTimeout)

  it("rejects native Vercel entries outside discovered definition directories", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vercel-external-native-")
    await linkNodeModuleEntry(join(playgroundDir, "../../packages/workflow/node_modules/workflow"), join(rootDir, "node_modules", "workflow"))
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(viteConfig, (await readFile(viteConfig, "utf8")).replaceAll("workflow: {},", "workflow: { provider: \"vercel\" },"))
    await mkdir(join(rootDir, "server", "durable"), { recursive: true })
    await writeFile(join(rootDir, "server", "durable", "welcome.ts"), [
      `export async function durable() {`,
      `  "use workflow"`,
      `  return "durable"`,
      `}`,
    ].join("\n"))
    await writeFile(join(rootDir, "server", "workflows", "native.ts"), [
      `import { defineWorkflow } from "@vite-hub/workflow"`,
      `import { durable } from "../durable/welcome"`,
      `export default defineWorkflow(async () => "inline", { native: durable })`,
    ].join("\n"))

    await expect(execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })).rejects.toThrow(/must be colocated with its discovered workflow definition/)
  }, buildOutputTestTimeout)

  it("does not emit provider deployment artifacts for OpenWorkflow provider overrides", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-openworkflow-override-")
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(
      viteConfig,
      (await readFile(viteConfig, "utf8")).replaceAll(
        "workflow: {},",
        "workflow: { provider: \"openworkflow\", postgres: { url: \"postgres://example\" } },",
      ),
    )

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)
    expect(existsSync(join(rootDir, "dist", "vite"))).toBe(false)
  }, buildOutputTestTimeout)

  it("cleans Cloudflare workflow output when switching to OpenWorkflow", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-cloudflare-to-openworkflow-")
    const viteConfig = join(rootDir, "vite.config.ts")

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    const cloudflareDir = join(rootDir, "dist", "vite")
    const nitroOutput = join(rootDir, ".vercel", "output", "nitro.json")
    const wranglerConfig = join(cloudflareDir, "wrangler.json")
    const wrangler = JSON.parse(await readFile(wranglerConfig, "utf8"))
    await writeFile(nitroOutput, "{\"preset\":\"vercel\"}\n")
    await writeFile(join(cloudflareDir, "sibling-output.mjs"), "export default {}\n")
    await writeFile(wranglerConfig, `${JSON.stringify({ ...wrangler, vars: { USER_OWNED: "true" } }, null, 2)}\n`)
    await writeFile(
      viteConfig,
      (await readFile(viteConfig, "utf8")).replaceAll(
        "workflow: {},",
        "workflow: { provider: \"openworkflow\", postgres: { url: \"postgres://example\" } },",
      ),
    )

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(cloudflareDir, "index.js"))).toBe(false)
    expect(existsSync(join(cloudflareDir, "worker.mjs"))).toBe(false)
    await expect(readFile(join(cloudflareDir, "sibling-output.mjs"), "utf8")).resolves.toBe("export default {}\n")
    await expect(readFile(nitroOutput, "utf8")).resolves.toBe("{\"preset\":\"vercel\"}\n")
    await expect(readFile(wranglerConfig, "utf8").then(JSON.parse)).resolves.toEqual({
      vars: { USER_OWNED: "true" },
    })
  }, buildOutputTestTimeout)

  it("preserves sibling Cloudflare output when switching to OpenWorkflow", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-cloudflare-sibling-")
    const viteConfig = join(rootDir, "vite.config.ts")

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    const cloudflareDir = join(rootDir, "dist", "vite")
    const wranglerConfig = join(cloudflareDir, "wrangler.json")
    const wrangler = JSON.parse(await readFile(wranglerConfig, "utf8"))
    await writeFile(join(cloudflareDir, "index.js"), "export default { fetch() {} }\n")
    await writeFile(wranglerConfig, `${JSON.stringify({ ...wrangler, r2_buckets: [{ binding: "ASSETS", bucket_name: "assets" }] }, null, 2)}\n`)
    await writeFile(
      viteConfig,
      (await readFile(viteConfig, "utf8")).replaceAll(
        "workflow: {},",
        "workflow: { provider: \"openworkflow\", postgres: { url: \"postgres://example\" } },",
      ),
    )

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(cloudflareDir, "worker.mjs"))).toBe(false)
    await expect(readFile(join(cloudflareDir, "index.js"), "utf8")).resolves.toBe("export default { fetch() {} }\n")
    await expect(readFile(wranglerConfig, "utf8").then(JSON.parse)).resolves.toEqual({
      compatibility_date: "2026-04-20",
      compatibility_flags: ["nodejs_compat"],
      main: "index.js",
      observability: { enabled: true },
      r2_buckets: [{ binding: "ASSETS", bucket_name: "assets" }],
    })
  }, buildOutputTestTimeout)

})
