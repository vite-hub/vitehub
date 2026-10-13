import { execFile } from "node:child_process"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const execFileAsync = promisify(execFile)

// Importing vite-hub and constructing plugins must not load analysis or request-time dependencies.
const deferredPackages = ["typescript", "better-auth", "drizzle-orm", "@libsql/client", "effect", "unimport"]
// Sandbox initializes auto-import discovery during config resolution, even in an empty project.
const requestTimePackages = deferredPackages.filter(name => name !== "unimport")

// The probe records every module that Node loads while the config imports `vite-hub` and resolves its Vite plugins.
const probe = `
import { registerHooks } from "node:module"

const loaded = []
registerHooks({
  load(url, context, next) {
    loaded.push(url)
    return next(url, context)
  },
})
const { resolveConfig } = await import(process.argv[3])
const { vitehub } = await import(process.argv[2])
const config = {
  configFile: false,
  logLevel: "silent",
  root: process.cwd(),
  plugins: [vitehub({
    // Queue and Sandbox require a preset that provides both capabilities.
    preset: "cloudflare",
    agent: true,
    auth: true,
    blob: true,
    console: true,
    database: true,
    kv: true,
    queue: true,
    sandbox: true,
    schedule: true,
    workflow: true,
    workspace: true,
  })],
}
const imported = [...loaded]
await resolveConfig(config, "serve")
process.stdout.write(JSON.stringify({ imported, resolved: loaded }))
`

function packageName(url: string): string | undefined {
  const index = url.lastIndexOf("/node_modules/")
  if (index < 0) return undefined
  const [scope, name] = url.slice(index + "/node_modules/".length).split("/")
  return scope?.startsWith("@") ? `${scope}/${name}` : scope
}

function loadedUrls(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(url => typeof url === "string")) {
    throw new TypeError("Expected the probe to print loaded module URLs.")
  }
  return value
}

describe("vite-hub config import", () => {
  it("keeps request-time dependencies unloaded through config resolution with Console enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-config-import-"))
    try {
      const probeFile = join(root, "probe.mjs")
      await writeFile(probeFile, probe)
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      const entry = pathToFileURL(join(packageRoot, "dist/index.js")).href
      const viteEntry = import.meta.resolve("vite")
      const { stdout } = await execFileAsync(process.execPath, [probeFile, entry, viteEntry], {
        cwd: root,
        env: { ...process.env, VITEHUB_CONSOLE_FIXTURE: "" },
        timeout: 60_000,
      })
      const loaded: unknown = JSON.parse(stdout)
      if (!loaded || typeof loaded !== "object" || !("imported" in loaded) || !("resolved" in loaded)) {
        throw new TypeError("Expected module-load snapshots for import and config resolution.")
      }
      const imported = loadedUrls(loaded.imported)
      const resolved = loadedUrls(loaded.resolved)
      expect(imported).toContain(entry)
      const importedPackages = new Set(imported.map(packageName))
      expect(deferredPackages.filter(name => importedPackages.has(name))).toEqual([])
      const packages = new Set(resolved.map(packageName))
      expect(requestTimePackages.filter(name => packages.has(name))).toEqual([])
      await access(join(root, ".vitehub/nitro/console/plugin.mjs"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 90_000)
})
