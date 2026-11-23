import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod, runMigration, upgradeCodemods } from "../src/index.ts"
import { nuxtServerImports } from "../src/nuxt-server-imports/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/nuxt-server-imports-test/", import.meta.url))
const config = "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"] })\n"

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function createApp(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [file, code] of Object.entries({ "nuxt.config.ts": config, ...files })) {
    const path = join(cwd, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, code)
  }
  return cwd
}

async function migrate(files: Record<string, string>) {
  const cwd = await createApp(files)
  const run = await runCodemod("nuxt-server-imports", { cwd, dryRun: true })
  return { cwd, run, after: (path: string) => run.result.edits.find(edit => edit.path === path)?.after }
}

describe("nuxt-server-imports", () => {
  it("imports the ViteHub helpers of an app", async () => {
    const name = "nuxt-server-imports"
    const input = join(fixtures, name, "input")
    const run = await runCodemod(name, { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    expect(run.result.edits.map(edit => edit.path)).not.toContain("server/schedules/cleanup.ts")
    expect(run.result.edits.map(edit => edit.path)).not.toContain("server/routes/shadow.ts")
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })

  it("names the first file that needs an import", async () => {
    const cwd = await createApp({ "server/api/a.ts": "export default { fetch: () => kv.get(\"a\") }\n" })
    expect(await nuxtServerImports.detect({ cwd })).toEqual({ reason: "server/api/a.ts uses kv without an import, and Nuxt server auto-imports are off" })
  })

  it.each([
    "experimental: { nitroAutoImports: true }",
    "experimental: { nitroAutoImports: process.env.AUTO === \"1\" }",
    "nitroLegacy: true",
    "nitroLegacy: { imports: true }",
    "nitroLegacy: {}",
  ])("leaves the app when nuxt.config sets %s", async (option) => {
    const cwd = await createApp({
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${option} })\n`,
      "server/api/a.ts": "export default { fetch: () => kv.get(\"a\") }\n",
    })
    expect(await nuxtServerImports.detect({ cwd })).toBeUndefined()
    expect((await runCodemod("nuxt-server-imports", { cwd, dryRun: true })).result.edits).toEqual([])
  })

  it.each([
    "experimental: { nitroAutoImports: false }",
    "nitroLegacy: false",
    "nitroLegacy: { imports: false }",
  ])("imports the helpers when nuxt.config sets %s", async (option) => {
    const { after } = await migrate({
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${option} })\n`,
      "server/api/a.ts": "export default { fetch: () => kv.get(\"a\") }\n",
    })
    expect(after("server/api/a.ts")).toBe("import { kv } from \"vite-hub/kv\"\n\nexport default { fetch: () => kv.get(\"a\") }\n")
  })

  it("finds the module when nuxt.config imports it", async () => {
    const { after } = await migrate({
      "nuxt.config.ts": "import viteHub from \"vite-hub/nuxt\"\nexport default defineNuxtConfig({ modules: [[viteHub, { kv: true }]] })\n",
      "server/api/a.ts": "export default { fetch: () => kv.get(\"a\") }\n",
    })
    expect(after("server/api/a.ts")).toContain("import { kv } from \"vite-hub/kv\"")
  })

  it("leaves a Nuxt app without ViteHub", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "server/api/a.ts": "export default { fetch: () => kv.get(\"a\") }\n",
    })
    expect(await nuxtServerImports.detect({ cwd })).toBeUndefined()
  })

  it("leaves a file that imports every helper it reads", async () => {
    const cwd = await createApp({ "server/api/a.ts": "import { kv } from \"vite-hub/kv\"\nexport default { fetch: () => kv.get(\"a\") }\n" })
    expect(await nuxtServerImports.detect({ cwd })).toBeUndefined()
  })

  it("does not import a name that the app gives from nitro.imports", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], nitro: { imports: { imports: [{ name: \"kv\", from: \"~/lib/kv\" }] } } })\n",
      "server/api/a.ts": "export default { fetch: () => kv.get(\"a\") }\n",
    })
    expect(await nuxtServerImports.detect({ cwd })).toBeUndefined()
    const run = await runCodemod("nuxt-server-imports", { cwd, dryRun: true })
    expect(run.result.edits).toEqual([])
    expect(run.result.notes).toContain("nuxt.config.ts nitro.imports.imports gives `kv`, and Nuxt still auto-imports it, so 1 file(s) keep the app's `kv`. Import ViteHub's from \"vite-hub/kv\" where you need it.")
  })

  it("keeps type positions and value uses apart", async () => {
    const { after } = await migrate({
      "server/api/a.ts": "type Row = schema.Users\nconst store: typeof kv = useStore()\nexport default { fetch: () => store as Row }\n",
    })
    expect(after("server/api/a.ts")).toBe("import { kv } from \"vite-hub/kv\"\n\ntype Row = schema.Users\nconst store: typeof kv = useStore()\nexport default { fetch: () => store as Row }\n")
  })

  it("adds a new import next to a type import of the same entry", async () => {
    const { after } = await migrate({
      "server/api/a.ts": "import type { QueueJob } from \"vite-hub/queue\"\nexport default { fetch: (job: QueueJob) => sendQueue(\"a\", job) }\n",
    })
    expect(after("server/api/a.ts")).toBe("import type { QueueJob } from \"vite-hub/queue\"\nimport { sendQueue } from \"vite-hub/queue\"\nexport default { fetch: (job: QueueJob) => sendQueue(\"a\", job) }\n")
  })

  it("puts the import below a shebang", async () => {
    const { after } = await migrate({ "server/tasks/run.mjs": "#!/usr/bin/env node\nawait sendQueue(\"a\", {})\n" })
    expect(after("server/tasks/run.mjs")).toBe("#!/usr/bin/env node\nimport { sendQueue } from \"vite-hub/queue\"\n\nawait sendQueue(\"a\", {})\n")
  })

  it("follows serverDir", async () => {
    const { after } = await migrate({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], serverDir: \"api-server\" })\n",
      "api-server/routes/a.ts": "export default { fetch: () => kv.get(\"a\") }\n",
      "server/api/b.ts": "export default { fetch: () => kv.get(\"b\") }\n",
    })
    expect(after("api-server/routes/a.ts")).toContain("import { kv } from \"vite-hub/kv\"")
    expect(after("server/api/b.ts")).toBeUndefined()
  })

  it("reports a file that does not parse", async () => {
    const { run } = await migrate({ "server/api/a.ts": "export default { fetch: () => kv.get(\"a\" }\n" })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/api/a.ts" })])
  })

  it("imports the helper names that earlier upgrade codemods write", async () => {
    const cwd = await createApp({
      "package.json": JSON.stringify({ dependencies: { "vite-hub": "0.0.0" } }),
      "server/api/a.ts": "import { runQueue } from \"vite-hub/queue\"\nexport default { fetch: () => runQueue(\"a\", {}) }\n",
      "server/api/b.ts": "export default { fetch: () => useAuth().user }\n",
    })
    const migration = await runMigration({ cwd, dryRun: true, codemods: upgradeCodemods })
    expect(migration.steps.map(step => step.codemod.name)).toContain("nuxt-server-imports")
    const after = (path: string) => migration.edits.find(edit => edit.path === path)?.after
    expect(after("server/api/a.ts")).toContain("sendQueue")
    expect(after("server/api/b.ts")).toBe("import { useAuth } from \"vite-hub/auth/server\"\n\nexport default { fetch: () => useAuth().user }\n")
  })
})
