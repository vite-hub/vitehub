import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

// `define-forms-drop` copies files from Drop (consumer group B), which pins a ViteHub preview: the default Database in
// `server/databases/config.ts` with sibling schema files and migrations, and a named `content` export. Its Schedule uses
// the removed `defineSchedule(cron, handler)` form. `define-forms-named` copies the named Databases of the Vite
// playground and the Sandbox Task example from before this release.
describe.each([
  ["define-forms-drop", "Drop: the default Database, a Content file, and a positional Schedule"],
  ["define-forms-named", "named Databases, Sandbox Tasks with `run`, and positional Schedules"],
])("define-forms with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("define-forms", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("define-forms edge cases", () => {
  let root = ""
  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true })
    root = ""
  })

  async function migrate(files: Record<string, string>) {
    root = await mkdtemp(join(tmpdir(), "vitehub-define-forms-"))
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents)
    }
    const run = await runCodemod("define-forms", { cwd: root, dryRun: true })
    return { after: Object.fromEntries(run.result.edits.map(edit => [edit.path, edit.after])), run }
  }

  it("detects each former form for the migration wizard", async () => {
    const reasons = async (files: Record<string, string>) => {
      await migrate(files)
      return (await detectCodemods(root)).map(entry => [entry.codemod.name, entry.detection.reason])
    }
    expect(await reasons({ "server/schedules/a.ts": "export default defineSchedule('0 9 * * *', () => {})\n" }))
      .toEqual([["define-forms", "server/schedules/a.ts calls defineSchedule(cron, handler)"]])
    expect(await reasons({ "server/sandbox-tasks/a.ts": "import { defineSandboxTask } from 'vite-hub/sandbox/task'\nexport default defineSandboxTask({ run: () => 1 })\n" }))
      .toEqual([["define-forms", "server/sandbox-tasks/a.ts passes `run` to defineSandboxTask()"]])
    expect(await reasons({ "server/content.ts": "import { defineContent } from 'vite-hub/content'\nexport const content = defineContent({})\n" }))
      .toEqual([["define-forms", "server/content.ts exports `content` by name"]])
    expect(await reasons({ "server/databases/blog/config.ts": "export default defineDatabase({ name: 'blog', schema: {} })\n" }))
      .toEqual([["define-forms", "server/databases/blog/config.ts uses a former Database file layout"]])
  })

  it("does not detect the current forms", async () => {
    await migrate({
      "server/schedules/a.ts": "export default defineSchedule({ cron: '0 9 * * *', handler: () => {} })\n",
      "server/sandbox-tasks/a.ts": "export default defineSandboxTask({ handler: () => 1 })\n",
      "server/content.ts": "export default defineContent({})\n",
      "server/databases/main.ts": "export default defineDatabase({ name: 'main', schema: {} })\n",
      "server/databases/blog/index.ts": "import { posts } from './posts'\nexport default defineDatabase({ name: 'blog', schema: { posts } })\n",
      "server/databases/blog/posts.ts": "export const posts = {}\n",
    })
    expect(await detectCodemods(root)).toEqual([])
  })

  it("leaves defineSchedule of another module alone", async () => {
    const { run } = await migrate({
      "server/jobs.ts": "import { defineSchedule } from './scheduler'\nexport default defineSchedule('0 9 * * *', () => {})\n",
    })
    expect(run.result.edits).toEqual([])
  })

  it("renames a run method and keeps the other options", async () => {
    const { after } = await migrate({
      "server/sandbox-tasks/a.ts": "export default defineSandboxTask({\n  timeout: 1000,\n  async run(payload: { a: number }) {\n    return payload.a\n  },\n})\n",
    })
    expect(after["server/sandbox-tasks/a.ts"]).toBe("export default defineSandboxTask({\n  timeout: 1000,\n  async handler(payload: { a: number }) {\n    return payload.a\n  },\n})\n")
  })

  it("keeps the content constant when the file reads it", async () => {
    const { after } = await migrate({
      "server/content.ts": "import { defineContent } from 'vite-hub/content'\nexport const content = defineContent({})\nexport const docs = content.collection('docs')\n",
    })
    expect(after["server/content.ts"]).toBe("import { defineContent } from 'vite-hub/content'\nconst content = defineContent({})\nexport default content\nexport const docs = content.collection('docs')\n")
  })

  it("re-exports content as the default export", async () => {
    const { after } = await migrate({
      "server/content.ts": "export { content } from './content/definition'\n",
      "server/routes/docs.ts": "import { content, docs } from '~~/server/content'\nexport default () => [content, docs]\n",
    })
    expect(after["server/content.ts"]).toBe("export { content as default } from './content/definition'\n")
    expect(after["server/routes/docs.ts"]).toBe("import content, { docs } from '~~/server/content'\nexport default () => [content, docs]\n")
  })

  it("moves the implicit default Database migrations", async () => {
    const { run } = await migrate({
      "server/databases/migrations/0000_init.sql": "CREATE TABLE a (id integer);\n",
      "server/api/a.ts": "export default () => 1\n",
    })
    expect(run.result.edits.map(edit => [edit.path, edit.after === null ? "deleted" : "written"])).toEqual([
      ["server/databases/migrations/0000_init.sql", "deleted"],
      ["server/databases/default/migrations/0000_init.sql", "written"],
    ])
  })

  it("reports a helper that the new discovery reads as a Database", async () => {
    const { run } = await migrate({
      "server/databases/shared.ts": "export const id = 1\n",
      "server/databases/blog/config.ts": "import { id } from '../shared'\nexport default defineDatabase({ name: 'blog', schema: { id } })\n",
    })
    expect(run.result.edits.map(edit => edit.path)).toEqual(["server/databases/blog/config.ts", "server/databases/blog/index.ts"])
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/databases/shared.ts", message: expect.stringContaining("Database Definition `shared`") })])
  })

  it("stops on the default Database when default/ already exists", async () => {
    const { run } = await migrate({
      "server/databases/config.ts": "export default defineDatabase({ schema: {} })\n",
      "server/databases/default/notes.ts": "export const notes = {}\n",
    })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps[0]?.message).toContain("`server/databases/default/` already exists")
  })
})
