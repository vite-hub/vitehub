import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runViteHubCli } from "@vite-hub/cli"
import { afterEach, describe, expect, it } from "vitest"

import { createMigrateCliNamespace } from "../src/migrate-cli.ts"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
    },
  }
}

const route = "import { db } from 'vite-hub/database/drizzle'\nimport { useServerEnv } from '#vitehub/env/server'\nexport default () => [db, useServerEnv()]\n"

describe("vitehub migrate", () => {
  let root = ""
  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true })
    root = ""
  })

  async function app() {
    root = await mkdtemp(join(tmpdir(), "vitehub-migrate-"))
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "server/api/notes.get.ts"), route)
    return root
  }

  async function migrate(args: string[], cwd: string) {
    const stdout = stream()
    const stderr = stream()
    // The command does not load the project config, so this loader must not run.
    const loadConfig = async () => { throw new Error("migrate loaded the project config") }
    const code = await runViteHubCli({ args: ["migrate", ...args], cwd, loadConfig, runtimeNamespaces: [createMigrateCliNamespace()], stderr, stdout })
    return { code, stderr: stderr.output(), stdout: stdout.output() }
  }

  it("prints the diff of the upgrade codemods with --dry-run and writes nothing", async () => {
    const cwd = await app()
    const result = await migrate(["--dry-run"], cwd)

    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(result.stdout).toContain("+import { db } from 'vite-hub/database'")
    expect(result.stdout).toContain("root-accessors: moved the accessor imports of 1 file(s) to the primitive roots")
    expect(await readFile(join(cwd, "server/api/notes.get.ts"), "utf8")).toBe(route)
  })

  it("rewrites the app folder that `run` names", async () => {
    const dir = await app()
    const result = await migrate(["run", dir], tmpdir())

    expect(result.code).toBe(0)
    expect(await readFile(join(dir, "server/api/notes.get.ts"), "utf8")).toBe("import { db } from 'vite-hub/database'\nimport { useServerEnv } from 'vite-hub/env'\nexport default () => [db, useServerEnv()]\n")
  })
})
