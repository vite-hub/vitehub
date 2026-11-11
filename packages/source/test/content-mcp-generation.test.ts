import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { expect, it } from "vitest"

import { mergeGeneratedSourceNitroConfig, prepareSourceGeneration } from "../src/vite.ts"

it.each(["options", "seo", "mcp"])("does not reserve /mcp for unknown %s, and serves it when enabled", async (imported) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-content-mcp-"))
  try {
    await mkdir(join(projectRoot, "server"))
    const helper = join(projectRoot, "content-helper.mjs")
    // The real generated middleware delegates enabled requests to this handler boundary.
    await writeFile(helper, "export const defineContent = options => options; export const defineContentMcpHandler = () => ({ fetch: async () => new Response('Content MCP') })")
    for (const enabled of [undefined, false, true]) {
      const suffix = String(enabled)
      const config = join(projectRoot, `config-${suffix}.mjs`)
      await writeFile(config, `export default ${JSON.stringify(imported === "options" ? { seo: { sitemap: true, mcp: enabled } } : imported === "seo" ? { sitemap: true, mcp: enabled } : enabled) ?? "undefined"}`)
      const expression = imported === "options" ? "value" : imported === "seo" ? "{ seo: value }" : "{ seo: { mcp: value } }"
      await writeFile(join(projectRoot, "server/content.mjs"), `import { defineContent } from ${JSON.stringify(helper)}; import value from ${JSON.stringify(config)}; export default defineContent(${expression})`)
      const handlers = await prepareSourceGeneration({ projectRoot, contentImportBase: helper })
      const appMcp = { handler: "/app-mcp.mjs", route: "/mcp" }
      const nitro = mergeGeneratedSourceNitroConfig({ handlers: [appMcp] }, handlers)
      expect(nitro.handlers).toContainEqual(appMcp)
      const mcp = handlers.find(handler => handler.route === "/mcp")!
      expect(mcp.middleware).toBe(true)
      // Give each fixture its own module URL so native ESM does not reuse the previous content configuration.
      const fixture = join(projectRoot, `middleware-${suffix}.mjs`)
      const content = join(projectRoot, `content-${suffix}.mjs`)
      await writeFile(content, await readFile(join(projectRoot, "server/content.mjs"), "utf8"))
      await writeFile(fixture, (await readFile(mcp.handler, "utf8")).replace(JSON.stringify(pathToFileURL(join(projectRoot, "server/content.mjs")).href), JSON.stringify(pathToFileURL(content).href)))
      const { default: middleware } = await import(/* @vite-ignore */ pathToFileURL(fixture).href)
      const result = await middleware({ req: new Request("https://app.test/mcp", { method: "POST" }) })
      if (enabled) expect(await result.text()).toBe("Content MCP")
      else expect(result).toBeUndefined()
      expect(await middleware({ req: new Request("https://app.test/other") })).toBeUndefined()
    }
  }
  finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

it("retains the collision guard when both MCP servers are explicitly enabled", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-content-mcp-"))
  try {
    await mkdir(join(projectRoot, "server"))
    await writeFile(join(projectRoot, "server/content.mjs"), "import { defineContent } from '@vite-hub/content'; export default defineContent({ seo: { mcp: true } })")
    const handlers = await prepareSourceGeneration({ projectRoot })
    expect(() => mergeGeneratedSourceNitroConfig({ handlers: [{ handler: "/app-mcp.mjs", route: "/mcp" }] }, handlers)).toThrowError(expect.objectContaining({ code: "SOURCE_B0002" }))
  }
  finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})
