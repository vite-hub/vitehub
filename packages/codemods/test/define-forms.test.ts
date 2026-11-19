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

  it("detects the former Queue form", async () => {
    await migrate({ "server/queues/welcome.ts": "import { defineQueue } from 'vite-hub/queue'\nexport default defineQueue(async () => {})\n" })
    expect((await detectCodemods(root)).map(entry => [entry.codemod.name, entry.detection.reason]))
      .toEqual([["define-forms", "server/queues/welcome.ts calls defineQueue(handler)"]])
  })

  it("migrates Queue and Workflow definitions in the same file", async () => {
    const path = "server/utils/definitions.ts"
    const imports = "import { defineQueue } from 'vite-hub/queue'\nimport { defineWorkflow } from 'vite-hub/workflow'\n"
    const queue = "export const queue = defineQueue(job => job.payload)"
    const workflow = "export const workflow = defineWorkflow('mail', input => input, { 'id': 'old', rootStep: false })"
    const { after } = await migrate({ [path]: `${imports}${queue}\n${workflow}\n` })
    expect(after[path]).toBe(`${imports}export const queue = defineQueue({ handler: job => job.payload })\nexport const workflow = defineWorkflow({ handler: ({ payload: input }) => input, rootStep: false })\n`)
  })

  it.each([
    ["preserves a handler that reads the job by field",
      "export default defineQueue<{ email: string }>(async (job) => {\n  console.log(job.id, job.payload.email, job.attempts)\n}, { concurrency: 4 })\n",
      "export default defineQueue<{ email: string }>({ handler: async (job) => {\n  console.log(job.id, job.payload.email, job.attempts)\n}, concurrency: 4 })\n"],
    ["preserves a bare arrow parameter even with comments",
      "export default defineQueue(async /* ( */ job => send(job.payload))\n",
      "export default defineQueue({ handler: async /* ( */ job => send(job.payload) })\n"],
    ["keeps a type annotation",
      "export default defineQueue(function (job: QueueJob<string>) { return job.payload })\n",
      "export default defineQueue({ handler: function (job: QueueJob<string>) { return job.payload } })\n"],
    ["preserves grouped handlers and flattens grouped literal options",
      "export default defineQueue((job => job.payload), (({ concurrency: 4, })),)\n",
      "export default defineQueue({ handler: (job => job.payload), concurrency: 4, })\n"],
    ["composes nested Queue rewrites",
      "export default defineQueue(() => defineQueue(() => null))\n",
      "export default defineQueue({ handler: () => defineQueue({ handler: () => null }) })\n"],
    ["preserves arguments access and strict mode",
      "export default defineQueue(function (job) { 'use strict'; arguments[0].attempts++; return job.attempts })\n",
      "export default defineQueue({ handler: function (job) { 'use strict'; arguments[0].attempts++; return job.attempts } })\n"],
    ["uses the shorthand for a handler named handler",
      "export default defineQueue(handler, { cache: false })\n",
      "export default defineQueue({ handler, cache: false })\n"],
    ["preserves multiline option trivia",
      "export default defineQueue(handler, { /* Keep this option. */\n  cache: false,\n})\n",
      "export default defineQueue({ handler, /* Keep this option. */\n  cache: false,\n})\n"],
    ["preserves comments around empty options",
      "export default defineQueue(handler, (/* ( */ {}),)\n",
      "export default defineQueue({ handler, /* ( */ })\n"],
  ])("rewrites defineQueue: %s", async (_, before, expected) => {
    const { after, run } = await migrate({ "server/queues/a.ts": before })
    expect(after["server/queues/a.ts"]).toBe(expected)
    expect(run.result.followUps).toEqual([])
    expect(await detectCodemods(root)).toEqual([expect.objectContaining({ codemod: expect.objectContaining({ name: "define-forms" }) })])
  })

  it.each([
    ["a shared options object", "const defaults = { concurrency: 2, handler: fallback }\nexport default defineQueue(sendReport, (defaults))\n"],
    ["an options spread", "export default defineQueue(sendReport, { ...defaults })\n"],
    ["an explicit handler in the options", "export default defineQueue(sendReport, { concurrency: 2, handler: fallback })\n"],
  ])("reports %s without changing the Queue call", async (_, before) => {
    const { after, run } = await migrate({ "server/queues/a.ts": before })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/queues/a.ts", message: expect.stringContaining("keep the original handler") })])
  })

  it("rewrites only the legacy calls to the imported Queue helper", async () => {
    const before = [
      "import { defineQueue as queue } from 'vite-hub/queue'",
      "const definition = { handler: () => 1 }",
      "const handler = () => 2",
      "queue(definition)",
      "queue(buildDefinition())",
      "queue({ handler } satisfies QueueDefinition)",
      "function other(queue: Function) { queue(() => 3) }",
      "queue(handler)",
      "",
    ].join("\n")
    const { after, run } = await migrate({ "server/queues/a.ts": before })
    expect(after["server/queues/a.ts"]).toBe(before.replace("queue(handler)", "queue({ handler })"))
    expect(run.result.followUps).toEqual([])
  })

  it("leaves the object form and defineQueue of another module alone", async () => {
    const { run } = await migrate({
      "server/queues/a.ts": "export default defineQueue({ handler: async ({ payload }) => payload })\n",
      "server/jobs.ts": "import { defineQueue } from './jobs-lib'\nexport default defineQueue(async (job) => job.payload)\n",
    })
    expect(run.result.edits).toEqual([])
  })

  it("does not detect the current forms", async () => {
    await migrate({
      "server/queues/a.ts": "export default defineQueue({ handler: async ({ payload }) => payload, concurrency: 2 })\n",
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

  it.each([
    "export default {}\n",
    "const other = {}\nexport { other as default }\n",
    "export { default } from './other'\n",
  ])("reports a conflicting default export without changing Content consumers: %s", async (existingDefault) => {
    const { after, run } = await migrate({
      "server/content.ts": `export const content = defineContent({})\n${existingDefault}`,
      "server/routes/docs.ts": "import { content } from '../content'\nexport default content\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/content.ts", message: expect.stringContaining("default export") })])
  })

  it("keeps consumers unchanged when a Content declaration needs manual conversion", async () => {
    const { after, run } = await migrate({
      "server/content.ts": "export const content = defineContent({}), other = 1\n",
      "server/routes/docs.ts": "import { content } from '../content'\nexport default content\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toHaveLength(1)
  })

  it("rewrites CommonJS and TypeScript import-equals references to moved Databases", async () => {
    const { after, run } = await migrate({
      "server/databases/config.cjs": "module.exports = defineDatabase({ schema: require('./schema.cjs') })\n",
      "server/databases/schema.cjs": "module.exports = {}\n",
      "server/routes/docs.cjs": "const db = require('../databases/config.cjs')\nmodule.exports = db\n",
      "server/routes/docs.cts": "import db = require('../databases/config')\nexport = db\n",
    })
    expect(after["server/databases/default/index.cjs"]).toContain("require('./schema.cjs')")
    expect(after["server/routes/docs.cjs"]).toContain("require('../databases/default/index.cjs')")
    expect(after["server/routes/docs.cts"]).toContain("require('../databases/default/index')")
    expect(run.result.followUps).toEqual([])
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

  describe("Workflows", () => {
    const run = async (code: string, path = "server/workflows/onboard-user/index.ts") => {
      const result = await migrate({ [path]: code })
      return { after: result.after[path], followUps: result.run.result.followUps }
    }
    const header = "import { createWorkflow, defineWorkflow } from 'vite-hub/workflow'\n"

    it("drops the name and moves the payload type to the type argument", async () => {
      const { after, followUps } = await run(`${header}export default defineWorkflow('onboard-user', async (payload: { email: string }, { steps }) => {\n  return await steps.createUser(payload)\n})\n`)
      expect(after).toBe(`${header}export default defineWorkflow<{ email: string }>({ handler: async ({ payload, steps }) => {\n  return await steps.createUser(payload)\n} })\n`)
      expect(followUps).toEqual([])
    })

    it("moves the options into the object and drops the unused `id` option", async () => {
      const { after } = await run(`${header}export default defineWorkflow('onboard-user', async input => input, { 'id': 'x', native: durable, rootStep: false })\n`)
      expect(after).toBe(`${header}export default defineWorkflow({ handler: async ({ payload: input }) => input, native: durable, rootStep: false })\n`)
    })

    it.each(["context", "{ ...context }"])("passes the full context to a handler with %s", async (binding) => {
      const { after } = await run(`${header}export default defineWorkflow('onboard-user', (input, ${binding}) => context.payload.email)\n`)
      expect(after).toContain(`workflowContext => ((input, ${binding}) => context.payload.email)(workflowContext.payload, workflowContext)`)
    })

    it.each(["options", "{ ...options, rootStep: false }"])("reports dynamic options %s and leaves the call alone", async (options) => {
      const { after, followUps } = await run(`${header}const options = { id: 'old' }\nexport default defineWorkflow('onboard-user', () => {}, ${options})\n`)
      expect(after).toBeUndefined()
      expect(followUps).toEqual([expect.objectContaining({ message: expect.stringContaining("remove the former `id`") })])
    })

    it("keeps a payload default and the old payload type argument", async () => {
      const { after } = await run(`${header}export default defineWorkflow<'onboard-user', { email?: string }>('onboard-user', async (payload = {}) => payload)\n`)
      expect(after).toBe(`${header}export default defineWorkflow<{ email?: string }>({ handler: async ({ payload = {} }) => payload })\n`)
    })

    it("moves the oldest defineWorkflow(handler, options) form without changing its handler", async () => {
      const { after } = await run(`${header}export default defineWorkflow(async ({ payload }) => payload, { rootStep: false })\n`)
      expect(after).toBe(`${header}export default defineWorkflow({ handler: async ({ payload }) => payload, rootStep: false })\n`)
    })

    it("wraps a handler that a name references and reports it", async () => {
      const { after, followUps } = await run(`${header}async function onboard(payload: { email: string }) { return payload.email }\nexport default defineWorkflow('onboard-user', onboard)\n`)
      expect(after).toContain("defineWorkflow<Parameters<typeof onboard>[0]>({ handler: workflowContext => onboard(workflowContext.payload) })")
      expect(followUps).toEqual([expect.objectContaining({ message: expect.stringContaining("wrapped `onboard`") })])
    })

    it("rewrites createWorkflow handlers and keeps the name", async () => {
      const { after } = await run(`${header}export const welcome = createWorkflow('welcome', async (payload: { email: string }) => payload.email)\nexport const other = createWorkflow({ name: 'other', handler: async (payload, { sleep }) => sleep('1 day') })\n`, "server/utils/workflows.ts")
      expect(after).toBe(`${header}export const welcome = createWorkflow<{ email: string }>('welcome', async ({ payload }) => payload.email)\nexport const other = createWorkflow({ name: 'other', handler: async ({ payload, sleep }) => sleep('1 day') })\n`)
    })

    it("does not change the current forms, so a second run does nothing", async () => {
      const code = `${header}import type { WorkflowExecutionContext } from 'vite-hub/workflow'\nexport default defineWorkflow<{ email: string }>({ handler: async ({ payload, steps }) => steps.createUser(payload) })\nexport const welcome = createWorkflow('welcome', async ({ sleep }: WorkflowExecutionContext) => sleep('1 day'))\n`
      expect((await run(code)).after).toBeUndefined()
      expect((await detectCodemods(root)).filter(entry => entry.codemod.name === "define-forms")).toEqual([])
    })

    it.each([
      "createWorkflow('welcome', ({ id }: { id: string }) => id.toUpperCase())",
      "createWorkflow('welcome', context => context.name)",
      "createWorkflow('welcome', handler)",
      "createWorkflow({ name: 'welcome', handler })",
      "createWorkflow({ name: 'welcome', handler({ id }) { return id } })",
    ])("reports ambiguous createWorkflow forms without rewriting %s", async (call) => {
      const { after, followUps } = await run(`${header}export const welcome = ${call}\n`)
      expect(after).toBeUndefined()
      expect(followUps).toEqual([expect.objectContaining({ message: expect.stringContaining("Check this `createWorkflow()` handler") })])
      expect((await detectCodemods(root)).find(entry => entry.codemod.name === "define-forms")?.detection.reason).toContain("Workflow definitions to review")
    })

    it("detects the former form for the migration wizard", async () => {
      await run(`${header}export default defineWorkflow('onboard-user', async () => undefined)\n`)
      expect((await detectCodemods(root)).map(entry => [entry.codemod.name, entry.detection.reason]))
        .toEqual([["define-forms", "server/workflows/onboard-user/index.ts calls defineWorkflow(name, handler) or passes a (payload, context) Workflow handler"]])
    })
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
