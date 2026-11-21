import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod, upgradeCodemods } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/shell-driver/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/shell-driver-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("shell-driver", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("shell-driver", () => {
  it("renames the Shell provider names to driver", async () => {
    const input = join(fixtures, "input")
    const run = await runCodemod("shell-driver", { cwd: input, dryRun: true })
    expect(run.result.edits.map(edit => edit.path)).toEqual([
      "server/api/tools.post.ts",
      "server/utils/docs-shell.ts",
      "server/utils/lazy.ts",
      "server/utils/namespace.ts",
    ])
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "output", "report.txt"))
  })

  it("runs in the release upgrade and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("shell-driver")
    const { cwd } = await migrate({
      "server/shell.ts": "import { createShellRuntime } from 'vite-hub/shell'\nimport { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'\nexport const shell = createShellRuntime({ provider: createJustBashProvider({ fs }) })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("shell-driver")
    await runCodemod("shell-driver", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/shell.ts"), "utf8")).toBe("import { createShellRuntime } from 'vite-hub/shell'\nimport { createJustBashDriver } from 'vite-hub/shell/providers/just-bash'\nexport const shell = createShellRuntime({ driver: createJustBashDriver({ fs }) })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("shell-driver")
  })

  it("keeps provider keys of other APIs and shadowed names", async () => {
    const source = [
      "import { createShellRuntime } from 'vite-hub/shell'",
      "import { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'",
      "import { createBrowser } from 'vite-hub/browser'",
      "createBrowser({ provider: browser })",
      "export const model = { provider: 'anthropic' }",
      "function local(createShellRuntime, createJustBashProvider) {",
      "  return createShellRuntime({ provider: createJustBashProvider() })",
      "}",
      "",
    ].join("\n")
    const { after } = await migrate({ "server/a.ts": source })
    expect(after["server/a.ts"]).toBe(source.replace(
      "import { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'",
      "import { createJustBashDriver } from 'vite-hub/shell/providers/just-bash'",
    ))
  })

  it("keeps the old local name when the new name is declared in the file", async () => {
    const { after } = await migrate({
      "server/top.ts": "import { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'\nconst createJustBashDriver = 1\nexport const make = () => [createJustBashProvider({ fs }), createJustBashDriver]\n",
      "server/nested.ts": "import { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'\nexport function make(createJustBashDriver) {\n  return createJustBashProvider({ fs: createJustBashDriver })\n}\n",
      "server/lazy.ts": "export async function make(createJustBashDriver) {\n  const { createJustBashProvider } = await import('vite-hub/shell/providers/just-bash')\n  return createJustBashProvider({ fs: createJustBashDriver })\n}\n",
    })
    expect(after["server/top.ts"]).toBe("import { createJustBashDriver as createJustBashProvider } from 'vite-hub/shell/providers/just-bash'\nconst createJustBashDriver = 1\nexport const make = () => [createJustBashProvider({ fs }), createJustBashDriver]\n")
    expect(after["server/nested.ts"]).toBe("import { createJustBashDriver as createJustBashProvider } from 'vite-hub/shell/providers/just-bash'\nexport function make(createJustBashDriver) {\n  return createJustBashProvider({ fs: createJustBashDriver })\n}\n")
    expect(after["server/lazy.ts"]).toBe("export async function make(createJustBashDriver) {\n  const { createJustBashDriver: createJustBashProvider } = await import('vite-hub/shell/providers/just-bash')\n  return createJustBashProvider({ fs: createJustBashDriver })\n}\n")
  })

  it("renames quoted and computed keys and the options of dynamically imported calls", async () => {
    const { after } = await migrate({
      "server/a.ts": [
        "export async function make(backend, workspace) {",
        "  const { createShellRuntime: runtime } = await import('@vite-hub/shell')",
        "  const tools = await import('vite-hub/workspace')",
        "  return [",
        "    runtime({ ['provider']: backend }),",
        "    runtime({ \"provider\": backend }),",
        "    tools.createWorkspaceTools(workspace, { executionProvider: backend }),",
        "  ]",
        "}",
        "",
      ].join("\n"),
    })
    expect(after["server/a.ts"]).toBe([
      "export async function make(backend, workspace) {",
      "  const { createShellRuntime: runtime } = await import('@vite-hub/shell')",
      "  const tools = await import('vite-hub/workspace')",
      "  return [",
      "    runtime({ ['driver']: backend }),",
      "    runtime({ \"driver\": backend }),",
      "    tools.createWorkspaceTools(workspace, { shellDriver: backend }),",
      "  ]",
      "}",
      "",
    ].join("\n"))
  })

  it("lists options that it cannot see", async () => {
    const { run } = await migrate({
      "server/a.ts": "import { createShellRuntime } from '@vite-hub/shell'\nexport const make = (options, base) => [createShellRuntime(options), createShellRuntime({ ...base })]\n",
    })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps).toEqual([
      { file: "server/a.ts", line: 2, message: expect.stringContaining("Rename it in the options that this `createShellRuntime()` call gets.") },
      { file: "server/a.ts", line: 2, message: expect.stringContaining("Rename it in the object that this `createShellRuntime()` call spreads.") },
    ])
  })
})
