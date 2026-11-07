import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createServer, createServerModuleRunner } from "vite"
import { expect, it } from "vitest"

import type { Plugin } from "vite"

const dist = resolve(import.meta.dirname, "../dist")
const disabledSpecifiers = ["@vite-hub/blob", "@vite-hub/database/runtime/registry"]

// vite-hub throws from resolveId for a feature that the app disables.
function disabledFeatures(): Plugin {
  return {
    name: "test:disabled-features",
    enforce: "pre",
    resolveId(id) {
      if (disabledSpecifiers.includes(id)) throw new Error(`${id} is disabled`)
    },
  }
}

it("loads the built Workflow loaders in vite dev when Blob and Database are disabled", async () => {
  const chunk = (await readdir(dist)).find(name => /^workflow-runtime-loaders-.+\.js$/.test(name))
  expect(chunk).toBeDefined()
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [disabledFeatures()],
    root: dist,
    server: { middlewareMode: true, ws: false },
  })
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false })
  try {
    // Vite resolves literal dynamic imports when it transforms a module, so a literal specifier fails here.
    const loaders: Record<string, unknown> = await runner.import(join(dist, chunk!))
    const names = Object.values(loaders).flatMap(value => typeof value === "function" ? [value.name] : [])
    expect(names).toEqual(expect.arrayContaining(["loadAgentWorkflowBlobPrimitive", "loadAgentWorkflowDatabasePrimitive"]))
  }
  finally {
    await runner.close()
    await server.close()
  }
})
