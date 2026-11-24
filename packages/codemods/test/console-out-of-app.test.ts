import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod, upgradeCodemods } from "../src/index.ts"
import { migrateConsoleAuthorize } from "../src/console-out-of-app/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/console-out-of-app-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function project(files: Record<string, string>): Promise<string> {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  return cwd
}

function lines(...values: string[]): string {
  return `${values.join("\n")}\n`
}

describe("console-out-of-app", () => {
  it("removes the page branch and the page context type, and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("console-out-of-app")
    const cwd = await project({
      "server/console-authorize.ts": lines(
        "import { defineConsoleAuthorize } from 'vite-hub/console/auth'",
        "import type { ConsoleAuthorizeContext, ConsolePageAuthorizeContext } from 'vite-hub/console/auth'",
        "",
        "export default defineConsoleAuthorize(({ via, user }: ConsoleAuthorizeContext) => {",
        "  if (via === \"page\") return user?.role === \"admin\"",
        "  return true",
        "})",
      ),
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("console-out-of-app")
    await runCodemod("console-out-of-app", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/console-authorize.ts"), "utf8")).toBe(lines(
      "import { defineConsoleAuthorize } from 'vite-hub/console/auth'",
      "import type { ConsoleAuthorizeContext } from 'vite-hub/console/auth'",
      "",
      "export default defineConsoleAuthorize(({ via, user }: ConsoleAuthorizeContext) => {",
      "  return true",
      "})",
    ))
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("console-out-of-app")
  })

  it("removes a member check with its comment, in a function declared apart", () => {
    const input = lines(
      "import { defineConsoleAuthorize as define } from 'vite-hub/console/auth'",
      "import type { ConsolePageAuthorizeContext } from 'vite-hub/console/auth'",
      "",
      "function authorize(context) {",
      "  // Show the Console link to every signed-in user of the app.",
      "  if ('page' == context.via) {",
      "    return Boolean(context.user)",
      "  }",
      "  // Every other caller keeps the access that it has without `authorize`.",
      "  return true",
      "}",
      "",
      "export default define(authorize)",
    )
    expect(migrateConsoleAuthorize("server/console.ts", input)).toEqual({
      changed: true,
      code: lines(
        "import { defineConsoleAuthorize as define } from 'vite-hub/console/auth'",
        "",
        "function authorize(context) {",
        "  // Every other caller keeps the access that it has without `authorize`.",
        "  return true",
        "}",
        "",
        "export default define(authorize)",
      ),
      followUps: [],
    })
  })

  it("removes the page branch of a plain function in server/console-authorize.ts", () => {
    const input = "export default (context) => {\n  if (context.via === 'page') return false\n  return context.via === 'console'\n}\n"
    expect(migrateConsoleAuthorize("server/console-authorize.js", input).code).toBe("export default (context) => {\n  return context.via === 'console'\n}\n")
  })

  it("reports the page checks that it cannot remove", () => {
    const input = lines(
      "import { defineConsoleAuthorize, type ConsolePageAuthorizeContext } from 'vite-hub/console/auth'",
      "",
      "const isPage = (context: ConsolePageAuthorizeContext) => context.user !== undefined",
      "",
      "export default defineConsoleAuthorize((context) => {",
      "  if (context.via === 'page') return isPage(context)",
      "  else if (context.via === 'cli') return false",
      "  switch (context.via) {",
      "    case 'page': return false",
      "  }",
      "  return context.via !== 'page' && true",
      "})",
    )
    const result = migrateConsoleAuthorize("server/console.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps.map(followUp => [followUp.line, followUp.message])).toEqual([
      [6, expect.stringContaining("no longer gets `via: \"page\"`")],
      [9, expect.stringContaining("no longer gets `via: \"page\"`")],
      [11, expect.stringContaining("no longer gets `via: \"page\"`")],
      [1, expect.stringContaining("`ConsolePageAuthorizeContext` was removed")],
    ])
  })

  it("leaves other functions and other modules alone", () => {
    const input = lines(
      "import { defineConsoleAuthorize } from './my-auth'",
      "export default defineConsoleAuthorize(({ via }) => {",
      "  if (via === 'page') return false",
      "  return true",
      "})",
      "export const route = ({ via }) => via === 'page'",
    )
    expect(migrateConsoleAuthorize("server/console.ts", input)).toMatchObject({ changed: false, code: input, followUps: [] })
  })

  it("reports VITEHUB_CONSOLE_MCP_KEY lines and never prints the value", async () => {
    const cwd = await project({
      ".env": "NUXT_PUBLIC_SITE=1\nVITEHUB_CONSOLE_MCP_KEY=secret-value-123\n",
      "apps/web/wrangler.jsonc": "{ \"vars\": { \"VITEHUB_CONSOLE_MCP_KEY\": \"secret-value-456\" } }\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("console-out-of-app")
    const run = await runCodemod("console-out-of-app", { cwd, dryRun: true })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps.map(followUp => `${followUp.file}:${followUp.line}`)).toEqual([".env:2", "apps/web/wrangler.jsonc:1"])
    expect(formatReport(run)).not.toContain("secret-value")
  })
})
