import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/tsconfig-paths-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("tsconfig-paths", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.map(edit => [edit.path, edit.after])), cwd, run }
}

describe("tsconfig-paths", () => {
  it("removes the #vitehub/* paths into generated folders and keeps the app's own paths", async () => {
    const { after, run } = await migrate({
      "tsconfig.json": [
        "{",
        "  // Nuxt writes the base config.",
        "  \"extends\": \"./.nuxt/tsconfig.json\",",
        "  \"compilerOptions\": {",
        "    \"paths\": {",
        "      \"#vitehub/emails/*\": [\"./.vitehub/email/templates/*\"],",
        "      \"#vitehub/env/server\": [\".vitehub/env/server.d.ts\"],",
        "      \"~/utils/*\": [\"./utils/*\"],",
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
    })
    expect(after["tsconfig.json"]).toBe([
      "{",
      "  // Nuxt writes the base config.",
      "  \"extends\": \"./.nuxt/tsconfig.json\",",
      "  \"compilerOptions\": {",
      "    \"paths\": {",
      "      \"~/utils/*\": [\"./utils/*\"],",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"))
    expect(run.result.followUps).toEqual([])
    expect(run.result.notes).toEqual(["tsconfig.json: removed `#vitehub/emails/*`, `#vitehub/env/server` from compilerOptions.paths. ViteHub generates their types in .vitehub/types/."])
  })

  it("removes paths when only #vitehub/* entries were in it, so the extended paths apply again", async () => {
    const { after } = await migrate({
      "tsconfig.json": "{\n  \"extends\": \"./.nuxt/tsconfig.json\",\n  \"compilerOptions\": {\n    \"strict\": true,\n    \"paths\": {\n      \"#vitehub/emails/*\": [\"./.vitehub/email/templates/*\"]\n    }\n  }\n}\n",
    })
    expect(after["tsconfig.json"]).toBe("{\n  \"extends\": \"./.nuxt/tsconfig.json\",\n  \"compilerOptions\": {\n    \"strict\": true,\n  }\n}\n")
  })

  it("reports a #vitehub/* path to the app's own file and changes nothing", async () => {
    const { run } = await migrate({
      "packages/app/tsconfig.test.json": "{ \"compilerOptions\": { \"paths\": { \"#vitehub/env/server\": [\"./test/env-stub.ts\"] } } }\n",
    })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps).toEqual([{ file: "packages/app/tsconfig.test.json", line: 1, message: expect.stringContaining("`#vitehub/env/server` maps a ViteHub alias to your own file") }])
  })

  it("is detected while a #vitehub/* path is left and not after the migration", async () => {
    const { cwd } = await migrate({ "tsconfig.json": "{ \"compilerOptions\": { \"paths\": { \"#vitehub/emails/*\": [\"./.vitehub/email/templates/*\"] } } }\n" })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toEqual(["tsconfig-paths"])
    await runCodemod("tsconfig-paths", { cwd })
    expect(await detectCodemods(cwd)).toEqual([])
    const current = await migrate({ "tsconfig.json": "{ \"compilerOptions\": { \"paths\": { \"~/*\": [\"./*\"] } } }\n" })
    expect(await detectCodemods(current.cwd)).toEqual([])
  })
})
