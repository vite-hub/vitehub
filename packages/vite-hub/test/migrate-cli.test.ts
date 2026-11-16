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
    expect(result.stdout).toContain("root-accessors (server/api/notes.get.ts uses vite-hub/database/drizzle)\n  moved the accessor imports of 1 file(s) to the primitive roots")
    expect(await readFile(join(cwd, "server/api/notes.get.ts"), "utf8")).toBe(route)
  })

  it("rewrites the app folder that it names", async () => {
    const dir = await app()
    const result = await migrate([dir], tmpdir())

    expect(result.code).toBe(0)
    expect(await readFile(join(dir, "server/api/notes.get.ts"), "utf8")).toBe("import { db } from 'vite-hub/database'\nimport { useServerEnv } from 'vite-hub/env'\nexport default () => [db, useServerEnv()]\n")
  })

  it("shows `vitehub migrate [dir]` in its help", async () => {
    const result = await migrate(["--help"], tmpdir())

    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(result.stdout).toContain("Usage: vitehub migrate [dir] [--dry-run]")
    expect(result.stdout).not.toContain("migrate run")
  })

  it("upgrades a pre-redesign app in one run", async () => {
    root = await mkdtemp(join(tmpdir(), "vitehub-migrate-"))
    const files: Record<string, string> = {
      ".env.example": "NUXT_APP_SECRET=\n",
      "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: ['vite-hub/nuxt', 'nuxt-og-image'],\n  vitehub: { preset: process.env.VERCEL ? 'vercel' : 'cloudflare' },\n})\n",
      "package.json": "{\"dependencies\":{\"nuxt\":\"npm:nuxt-nightly@5x\",\"nuxt-og-image\":\"^5.0.0\",\"vite-hub\":\"0.0.9\"}}\n",
      "scripts/kv.vite.config.ts": "import { hubKv } from '@vite-hub/kv/vite'\nexport default { plugins: [hubKv()] }\n",
      "server/api/sync.post.ts": [
        "import { runWorkflow } from 'vite-hub/workflow'",
        "import { useServerEnv } from '#vitehub/env/server'",
        "import { email } from 'vite-hub/email/server'",
        "",
        "export default defineEventHandler(async () => {",
        "  await email.send({ to: useServerEnv().ADMIN_EMAIL, subject: 'Sync', text: 'Started' })",
        "  return await runWorkflow('sync', { full: true })",
        "})",
        "",
      ].join("\n"),
      "tsconfig.json": "{\n  \"extends\": \"./.nuxt/tsconfig.json\",\n  \"compilerOptions\": {\n    \"paths\": {\n      \"#vitehub/emails/*\": [\"./.vitehub/email/templates/*\"],\n      \"#vitehub/env/server\": [\"./.vitehub/env/server.d.ts\"]\n    }\n  }\n}\n",
    }
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), contents)
    }

    const result = await migrate([root], tmpdir())

    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(root, "nuxt.config.ts"), "utf8")).toContain("vitehub: { host: process.env.VERCEL ? 'vercel' : 'cloudflare' },")
    expect(await readFile(join(root, "server/api/sync.post.ts"), "utf8")).toBe([
      "import { startWorkflow } from 'vite-hub/workflow'",
      "import { useServerEnv } from 'vite-hub/env'",
      "import { email } from 'vite-hub/email'",
      "",
      "export default defineEventHandler(async () => {",
      "  await email.send({ to: useServerEnv().ADMIN_EMAIL, subject: 'Sync', text: 'Started' })",
      "  return await startWorkflow('sync', { full: true })",
      "})",
      "",
    ].join("\n"))
    expect(await readFile(join(root, "scripts/kv.vite.config.ts"), "utf8")).toBe("import { hubKV } from '@vite-hub/kv/vite'\nexport default { plugins: [hubKV()] }\n")
    expect(await readFile(join(root, "tsconfig.json"), "utf8")).toBe("{\n  \"extends\": \"./.nuxt/tsconfig.json\",\n  \"compilerOptions\": {\n  }\n}\n")
    expect(await readFile(join(root, ".env.example"), "utf8")).toBe(files[".env.example"])
    for (const name of ["vitehub-options", "root-accessors", "queue-workflow-verbs", "renamed-apis", "tsconfig-paths"]) expect(result.stdout).toContain(`\n${name} (`)
    expect(result.stdout).toContain("Keep `NUXT_APP_SECRET` when another module, such as nuxt-og-image, reads it.")
    expect(result.stdout).toContain("Rule VHUB0003 lists Result calls whose error the code drops, such as `await email.send(...)`")

    const again = await migrate([root], tmpdir())
    expect(again.stdout).toContain("1 codemod applies to")
    expect(again.stdout).toContain("Files changed (0):")
  })
})
