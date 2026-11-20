import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { webContainerHeaders } from "@vite-hub/web-container/vite"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

const files = {
  "package.json": JSON.stringify({ name: "web-container-build", private: true, type: "module" }),
  "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  "server/routes/docs.ts": "export default () => 'docs'\n",
  "server/routes/play/index.ts": "export default () => 'play'\n",
  "server/routes/play/editor.ts": "export default () => 'editor'\n",
}

describe("webContainer in a built Node server", () => {
  it("sends the isolation headers on the WebContainer routes only", async () => {
    const root = await createProject(files)
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub({ host: "node", webContainer: { routes: ["/play/**"] } }), nitro()], root } as never)
    await builder.buildApp()
    const server = await startBuiltServer(root, {})
    const isolation = async (path: string) => {
      const response = await server.fetch(path)
      await response.arrayBuffer()
      return Object.fromEntries(Object.keys(webContainerHeaders).map(name => [name, response.headers.get(name)]))
    }
    try {
      expect(await isolation("/play")).toEqual(webContainerHeaders)
      expect(await isolation("/play/editor")).toEqual(webContainerHeaders)
      expect(await isolation("/docs")).toEqual({ "Cross-Origin-Embedder-Policy": null, "Cross-Origin-Opener-Policy": null })
    }
    finally {
      server.close()
    }
  }, 180_000)
})
