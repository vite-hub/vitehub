import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { nitro } from "nitro/vite"
import { createNitro } from "nitro/builder"
import type { NitroConfig } from "nitro/types"
import { createBuilder, createServer } from "vite"
import { expect, it } from "vitest"
import { hubSource, mergeGeneratedSourceNitroConfig } from "@vite-hub/source/vite"

it.each(["node-worker", "miniflare"] as const)("writes Content declarations on the host with the %s dev runner", async (runner) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-types-workerd-"))
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), `
      import { defineContent } from "vite-hub/content"
      export default defineContent({ access: "public", sources: {
        docs: { async items() { return [{ key: "about.md", content: "---\\ntitle: About\\n---\\n" }] } },
      } })
    `)
    const plugins = () => [
      hubSource({ contentImportBase: "vite-hub/content" }),
      nitro({ preset: "cloudflare_module", devServer: { runner } }),
    ]
    const server = await createServer({ configFile: false, root, logLevel: "silent", plugins: plugins(), server: { port: 0, fs: { allow: [root, resolve(import.meta.dirname, "../../..")] } } })
    try {
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === "string") throw new Error("Expected a TCP dev server")
      await fetch(`http://localhost:${address.port}/`)
      await expect.poll(() => readFile(join(root, ".vitehub/types/content.d.ts"), "utf8"), { timeout: 15_000 }).toContain("'/about': DocsData")
      expect(await readFile(join(root, ".vitehub/types/content.d.ts"), "utf8")).toContain("declare module 'vite-hub/content'")
    }
    finally {
      await server.close()
    }
    const builder = await createBuilder({ configFile: false, root, logLevel: "silent", plugins: plugins() })
    await builder.buildApp()
    const output = join(root, ".output/server")
    const modules = (await readdir(output, { recursive: true })).filter(file => file.endsWith(".mjs"))
    const production = (await Promise.all(modules.map(file => readFile(join(output, file), "utf8")))).join("\n")
    expect(production).not.toContain("Could not generate Content types")
    expect(production).not.toContain("vitehubContentTypesWriter")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it("starts and closes the writer through Nitro modules as used by Nuxt", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-types-nitro-"))
  try {
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), "export default defineContent({})")
    const handlers = await hubSource().api.prepareSources({ projectRoot: root })
    // SAFETY: Source contributes this Nitro config through the same boundary as Nuxt.
    const contribution = mergeGeneratedSourceNitroConfig({}, handlers) as NitroConfig
    const host = await createNitro({ ...contribution, dev: true, rootDir: root, logLevel: 0 })
    const endpoint = host.options.runtimeConfig.vitehubContentTypesWriter
    if (typeof endpoint !== "string") throw new Error("Expected a host writer URL")
    try {
      expect((await fetch(endpoint, { method: "POST", body: "invalid", headers: { origin: "http://other.test" } })).status).toBe(403)
      expect((await fetch(new URL("/wrong-token", endpoint), { method: "POST", body: "invalid" })).status).toBe(403)
      expect((await fetch(endpoint, { method: "POST", body: "export {}\n" })).status).toBe(204)
      expect(await readFile(join(root, ".vitehub/types/content.d.ts"), "utf8")).toBe("export {}\n")
    }
    finally {
      await host.close()
    }
    await expect(fetch(endpoint, { method: "POST", body: "export {}" })).rejects.toThrow()
    const production = await createNitro({ ...contribution, dev: false, preset: "node-server", rootDir: root, logLevel: 0 })
    try {
      expect(production.options.runtimeConfig.vitehubContentTypesWriter).toBeUndefined()
    }
    finally {
      await production.close()
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("closes the writer once when Nuxt and the CLI both close Nitro", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-types-close-"))
  try {
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), "export default defineContent({})")
    const handlers = await hubSource().api.prepareSources({ projectRoot: root })
    // SAFETY: Source contributes this Nitro config through the same boundary as Nuxt.
    const host = await createNitro({ ...mergeGeneratedSourceNitroConfig({}, handlers) as NitroConfig, dev: true, rootDir: root, logLevel: 0 })
    // CLI discovery closes Nitro, then `nuxt.close()` calls the Nitro close hook again.
    await host.close()
    await expect(host.hooks.callHook("close")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
