import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginOption } from "vite"
import { describe, expect, it } from "vitest"
import { vitehub, type ViteHubOptions } from "../src/index.ts"

/** The name that the generated Console app module installs for `project.get`, in a project whose package is `glosa-docs`. */
async function generatedProjectName(options: Pick<ViteHubOptions, "name">): Promise<string | undefined> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-name-"))
  try {
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "glosa-docs" })}\n`)
    // SAFETY: vitehub() returns concrete plugins, and the included Nitro plugins as one nested list.
    const plugins = (vitehub({ ...options, comments: false, console: { auth: false }, env: false, host: "node" }) as PluginOption[]).flat() as Plugin[]
    const config: { root: string } = { root }
    for (const plugin of plugins.filter(plugin => plugin.name === "vite-hub/console")) {
      const hook = plugin.config
      const handler = typeof hook === "function" ? hook : hook?.handler
      if (handler) await Reflect.apply(handler, {}, [config, { command: "serve", mode: "development" }])
    }
    const source = await readFile(join(root, ".vitehub/nitro/console/app-dev.mjs"), "utf8")
    const call = source.match(/installConsoleProjectName\("[^"]*", ("[^"]*")\)/)
    return call ? JSON.parse(call[1]!) : undefined
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("project.get name", () => {
  it("reports the name option of vitehub()", async () => {
    await expect(generatedProjectName({ name: "glosa" })).resolves.toBe("glosa")
  })

  it("reports the package.json name without the name option", async () => {
    await expect(generatedProjectName({})).resolves.toBe("glosa-docs")
  })
})
