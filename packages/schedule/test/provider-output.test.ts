import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"
import { createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { createVercelConfigJson } from "@vite-hub/internal/build/vercel-config"

import { createNetlifyScheduleFunctionOutputs, generateProviderOutputs, resolveScheduleDefinitionEntry, resolveScheduleRuntimeEntry, validateProviderCron, writeVercelScheduleFunctions } from "../src/internal/provider-output.ts"
import { discoverScheduleDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function createTempProject(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "dist", "client"), { recursive: true })
  await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
    "import { defineSchedule } from '@vite-hub/schedule'",
    "",
    "export default defineSchedule({ cron: '0 0 * * *', handler: () => 'ok' })",
    "",
  ].join("\n"), "utf8")
  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("schedule provider output", () => {
  it("keeps esbuild external in built provider output code", async () => {
    const distDir = join(packageRoot, "dist")
    const outputFiles = (await readdir(distDir)).filter(file => file.endsWith(".js"))
    const output = (await Promise.all(outputFiles.map(file => readFile(join(distDir, file), "utf8")))).join("\n")

    expect(output).not.toContain("The esbuild JavaScript API cannot be bundled")
    expect(output).not.toContain("esbuildCommandAndArgs")
  })

  it("keeps the definition entry out of public package exports", async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { exports: Record<string, unknown> }

    expect(packageJson.exports).not.toHaveProperty("./definition")
    expect(packageJson.exports).toHaveProperty("./runtime/driver", "./dist/runtime/driver.js")
  })

  it("emits Cloudflare, Vercel, and Netlify schedule provider wake output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-")
    await writeFile(join(rootDir, "src", "agent-turn.schedule.ts"), [
      "import { defineScheduleTarget } from '@vite-hub/schedule'",
      "",
      "export default defineScheduleTarget({ handler: () => 'ok' })",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    const cloudflareWorker = join(cloudflareRoot, "index.js")
    const cloudflareConfig = join(cloudflareRoot, "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelFunction = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs")
    const netlifyFunction = join(createDefaultNetlifyOutputRoot(rootDir), "functions", "vitehub-schedule-cleanup.mjs")

    expect(existsSync(cloudflareWorker)).toBe(true)
    await expect(readFile(cloudflareWorker, "utf8")).resolves.toContain("waitUntil: (promise) => ctx.waitUntil(promise)")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 0 * * *"])
    expect(JSON.parse(await readFile(vercelConfig, "utf8")).crons).toEqual([{
      path: "/api/vitehub/schedules/vercel/cleanup",
      schedule: "0 0 * * *",
    }])
    expect(await readFile(vercelFunction, "utf8")).toContain("executeStaticSchedule")
    expect(await readFile(vercelFunction, "utf8")).not.toContain("setWorkflowRuntimeRegistry")
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "agent-turn.func"))).toBe(false)
    await expect(readFile(netlifyFunction, "utf8")).resolves.toContain("export const config = {")
    expect(existsSync(join(createDefaultNetlifyOutputRoot(rootDir), "functions", "vitehub-schedule-agent-turn.mjs"))).toBe(false)
    await expect(readFile(netlifyFunction, "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
    await expect(readFile(netlifyFunction, "utf8")).resolves.toContain("executeStaticSchedule")
    await expect(readFile(join(rootDir, ".vitehub", "schedule", "registry.mjs"), "utf8")).resolves.not.toContain("agent-turn")
  })

  it("installs a composed Workflow runtime in Vercel schedule functions", async () => {
    const rootDir = await createTempProject("vitehub-schedule-workflow-output-")
    const workflowDir = join(rootDir, ".vitehub", "workflow")
    await mkdir(workflowDir, { recursive: true })
    const workflowRegistry = join(workflowDir, "registry.mjs")
    const state = join(workflowDir, "state.mjs")
    const vercelRuntime = join(workflowDir, "vercel-runtime.mjs")
    const workflowApi = join(workflowDir, "workflow-api.mjs")
    const workflowRuntime = join(workflowDir, "workflow-runtime.mjs")
    await writeFile(workflowRegistry, "export default { recap: async () => ({}) }\n")
    await writeFile(state, "export function setWorkflowRuntimeConfig(value) { globalThis.__workflowConfig = value }\nexport function setWorkflowRuntimeRegistry(value) { globalThis.__workflowRegistry = value }\n")
    await writeFile(vercelRuntime, "export function setVercelWorkflowRuntimeModules() { globalThis.__workflowModules = true }\n")
    await writeFile(workflowApi, "export const api = true\n")
    await writeFile(workflowRuntime, "export const runtime = true\n")

    await generateProviderOutputs({
      bundleAlias: {
        "test-workflow/runtime/state": state,
        "test-workflow/runtime/vercel-vite": vercelRuntime,
        "workflow/api": workflowApi,
        "workflow/runtime": workflowRuntime,
      },
      clientOutDir: "dist/client",
      rootDir,
      workflow: {
        bundleAlias: {},
        importBase: "test-workflow",
        native: true,
        registryFile: workflowRegistry,
      },
    })

    const vercelFunction = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs")
    const output = await readFile(vercelFunction, "utf8")
    expect(output).toContain("__workflowModules")
    expect(output).toContain("__workflowConfig")
    expect(output).toContain("__workflowRegistry")
  })

  it("installs inline Workflow definitions without Workflow DevKit", async () => {
    const rootDir = await createTempProject("vitehub-schedule-inline-workflow-output-")
    const workflowDir = join(rootDir, ".vitehub", "workflow")
    await mkdir(workflowDir, { recursive: true })
    const workflowRegistry = join(workflowDir, "registry.mjs")
    const state = join(workflowDir, "state.mjs")
    await writeFile(workflowRegistry, "export default { recap: async () => ({}) }\n")
    await writeFile(state, "export function setWorkflowRuntimeConfig(value) { globalThis.__workflowConfig = value }\nexport function setWorkflowRuntimeRegistry(value) { globalThis.__workflowRegistry = value }\n")

    await generateProviderOutputs({
      bundleAlias: { "test-workflow/runtime/state": state },
      clientOutDir: "dist/client",
      rootDir,
      workflow: {
        bundleAlias: {},
        importBase: "test-workflow",
        native: false,
        registryFile: workflowRegistry,
      },
    })

    const output = await readFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs"), "utf8")
    expect(output).toContain("__workflowConfig")
    expect(output).toContain("__workflowRegistry")
    expect(output).not.toContain("workflow/api")
    expect(output).not.toContain("workflow/runtime")
    expect(output).not.toContain("setVercelWorkflowRuntimeModules")
  })

  it("creates Netlify scheduled function output contributions", async () => {
    const rootDir = await createTempProject("vitehub-schedule-netlify-output-")
    await writeFile(join(rootDir, "src", "AdminReport.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "",
      "export default defineSchedule({ cron: '0 1 * * *', handler: () => 'ok' })",
      "",
    ].join("\n"), "utf8")
    const definitions = discoverScheduleDefinitions({ rootDir })
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    const outputs = await createNetlifyScheduleFunctionOutputs({
      definitions,
      functionRoot: join(rootDir, "netlify", "functions"),
      registryFile,
    })

    expect(outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        cron: "0 0 * * *",
        file: join(rootDir, "netlify", "functions", "vitehub-schedule-cleanup.mjs"),
        name: "cleanup",
      }),
      expect.objectContaining({
        cron: "0 1 * * *",
        file: join(rootDir, "netlify", "functions", "vitehub-schedule-adminreport.mjs"),
        name: "AdminReport",
      }),
    ]))
    const cleanup = outputs.find(output => output.name === "cleanup")
    expect(cleanup?.source).toContain("export const config = {")
    expect(cleanup?.source).toContain("schedule: \"0 0 * * *\"")
    expect(cleanup?.source).not.toContain("next_run")
    expect(cleanup?.source).toContain("scheduledAt: new Date()")
    expect(cleanup?.source).toContain("executeStaticSchedule")
  })

  it("emits Deno cron provider wake output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-deno-output-")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const denoCron = join(rootDir, ".vitehub", "schedule", "deno-cron.mjs")
    const source = await readFile(denoCron, "utf8")

    expect(source).toContain("Deno.cron(`vitehub:${name}`, cron")
    expect(source).toContain('from "@vite-hub/schedule/runtime/static"')
  })

  it("can route Deno cron provider wake output through a preset facade", async () => {
    const rootDir = await createTempProject("vitehub-schedule-deno-facade-output-")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
      runtimeImport: "#app/schedule/runtime",
    })

    const denoCron = join(rootDir, ".vitehub", "schedule", "deno-cron.mjs")
    const source = await readFile(denoCron, "utf8")

    expect(source).toContain('from "#app/schedule/runtime"')
    expect(source).toContain('"cleanup": "0 0 * * *"')
    expect(source).toContain("executeStaticSchedule")
  })

  it("preserves existing provider output files when adding schedule output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-preserve-")
    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    const vercelRoot = join(rootDir, ".vercel", "output")
    const netlifyRoot = createDefaultNetlifyOutputRoot(rootDir)
    await mkdir(cloudflareRoot, { recursive: true })
    await mkdir(vercelRoot, { recursive: true })
    await mkdir(join(netlifyRoot, "functions"), { recursive: true })
    await writeFile(join(cloudflareRoot, "existing.txt"), "keep\n", "utf8")
    await writeFile(join(vercelRoot, "existing.txt"), "keep\n", "utf8")
    await writeFile(join(netlifyRoot, "functions", "other.mjs"), "keep\n", "utf8")
    await writeFile(join(netlifyRoot, "functions", "vitehub-schedule-stale.mjs"), "stale\n", "utf8")
    await writeFile(join(cloudflareRoot, "wrangler.json"), JSON.stringify({
      main: "index.js",
      triggers: { crons: ["0 1 * * *"] },
    }), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    await expect(readFile(join(cloudflareRoot, "existing.txt"), "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(vercelRoot, "existing.txt"), "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(netlifyRoot, "functions", "other.mjs"), "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(netlifyRoot, "functions", "vitehub-schedule-stale.mjs"), "utf8")).rejects.toThrow()
    await expect(readFile(join(netlifyRoot, "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
    expect(JSON.parse(await readFile(join(cloudflareRoot, "wrangler.json"), "utf8")).triggers.crons).toEqual(["0 1 * * *", "0 0 * * *"])
  })

  it("avoids empty Netlify output and cleans stale files without static schedules", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-empty-netlify-")
    const outputRoot = createDefaultNetlifyOutputRoot(rootDir)
    const functionRoot = join(outputRoot, "functions")

    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(outputRoot)).toBe(false)

    await mkdir(functionRoot, { recursive: true })
    await writeFile(join(functionRoot, "other.mjs"), "keep\n", "utf8")
    await writeFile(join(functionRoot, "vitehub-schedule-stale.mjs"), "stale\n", "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    await expect(readFile(join(functionRoot, "other.mjs"), "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(functionRoot, "vitehub-schedule-stale.mjs"), "utf8")).rejects.toThrow()

    await rm(join(functionRoot, "other.mjs"))
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".netlify"))).toBe(false)
  })

  it("avoids empty Vercel output and cleans stale files without static schedules", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-empty-vercel-")
    const outputRoot = join(rootDir, ".vercel", "output")
    const functionRoot = join(outputRoot, "functions", "api", "vitehub", "schedules", "vercel")

    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)

    await generateProviderOutputs({ clientOutDir: "dist/client", rootDir })
    expect(existsSync(join(outputRoot, "config.json"))).toBe(true)
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)

    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "config.json"), JSON.stringify({ ...createVercelConfigJson(), crons: [] }), "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)

    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "config.json"), JSON.stringify(createVercelConfigJson()), "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)

    await mkdir(join(functionRoot, "stale.func"), { recursive: true })
    await writeFile(join(functionRoot, "stale.func", "index.mjs"), "stale\n", "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)

    await mkdir(outputRoot, { recursive: true })
    const siblingFunction = join(outputRoot, "functions", "__server.func", "index.mjs")
    await mkdir(dirname(siblingFunction), { recursive: true })
    await writeFile(siblingFunction, "keep\n", "utf8")
    await writeFile(join(outputRoot, "config.json"), JSON.stringify(createVercelConfigJson()), "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    await expect(readFile(siblingFunction, "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual(createVercelConfigJson())

    await mkdir(join(functionRoot, "stale.func"), { recursive: true })
    await writeFile(join(functionRoot, "stale.func", "index.mjs"), "stale\n", "utf8")
    const userFunction = join(outputRoot, "functions", "api", "user.func", "index.mjs")
    await mkdir(dirname(userFunction), { recursive: true })
    await writeFile(userFunction, "keep\n", "utf8")
    await writeFile(join(outputRoot, "existing.txt"), "keep\n", "utf8")
    await writeFile(join(outputRoot, "config.json"), JSON.stringify({
      crons: [
        { path: "/api/user-cron", schedule: "0 1 * * *" },
        { path: "/api/vitehub/schedules/vercel/stale", schedule: "0 2 * * *" },
      ],
      routes: [{ handle: "filesystem" }],
      version: 3,
    }), "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(functionRoot)).toBe(false)
    await expect(readFile(userFunction, "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(outputRoot, "existing.txt"), "utf8")).resolves.toBe("keep\n")
    await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      crons: [{ path: "/api/user-cron", schedule: "0 1 * * *" }],
      routes: [{ handle: "filesystem" }],
      version: 3,
    })

    const unrelatedConfig = "{\n  \"version\": 3,\n  \"custom\": \"keep exact bytes\"\n}\n"
    await writeFile(join(outputRoot, "config.json"), unrelatedConfig, "utf8")
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    await expect(readFile(join(outputRoot, "config.json"), "utf8")).resolves.toBe(unrelatedConfig)
  })

  it("removes stale Deno and Cloudflare output when no static schedules remain", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-empty-cleanup-")
    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    await generateProviderOutputs({ clientOutDir: "dist/client", rootDir })
    const configFile = join(cloudflareRoot, "wrangler.json")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    await writeFile(configFile, JSON.stringify({
      ...config,
      custom: "keep",
      triggers: { ...config.triggers, crons: ["0 1 * * *", ...config.triggers.crons] },
    }), "utf8")

    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(existsSync(join(rootDir, ".vitehub", "schedule", "deno-cron.mjs"))).toBe(false)
    expect(existsSync(join(rootDir, ".vitehub", "schedule", "cloudflare-worker.mjs"))).toBe(false)
    expect(existsSync(join(rootDir, ".vitehub", "schedule", "registry.mjs"))).toBe(false)
    expect(existsSync(join(rootDir, ".vitehub", "schedule", "vercel-server.mjs"))).toBe(false)
    expect(existsSync(join(cloudflareRoot, "index.js"))).toBe(false)
    await expect(readFile(configFile, "utf8")).resolves.toContain('"custom": "keep"')
    expect(JSON.parse(await readFile(configFile, "utf8")).triggers.crons).toEqual(["0 1 * * *"])
  })

  it("preserves an existing Cloudflare trigger that matches a generated cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-cron-ownership-")
    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareRoot, { recursive: true })
    const configFile = join(cloudflareRoot, "wrangler.json")
    await writeFile(configFile, JSON.stringify({
      main: "index.js",
      triggers: { crons: ["0 0 * * *"] },
    }), "utf8")

    await generateProviderOutputs({ clientOutDir: "dist/client", rootDir })
    await generateProviderOutputs({ clientOutDir: "dist/client", definitions: [], rootDir })

    expect(JSON.parse(await readFile(configFile, "utf8")).triggers.crons).toEqual(["0 0 * * *"])
  })

  it("reports provider cron syntax limitations before output generation", () => {
    expect(() => validateProviderCron("0 0 1 1 * 2026", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
    expect(() => validateProviderCron("0 0 * JAN *", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
    expect(() => validateProviderCron("0 0 1 * 1", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
  })

  it("resolves the static schedule runtime from its declared package export", () => {
    expect(resolveScheduleRuntimeEntry((specifier) => {
      expect(specifier).toBe("@vite-hub/schedule/runtime/static")
      return "file:///repo/node_modules/@vite-hub/schedule/dist/runtime/static.js"
    })).toBe("/repo/node_modules/@vite-hub/schedule/dist/runtime/static.js")
  })

  it("resolves the private schedule definition from the declared package root", () => {
    expect(resolveScheduleDefinitionEntry((specifier) => {
      expect(specifier).toBe("@vite-hub/schedule/package.json")
      return "file:///repo/node_modules/@vite-hub/schedule/package.json"
    })).toBe("/repo/node_modules/@vite-hub/schedule/dist/definition.js")
  })

  it("writes Cloudflare schedule output to an existing Wrangler main", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-custom-main-")
    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareRoot, { recursive: true })
    await writeFile(join(cloudflareRoot, "wrangler.json"), JSON.stringify({
      main: "worker.js",
    }), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    expect(existsSync(join(cloudflareRoot, "worker.js"))).toBe(true)
    expect(existsSync(join(cloudflareRoot, "index.js"))).toBe(false)
    expect(JSON.parse(await readFile(join(cloudflareRoot, "wrangler.json"), "utf8")).main).toBe("worker.js")
  })

  it("rejects dynamic cron expressions before provider output generation", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-dynamic-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "const suffix = '0'",
      "export default defineSchedule({ cron: '0 0 * * *' + suffix, handler: () => 'ok' })",
      "",
    ].join("\n"), "utf8")

    await expect(generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })).rejects.toThrow(/must declare a static cron string/)
  })

  it("reads cron from the top-level schedule object", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-top-level-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: () => ({ cron: '0 1 * * *' }),",
      "  cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    expect(JSON.parse(await readFile(vercelConfig, "utf8")).crons).toEqual([{
      path: "/api/vitehub/schedules/vercel/cleanup",
      schedule: "0 2 * * *",
    }])
  })

  it("reads cron from a top-level property with leading comments", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-commented-property-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: () => 'ok',",
      "  /* schedule */ cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    expect(JSON.parse(await readFile(vercelConfig, "utf8")).crons).toEqual([{
      path: "/api/vitehub/schedules/vercel/cleanup",
      schedule: "0 2 * * *",
    }])
  })

  it("balances regex literals while reading top-level provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-regex-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: () => /}/.test('x'),",
      "  cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("balances regex literals after await while reading top-level provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-await-regex-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: async () => { await /}/.test('x') },",
      "  cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("balances regex literals after throw while reading top-level provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-throw-regex-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: () => { throw /}/.test('x') },",
      "  cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("balances regex literals after unary keywords while reading top-level provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-unary-regex-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: () => { void /}/.test('x'); return typeof /}/ },",
      "  cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("balances template interpolation while reading top-level provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-template-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule({",
      "  handler: () => `${`x`}`,",
      "  cron: '0 2 * * *',",
      "})",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("ignores commented defineSchedule examples when reading static provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-commented-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "// export default defineSchedule({ cron: '0 1 * * *', handler: () => 'docs' })",
      "export default defineSchedule({ cron: '0 2 * * *', handler: () => 'ok' })",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("ignores quoted defineSchedule examples when reading static provider cron", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-quoted-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "const docs = \"export default defineSchedule({ cron: '0 1 * * *', handler: () => 'docs' })\"",
      "export default defineSchedule({ cron: '0 2 * * *', handler: () => 'ok' })",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("reads static provider cron from generic defineSchedule exports", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-generic-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default defineSchedule<string>({ cron: '0 2 * * *', handler: () => 'ok' })",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("reads static provider cron from parenthesized defineSchedule exports", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-parenthesized-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "export default ((defineSchedule({ cron: '0 2 * * *', handler: () => 'ok' })))",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
  })

  it("rejects raw default objects for provider cron extraction", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-raw-object-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "const docs = 'export default helper'",
      "export default { cron: '0 2 * * *', handler: () => 'ok' }",
      "",
    ].join("\n"), "utf8")

    await expect(generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })).rejects.toThrow(/must declare a static cron string/)
  })

  it("preserves existing Vercel output config when adding schedule crons", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-config-")
    const outputRoot = join(rootDir, ".vercel", "output")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "config.json"), JSON.stringify({
      routes: [{ src: "/api/(.*)", dest: "/api/index.func" }],
      version: 3,
    }), "utf8")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    await writeFile(registryFile, "export default {}\n", "utf8")

    await writeVercelScheduleFunctions({
      definitions: [{
        handler: join(rootDir, "src", "cleanup.schedule.ts"),
        name: "cleanup",
      }],
      outputRoot,
      registryFile,
      rootDir,
    }, new Map([["cleanup", "0 0 * * *"]]))

    expect(JSON.parse(await readFile(join(outputRoot, "config.json"), "utf8"))).toMatchObject({
      crons: [{ path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" }],
      routes: [{ src: "/api/(.*)", dest: "/api/index.func" }],
      version: 3,
    })
  })

  it("removes stale generated Vercel schedule crons when rewriting config", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-stale-crons-")
    const outputRoot = join(rootDir, ".vercel", "output")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "config.json"), JSON.stringify({
      crons: [
        { path: "/api/user-cron", schedule: "0 1 * * *" },
        { path: "/api/vitehub/schedules/vercel/old-cleanup", schedule: "0 2 * * *" },
      ],
      version: 3,
    }), "utf8")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    await writeFile(registryFile, "export default {}\n", "utf8")

    await writeVercelScheduleFunctions({
      definitions: [{
        handler: join(rootDir, "src", "cleanup.schedule.ts"),
        name: "cleanup",
      }],
      outputRoot,
      registryFile,
      rootDir,
    }, new Map([["cleanup", "0 0 * * *"]]))

    expect(JSON.parse(await readFile(join(outputRoot, "config.json"), "utf8")).crons).toEqual([
      { path: "/api/user-cron", schedule: "0 1 * * *" },
      { path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" },
    ])
  })

  it("uses server aliases when bundling Vercel schedule functions", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-alias-")
    const aliasFile = join(rootDir, "server-imports.mjs")
    const outputRoot = join(rootDir, ".vercel", "output")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    await writeFile(aliasFile, "export const marker = 'server-alias-marker'\n", "utf8")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "import { marker } from '#imports'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => marker })",
      "",
    ].join("\n"), "utf8")
    await writeFile(registryFile, [
      "const registry = {",
      `  cleanup: async () => import(${JSON.stringify(join(rootDir, "src", "cleanup.schedule.ts"))}),`,
      "}",
      "export default registry",
      "",
    ].join("\n"), "utf8")

    await writeVercelScheduleFunctions({
      bundleAlias: { "#imports": aliasFile },
      definitions: [{
        handler: join(rootDir, "src", "cleanup.schedule.ts"),
        name: "cleanup",
      }],
      outputRoot,
      registryFile,
      rootDir,
    }, new Map([["cleanup", "0 0 * * *"]]))

    await expect(readFile(join(outputRoot, "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs"), "utf8")).resolves.toContain("server-alias-marker")
  })

  it("uses Vite aliases when bundling provider output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-vite-alias-")
    const aliasFile = join(rootDir, "schedule-helper.mjs")
    await writeFile(aliasFile, "export const marker = 'vite-alias-marker'\n", "utf8")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "import { marker } from '#schedule-helper'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => marker })",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      bundleAlias: { "#schedule-helper": aliasFile },
      clientOutDir: "dist/client",
      rootDir,
    })

    await expect(readFile(join(createDefaultCloudflareOutputRoot(rootDir), "index.js"), "utf8")).resolves.toContain("vite-alias-marker")
    await expect(readFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs"), "utf8")).resolves.toContain("vite-alias-marker")
  })

  it("rejects sanitized Vercel function path collisions", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-collision-")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    await writeFile(registryFile, "export default {}\n", "utf8")

    await expect(writeVercelScheduleFunctions({
      definitions: [
        { handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "daily?report" },
        { handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "daily:report" },
      ],
      outputRoot: join(rootDir, ".vercel", "output"),
      registryFile,
      rootDir,
    }, new Map([
      ["daily?report", "0 0 * * *"],
      ["daily:report", "0 0 * * *"],
    ]))).rejects.toThrow(/same Vercel function path/)
  })

  it("rejects normalized Vercel function path collisions", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-normalized-collision-")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    await writeFile(registryFile, "export default {}\n", "utf8")

    await expect(writeVercelScheduleFunctions({
      definitions: [
        { handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "reports/daily" },
        { handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "reports//daily" },
      ],
      outputRoot: join(rootDir, ".vercel", "output"),
      registryFile,
      rootDir,
    }, new Map([
      ["reports/daily", "0 0 * * *"],
      ["reports//daily", "0 0 * * *"],
    ]))).rejects.toThrow(/same Vercel function path/)
  })

  it("emits Vercel handlers that load nested schedule names from the full path", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-nested-")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await writeFile(registryFile, "export default {}\n", "utf8")

    await writeVercelScheduleFunctions({
      definitions: [{ handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "reports/daily" }],
      outputRoot: join(rootDir, ".vercel", "output"),
      registryFile,
      rootDir,
    }, new Map([["reports/daily", "0 0 * * *"]]))

    const source = await readFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "reports", "daily.func", "index.mjs"), "utf8")
    expect(source).toContain("const name = \"reports/daily\"")
  })

  it("emits Vercel handlers that require the cron secret when configured", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-auth-")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await writeFile(registryFile, "export default {}\n", "utf8")

    await writeVercelScheduleFunctions({
      definitions: [{ handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "cleanup" }],
      outputRoot: join(rootDir, ".vercel", "output"),
      registryFile,
      rootDir,
    }, new Map([["cleanup", "0 0 * * *"]]))

    const source = await readFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs"), "utf8")
    expect(source).toContain("process.env.CRON_SECRET")
    expect(source).toContain("authorization !== `Bearer ${cronSecret}`")
    expect(source).toContain("res.statusCode = 401")
  })

  it("emits Vercel handlers that load unsanitized schedule names", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-unsanitized-")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await writeFile(registryFile, "export default {}\n", "utf8")

    await writeVercelScheduleFunctions({
      definitions: [{ handler: join(rootDir, "src", "cleanup.schedule.ts"), name: "billing:daily" }],
      outputRoot: join(rootDir, ".vercel", "output"),
      registryFile,
      rootDir,
    }, new Map([["billing:daily", "0 0 * * *"]]))

    const source = await readFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "billing_daily.func", "index.mjs"), "utf8")
    expect(source).toContain("const name = \"billing:daily\"")
  })
})
