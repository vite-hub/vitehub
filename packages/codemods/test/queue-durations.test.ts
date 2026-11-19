import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod, upgradeCodemods } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/queue-durations/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/queue-durations-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("queue-durations", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("queue-durations", () => {
  it("renames delaySeconds and retentionSeconds and writes delay as a duration", async () => {
    const input = join(fixtures, "input")
    const run = await runCodemod("queue-durations", { cwd: input, dryRun: true })
    expect(run.result.edits.map(edit => edit.path)).toEqual([
      "server/api/nuxt.post.ts",
      "server/api/signup.post.ts",
      "server/queues/sync.ts",
      "server/queues/welcome-email.ts",
    ])
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "output", "report.txt"))
  })

  it("runs in the release upgrade after queue-workflow-verbs and is not detected after it", async () => {
    const names = upgradeCodemods.map(codemod => codemod.name)
    expect(names.indexOf("queue-durations")).toBeGreaterThan(names.indexOf("queue-workflow-verbs"))
    const { cwd } = await migrate({
      "server/api/a.ts": "import { sendQueue } from 'vite-hub/queue'\nexport const send = () => sendQueue('welcome', {}, { delaySeconds: 60 })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("queue-durations")
    await runCodemod("queue-durations", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/api/a.ts"), "utf8")).toBe("import { sendQueue } from 'vite-hub/queue'\nexport const send = () => sendQueue('welcome', {}, { delay: '60s' })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("queue-durations")
  })

  it("reads the old Queue verbs, which vitehub migrate detects before it renames them", async () => {
    const { after } = await migrate({
      "server/api/a.ts": "import { getQueue, runQueue } from 'vite-hub/queue'\nawait runQueue('welcome', {}, { delaySeconds: 1 })\nconst queue = await getQueue('welcome')\nawait queue.send({}, { delaySeconds: 2 })\n",
    })
    expect(after["server/api/a.ts"]).toBe("import { getQueue, runQueue } from 'vite-hub/queue'\nawait runQueue('welcome', {}, { delay: '1s' })\nconst queue = await getQueue('welcome')\nawait queue.send({}, { delay: '2s' })\n")
  })

  it("keeps files that do not use Queue and calls of other functions", async () => {
    const source = "import { sendQueue } from 'vite-hub/queue'\nfunction local(sendQueue: (...args: unknown[]) => void) {\n  sendQueue('a', {}, { delaySeconds: 1 })\n}\nexport { local, sendQueue }\n"
    const { after, run } = await migrate({
      "server/a.ts": source,
      "workers/native.ts": "export default { queue: (batch) => batch.retryAll({ delaySeconds: 5 }) }\n",
    })
    expect(after["server/a.ts"]).toBeUndefined()
    expect(run.result.followUps.map(entry => entry.file)).toEqual(["server/a.ts"])
  })
})
