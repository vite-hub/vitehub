import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { H3 } from "h3"
import { afterEach, describe, expect, it } from "vitest"

import { commentsApiRoute } from "../src/page.ts"
import { componentNames, hubComments, readCommentsBuild, readCommentsComponents, readCommentsDatabase } from "../src/vite.ts"

import type { UserConfig } from "vite"
import type { H3Event } from "h3"
import type { RealtimeDefinition } from "@vite-hub/realtime"
import type { createCommentsHandler } from "../src/runtime/handler.ts"

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

async function configure(plugin: ReturnType<typeof hubComments>, root: string, extra: UserConfig & Record<string, unknown> = {}) {
  const config: UserConfig & Record<PropertyKey, unknown> = { root, [VITEHUB_PROJECT_ROOT]: root, ...extra }
  const hook = plugin.config as { handler: (config: UserConfig) => Promise<void> }
  await hook.handler(config)
  return Reflect.get(config, "nitro") as { handlers?: Array<{ route: string, handler: string }>, plugins?: string[], publicAssets?: Array<{ baseURL: string }> } | undefined
}

async function readComponentsModule(root: string): Promise<Record<string, string[]>> {
  const source = await readFile(join(root, ".vitehub/nitro/comments/components.mjs"), "utf8")
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default
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

  it("serves the API, installs the runtime, and serves the overlay with the page tools routes", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()", "server/content.ts": "export const content = {}" })
    const nitro = await configure(hubComments({ auth: true }), root)
    expect(nitro?.handlers).toEqual([
      { route: "/api/_vitehub/comments/**", handler: join(root, ".vitehub/nitro/comments/handler.mjs") },
      { route: "/_vitehub/page/session", handler: join(root, ".vitehub/nitro/comments/page-session.mjs") },
    ])
    expect(nitro?.plugins).toEqual([join(root, ".vitehub/nitro/comments/plugin.mjs")])
    expect(nitro?.publicAssets).toEqual([
      expect.objectContaining({ baseURL: "/_vitehub/page/assets", dir: expect.stringMatching(/dist[/\\]page$/) }),
      expect.objectContaining({ baseURL: "/api/_vitehub/comments/assets" }),
    ])
    expect(await readFile(join(root, ".vitehub/nitro/comments/page-session.mjs"), "utf8")).toBe("export { viteHubPageSessionHandler as default } from \"@vite-hub/comments/runtime\"\n")
    // The page tool check reads the same session as the API.
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain("session: commentsAuthSession,")
    const handler = await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")
    expect(handler).toContain("import { commentsAuthSession } from \"@vite-hub/comments/runtime/auth\"")
    expect(handler).toContain("content: contentModule.content ? { runtime: contentModule.content, parseField: parseContentField } : undefined")
    expect(handler).toContain("realtime: false")
  })

  it("serves the API, the overlay, and the page tools below the Vite base, and passes the base to the runtime", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()" })
    const nitro = await configure(hubComments(), root, { base: "/portal/" })
    expect(nitro?.handlers?.map(handler => handler.route)).toEqual(["/portal/api/_vitehub/comments/**", "/portal/_vitehub/page/session"])
    expect(nitro?.publicAssets?.map(asset => asset.baseURL)).toEqual(["/portal/_vitehub/page/assets", "/portal/api/_vitehub/comments/assets"])
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(plugin).toContain("overlay: \"/api/_vitehub/comments/assets/overlay.js?v=3\", base: \"/portal\"")
    // Nitro serves its routes below its own baseURL, as Nuxt does for `app.baseURL`.
    const nested = await configure(hubComments(), root, { base: "/portal/", nitro: { baseURL: "/portal/" } } as UserConfig)
    expect(nested?.handlers?.map(handler => handler.route)).toEqual(["/api/_vitehub/comments/**", "/_vitehub/page/session"])
    // The overlay finds the API next to itself.
    expect(commentsApiRoute("http://site.test/portal/api/_vitehub/comments/assets/overlay.js?v=3")).toBe("/portal/api/_vitehub/comments")
    expect(commentsApiRoute("http://site.test/api/_vitehub/comments/assets/chunk-1.js")).toBe("/api/_vitehub/comments")
  })

  it("adds the page tools loader to the index.html of a single page app, below the Vite base", async () => {
    const html = "<html><body><main></main></body></html>"
    const without = hubComments()
    await configure(without, await project({}))
    const transform = (plugin: ReturnType<typeof hubComments>, page: string) => (plugin.transformIndexHtml as { handler: (html: string) => string | undefined }).handler(page)
    expect(transform(without, html)).toBe(html)
    const plugin = hubComments()
    await configure(plugin, await project({ "server/comments.ts": "export const comments = defineComments()" }), { base: "/portal/" })
    const page = transform(plugin, html)
    expect(page).toContain("import(\"/portal/_vitehub/page/assets/loader.js?v=4\")")
    // A second owner, such as the Console, sees the loader and adds no other.
    expect(transform(plugin, page!)).toBeUndefined()
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
    expect((await readComponentsModule(root)).PricingCard).toEqual(["app/components/PricingCard.vue"])
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("  components,")
  })

  it("maps filenames that are inherited object keys through Comments configuration", async () => {
    const root = await project({
      "server/comments.ts": "export const comments = defineComments()",
      "app/components/constructor.vue": "<template />",
      "app/components/toString.vue": "<template />",
      "app/components/__proto__.vue": "<template />",
    })
    const expected = {
      constructor: ["app/components/constructor.vue"],
      toString: ["app/components/toString.vue"],
      ["__proto__"]: ["app/components/__proto__.vue"],
    }
    expect(await readCommentsComponents(root)).toEqual(expected)
    await configure(hubComments(), root)
    const components = await readComponentsModule(root)
    expect(Object.hasOwn(components, "__proto__")).toBe(true)
    expect(components).toEqual(expected)
  })

  it("maps resolved component names that are inherited object keys", async () => {
    const root = await project({ "widgets/Card.vue": "<template />" })
    const components = await readCommentsComponents(root, 5000, [{ pascalName: "constructor", filePath: join(root, "widgets/Card.vue") }])
    expect(components.constructor).toEqual(["widgets/Card.vue"])
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
    const readMap = () => readComponentsModule(root)
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
    expect(handler).toContain("consoleSession: commentsConsoleSession(consoleRealtimeAccess(\"comments\")),")
    expect(handler).not.toContain("commentsAuthSession")
    const mcpPlugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(mcpPlugin).toContain("import { consoleRealtimeAccess } from \"vite-hub/console/sections\"")
    expect(mcpPlugin).toContain("consoleSession: commentsConsoleSession(consoleRealtimeAccess(\"comments\"))")
    const directory = join(root, ".vitehub/nitro/realtime")
    await plugin.api.contributeRealtime({ authority: "memory", directory, projectRoot: root })
    expect(await readFile(join(directory, "comments.mjs"), "utf8")).toContain("commentsRealtime(comments, { consoleSession: commentsConsoleSession(consoleRealtimeAccess(\"comments\")) })")
  })

  it("uses custom identify without calling Auth in generated HTTP and Realtime handlers", async () => {
    const root = await project({
      "server/comments.ts": `import { defineComments } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)}
export const comments = defineComments({ identify: () => ({ id: "custom", name: "Custom" }) })`,
      "auth.mjs": `export const calls = []
export async function commentsAuthSession() { calls.push(true); throw new Error("Auth unavailable") }`,
    })
    const auth = pathToFileURL(join(root, "auth.mjs")).href
    const plugin = hubComments({ auth: true, imports: {
      auth,
      runtime: new URL("../dist/runtime/index.js", import.meta.url).href,
      realtime: new URL("../dist/realtime.js", import.meta.url).href,
    } })
    const directory = join(root, ".vitehub/nitro/realtime")
    await plugin.api.contributeRealtime({ authority: "memory", directory, projectRoot: root })
    await configure(plugin, root)
    const { default: handler } = await import(pathToFileURL(join(root, ".vitehub/nitro/comments/handler.mjs")).href) as { default: ReturnType<typeof createCommentsHandler> }
    const app = new H3().all("/api/_vitehub/comments/**", handler)
    const response = await app.fetch(new Request("http://site.test/api/_vitehub/comments/session"))
    expect(await response.json()).toMatchObject({ data: { user: { id: "custom", name: "Custom" }, can: { read: true } } })

    const { default: room } = await import(pathToFileURL(join(directory, "comments.mjs")).href) as { default: RealtimeDefinition }
    // SAFETY: the room only keys access by this event; the Auth reader must never run.
    const event = {} as H3Event
    const context = { event, definition: "comments", request: new Request("http://site.test") }
    const user = await room.identify!(context)
    expect(user).toEqual({ id: "custom", name: "Custom" })
    expect(await room.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(true)
    expect((await import(auth) as { calls: boolean[] }).calls).toEqual([])
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

  it.each([
    { base: "/portal/" },
    { base: "/_nuxt/", __vitehubAppBaseURL: "/portal/" },
  ])("mounts Comments below the application base: %j", async (config) => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()" })
    const plugin = hubComments({ console: { module: "vite-hub/console/sections" } })
    const nitro = await configure(plugin, root, config)
    expect(nitro?.handlers?.[0]?.route).toBe("/portal/api/_vitehub/comments/**")
    expect(nitro?.publicAssets).toEqual(expect.arrayContaining([expect.objectContaining({ baseURL: "/portal/api/_vitehub/comments/assets" })]))
    const mcpPlugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(mcpPlugin).toContain('overlay: "/api/_vitehub/comments/assets/overlay.js?v=3", base: "/portal"')
    expect(mcpPlugin).toContain('consoleSession: commentsConsoleSession(consoleRealtimeAccess("comments"))')
    const hook = plugin.transformIndexHtml
    const transform = typeof hook === "function" ? hook : hook?.handler
    if (!transform) throw new Error("Expected a Comments HTML transform")
    const tags: unknown = await Reflect.apply(transform, undefined, ["", { path: "/", filename: join(root, "index.html") }])
    expect(tags).toContain('import("/portal/_vitehub/page/assets/loader.js?v=4")')
  })

  it.each([
    ['import { defineComments as defineSiteComments } from "vite-hub/comments"; export const comments = defineSiteComments({ database: "content" })', "content"],
    ['import { defineComments as defineSiteComments } from "@vite-hub/comments"; const site = defineSiteComments({ database: "content" }); export { site as comments }', "content"],
    ['// database: "wrong"\nexport const comments = defineComments({ database: "content" })', "content"],
    ['const text = \'database: "wrong"\'; export const comments = defineComments({ database: "content" })', "content"],
    ['const helper = { database: "wrong" }; export const comments = defineComments({ database: "content" })', "content"],
    ['const other = defineComments({ database: "wrong" }); export const comments = defineComments({ database: "content" })', "content"],
    ['export const comments = defineComments({ database: "wrong", database: "content" })', "content"],
    ['export const comments = defineComments({ database: "wrong", database: chooseDatabase() })', undefined],
    ['export const comments = defineComments({ database: "wrong", ...options })', undefined],
    ['export const comments = defineComments({ ...options, ["database"]: `content` } as const)', "content"],
    ['const definition = defineComments({ database: "content" }); export { definition as comments }', "content"],
    ['const helper = { database: "wrong" }; export const comments = defineComments()', undefined],
  ])("reads only the effective exported Database option: %s", async (source, database) => {
    const root = await project({ "server/comments.ts": source })
    expect(await readCommentsDatabase(join(root, "server/comments.ts"))).toBe(database)
    const plugin = hubComments()
    await configure(plugin, root)
    const contributions = await plugin.vitehub.databases({ root, rootDir: root, projectRoot: root })
    expect(contributions).toHaveLength(1)
    if (database === undefined) expect(contributions[0]).not.toHaveProperty("database")
    else expect(contributions[0]).toHaveProperty("database", database)
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain(`const name = ${JSON.stringify(database ?? null)}`)
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
