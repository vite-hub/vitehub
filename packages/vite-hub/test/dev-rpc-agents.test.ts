import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"
import { createServer, type PluginOption } from "vite"
import { callOperation } from "@vite-hub/internal/operations"
import { vitehub } from "vite-hub"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const execFileAsync = promisify(execFile)

const probe = `
const { resolveConfig } = await import(process.argv[3])
const { vitehub } = await import(process.argv[2])
await resolveConfig({
  configFile: false,
  logLevel: "silent",
  root: process.cwd(),
  plugins: [vitehub({ host: "node", agent: true })],
}, "serve")
process.exit(0)
`

describe("dev RPC without the Console", () => {
  it("serves project operations when Agents use separate journals", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".dev-rpc-separate-journals-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      await symlink(join(packageRoot, "../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "journal-test", type: "module" }))
      await mkdir(join(root, "server/agents"), { recursive: true })
      const definition = 'import { defineAgent } from "vite-hub/agent"\n'
      await writeFile(join(root, "server/agents/shared.ts"), `${definition}export default defineAgent({ driver: { run: () => "done" } })\n`)
      await writeFile(join(root, "server/agents/separate.ts"), `${definition}export default defineAgent({ driver: { run: () => "done" }, invocations: "memory" })\n`)

      const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => PluginOption }
      server = await createServer({
        configFile: false,
        logLevel: "silent",
        plugins: [vitehub({ host: "node", agent: { invocations: "memory" } }), nitro()],
        root,
        server: { hmr: false, host: "127.0.0.1", port: 0 },
      })
      await server.listen()
      const target = { env: {}, roots: [root], url: server.resolvedUrls!.local[0]! }
      await expect(callOperation(target, "project.get", {})).resolves.toMatchObject({ ok: true, value: { name: "journal-test" } })
      await expect(callOperation(target, "invocations.list", {})).resolves.toMatchObject({ code: "VITE_HUB_R0047", ok: false })
      await expect(callOperation(target, "env.get", {})).resolves.toEqual({ ok: true, value: { entries: [] } })
    }
    finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 90_000)

  it("installs the Agent Definitions and their journal, so `vitehub agent` commands work", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-dev-rpc-agents-"))
    try {
      await writeFile(join(root, "probe.mjs"), probe)
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      await mkdir(join(root, "server/agents"), { recursive: true })
      await writeFile(join(root, "server/agents/greeter.ts"), "export default {}\n")
      const entry = pathToFileURL(join(packageRoot, "dist/index.js")).href
      await execFileAsync(process.execPath, [join(root, "probe.mjs"), entry, import.meta.resolve("vite")], { cwd: root, timeout: 60_000 })
      const appModule = await readFile(join(root, ".vitehub/nitro/console/app-dev.mjs"), "utf8")
      expect(appModule).toContain("installConsoleAgentDefinitions([")
      expect(appModule).toContain("allowSeparateJournals: true")
      expect(appModule).toContain("server/agents/greeter.ts")
      expect(appModule).toMatch(/installConsoleSections\([^)]*"agents"/)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 90_000)
})
