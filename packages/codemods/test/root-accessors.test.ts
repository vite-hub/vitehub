import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

// Inputs are files copied from public apps that pin a ViteHub preview: Drop and Finance (consumer group B), calories
// (group D), and the Schedule server API page before this release.
describe.each([
  ["root-accessors-drop", "Drop: db from vite-hub/database/drizzle beside #vitehub/env/server"],
  ["root-accessors-finance", "Finance: email from vite-hub/email/server and Server Env in auth and schedules"],
  ["root-accessors-calories", "calories: useDatabase() and Server Env in an Agent and a collection"],
  ["root-accessors-schedule", "runSchedule() with the generated registry"],
])("root-accessors with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("root-accessors", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("root-accessors edge cases", () => {
  let root = ""
  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true })
    root = ""
  })

  async function migrate(files: Record<string, string>) {
    root = await mkdtemp(join(tmpdir(), "vitehub-root-accessors-"))
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents)
    }
    const run = await runCodemod("root-accessors", { cwd: root, dryRun: true })
    return { after: Object.fromEntries(run.result.edits.map(edit => [edit.path, edit.after])), run }
  }

  it("detects former accessor paths for the migration wizard", async () => {
    await migrate({
      "server/api/a.ts": "import { db } from 'vite-hub/database/drizzle'\nexport { db }\n",
    })
    const detected = await detectCodemods(root)
    expect(detected.map(entry => [entry.codemod.name, entry.detection.reason])).toEqual([
      ["root-accessors", "server/api/a.ts uses vite-hub/database/drizzle"],
    ])
  })

  it("does not detect browser Public Env or current accessor paths", async () => {
    await migrate({
      "app/env.ts": "import { usePublicEnv } from '#vitehub/env/public'\nexport { usePublicEnv }\n",
      "server/env.ts": "import { useServerEnv } from 'vite-hub/env'\nexport { useServerEnv }\n",
    })
    expect(await detectCodemods(root)).toEqual([])
  })

  it("joins a moved import with an existing import of the root", async () => {
    const { after } = await migrate({
      "server/api/a.ts": "import { defineDatabase } from 'vite-hub/database'\nimport { db, schema } from 'vite-hub/database/drizzle'\nexport { db, defineDatabase, schema }\n",
    })
    expect(after["server/api/a.ts"]).toBe("import { defineDatabase, db, schema } from 'vite-hub/database'\nexport { db, defineDatabase, schema }\n")
  })

  it("keeps #vitehub/env/public in browser code and moves it in server code", async () => {
    const { after, run } = await migrate({
      "app/composables/title.ts": "import { usePublicEnv } from '#vitehub/env/public'\nexport const title = () => usePublicEnv().title\n",
      "server/api/title.get.ts": "import { usePublicEnv } from '#vitehub/env/public'\nimport { useServerEnv } from '#vitehub/env/server'\nexport default () => [usePublicEnv().title, useServerEnv().token]\n",
    })
    expect(Object.keys(after)).toEqual(["server/api/title.get.ts"])
    expect(after["server/api/title.get.ts"]).toBe("import { usePublicEnv, useServerEnv } from 'vite-hub/env'\nexport default () => [usePublicEnv().title, useServerEnv().token]\n")
    expect(run.result.notes).toContain("1 file(s) outside `server/` keep `#vitehub/env/public`, the browser path of Public Env.")
  })

  it("uses @vite-hub/env when the app does not install vite-hub", async () => {
    const { after } = await migrate({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/env": "*" } }),
      "src/server.ts": "import { useServerEnv } from '#vitehub/env/server'\nexport const env = useServerEnv()\n",
    })
    expect(after["src/server.ts"]).toBe("import { useServerEnv } from '@vite-hub/env'\nexport const env = useServerEnv()\n")
  })

  it("rewrites registry augmentations, mocks, and dynamic imports, and reports names that are no longer public", async () => {
    const { after, run } = await migrate({
      "server/types.d.ts": "declare module 'vite-hub/database/drizzle' {\n  interface DatabaseRegistry { notes: { schema: {} } }\n}\nexport {}\n",
      "test/a.test.ts": "vi.mock('vite-hub/email/server', () => ({ email: { send: vi.fn() } }))\nconst { db } = await import('vite-hub/database/drizzle')\n",
      "server/agent.ts": "import { agentDb, useDatabase } from '@vite-hub/database/drizzle'\nexport const notes = useDatabase('notes')?.db\nexport { agentDb }\n",
    })
    expect(after["server/types.d.ts"]).toContain("declare module 'vite-hub/database' {")
    expect(after["test/a.test.ts"]).toBe("vi.mock('vite-hub/email', () => ({ email: { send: vi.fn() } }))\nconst { db } = await import('vite-hub/database')\n")
    expect(after["server/agent.ts"]).toContain("import { agentDb, useDatabase } from '@vite-hub/database'")
    expect(run.result.followUps.map(item => `${item.file}:${item.line}`)).toEqual(["server/agent.ts:1", "server/agent.ts:2"])
  })

  it("keeps the schedule registry import when runSchedule() options are not a literal", async () => {
    const { after, run } = await migrate({
      "server/api/run.ts": "import registry from '#vitehub/schedule/registry'\nimport { runSchedule } from 'vite-hub/schedule/runtime'\nconst options = { registry }\nexport default () => runSchedule('a', options)\n",
    })
    expect(after["server/api/run.ts"]).toBe("import registry from '#vitehub/schedule/registry'\nimport { runSchedule } from 'vite-hub/schedule'\nconst options = { registry }\nexport default () => runSchedule('a', options)\n")
    expect(run.result.followUps).toEqual([{ file: "server/api/run.ts", line: 4, message: "`runSchedule()` no longer takes a `registry` option. Remove it from these options." }])
  })

  it.each(["vite-hub/schedule/runtime", "@vite-hub/schedule/runtime"])("reports namespace imports from %s", async (source) => {
    const { after, run } = await migrate({
      "server/api/run.js": `import registry from '#vitehub/schedule/registry'\nimport * as schedule from '${source}'\nexport default () => schedule.runSchedule('a', { registry })\n`,
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([{
      file: "server/api/run.js",
      line: 2,
      message: `\`runSchedule\` and \`RunScheduleOptions\` moved to \`${source.replace("/runtime", "")}\`. Update reads through this namespace import by hand and remove the \`registry\` option from \`runSchedule()\`.`,
    }])
  })

  it("keeps a re-export of a removed name and reports it", async () => {
    const { after, run } = await migrate({
      "server/utils/db.ts": "export { agentDb } from 'vite-hub/database/drizzle'\nexport { db } from 'vite-hub/database/drizzle'\n",
      "server/utils/dynamic.ts": "export const load = async () => (await import('vite-hub/database/drizzle')).agentDb\n",
    })
    expect(after["server/utils/db.ts"]).toBe("export { agentDb } from 'vite-hub/database/drizzle'\nexport { db } from 'vite-hub/database'\n")
    expect(after["server/utils/dynamic.ts"]).toBe("export const load = async () => (await import('vite-hub/database')).agentDb\n")
    expect(run.result.followUps.map(item => `${item.file}:${item.line}`)).toEqual(["server/utils/db.ts:1", "server/utils/dynamic.ts:1"])
  })

  it("keeps the schedule registry import when another expression reads it", async () => {
    const { after } = await migrate({
      "server/api/run.ts": "import registry from '#vitehub/schedule/registry'\nimport { runSchedule } from 'vite-hub/schedule/runtime'\nexport default () => runSchedule('a', { registry, scheduledAt: pick(registry) })\n",
    })
    expect(after["server/api/run.ts"]).toBe("import registry from '#vitehub/schedule/registry'\nimport { runSchedule } from 'vite-hub/schedule'\nexport default () => runSchedule('a', { scheduledAt: pick(registry) })\n")
  })

  it("leaves runSchedule() calls alone when a local declaration shadows the import", async () => {
    const { after, run } = await migrate({
      "server/api/run.ts": "import registry from '#vitehub/schedule/registry'\nimport { runSchedule } from 'vite-hub/schedule/runtime'\nexport const retry = (runSchedule) => runSchedule('a', { registry })\n",
    })
    expect(after["server/api/run.ts"]).toBe("import registry from '#vitehub/schedule/registry'\nimport { runSchedule } from 'vite-hub/schedule'\nexport const retry = (runSchedule) => runSchedule('a', { registry })\n")
    expect(run.result.followUps.map(item => `${item.file}:${item.line}`)).toEqual(["server/api/run.ts:3"])
  })

  it("reports module paths in strings, such as test stubs, without changing them", async () => {
    const { run } = await migrate({
      "test/stubs.ts": "export const stubs = {\n  \"vite-hub/database/drizzle\": \"export const db = globalThis.db\",\n  \"#vitehub/env/server\": \"export const useServerEnv = () => ({})\",\n}\n",
    })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps).toEqual([
      { file: "test/stubs.ts", line: 2, message: "This string names `vite-hub/database/drizzle`. Its exports moved to `vite-hub/database`, so update the stub or alias by hand." },
      { file: "test/stubs.ts", line: 3, message: "This string names `#vitehub/env/server`. Its exports moved to `vite-hub/env`, so update the stub or alias by hand." },
    ])
  })

  it("does nothing when the app has no moved import", async () => {
    const { run } = await migrate({ "server/api/a.ts": "import { kv } from 'vite-hub/kv'\nexport { kv }\n" })
    expect(run.result.edits).toEqual([])
    expect(run.result.summary).toBe("found no import to move")
  })
})
