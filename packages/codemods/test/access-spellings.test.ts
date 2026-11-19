import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/access-spellings-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("access-spellings", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("access-spellings", () => {
  it("runs in the release upgrade and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("access-spellings")
    const { cwd } = await migrate({
      "server/realtime/docs.ts": "import { defineRealtime } from 'vite-hub/realtime'\nexport default defineRealtime({ auth: true, document: { workspace: 'docs' } })\n",
      "server/mcp/tools/search.ts": "import { defineMcpTool } from 'vite-hub/mcp'\nexport default defineMcpTool({ description: 'Search.', public: true, handler: () => 'results' })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("access-spellings")
    await runCodemod("access-spellings", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/realtime/docs.ts"), "utf8")).toBe("import { defineRealtime } from 'vite-hub/realtime'\nexport default defineRealtime({ authorize: true, document: { workspace: 'docs' } })\n")
    expect(await readFile(join(cwd, "server/mcp/tools/search.ts"), "utf8")).toBe("import { defineMcpTool } from 'vite-hub/mcp'\nexport default defineMcpTool({ description: 'Search.', access: 'public', handler: () => 'results' })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("access-spellings")
  })

  it("renames auto-imported and plain-object definitions, and removes the false flags", async () => {
    const { after } = await migrate({
      "server/realtime/presence.ts": "export default defineRealtime({\n  auth: true,\n  document: false,\n})\n",
      "server/realtime/plain.js": "export default { auth: false, authorize: ({ mode }) => mode === \"read\", document: false }\n",
      "server/mcp/prompts/review.ts": "import { defineMcpPrompt } from \"@vite-hub/mcp\"\nexport default defineMcpPrompt({ public: false, handler: () => \"Review.\" })\n",
      "server/mcp/resources/player.ts": "export default { uri: \"ui://player.html\", public: true, handler: () => \"<html>\" }\n",
    })
    expect(after).toEqual({
      "server/realtime/presence.ts": "export default defineRealtime({\n  authorize: true,\n  document: false,\n})\n",
      "server/realtime/plain.js": "export default { authorize: ({ mode }) => mode === \"read\", document: false }\n",
      "server/mcp/prompts/review.ts": "import { defineMcpPrompt } from \"@vite-hub/mcp\"\nexport default defineMcpPrompt({ handler: () => \"Review.\" })\n",
      "server/mcp/resources/player.ts": "export default { uri: \"ui://player.html\", access: \"public\", handler: () => \"<html>\" }\n",
    })
  })

  it("leaves auth: true next to authorize() for a person, because the callback now also runs signed out", async () => {
    const source = "import { defineRealtime } from 'vite-hub/realtime'\nexport default defineRealtime({\n  auth: true,\n  authorize: ({ user, mode }) => mode === 'read' || user?.id === 'ana',\n  document: false,\n})\n"
    const { after, run } = await migrate({ "server/realtime/pages.ts": source })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/realtime/pages.ts", line: 3, message: expect.stringContaining("return `false` from `authorize()` when `user` is `null`") })])
  })

  it("keeps the same keys of other calls and shadowed names", async () => {
    const source = [
      "import { defineRealtime } from 'vite-hub/realtime'",
      "const options = { auth: true, public: true }",
      "function local(defineRealtime) {",
      "  return defineRealtime({ auth: true })",
      "}",
      "export default defineRealtime({ access: 'public', document: false })",
      "",
    ].join("\n")
    const { after } = await migrate({ "server/realtime/open.ts": source, "server/api/config.ts": "export default { auth: true, public: true }\n" })
    expect(after).toEqual({})
  })

  it("reports legacy rules whose effective access cannot be preserved", async () => {
    const { after, run } = await migrate({
      "server/mcp/tools/default.ts": "const options = { public: false }; export default defineMcpTool({ public: true, ...options, handler: () => 'ok' })",
      "server/mcp/prompts/computed.ts": "const key = 'public'; export default { public: true, [key]: false, handler: () => 'ok' }",
      "server/mcp/resources/duplicate.ts": "export default { public: true, public: false, uri: 'test:resource', handler: () => 'ok' }",
      "server/mcp/tools/mixed.ts": "export default { public: false, access: 'public', handler: () => 'ok' }",
      "server/realtime/computed.ts": "const key = 'authorize'; export default defineRealtime({ auth: true, [key]: () => true, document: false })",
      "server/realtime/composed.ts": "const options = { auth: true }; export default { ...options, auth: false, document: false }",
    })
    expect(after).toEqual({})
    expect(run.result.followUps.map(item => item.file)).toEqual([
      "server/mcp/prompts/computed.ts",
      "server/mcp/resources/duplicate.ts",
      "server/mcp/tools/default.ts",
      "server/mcp/tools/mixed.ts",
      "server/realtime/composed.ts",
      "server/realtime/computed.ts",
    ])
  })

  it("migrates wrapped definition literals and nested Realtime files", async () => {
    const { after } = await migrate({
      "server/realtime/notes/presence.ts": "export default { ['auth']: true, document: false } satisfies RealtimeDefinition",
      "server/mcp/tools/search.ts": "export default defineMcpTool({ public: true, handler: () => 'ok' } as McpToolDefinition)",
    })
    expect(after).toEqual({
      "server/realtime/notes/presence.ts": 'export default { ["authorize"]: true, document: false } satisfies RealtimeDefinition',
      "server/mcp/tools/search.ts": 'export default defineMcpTool({ access: "public", handler: () => \'ok\' } as McpToolDefinition)',
    })
  })
})
