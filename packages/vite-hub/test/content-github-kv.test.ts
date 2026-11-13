import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { resolveCmsPresetFeatures, withCmsPresetPlugins } from "../src/internal/cms-preset-features.ts"
import { createProject, serverBuild } from "./support/content-cms.ts"

import type { Plugin } from "vite"

const githubContent = [
  "import { defineContent } from 'vite-hub/content'",
  "import { github } from 'vite-hub/source'",
  "export default defineContent({ sources: { docs: github({ repo: 'acme/docs', ref: 'main' }) } })",
  "",
].join("\n")

const globContent = [
  "import { defineContent } from 'vite-hub/content'",
  "import { glob } from 'vite-hub/source'",
  "export default defineContent({ sources: { docs: glob('content/**/*.md') } })",
  "",
].join("\n")

async function project(content: string) {
  return await createProject({
    "package.json": JSON.stringify({ name: "content-github-kv", private: true, type: "module" }),
    "server/content.ts": content,
    "src/server.ts": "export default {}\n",
  })
}

async function pluginNames(root: string, options: Record<string, unknown> = {}) {
  const config = await resolveConfig(serverBuild(root, vitehub({ host: "node", env: false, ...options })), "build")
  return { config, names: config.plugins.map(plugin => plugin.name) }
}

/** The code that the Content plugin adds at the top of `server/content.ts` on the server. */
async function contentPrelude(plugins: readonly Plugin[], root: string) {
  const content = plugins.find(plugin => plugin.name === "@vite-hub/content/vite")!
  // SAFETY: The Content plugin declares `transform` as an object hook with a handler.
  const { handler } = content.transform as { handler: (this: unknown, code: string, id: string) => Promise<{ code: string } | undefined> }
  const result = await handler.call({ environment: { config: { consumer: "server", command: "serve" } } }, githubContent, join(root, "server/content.ts"))
  return result?.code.slice(0, result.code.length - githubContent.length) ?? ""
}

describe("github() Sources turn KV on", () => {
  it("enables KV and gives server/content.ts the KV store", async () => {
    const root = await project(githubContent)
    const { config, names } = await pluginNames(root)
    expect(names.filter(name => name === "@vite-hub/kv/vite")).toHaveLength(1)
    expect(await contentPrelude(config.plugins, root)).toContain("__vitehubRegisterContentKV(__vitehubContentKV, ")
  }, 60_000)

  it("keeps KV off with kv: false, so Content reads the branch", async () => {
    const root = await project(githubContent)
    const { config, names } = await pluginNames(root, { kv: false })
    expect(names).not.toContain("@vite-hub/kv/vite")
    expect(await contentPrelude(config.plugins, root)).toBe("")
  }, 60_000)

  it("leaves KV off for Sources other than github()", async () => {
    const root = await project(globContent)
    const { names } = await pluginNames(root)
    expect(names).not.toContain("@vite-hub/kv/vite")
  }, 60_000)

  it("turns KV on next to the Database that server/comments.ts turns on", async () => {
    const root = await project(githubContent)
    await writeFile(join(root, "server/comments.ts"), "export default defineComments({})\n")
    const options = { database: undefined, kv: undefined }
    let selected: typeof options | undefined
    const config = await resolveConfig({
      root,
      configFile: false,
      plugins: withCmsPresetPlugins(options, resolved => [
        { name: "selected-services", config: () => { selected = resolved } },
        ...(resolved.database ? [{ name: "database-service" }] : []),
        ...(resolved.kv ? [{ name: "kv-service" }] : []),
      ]),
    }, "build")
    expect(selected).toEqual({ database: true, kv: true })
    expect(config.plugins.map(plugin => plugin.name)).toEqual(expect.arrayContaining(["database-service", "kv-service"]))
  })

  it("turns KV on for Nuxt, which knows the project root", async () => {
    const root = await project(githubContent)
    expect(resolveCmsPresetFeatures({}, { projectRoot: root })).toEqual({ kv: true })
    expect(resolveCmsPresetFeatures({ kv: false }, { projectRoot: root })).toEqual({ kv: false })
    expect(resolveCmsPresetFeatures({}, { projectRoot: await project(globContent) })).toEqual({})
  })
})
