import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"
import { createDefaultCloudflareOutputRoot } from "@vitehub/internal/build/deployment-output"

import { generateProviderOutputs, resolveScheduleRuntimeEntry, validateProviderCron, writeVercelScheduleFunctions } from "../src/internal/provider-output.ts"

const tempDirs: string[] = []

async function createTempProject(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "dist", "client"), { recursive: true })
  await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
    "export default { cron: '0 0 * * *', handler: () => 'ok' }",
    "",
  ].join("\n"), "utf8")
  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("schedule provider output", () => {
  it("emits Cloudflare and Vercel schedule provider wake output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    const cloudflareWorker = join(cloudflareRoot, "index.js")
    const cloudflareConfig = join(cloudflareRoot, "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelFunction = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 0 * * *"])
    expect(JSON.parse(await readFile(vercelConfig, "utf8")).crons).toEqual([{
      path: "/api/vitehub/schedules/vercel/cleanup",
      schedule: "0 0 * * *",
    }])
    expect(await readFile(vercelFunction, "utf8")).toContain("executeStaticSchedule")
  })

  it("preserves existing provider output files when adding schedule output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-preserve-")
    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    const vercelRoot = join(rootDir, ".vercel", "output")
    await mkdir(cloudflareRoot, { recursive: true })
    await mkdir(vercelRoot, { recursive: true })
    await writeFile(join(cloudflareRoot, "existing.txt"), "keep\n", "utf8")
    await writeFile(join(vercelRoot, "existing.txt"), "keep\n", "utf8")
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
    expect(JSON.parse(await readFile(join(cloudflareRoot, "wrangler.json"), "utf8")).triggers.crons).toEqual(["0 1 * * *", "0 0 * * *"])
  })

  it("reports provider cron syntax limitations before output generation", () => {
    expect(() => validateProviderCron("0 0 1 1 * 2026", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
    expect(() => validateProviderCron("0 0 * JAN *", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
    expect(() => validateProviderCron("0 0 1 * 1", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
  })

  it("resolves the static schedule runtime entry from package source and dist layouts", () => {
    expect(resolveScheduleRuntimeEntry("file:///repo/packages/schedule/src/internal/provider-output.ts")).toBe("/repo/packages/schedule/src/runtime/static.ts")
    expect(resolveScheduleRuntimeEntry("file:///C:/repo/packages/schedule/src/internal/provider-output.ts")).toBe("/C:/repo/packages/schedule/src/runtime/static.ts")
    expect(resolveScheduleRuntimeEntry("file:///repo/packages/schedule/dist/internal/provider-output.js")).toBe("/repo/packages/schedule/dist/runtime/static.js")
    expect(resolveScheduleRuntimeEntry("file:///home/user/src/app/node_modules/@vitehub/schedule/dist/internal/provider-output.js")).toBe("/home/user/src/app/node_modules/@vitehub/schedule/dist/runtime/static.js")
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

  it("continues to later object default exports when earlier defaults are not objects", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-later-object-cron-")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "const docs = 'export default helper'",
      "export default { cron: '0 2 * * *', handler: () => 'ok' }",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareConfig = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 2 * * *"])
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

  it("uses Nitro aliases when bundling Vercel schedule functions", async () => {
    const rootDir = await createTempProject("vitehub-schedule-vercel-alias-")
    const aliasFile = join(rootDir, "nitro-imports.mjs")
    const outputRoot = join(rootDir, ".vercel", "output")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    await mkdir(join(rootDir, ".vitehub", "schedule"), { recursive: true })
    await writeFile(aliasFile, "export const marker = 'nitro-alias-marker'\n", "utf8")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "import { marker } from '#imports'",
      "export default { cron: '0 0 * * *', handler: () => marker }",
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

    await expect(readFile(join(outputRoot, "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs"), "utf8")).resolves.toContain("nitro-alias-marker")
  })

  it("uses Vite aliases when bundling provider output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-vite-alias-")
    const aliasFile = join(rootDir, "schedule-helper.mjs")
    await writeFile(aliasFile, "export const marker = 'vite-alias-marker'\n", "utf8")
    await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
      "import { marker } from '#schedule-helper'",
      "export default { cron: '0 0 * * *', handler: () => marker }",
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
