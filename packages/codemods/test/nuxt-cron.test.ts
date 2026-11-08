import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { cronPresets } from "../src/nuxt-cron/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/nuxt-cron-test/", import.meta.url))
const dailyJob = 'export default defineCronHandler("daily", () => {})\n'

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function createApp(config: string, jobs: Record<string, string> = { "daily.ts": dailyJob }) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  await writeFile(join(cwd, "nuxt.config.ts"), config)
  await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { "nuxt-cron": "^1.8.0" } }))
  for (const [file, code] of Object.entries(jobs)) {
    const path = join(cwd, "server/cron", file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, code)
  }
  return cwd
}

describe.each([
  ["nuxt-cron", "every job on Node"],
  ["nuxt-cron-partial", "a six-field job that stays on a serverless host"],
])("nuxt-cron with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("nuxt-cron", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      // The report lists deleted files. Only kept and new files have an output snapshot.
      if (edit.after !== null) await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("nuxt-cron presets", () => {
  it("are five-field cron strings except everySecond", () => {
    for (const [name, cron] of Object.entries(cronPresets)) expect(cron.split(" ")).toHaveLength(name === "everySecond" ? 6 : 5)
  })

  it("preserves nuxt-cron 1.8.0's everyOddHour expression", () => {
    expect(cronPresets.everyOddHour).toBe("0 */2 * * *")
  })
})

describe("nuxt-cron migration safety", () => {
  it.each([
    ["cleanup.ts", "cleanup.cron.ts", "cleanup"],
    ["cleanup.js", "cleanup.ts", "cleanup"],
    ["reports/cleanup.ts", "reports/cleanup.cron.mjs", "reports/cleanup"],
  ])("keeps both colliding jobs %s and %s", async (first, second, target) => {
    const jobs = { [first]: dailyJob, [second]: dailyJob.replace("daily", "hourly"), "independent.ts": dailyJob }
    const cwd = await createApp('export default defineNuxtConfig({ modules: ["nuxt-cron"] })', jobs)
    const run = await runCodemod("nuxt-cron", { cwd })

    for (const file of [first, second]) {
      expect(await readFile(join(cwd, "server/cron", file), "utf8")).toBe(jobs[file])
      expect(run.result.followUps).toContainEqual(expect.objectContaining({ file: `server/cron/${file}`, message: expect.stringContaining("collide") }))
    }
    await expect(readFile(join(cwd, `server/schedules/${target}.ts`), "utf8")).rejects.toThrow()
    expect(await readFile(join(cwd, "server/schedules/independent.ts"), "utf8")).toContain("defineSchedule")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toContain('"nuxt-cron"')
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("nuxt-cron")
  })

  it("changes nothing when every job collides", async () => {
    const config = 'export default defineNuxtConfig({ modules: ["nuxt-cron"] })'
    const cwd = await createApp(config, { "cleanup.ts": dailyJob, "cleanup.cron.ts": dailyJob })
    await expect(runCodemod("nuxt-cron", { cwd })).rejects.toThrow("collide")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    for (const file of ["cleanup.ts", "cleanup.cron.ts"]) expect(await readFile(join(cwd, "server/cron", file), "utf8")).toBe(dailyJob)
  })

  it.each(["cloudflare", "netlify", "vercel", "node"])("uses the inline %s preset before the root preset", async (preset) => {
    const config = `export default defineNuxtConfig({ modules: [["vite-hub/nuxt", { preset: "${preset}" }], "nuxt-cron"], vitehub: { preset: "${preset === "node" ? "cloudflare" : "node"}" } })`
    const cwd = await createApp(config, { "daily.ts": 'export default defineCronHandler("daily", () => {}, { timeZone: "America/New_York" })' })
    const run = await runCodemod("nuxt-cron", { cwd, dryRun: true })
    const output = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    const job = run.result.edits.find(edit => edit.path === "server/schedules/daily.ts")?.after
    expect(output).toContain(preset === "node" ? 'schedule: { runtime: { driver: "process" } }' : "schedule: true")
    if (preset === "node") {
      expect(output).toContain("kv: true")
      expect(job).toContain('timeZone: "America/New_York"')
    }
    else {
      expect(job).not.toContain("timeZone:")
      expect(run.result.followUps).toContainEqual(expect.objectContaining({ message: expect.stringContaining("cron now runs in UTC") }))
    }
  })

  it("reads the inline preset on an imported ViteHub module", async () => {
    const cwd = await createApp('import vitehub from "vite-hub/nuxt"\nexport default defineNuxtConfig({ modules: [[vitehub, { preset: "cloudflare" }], "nuxt-cron"] })')
    const run = await runCodemod("nuxt-cron", { cwd, dryRun: true })
    expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).toContain("schedule: true")
  })

  it.each([
    'modules: [["vite-hub/nuxt", { schedule: false }], "nuxt-cron"]',
    'modules: [["vite-hub/nuxt", { schedule: true }], "nuxt-cron"]',
    'modules: [["vite-hub/nuxt", { preset: "cloudflare", schedule: false }], "nuxt-cron"]',
    'modules: [["vite-hub/nuxt", { schedule: { runtime: { driver: "process" } } }], "nuxt-cron"]',
    'modules: [["vite-hub/nuxt", { schedule: getSchedule() }], "nuxt-cron"]',
    'modules: [[vitehub, { schedule: false }], "nuxt-cron"]',
    'modules: ["nuxt-cron"], vitehub: { schedule: false }',
  ])("preserves existing Schedule options without moving jobs: %s", async (options) => {
    const config = `import vitehub from "vite-hub/nuxt"\nexport default defineNuxtConfig({ ${options} })`
    const cwd = await createApp(config)
    const manifest = await readFile(join(cwd, "package.json"), "utf8")
    await expect(runCodemod("nuxt-cron", { cwd })).rejects.toThrow(/schedule/i)
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(manifest)
    expect(await readFile(join(cwd, "server/cron/daily.ts"), "utf8")).toBe(dailyJob)
    await expect(readFile(join(cwd, "server/schedules/daily.ts"), "utf8")).rejects.toThrow()
  })

  it.each(["node", "cloudflare"])("keeps computed per-job time zones on %s", async (preset) => {
    const config = `export default defineNuxtConfig({ modules: ["nuxt-cron"], cron: { timeZone: "America/New_York" }, vitehub: { preset: "${preset}" } })`
    const computedJob = 'export default defineCronHandler("daily", () => {}, { timeZone: getZone() })\n'
    const cwd = await createApp(config, { "computed.ts": computedJob, "daily.ts": dailyJob })
    const run = await runCodemod("nuxt-cron", { cwd })
    expect(await readFile(join(cwd, "server/cron/computed.ts"), "utf8")).toBe(computedJob)
    await expect(readFile(join(cwd, "server/schedules/computed.ts"), "utf8")).rejects.toThrow()
    expect(await readFile(join(cwd, "server/schedules/daily.ts"), "utf8")).toContain("defineSchedule")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file: "server/cron/computed.ts", message: expect.stringContaining("timeZone") }))
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toContain('"nuxt-cron"')
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("nuxt-cron")
  })

  it.each([
    'modules: ["nuxt-cron"], cron: { timeZone: getZone() }',
    'modules: [["nuxt-cron", { timeZone: getZone() }]], cron: { timeZone: "America/New_York" }',
  ])("keeps computed module time zones unless a job overrides them: %s", async (options) => {
    const config = `export default defineNuxtConfig({ ${options} })`
    const explicitJob = 'export default defineCronHandler("daily", () => {}, { timeZone: "Europe/Madrid" })\n'
    const cwd = await createApp(config, { "computed.ts": dailyJob, "explicit.ts": explicitJob })
    const run = await runCodemod("nuxt-cron", { cwd })
    expect(await readFile(join(cwd, "server/cron/computed.ts"), "utf8")).toBe(dailyJob)
    expect(await readFile(join(cwd, "server/schedules/explicit.ts"), "utf8")).toContain('timeZone: "Europe/Madrid"')
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file: "server/cron/computed.ts", message: expect.stringContaining("timeZone") }))
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("nuxt-cron")
  })

  it.each([
    'modules: [["vite-hub/nuxt", { preset: getPreset() }], "nuxt-cron"], vitehub: { preset: "node" }',
    'modules: ["nuxt-cron"], vitehub: { preset: getPreset() }',
  ])("stops for a computed effective preset: %s", async (options) => {
    const cwd = await createApp(`export default defineNuxtConfig({ ${options} })`)
    await expect(runCodemod("nuxt-cron", { cwd })).rejects.toThrow("preset")
    expect(await readFile(join(cwd, "server/cron/daily.ts"), "utf8")).toBe(dailyJob)
  })

  it.each([
    'modules: ["nuxt-cron"], vitehub: { preset: "deno" }',
    'modules: [["vite-hub/nuxt", { preset: "deno" }], "nuxt-cron"]',
    'modules: ["nuxt-cron"], nitro: { preset: "deno-deploy" }',
  ])("keeps Deno jobs unchanged: %s", async (options) => {
    const config = `export default defineNuxtConfig({ ${options} })`
    const cwd = await createApp(config)
    await expect(runCodemod("nuxt-cron", { cwd })).rejects.toThrow("deno")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, "server/cron/daily.ts"), "utf8")).toBe(dailyJob)
  })

  it.each([
    'modules: ["nuxt-cron"], vitehub: { preset: "node", kv: false }',
    'modules: [["vite-hub/nuxt", { preset: "node", kv: false }], "nuxt-cron"]',
    'modules: [["vite-hub/nuxt", { kv: false }], "nuxt-cron"], vitehub: { preset: "node", kv: true }',
  ])("stops when Node explicitly disables KV: %s", async (options) => {
    const config = `export default defineNuxtConfig({ ${options} })`
    const cwd = await createApp(config)
    await expect(runCodemod("nuxt-cron", { cwd })).rejects.toThrow("KV")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, "server/cron/daily.ts"), "utf8")).toBe(dailyJob)
  })

  it.each([
    ["daily.ts", "../utils/format", false],
    ["reports/daily.ts", "../format", true],
    ["reports/daily.ts", "../../utils/format", false],
    ["reports/daily.ts", "./format", true],
  ])("checks the resolved relative import in %s: %s", async (file, specifier, changed) => {
    const cwd = await createApp('export default defineNuxtConfig({ modules: ["nuxt-cron"] })', { [file]: `import { format } from "${specifier}"\nexport default defineCronHandler("daily", () => format())` })
    const run = await runCodemod("nuxt-cron", { cwd, dryRun: true })
    const imports = run.result.followUps.filter(entry => entry.message.includes("relative import"))
    expect(imports).toHaveLength(changed ? 1 : 0)
  })
})
