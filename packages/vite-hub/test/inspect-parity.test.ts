import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { collectViteHubDefinitionInspectors } from "@vite-hub/internal/inspect"
import { resolveConfig } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { discoverConsoleBuildCatalog } from "../src/console/build.ts"
import { vitehub } from "../src/index.ts"

import type { ConsoleSectionCatalog } from "../src/console/runtime/definitions.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function writeProjectFile(root: string, file: string, contents: string) {
  await mkdir(join(root, file, ".."), { recursive: true })
  await writeFile(join(root, file), contents)
}

const sectionByKind = {
  database: "databases",
  queue: "queues",
  "rate-limit": "rate-limits",
  "sandbox-task": "sandbox-tasks",
  schedule: "schedules",
  workflow: "workflows",
  workspace: "workspaces",
} as const satisfies Record<string, keyof ConsoleSectionCatalog["content"]>

describe("Definition inspection parity", () => {
  it("lists the same Definitions in `vitehub inspect` and the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-inspect-parity-"))
    directories.push(root)
    await writeProjectFile(root, "package.json", "{}\n")
    await writeProjectFile(root, "server/databases/config.ts", "export default defineDatabase({ schema: { notes } })\n")
    await writeProjectFile(root, "server/queues/email.ts", "export default defineQueue({ handler() {} })\n")
    await writeProjectFile(root, "server/api/login.post.ts", 'export default defineHandler(async (event) => { await requireRateLimit(event, "login", { limit: 5, window: "1m" }) })\n')
    await writeProjectFile(root, "src/runner.sandbox-task.ts", "export default defineSandboxTask({ run: async () => ({}) })\n")
    await writeProjectFile(root, "server/schedules/adhoc.ts", "export default defineSchedule({ cron: '0 9 * * *', handler() {} })\n")
    await writeProjectFile(root, "server/workflows/welcome.ts", "export default defineWorkflow(async () => {})\n")
    await writeProjectFile(root, "server/workspaces/docs/config.ts", "export default defineWorkspace({ store: { provider: 'memory' } })\n")

    const config = await resolveConfig({
      logLevel: "silent",
      plugins: [vitehub({ blob: false, console: false, database: true, env: false, preset: "cloudflare", queue: true, rateLimit: true, sandboxTask: true, schedule: true, workflow: true, workspace: true })],
      root,
    }, "build")
    const inspectors = await collectViteHubDefinitionInspectors(config.plugins)
    const catalog = await discoverConsoleBuildCatalog({
      discoveryRoot: root,
      projectRoot: root,
      sections: Object.values(sectionByKind),
    })

    for (const [kind, section] of Object.entries(sectionByKind)) {
      const inspector = inspectors.find(candidate => candidate.kind === kind)
      expect(inspector, `Expected a ${kind} inspector`).toBeDefined()
      const listed = await inspector!.list()
      expect(listed.length, `Expected ${kind} Definitions`).toBeGreaterThan(0)
      const content = catalog.content[section]
      if (content?.kind === "record-table") {
        // Record tables keep one `definition:<name>` record per Definition, with the same file and fields.
        expect(content.records.map(record => record.id), kind).toEqual(listed.map(definition => `definition:${definition.name}`))
        for (const [index, definition] of listed.entries()) {
          expect(content.records[index]?.fields, kind).toEqual(expect.arrayContaining([
            ...definition.fields,
            { label: "File", value: definition.file },
            { label: "Source", value: definition.source },
          ]))
        }
        continue
      }
      expect(content?.kind, kind).toBe("definition-catalog")
      expect({ definitions: listed, kind: "definition-catalog" }, kind).toEqual(content)
    }
  }, 60_000)

  it("marks contributed Database tables in `vitehub inspect` and the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-inspect-contributed-tables-"))
    directories.push(root)
    await writeProjectFile(root, "package.json", "{}\n")
    await writeProjectFile(root, "server/databases/config.ts", "export default defineDatabase({ schema: { notes } })\n")
    const tables = join(root, "vendor/history.mjs")
    await writeProjectFile(root, "vendor/history.mjs", "export const historySchema = {}\n")
    const historyOwner = {
      name: "history-owner/vite",
      vitehub: { databases: () => [{ definition: { export: "historySchema", module: tables }, name: "history" }] },
    }

    const config = await resolveConfig({
      logLevel: "silent",
      plugins: [vitehub({ blob: false, console: false, database: true, env: false, preset: "node" }), historyOwner],
      root,
    }, "build")
    const inspector = (await collectViteHubDefinitionInspectors(config.plugins)).find(candidate => candidate.kind === "database")
    const listed = await inspector!.list()
    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: config.plugins, projectRoot: root, sections: ["databases"] })

    // The Database package owns this field. The contributed schema holds no Drizzle table.
    expect(listed[0]?.fields).toContainEqual({ label: "Contributed tables", value: `No tables from "history" (${tables}#historySchema from plugin "history-owner/vite")` })
    expect(catalog.content.databases).toEqual({ definitions: listed, kind: "definition-catalog" })
  }, 60_000)

  it("lists contributed Workspaces in `vitehub inspect` and the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-inspect-contributed-"))
    directories.push(root)
    await writeProjectFile(root, "package.json", "{}\n")
    await writeProjectFile(root, "server/workspaces/docs.ts", "export default defineWorkspace({ store: { provider: 'memory' } })\n")
    const contentOwner = {
      name: "content-owner/vite",
      vitehub: { workspaces: () => [{ definition: { export: "contentWorkspace", module: "content-owner/workspace" }, name: "content" }] },
    }

    const config = await resolveConfig({
      logLevel: "silent",
      plugins: [vitehub({ blob: false, console: false, env: false, preset: "node", workspace: true }), contentOwner],
      root,
    }, "build")
    const inspector = (await collectViteHubDefinitionInspectors(config.plugins)).find(candidate => candidate.kind === "workspace")
    const listed = await inspector!.list()
    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: config.plugins, projectRoot: root, sections: ["workspaces"] })

    expect(listed.map(definition => [definition.name, definition.source])).toEqual([
      ["content", "vite-plugin-contribution"],
      ["docs", "server-workspaces"],
    ])
    expect(catalog.content.workspaces).toEqual({ definitions: listed, kind: "definition-catalog" })
  }, 60_000)

  it("lists contributed Schedules in `vitehub inspect` and the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-inspect-contributed-schedule-"))
    directories.push(root)
    await writeProjectFile(root, "package.json", "{}\n")
    await writeProjectFile(root, "server/schedules/report.ts", "export default defineSchedule({ cron: '0 9 * * *', handler() {} })\n")
    await writeProjectFile(root, ".vitehub/content/publish-schedule.ts", "export default defineSchedule({ cron: '*/5 * * * *', manual: true, handler() {} })\n")
    const contentOwner = {
      name: "content-owner/vite",
      vitehub: { schedules: () => [{ definition: { module: join(root, ".vitehub/content/publish-schedule.ts") }, name: "content/publish", reason: "The cms preset publishes due documents." }] },
    }

    const config = await resolveConfig({
      logLevel: "silent",
      plugins: [vitehub({ blob: false, console: false, env: false, preset: "node", schedule: true }), contentOwner],
      root,
    }, "build")
    const inspector = (await collectViteHubDefinitionInspectors(config.plugins)).find(candidate => candidate.kind === "schedule")
    const listed = await inspector!.list()
    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: config.plugins, projectRoot: root, sections: ["schedules"] })

    expect(listed.map(definition => [definition.name, definition.source])).toEqual([
      ["content/publish", "vite-plugin-contribution"],
      ["report", "server-schedules"],
    ])
    expect(listed[0]!.fields).toEqual(expect.arrayContaining([
      { label: "Contributed by", value: "content-owner/vite" },
      { label: "Reason", value: "The cms preset publishes due documents." },
    ]))
    const content = catalog.content.schedules
    expect(content?.kind).toBe("record-table")
    if (content?.kind !== "record-table") return
    expect(content.records.map(record => record.id)).toEqual(["definition:content/publish", "definition:report"])
    expect(content.records[0]?.fields).toEqual(expect.arrayContaining([...listed[0]!.fields]))
    expect(catalog.manualSchedules).toEqual([{ handler: join(root, ".vitehub/content/publish-schedule.ts"), name: "content/publish" }])
  }, 60_000)
})
