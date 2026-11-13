import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { oneEntryImports } from "../src/one-entry-imports/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/one-entry-imports-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function createApp(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [file, code] of Object.entries(files)) {
    const path = join(cwd, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, code)
  }
  return cwd
}

async function migrate(files: Record<string, string>) {
  const cwd = await createApp(files)
  const run = await runCodemod("one-entry-imports", { cwd, dryRun: true })
  return { run, after: (path: string) => run.result.edits.find(edit => edit.path === path)?.after }
}

describe("one-entry-imports", () => {
  it("moves the imports of an app", async () => {
    const name = "one-entry-imports"
    const input = join(fixtures, name, "input")
    const run = await runCodemod(name, { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })

  it("joins a moved import with an import of the same root", async () => {
    const { after } = await migrate({
      "server/api/a.ts": "import { blob } from \"@vite-hub/blob\"\nimport { ensureBlob } from \"@vite-hub/blob/ensure\"\nimport { file } from \"@vite-hub/blob/reference\"\n",
    })
    expect(after("server/api/a.ts")).toBe("import { blob, ensureBlob, file } from \"@vite-hub/blob\"\n")
  })

  it("keeps type imports apart from value imports", async () => {
    const { after } = await migrate({
      "server/a.ts": "import { env } from \"vite-hub/env\"\nimport type { SecretEnv } from \"vite-hub/env/secret\"\n",
    })
    expect(after("server/a.ts")).toBe("import { env } from \"vite-hub/env\"\nimport type { SecretEnv } from \"vite-hub/env\"\n")
  })

  it.each([
    "src/components/Upload.tsx",
    "app/utils/upload.ts",
    "src/lib/upload.ts",
    "upload.client.ts",
    "shared/signatures.ts",
  ])("keeps signature imports browser-safe in %s", async (file) => {
    const { after, run } = await migrate({
      [file]: "import { detectContentType } from 'vite-hub/blob/content-type'\nexport { detectContentType as detect } from '@vite-hub/blob/content-type'\n",
    })
    expect(after(file)).toBe("import { detectContentType } from 'vite-hub/blob/client'\nexport { detectContentType as detect } from '@vite-hub/blob/client'\n")
    expect(run.result.followUps).toEqual([])
  })

  it.each([
    "export * from 'vite-hub/env/server'",
    "export type * from '@vite-hub/env/server'",
    "export * as serverEnv from 'vite-hub/env/server'",
    "import * as serverEnv from '@vite-hub/env/server'",
    "import { resolveServerEnv, loadServerEnv } from '@vite-hub/env/server'",
  ])("preserves the explicit Env registry contract in %s", async (code) => {
    const { run } = await migrate({ "server/barrel.ts": `${code}\n` })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps).toEqual([])
  })

  it("moves imports in import types and declare module", async () => {
    const { after } = await migrate({
      "types.d.ts": "declare module \"vite-hub/env/server\" {}\nexport type T = import(\"vite-hub/env/presets\").TypesafeEnvOptions\n",
    })
    expect(after("types.d.ts")).toBe("declare module \"vite-hub/env/server\" {}\nexport type T = import(\"vite-hub/env\").TypesafeEnvOptions\n")
  })

  it("asks for nitro when the app installs neither nitro nor nuxt", async () => {
    const { run } = await migrate({
      "package.json": JSON.stringify({ dependencies: { "vite-hub": "0.0.4" } }),
      "server/tasks/a.ts": "import { defineTask } from \"vite-hub/task\"\nexport default defineTask({ run: () => ({ result: 1 }) })\n",
    })
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file: "package.json", message: expect.stringContaining("Add `nitro`") }))
  })

  it("detects only apps that import a moved path", async () => {
    const used = await createApp({ "server/a.ts": "import { glob } from 'vite-hub/source/glob'\n" })
    const unused = await createApp({ "server/a.ts": "import { glob } from 'vite-hub/source'\nimport { defineTask } from 'nitro/task'\n" })
    await expect(oneEntryImports.detect({ cwd: used })).resolves.toEqual({ reason: "server/a.ts imports vite-hub/source/glob" })
    await expect(oneEntryImports.detect({ cwd: unused })).resolves.toBeUndefined()
  })
})
