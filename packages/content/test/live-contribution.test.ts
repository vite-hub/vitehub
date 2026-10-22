import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { contributeContentRealtime } from "../src/vite.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(options: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-live-"))
  roots.push(root)
  await mkdir(join(root, "server"), { recursive: true })
  await writeFile(join(root, "server/content.ts"), [
    "import { defineContent, documents } from \"vite-hub/content\"",
    `export const content = defineContent(${options})`,
    "",
  ].join("\n"))
  return root
}

const collections = "workspace: 'site', collections: { posts: documents({ path: 'posts/*.md', fields: {} }) }"

describe("contributeContentRealtime", () => {
  it("generates the content definition with Console access and the live plugin for one process", async () => {
    const root = await project(`{ ${collections} }`)
    const directory = join(root, ".vitehub/nitro/realtime")
    const contribution = await contributeContentRealtime({
      authority: "memory",
      console: { module: "vite-hub/console/sections", section: "content" },
      contentImport: "vite-hub/content/realtime",
      directory,
      projectRoot: root,
      realtimeImport: "vite-hub/realtime/server",
    })
    expect(contribution).toEqual({ definitions: [{ handler: join(directory, "content.mjs"), name: "content" }], plugins: [join(directory, "content-live.mjs")] })
    const definition = await readFile(join(directory, "content.mjs"), "utf8")
    expect(definition).toContain("export default contentRealtime(content, consoleRealtimeAccess(\"content\"))")
    const plugin = await readFile(join(directory, "content-live.mjs"), "utf8")
    expect(plugin).toContain("installContentLive({ definition: \"content\", refresh: documentId => refreshRealtimeDocument(\"content\", documentId) })")
    expect(plugin).not.toContain("cloudflare:workers")
  })

  it("reaches the Durable Object of each room on Cloudflare, and uses the app session without the Console", async () => {
    const root = await project(`{ ${collections} }`)
    const directory = join(root, ".vitehub/nitro/realtime")
    await contributeContentRealtime({ authority: "cloudflare", contentImport: "vite-hub/content/realtime", directory, projectRoot: root, realtimeImport: "vite-hub/realtime/server" })
    expect(await readFile(join(directory, "content.mjs"), "utf8")).toContain("export default contentRealtime(content)")
    expect(await readFile(join(directory, "content-live.mjs"), "utf8")).toContain("{ durableObjects: env.$DurableObject }")
  })

  it("contributes nothing with live: false or without collections", async () => {
    const off = await project(`{ ${collections}, live: false }`)
    const options = { authority: "memory" as const, contentImport: "x", realtimeImport: "y" }
    await expect(contributeContentRealtime({ ...options, directory: join(off, "out"), projectRoot: off })).resolves.toBeUndefined()
    const sourcesOnly = await project("{}")
    await expect(contributeContentRealtime({ ...options, directory: join(sourcesOnly, "out"), projectRoot: sourcesOnly })).resolves.toBeUndefined()
  })
})
