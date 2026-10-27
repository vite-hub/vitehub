import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it } from "vitest"

import { componentNames, hubComments, readCommentsBuild, readCommentsComponents } from "../src/vite.ts"

import type { UserConfig } from "vite"

const roots: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-comments-"))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), source)
  }
  return root
}

async function configure(plugin: ReturnType<typeof hubComments>, root: string) {
  const config: UserConfig & Record<PropertyKey, unknown> = { root, [VITEHUB_PROJECT_ROOT]: root }
  const hook = plugin.config as { handler: (config: UserConfig) => Promise<void> }
  await hook.handler(config)
  return Reflect.get(config, "nitro") as { handlers?: Array<{ route: string, handler: string }>, plugins?: string[], publicAssets?: Array<{ baseURL: string }> } | undefined
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubComments", () => {
  it("does nothing without server/comments.ts", async () => {
    const root = await project({ "server/content.ts": "export const content = {}" })
    const plugin = hubComments()
    expect(await configure(plugin, root)).toBeUndefined()
    expect(await plugin.vitehub.databases({ root, rootDir: root, projectRoot: root })).toEqual([])
  })

  it("serves the API, installs the runtime, and serves the overlay", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()", "server/content.ts": "export const content = {}" })
    const nitro = await configure(hubComments({ auth: true }), root)
    expect(nitro?.handlers).toEqual([{ route: "/api/_vitehub/comments/**", handler: join(root, ".vitehub/nitro/comments/handler.mjs") }])
    expect(nitro?.plugins).toEqual([join(root, ".vitehub/nitro/comments/plugin.mjs")])
    expect(nitro?.publicAssets).toEqual([expect.objectContaining({ baseURL: "/api/_vitehub/comments/assets" })])
    const handler = await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")
    expect(handler).toContain("import { commentsAuthSession } from \"@vite-hub/comments/runtime/auth\"")
    expect(handler).toContain("content: contentModule.content ? { runtime: contentModule.content, parseField: parseContentField } : undefined")
    expect(handler).toContain("realtime: false")
  })

  it("names a Vue file the way production builds and Nuxt name its component", () => {
    expect(componentNames("app/components/PricingCard.vue")).toEqual(["PricingCard"])
    expect(componentNames("app/components/viewer/Thread.vue")).toEqual(["Thread"])
    expect(componentNames("app/components/viewer/ViewerCommentThread.vue")).toEqual(["ViewerCommentThread"])
    expect(componentNames("app/pages/drops/index.vue")).toEqual(["index", "drops"])
    expect(componentNames("app/pages/blog/[id].vue")).toEqual(["[id]", "blog-id"])
    expect(componentNames("app/pages/index.vue")).toEqual(["index"])
  })

  it("lists the Vue files by component name and reads the build from the host", async () => {
    const root = await project({
      "server/comments.ts": "export const comments = defineComments()",
      "app/components/PricingCard.vue": "<template />",
      "app/pages/index.vue": "<template />",
      "app/pages/blog/index.vue": "<template />",
      "node_modules/lib/Hidden.vue": "<template />",
      ".nuxt/Generated.vue": "<template />",
    })
    expect(await readCommentsComponents(root)).toEqual({
      PricingCard: ["app/components/PricingCard.vue"],
      index: expect.arrayContaining(["app/pages/index.vue"]),
      blog: ["app/pages/blog/index.vue"],
    })
    expect(await readCommentsBuild(root, { WORKERS_CI_COMMIT_SHA: "abc", WORKERS_CI_BRANCH: "main" })).toEqual({ commit: "abc", branch: "main" })
    expect(await readCommentsBuild(root, { GITHUB_SHA: "def", GITHUB_REF_NAME: "feat" })).toEqual({ commit: "def", branch: "feat" })
    await configure(hubComments(), root)
    expect(await readFile(join(root, ".vitehub/nitro/comments/components.mjs"), "utf8")).toContain("\"PricingCard\":[\"app/components/PricingCard.vue\"]")
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("  components,")
  })

  it("uses resolved Nuxt names, including configured directories and mode suffixes, before and after configuration", async () => {
    const root = await project({
      "server/comments.ts": "export const comments = defineComments()",
      "app/components/cards/index.vue": "<template />",
      "app/components/(group)/Buy.client.vue": "<template />",
      "app/components/Account.server.vue": "<template />",
      "widgets/Thing.vue": "<template />",
    })
    const plugin = hubComments()
    const entries = [
      { pascalName: "Cards", filePath: join(root, "app/components/cards/index.vue") },
      { pascalName: "Buy", filePath: join(root, "app/components/(group)/Buy.client.vue") },
      { pascalName: "Account", filePath: join(root, "app/components/Account.server.vue") },
      { pascalName: "CustomThing", filePath: join(root, "widgets/Thing.vue") },
      { pascalName: "Primitive", filePath: join(root, "node_modules/lib/Primitive.vue") },
    ]
    await plugin.api.setComponents(entries)
    await configure(plugin, root)
    const readMap = async () => JSON.parse((await readFile(join(root, ".vitehub/nitro/comments/components.mjs"), "utf8")).replace(/^export default /, ""))
    expect(await readMap()).toMatchObject({
      Cards: ["app/components/cards/index.vue"],
      Buy: ["app/components/(group)/Buy.client.vue"],
      Account: ["app/components/Account.server.vue"],
      CustomThing: ["widgets/Thing.vue"],
    })
    expect(await readMap()).not.toHaveProperty("Primitive")
    expect(await readMap()).not.toHaveProperty("CardsIndex")
    await plugin.api.setComponents([{ pascalName: "Thing", filePath: join(root, "widgets/Thing.vue") }])
    expect(await readMap()).toMatchObject({ Thing: ["widgets/Thing.vue"] })
    expect(await readMap()).not.toHaveProperty("CustomThing")
  })

  it("reads the people from the Console access rules when the app has the Console", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()" })
    const plugin = hubComments({ auth: true, console: { module: "vite-hub/console/sections" } })
    await configure(plugin, root)
    const handler = await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")
    expect(handler).toContain("import { consoleRealtimeAccess } from \"vite-hub/console/sections\"")
    expect(handler).toContain("session: commentsConsoleSession(consoleRealtimeAccess(\"comments\")),")
    expect(handler).not.toContain("commentsAuthSession")
    const directory = join(root, ".vitehub/nitro/realtime")
    await plugin.api.contributeRealtime({ authority: "memory", directory, projectRoot: root })
    expect(await readFile(join(directory, "comments.mjs"), "utf8")).toContain("commentsRealtime(comments, { session: commentsConsoleSession(consoleRealtimeAccess(\"comments\")) })")
  })

  it("adds the tables to the Database that defineComments names", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments({ database: \"content\" })" })
    const plugin = hubComments()
    await configure(plugin, root)
    expect(await plugin.vitehub.databases({ root, rootDir: root, projectRoot: root })).toEqual([expect.objectContaining({
      database: "content",
      definition: { export: "commentsSchema", module: "@vite-hub/comments/database" },
      name: "comments",
    })])
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain("const name = \"content\"")
  })

  it("contributes the presence rooms when Realtime has an authority, and says so in the API", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()" })
    const plugin = hubComments()
    const directory = join(root, ".vitehub/nitro/realtime")
    const contribution = await plugin.api.contributeRealtime({ authority: "memory", directory, projectRoot: root })
    expect(contribution).toEqual({ definitions: [{ handler: join(directory, "comments.mjs"), name: "comments" }] })
    expect(await readFile(join(directory, "comments.mjs"), "utf8")).toContain("export default commentsRealtime(comments, { session: undefined })")
    await configure(plugin, root)
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("realtime: true")
  })
})
