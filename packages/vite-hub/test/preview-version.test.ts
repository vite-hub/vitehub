import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
// The version that `.github/scripts/preview-packages.mjs` writes for a commit.
const version = "0.0.0-preview-4f9c2e1"

/**
 * The pkg.pr.new workflow builds the packages, then gives them the version `0.0.0-preview-<sha>`. This copies the built
 * package next to its dependencies with that version, as an app installs it.
 */
async function installPreview(): Promise<string> {
  const root = join(packageRoot, "node_modules/.vitehub-preview-version", randomUUID(), "vite-hub")
  await mkdir(root, { recursive: true })
  await cp(join(packageRoot, "dist"), join(root, "dist"), { recursive: true })
  const manifest: Record<string, unknown> = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  await writeFile(join(root, "package.json"), JSON.stringify({ ...manifest, version }))
  return root
}

function findPlugin(plugins: unknown, name: string): object | undefined {
  if (Array.isArray(plugins)) return plugins.map(plugin => findPlugin(plugin, name)).find(Boolean)
  return plugins && typeof plugins === "object" && "name" in plugins && plugins.name === name ? plugins : undefined
}

function hookHandler(hook: unknown): (...args: unknown[]) => unknown {
  const handler = hook && typeof hook === "object" && "handler" in hook ? hook.handler : hook
  if (typeof handler !== "function") throw new TypeError("Expected a plugin hook.")
  return handler as (...args: unknown[]) => unknown
}

describe("a pkg.pr.new preview of vite-hub", () => {
  it("reports the preview version in project.get and Vite Doctor", async () => {
    const preview = await installPreview()
    const app = await mkdtemp(join(tmpdir(), "vitehub-preview-app-"))
    try {
      await writeFile(join(app, "package.json"), `${JSON.stringify({ name: "preview-app" })}\n`)
      const { vitehub } = await import(pathToFileURL(join(preview, "dist/index.js")).href) as typeof import("../src/index.ts")
      const consolePlugin = findPlugin(vitehub({ console: true }), "vite-hub/console")
      if (!consolePlugin || !("config" in consolePlugin)) throw new TypeError("Expected the Console plugin.")
      const config: { nitro?: { plugins: string[] }, root: string } = { root: app }
      await Reflect.apply(hookHandler(consolePlugin.config), {}, [config, { command: "build", mode: "production" }])
      const generated = config.nitro?.plugins.find(file => file.endsWith("console/plugin.mjs"))
      if (!generated) throw new TypeError("Expected the generated Console plugin.")
      expect(await readFile(generated, "utf8")).toContain(`installConsoleVersion(${JSON.stringify(version)})`)

      const { default: doctor } = await import(pathToFileURL(join(preview, "dist/doctor.js")).href) as typeof import("../src/doctor.ts")
      expect(doctor.rulePacks?.[0]?.version).toBe(version)
    }
    finally {
      await rm(dirname(preview), { force: true, recursive: true })
      await rm(app, { force: true, recursive: true })
    }
  }, 60_000)
})
