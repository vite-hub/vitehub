import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it } from "vitest"

import { comments, hubComments, readCommentsBuild, readCommentsComponents } from "../src/vite.ts"

import type { ConfigEnv, Plugin, UserConfig } from "vite"

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

async function configure(plugin: Plugin, root: string, command: ConfigEnv["command"] = "build") {
  const config: UserConfig & Record<PropertyKey, unknown> = { root, [VITEHUB_PROJECT_ROOT]: root }
  const hook = plugin.config as { handler: (config: UserConfig, env: ConfigEnv) => Promise<void> }
  await hook.handler(config, { command, mode: command === "serve" ? "development" : "production" })
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
      index: expect.arrayContaining(["app/pages/index.vue", "app/pages/blog/index.vue"]),
    })
    expect(await readCommentsBuild(root, { WORKERS_CI_COMMIT_SHA: "abc", WORKERS_CI_BRANCH: "main" })).toEqual({ commit: "abc", branch: "main" })
    expect(await readCommentsBuild(root, { GITHUB_SHA: "def", GITHUB_REF_NAME: "feat" })).toEqual({ commit: "def", branch: "feat" })
    await configure(hubComments(), root)
    expect(await readFile(join(root, ".vitehub/nitro/comments/components.mjs"), "utf8")).toContain("\"PricingCard\":[\"app/components/PricingCard.vue\"]")
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("  components,")
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
    // Without Auth or the Console, the people of the rooms are the people signed in with GitHub.
    expect(await readFile(join(directory, "comments.mjs"), "utf8")).toMatch(/export default commentsRealtime\(comments, \{ session: createCommentsGitHubLogin\(.*\)\.user \}\)/)
    await configure(plugin, root)
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("realtime: true")
  })
})

describe("comments() without vite-hub", () => {
  const standalone = () => comments()[0] as Plugin

  it("turns on without server/comments.ts, with a SQLite file in development that Git ignores", async () => {
    const root = await project({ "package.json": "{}" })
    const nitro = await configure(standalone(), root, "serve")
    expect(nitro?.handlers).toEqual([{ route: "/api/_vitehub/comments/**", handler: join(root, ".vitehub/nitro/comments/handler.mjs") }])
    expect(await readFile(join(root, ".vitehub/nitro/comments/definition.mjs"), "utf8")).toContain("export const comments = defineComments()")
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(plugin).toContain(`openCommentsSqlite(${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)})`)
    expect(plugin).not.toContain("@vite-hub/database")
    expect(await readFile(join(root, ".vitehub/data/.gitignore"), "utf8")).toBe("*\n")
    expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("githubLogin: createCommentsGitHubLogin(")
  })

  it("needs the database option in a production build, and says so in the server log", async () => {
    const root = await project({ "package.json": "{}" })
    await configure(standalone(), root)
    const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
    expect(plugin).toContain("const database = () => undefined")
    expect(plugin).toContain("comments({ database: \\\"file:./data/comments.sqlite\\\" })")
    const configured = comments({ database: "file:./data/comments.sqlite" })[0] as Plugin
    await configure(configured, root)
    expect(await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).toContain("openCommentsSqlite(\"file:./data/comments.sqlite\")")
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
