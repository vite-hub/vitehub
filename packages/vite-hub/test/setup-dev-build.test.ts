import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { createBuilder } from "vite"
import { afterAll, describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleSetupRoute, installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { setupDevRoute } from "../src/setup-dev.ts"
import { createProject } from "./support/content-cms.ts"

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.flatMap(root => [rm(root, { force: true, recursive: true }), rm(`${root}.vite-cache`, { force: true, recursive: true })]))
})

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

/** Server endpoint and writer markers. The shared browser app also contains the dev-token request header. */
const writerMarkers = [setupDevRoute, "vite-hub/setup-dev", "createSetupSession", "planSetupAdd", "planSetupRemove", "applySetupAdd", "editViteHubConfig", "SETUP_STALE_PLAN"]

describe("dev Setup in a production build", () => {
  it.each([
    ["without console options", {}],
    ["with the Console", { console: true }],
  ])("leaves the Setup route and the writer out of the output, %s", { timeout: 240_000 }, async (_name, options) => {
    const root = await createProject({
      "index.html": "<!doctype html><html><head><title>Fixture</title></head><body><main>ok</main></body></html>\n",
      "package.json": JSON.stringify({ name: "setup-build", private: true, type: "module" }),
      "server/routes/health.ts": "export default () => 'ok'\n",
    })
    roots.push(root)
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({
      cacheDir: `${root}.vite-cache`,
      logLevel: "silent",
      plugins: [vitehub({ ...options, kv: true, host: "node" }), nitro() as never],
      root,
    } as never)
    await builder.buildApp()

    const output = await files(join(root, ".output"))
    expect(output.length).toBeGreaterThan(0)
    const found: string[] = []
    for (const file of output) {
      const text = await readFile(file, "utf8")
      for (const marker of writerMarkers) if (text.includes(marker)) found.push(`${file.slice(root.length + 1)}: ${marker}`)
    }
    expect(found).toEqual([])
  })
})

describe("dev Setup route in the Console runtime", () => {
  it("reports the route only for development output", () => {
    installConsoleDevelopment("/app-production", false, setupDevRoute)
    expect(consoleSetupRoute()).toBeUndefined()
    installConsoleDevelopment("/app-production", true)
    expect(consoleSetupRoute()).toBeUndefined()
    installConsoleDevelopment("/app-production", true, setupDevRoute)
    expect(consoleSetupRoute()).toBe(setupDevRoute)
  })
})
