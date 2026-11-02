import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { createNitro } from "nitro/builder"
import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { commentsApiRoute } from "../src/page.ts"
import { comments, componentNames, githubRepository, hubComments, readCommentsBuild, readCommentsComponents, readCommentsDatabase } from "../src/vite.ts"

import type { ConfigEnv, Plugin, UserConfig } from "vite"
import type { NitroConfig } from "nitro/types"
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

async function configure(plugin: Plugin, root: string, command: ConfigEnv["command"] = "build", extra: UserConfig & Record<string, unknown> = {}, env: ConfigEnv = { command, mode: command === "serve" ? "development" : "production" }) {
  const config: UserConfig & Record<PropertyKey, unknown> = { root, [VITEHUB_PROJECT_ROOT]: root, ...extra }
  const hook = plugin.config as { handler: (config: UserConfig, env: ConfigEnv) => Promise<void> }
  await hook.handler(config, env)
  if (plugin.nitro) {
    const instance = await createNitro({ ...config.nitro, rootDir: root, dev: env.command === "serve" && !env.isPreview })
    await instance.close()
    return instance.options
  }
  return Reflect.get(config, "nitro") as NitroConfig | undefined
}

async function readComponentsModule(root: string): Promise<Record<string, string[]>> {
  const source = await readFile(join(root, ".vitehub/nitro/comments/components.mjs"), "utf8")
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubComments", () => {
  it.each([
    "git@ghe.example.com:acme/app.git",
    "https://ghe.example.com/acme/app.git",
    "ssh://git@ghe.example.com:2222/acme/app.git",
    "git@github.com:acme/app.git",
    "https://github.com/acme/app/",
  ])("discovers a repository from a GitHub or Enterprise remote: %s", async (remote) => {
    expect(githubRepository(remote)).toBe("acme/app")
    const root = await project({})
    expect(await readCommentsBuild(root, { COMMIT_REF: "abc", BRANCH: "feat", REPOSITORY_URL: remote, PULL_REQUEST: "true", REVIEW_ID: "7" }))
      .toEqual({ commit: "abc", branch: "feat", repository: "acme/app", pullRequest: 7 })
  })

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
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain("session: commentsAuthSession")
  })

  it("carries the preview's pull request into the generated live handler", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app")
    vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "7")
    const root = await project({ "server/comments.ts": "export const comments = defineComments({ forge: { provider: 'github' } })" })
    await configure(hubComments(), root)
    const handler = await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")
    expect(handler).toContain('"repository":"acme/app"')
    expect(handler).toContain('"pullRequest":7')
  })

  it("serves the API, the overlay, and the page tools below the Vite base, and passes the base to the runtime", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()" })
    const nitro = await configure(hubComments(), root, "build", { base: "/portal/" })
    expect(nitro?.handlers?.map(handler => handler.route)).toEqual(["/portal/api/_vitehub/comments/**", "/portal/_vitehub/page/session"])
    expect(nitro?.publicAssets?.map(asset => asset.baseURL)).toEqual(["/portal/_vitehub/page/assets", "/portal/api/_vitehub/comments/assets"])
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(plugin).toContain("overlay: \"/api/_vitehub/comments/assets/overlay.js?v=3\", base: \"/portal\"")
    // Nitro serves its routes below its own baseURL, as Nuxt does for `app.baseURL`.
    const nested = await configure(hubComments(), root, "build", { base: "/portal/", nitro: { baseURL: "/portal/" } })
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
    await configure(plugin, await project({ "server/comments.ts": "export const comments = defineComments()" }), "build", { base: "/portal/" })
    const page = transform(plugin, html)
    expect(page).toContain("import(\"/portal/_vitehub/page/assets/loader.js?v=10\")")
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
    const nitro = await configure(plugin, root, "build", config)
    expect(nitro?.handlers?.[0]?.route).toBe("/portal/api/_vitehub/comments/**")
    expect(nitro?.publicAssets).toEqual(expect.arrayContaining([expect.objectContaining({ baseURL: "/portal/api/_vitehub/comments/assets" })]))
    const mcpPlugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(mcpPlugin).toContain('overlay: "/api/_vitehub/comments/assets/overlay.js?v=3", base: "/portal"')
    expect(mcpPlugin).toContain('consoleSession: commentsConsoleSession(consoleRealtimeAccess("comments"))')
    const hook = plugin.transformIndexHtml
    const transform = typeof hook === "function" ? hook : hook?.handler
    if (!transform) throw new Error("Expected a Comments HTML transform")
    const tags: unknown = await Reflect.apply(transform, undefined, ["", { path: "/", filename: join(root, "index.html") }])
    expect(tags).toContain('import("/portal/_vitehub/page/assets/loader.js?v=10")')
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
    // Without Auth or the Console, the people of the rooms are the people signed in with GitHub.
    expect(await readFile(join(directory, "comments.mjs"), "utf8")).toContain("export default commentsRealtime(comments, { session: githubLogin.user })")
    await configure(plugin, root)
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("realtime: true")
  })
})

describe("comments() without vite-hub", () => {
  const standalone = () => comments()[0] as Plugin

  it.each(["standalone", "vitehub"])("uses the build repository for the %s MCP session's GitHub fallback", async (setup) => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app")
    const root = await project(setup === "standalone" ? {} : { "server/comments.ts": "export const comments = defineComments()" })
    await configure(setup === "standalone" ? standalone() : hubComments(), root, "serve")
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    const handler = await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")
    expect(plugin).toContain('const githubLogin = createCommentsGitHubLogin({"repository":"acme/app"})')
    expect(plugin).toContain('session: githubLogin.user, githubLogin,')
    expect(handler).toContain('githubLogin: createCommentsGitHubLogin({"repository":"acme/app"})')
  })

  it.each([
    { command: "build", preset: "node-server" },
    { command: "build", preset: "cloudflare-module" },
    { command: "serve", preset: undefined },
    { command: "serve", preset: "cloudflare-module" },
  ] as const)("mounts standalone Comments, its overlay and GitHub sign-in below the app base for $command ($preset)", async ({ command, preset }) => {
    const root = await project({ "package.json": "{}" })
    const plugin = standalone()
    const nitro = await configure(plugin, root, command, { base: "/portal/", nitro: { preset, compatibilityDate: "2026-10-27" } })
    expect(nitro?.handlers?.[0]?.route).toBe("/portal/api/_vitehub/comments/**")
    expect(nitro?.handlers).toContainEqual({ route: "/portal/_vitehub/page/session", handler: join(root, ".vitehub/nitro/comments/page-session.mjs") })
    expect(nitro?.publicAssets).toContainEqual(expect.objectContaining({ baseURL: "/portal/_vitehub/page/assets" }))
    const generated = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(generated).toContain('overlay: "/api/_vitehub/comments/assets/overlay.js?v=3", base: "/portal"')
    expect(generated).toContain(`development: ${command === "serve"}`)
    expect(generated).toContain("session: githubLogin.user, githubLogin,")
    expect(generated).toContain('"basePath":"/portal/api/_vitehub/comments/auth"')
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain('"basePath":"/portal/api/_vitehub/comments/auth"')
    const transform = plugin.transformIndexHtml
    if (!transform) throw new Error("Expected a standalone Comments HTML transform")
    const page: unknown = await Reflect.apply(typeof transform === "function" ? transform : transform.handler, {}, ["<body>Guide</body>"])
    expect(page).toContain('import("/portal/_vitehub/page/assets/loader.js?v=10")')
  }, 30_000)

  it("turns on without server/comments.ts, with a SQLite file in development that Git ignores", async () => {
    const root = await project({ "package.json": "{}" })
    const nitro = await configure(standalone(), root, "serve")
    expect(nitro?.handlers).toEqual(expect.arrayContaining([
      { route: "/api/_vitehub/comments/**", handler: join(root, ".vitehub/nitro/comments/handler.mjs") },
      { route: "/_vitehub/page/session", handler: join(root, ".vitehub/nitro/comments/page-session.mjs") },
    ]))
    expect(await readFile(join(root, ".vitehub/nitro/comments/definition.mjs"), "utf8")).toContain("export const comments = defineComments()")
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(plugin).toContain("from \"@vite-hub/comments/runtime/connect/node\"")
    expect(plugin).toContain(`connectDatabase(${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)}, { name: "comments", setup: commentsTables })`)
    expect(await readFile(join(root, ".vitehub/data/.gitignore"), "utf8")).toBe("*\n")
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("githubLogin: createCommentsGitHubLogin(")
  })

  it("connects a production build to the database it finds at runtime, or to the location it gets", async () => {
    const root = await project({ "package.json": "{}" })
    const plugin = () => readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    await configure(standalone(), root)
    expect(await plugin()).toContain("connectDatabase(undefined, { name: \"comments\", setup: commentsTables })")
    expect(await plugin()).toContain("from \"@vite-hub/comments/runtime/connect/node\"")
    await configure(comments({ database: "file:./data/comments.sqlite" })[0] as Plugin, root)
    expect(await plugin()).toContain("connectDatabase(\"file:./data/comments.sqlite\"")
    expect(await plugin()).toContain("from \"@vite-hub/comments/runtime/connect/node\"")
    await configure(comments({ database: "env:COMMENTS_DATABASE_URL" })[0] as Plugin, root, "serve")
    expect(await plugin()).toContain(`connectDatabase("env:COMMENTS_DATABASE_URL", { name: "comments", setup: commentsTables, fallback: ${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)} })`)
  })

  it.each([undefined, "env:COMMENTS_DATABASE_URL", ":memory:"])("opens runtime-selected files in generated Node output (%s)", async (database) => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app")
    const root = await project({ "package.json": "{\"type\":\"module\"}" })
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    await symlink(join(import.meta.dirname, ".."), join(root, "node_modules/@vite-hub/comments"), "dir")
    await configure(comments({ database })[0] as Plugin, root, "build", { nitro: { preset: "node-server", compatibilityDate: "2026-10-27" } })
    // Supply the file only after generation: neither its path nor its token belongs in the build.
    const file = `file:${join(root, "data/comments.sqlite")}`
    vi.stubEnv("DATABASE_URL", database === undefined ? file : "")
    vi.stubEnv("COMMENTS_DATABASE_URL", file)
    const generated = join(root, ".vitehub/nitro/comments/plugin.mjs")
    const source = await readFile(generated, "utf8")
    expect(source).not.toContain(file)
    expect(source).toContain('const githubLogin = createCommentsGitHubLogin({"repository":"acme/app"})')
    expect(source).toContain('session: githubLogin.user, githubLogin,')
    const { default: install } = await import(pathToFileURL(generated).href)
    install(null)
    const { comments: definition } = await import(pathToFileURL(join(root, ".vitehub/nitro/comments/definition.mjs")).href)
    const [error, threads] = await definition.list({ page: "/" })
    expect(error).toBeUndefined()
    expect(threads).toEqual([])
    vi.stubEnv("NODE_ENV", "development")
    expect(await definition.can({ user: null, action: "read" })).toBe(false)
    expect(source).toContain("from \"@vite-hub/comments/runtime/connect/node\"")
  }, 30_000)

  it.each([undefined, "env:COMMENTS_DATABASE_URL", "d1:COMMENTS"])("keeps the Node connector out of generated Worker output (%s)", async (database) => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app")
    const root = await project({ "package.json": "{}" })
    const nitro = await configure(comments({ database })[0] as Plugin, root, "build", { nitro: { preset: "cloudflare-module", compatibilityDate: "2026-10-27" } })
    expect(nitro?.node).toBe(false)
    const source = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(source).toContain("from \"@vite-hub/comments/runtime/connect\"")
    expect(source).not.toContain("runtime/connect/node")
    expect(source).not.toContain("node:sqlite")
    expect(source).toContain("development: false")
    expect(source).toContain('const githubLogin = createCommentsGitHubLogin({"repository":"acme/app"})')
    expect(source).toContain('session: githubLogin.user, githubLogin,')
  }, 30_000)

  it.each(["file:./data/comments.sqlite", ":memory:"])("rejects static SQLite locations on Workers (%s)", async (database) => {
    const root = await project({ "package.json": "{}" })
    await expect(configure(comments({ database })[0] as Plugin, root, "build", { nitro: { preset: "cloudflare-module", compatibilityDate: "2026-10-27" } })).rejects.toMatchObject({ code: "DATABASE_UNSUPPORTED_URL" })
  }, 30_000)

  it.each(["file:./data/comments.sqlite", ":memory:"])("keeps static SQLite locations buildable on Node (%s)", async (database) => {
    const root = await project({ "package.json": "{}" })
    await configure(comments({ database })[0] as Plugin, root, "build", { nitro: { preset: "node-server", compatibilityDate: "2026-10-27" } })
    const source = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(source).toContain('from "@vite-hub/comments/runtime/connect/node"')
    expect(source).toContain(`connectDatabase(${JSON.stringify(database)}`)
  }, 30_000)

  it("adds the D1 binding to the Wrangler config, unless the app's wrangler.jsonc has it", async () => {
    const root = await project({ "package.json": "{}" })
    const d1 = () => comments({ database: "d1:COMMENTS" })[0] as Plugin
    const nitro = await configure(d1(), root)
    expect(nitro?.cloudflare?.wrangler?.d1_databases).toEqual([{ binding: "COMMENTS", database_name: "comments" }])
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain("connectDatabase(\"d1:COMMENTS\"")
    await writeFile(join(root, "wrangler.jsonc"), `{ "d1_databases": [{ "binding": "COMMENTS", "database_id": "abc" }] }`)
    expect((await configure(d1(), root))?.cloudflare).toBeUndefined()
    // The development server has no binding, so it keeps the threads in the local file.
    await configure(d1(), root, "serve")
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain(`connectDatabase(${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)}`)
  })

  it.each([
    ["wrangler.jsonc", '// { "binding": "COMMENTS" }\n{ "d1_databases": [] }'],
    ["wrangler.jsonc", '{ /* "binding": "COMMENTS" */ "d1_databases": [], }'],
    ["wrangler.json", '{ "kv_namespaces": [{ "binding": "COMMENTS" }] }'],
    ["wrangler.jsonc", '{ "env": { "production": { "d1_databases": [{ "binding": "COMMENTS" }] } } }'],
    ["wrangler.toml", '# binding = "COMMENTS"\nname = "app"'],
    ["wrangler.toml", '[[kv_namespaces]]\nbinding = "COMMENTS"'],
    ["wrangler.toml", '[[env.production.d1_databases]]\nbinding = "COMMENTS"'],
  ])("adds D1 when %s mentions the binding outside its active D1 entries (%s)", async (file, source) => {
    const root = await project({ "package.json": "{}", [file]: source })
    const nitro = await configure(comments({ database: "d1:COMMENTS" })[0] as Plugin, root)
    expect(nitro?.cloudflare?.wrangler?.d1_databases).toEqual([{ binding: "COMMENTS", database_name: "comments" }])
  })

  it.each([
    ["wrangler.jsonc", '{ /* existing */ "d1_databases": [{ "binding": "COMMENTS", "database_id": "abc" },], }'],
    ["wrangler.toml", '[[d1_databases]]\nbinding = "COMMENTS"\ndatabase_id = "abc"'],
  ])("preserves an active D1 binding in %s", async (file, source) => {
    const root = await project({ "package.json": "{}", [file]: source })
    expect((await configure(comments({ database: "d1:COMMENTS" })[0] as Plugin, root))?.cloudflare).toBeUndefined()
  })

  it("fails the build on a location that Comments cannot use", async () => {
    const root = await project({ "package.json": "{}" })
    await expect(configure(comments({ database: "postgres://db.test/app" })[0] as Plugin, root)).rejects.toThrow("cannot connect to a Postgres URL")
    await expect(configure(comments({ database: "./data.sqlite" })[0] as Plugin, root)).rejects.toMatchObject({ code: "DATABASE_UNSUPPORTED_URL" })
  })

  it.each(["file:./data/comments.sqlite", ":memory:"])("rejects static SQLite locations in workerd development but keeps the Node runner (%s)", async (database) => {
    const root = await project({ "package.json": "{}" })
    await expect(configure(comments({ database })[0] as Plugin, root, "serve", { nitro: { preset: "cloudflare_module" } })).rejects.toMatchObject({ code: "DATABASE_UNSUPPORTED_URL" })
    await expect(readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await configure(comments({ database })[0] as Plugin, root, "serve", { nitro: { preset: "cloudflare_module", devServer: { runner: "node-worker" } } })
    const source = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(source).toContain('from "@vite-hub/comments/runtime/connect/node"')
    expect(source).toContain(`connectDatabase(${JSON.stringify(database)}`)
  }, 30_000)

  it("keeps threads in a local D1 binding when the development server runs in workerd", async () => {
    const root = await project({ "package.json": "{}" })
    const plugin = () => readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    const nitro = await configure(standalone(), root, "serve", { nitro: { preset: "cloudflare_module" } })
    expect(await plugin()).toContain(`import { connectDatabase } from "@vite-hub/comments/runtime/connect"\n`)
    expect(await plugin()).toContain(`connectDatabase("d1:COMMENTS"`)
    expect(nitro?.cloudflare?.wrangler?.d1_databases).toEqual([{ binding: "COMMENTS", database_name: "comments" }])
    // Nitro's Node runner can open the local file.
    await configure(standalone(), root, "serve", { nitro: { preset: "cloudflare_module", devServer: { runner: "node-worker" } } })
    expect(await plugin()).toContain(`connectDatabase(${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)}`)
  })

  it("falls back to local D1 when an explicit environment database is unset in workerd dev", async () => {
    vi.stubEnv("COMMENTS_DATABASE_URL", "")
    const root = await project({ "package.json": "{}" })
    const nitro = await configure(comments({ database: "env:COMMENTS_DATABASE_URL" })[0] as Plugin, root, "serve", { nitro: { preset: "cloudflare_module" } })
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(plugin).toContain('connectDatabase("env:COMMENTS_DATABASE_URL", { name: "comments", setup: commentsTables, fallback: "d1:COMMENTS" })')
    expect(plugin).toContain('from "@vite-hub/comments/runtime/connect"\n')
    expect(nitro?.cloudflare?.wrangler?.d1_databases).toEqual([{ binding: "COMMENTS", database_name: "comments" }])
    await expect(readFile(join(root, ".vitehub/data/.gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps the app's server/comments.ts, and adds no tables to a ViteHub Database", async () => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments({ authorize: () => true })" })
    const plugin = standalone() as ReturnType<typeof hubComments>
    await configure(plugin, root, "serve")
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain(pathToFileURL(join(root, "server/comments.ts")).href)
    expect(await plugin.vitehub.databases({ root, rootDir: root, projectRoot: root })).toEqual([])
  })

  it("steps aside, with its Nitro, when vitehub() runs Comments", () => {
    const [plugin, ...nitro] = comments() as Plugin[]
    const config: UserConfig = { plugins: [[{ name: "@vite-hub/comments/vite" }]] }
    const env: ConfigEnv = { command: "serve", mode: "development" }
    expect((plugin!.apply as (config: UserConfig, env: ConfigEnv) => boolean)(config, env)).toBe(false)
    expect(nitro.length).toBeGreaterThan(0)
    for (const part of nitro) expect(typeof part.apply === "function" ? part.apply(config, env) : true).toBe(false)
    expect((plugin!.apply as (config: UserConfig, env: ConfigEnv) => boolean)({ plugins: [] }, env)).toBe(true)
  })
})

describe("generated guest access policy", () => {
  it.each(["standalone", "vitehub"])("records Vite's command for %s, including builds in development mode", async (setup) => {
    const root = await project({ "server/comments.ts": "export const comments = defineComments()" })
    const plugin = setup === "standalone" ? comments()[0] as Plugin : hubComments()
    const cases: Array<{ env: ConfigEnv, development: boolean }> = [
      { env: { command: "serve", mode: "development" }, development: true },
      { env: { command: "build", mode: "development" }, development: false },
      { env: { command: "serve", mode: "development", isPreview: true }, development: false },
    ]
    for (const { env, development } of cases) {
      await configure(plugin, root, env.command, undefined, env)
      const generated = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
      expect(generated).toContain(`development: ${development}`)
    }
  })
})
