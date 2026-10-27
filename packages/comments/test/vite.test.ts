// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { getTableColumns, getTableName } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"

import { commentsSchema } from "../src/database.ts"
import { commentsPostgresSchema } from "../src/database/postgres.ts"
import { builtinCommentSubjects, defineCommentSubject, defineComments } from "../src/index.ts"
import { commentsOperations } from "../src/operations.ts"
import { findCommentsEntry, hubComments, renderCommentsNitroPlugin, usesComments } from "../src/vite.ts"

import type { ResolvedConfig } from "vite"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(withComments: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-comments-vite-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{}")
  await mkdir(join(root, "server"))
  if (withComments) await writeFile(join(root, "server", "comments.ts"), `import { defineComments } from ${JSON.stringify(new URL("../src/define.ts", import.meta.url).href)}\nexport default defineComments()\n`)
  return root
}

type ConfigHook = (config: Record<string, unknown>) => Promise<void>

function configHook(plugin: ReturnType<typeof hubComments>): ConfigHook {
  const hook = plugin.config
  // SAFETY: The test calls the concrete hook with the Vite config fields that it reads.
  return (hook && "handler" in hook ? hook.handler : hook) as unknown as ConfigHook
}

describe("comment tables", () => {
  it("name the tables and keep the same columns for SQLite and Postgres", () => {
    expect(Object.keys(commentsSchema)).toEqual(["commentThreads", "commentMessages", "commentCounters"])
    expect(Object.keys(commentsPostgresSchema)).toEqual(["commentThreads", "commentMessages", "commentCounters"])
    for (const schema of [commentsSchema, commentsPostgresSchema]) {
      expect(getTableName(schema.commentThreads)).toBe("vitehub_comment_threads")
      expect(getTableName(schema.commentMessages)).toBe("vitehub_comment_messages")
    }
    expect(Object.keys(getTableColumns(commentsSchema.commentThreads)).sort()).toEqual(Object.keys(getTableColumns(commentsPostgresSchema.commentThreads)).sort())
    expect(Object.keys(getTableColumns(commentsSchema.commentMessages)).sort()).toEqual(Object.keys(getTableColumns(commentsPostgresSchema.commentMessages)).sort())
    expect(getTableName(commentsSchema.commentCounters)).toBe("vitehub_comment_counters")
    expect(getTableName(commentsPostgresSchema.commentCounters)).toBe("vitehub_comment_counters")
    expect(Object.keys(getTableColumns(commentsSchema.commentCounters))).toEqual(["scope", "next"])
  })
})

describe("defineComments", () => {
  it("keeps the policy and knows the built-in subjects", () => {
    const authorize = () => true
    const definition = defineComments({ authorize, subjects: [defineCommentSubject({ kind: "drop", scope: id => id })] })
    expect(definition.authorize).toBe(authorize)
    expect(builtinCommentSubjects.map(subject => [subject.kind, subject.scope("x")])).toEqual([["page", "site"], ["content", "site"]])
    expect(commentsOperations.map(operation => operation.name)).toEqual([
      "comments.list", "comments.get", "comments.create", "comments.reply", "comments.edit", "comments.delete", "comments.resolve", "comments.reopen", "comments.users",
    ])
    expect(commentsOperations.map(operation => operation.kind)).toEqual(["read", "read", "write", "write", "write", "destructive", "write", "write", "read"])
    expect(commentsOperations.every(operation => operation.section === "comments")).toBe(true)
  })
})

const unused = { plugins: [], projectRoot: "/unused", root: "/unused", rootDir: "/unused" }

describe("hubComments", () => {
  it.each(["comments.ts", "comments.mts", "comments.js", "comments.mjs"])("finds server/%s", async (name) => {
    const root = await project(false)
    await writeFile(join(root, "server", name), "export default {}")
    expect(findCommentsEntry({ projectRoot: root })).toBe(join(root, "server", name))
    expect(usesComments({ projectRoot: root })).toBe(true)
    expect(usesComments({ projectRoot: await project(false) })).toBe(false)
  })

  it("contributes the tables and the operations only when the app has the file", async () => {
    const without = hubComments()
    await configHook(without)({ root: await project(false) })
    expect(await without.vitehub.databases(unused)).toEqual([])
    const noOperations = without.vitehub.operations
    expect(noOperations instanceof Function ? await noOperations() : noOperations).toEqual([])

    const plugin = hubComments({ database: "main" })
    await configHook(plugin)({ root: await project(true) })
    expect(await plugin.vitehub.databases(unused)).toEqual([{ database: "main", definition: { export: "commentsSchema", module: "@vite-hub/comments/database" }, name: "comments", reason: expect.stringContaining("comment threads") }])
    const operations = plugin.vitehub.operations
    const entries = operations instanceof Function ? await operations() : operations
    expect(entries).toEqual([expect.objectContaining({ export: "commentsOperations", module: "@vite-hub/comments/operations" })])
    expect(await entries[0]!.load!()).toBe(commentsOperations)
  })

  it("adds the default Database when the app has no Database Definition, and not when it has one", async () => {
    const root = await project(true)
    const plugin = hubComments()
    await configHook(plugin)({ root })
    const context = { plugins: [], projectRoot: root, root, rootDir: root }
    const [definition, tables] = await plugin.vitehub.databases(context)
    const file = join(root, ".vitehub/comments/database.ts")
    expect(definition).toMatchObject({ definition: file, name: "default", reason: expect.stringContaining("server/comments.ts uses comments") })
    expect(tables).toMatchObject({ database: "default", name: "comments" })
    expect(await readFile(file, "utf8")).toContain("export default defineDatabase({ schema: {} })")

    // The app now defines its own Database: the tables go to it, and the generated module goes away.
    await mkdir(join(root, "server/databases"), { recursive: true })
    await writeFile(join(root, "server/databases/config.ts"), "export default {}\n")
    const contributed = await plugin.vitehub.databases(context)
    expect(contributed).toEqual([expect.objectContaining({ name: "comments" })])
    expect(contributed[0]).not.toHaveProperty("database")
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("leaves the choice to the app when it names the Database", async () => {
    const root = await project(true)
    const plugin = hubComments({ database: "main" })
    await configHook(plugin)({ root })
    expect(await plugin.vitehub.databases({ plugins: [], projectRoot: root, root, rootDir: root })).toEqual([expect.objectContaining({ database: "main", name: "comments" })])
    await expect(readFile(join(root, ".vitehub/comments/database.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses the Postgres tables for a Postgres Database", async () => {
    const plugin = hubComments({ dialect: "postgresql" })
    const root = await project(true)
    await configHook(plugin)({ root })
    const entries = await plugin.vitehub.databases({ plugins: [], projectRoot: root, root, rootDir: root })
    expect(entries.at(-1)).toEqual(expect.objectContaining({ definition: { export: "commentsPostgresSchema", module: "@vite-hub/comments/database/postgres" }, dialect: "postgresql" }))
  })

  it("writes the Nitro plugin that installs the runtime", async () => {
    const root = await project(true)
    const plugin = hubComments({ auth: true, imports: { auth: "vite-hub/auth/server", database: "vite-hub/database/drizzle", runtime: "vite-hub/comments/server" } })
    const config: Record<string, unknown> = { nitro: { plugins: [] }, root }
    await configHook(plugin)(config)
    const file = join(root, ".vitehub/nitro/comments/plugin.mjs")
    expect(config.nitro).toMatchObject({ plugins: [file] })
    const source = await readFile(file, "utf8")
    expect(source).toContain('import { databases } from "vite-hub/database/drizzle"')
    expect(source).toContain('import { createAuthUsers, createCommentsStore, installComments, validateCommentsDefinition } from "vite-hub/comments/server"')
    expect(source).toContain('import { getAuth } from "vite-hub/auth/server"')
    expect(source).toContain("users: createAuthUsers(() => getAuth())")
    expect(renderCommentsNitroPlugin({ auth: false, entry: join(root, "server/comments.ts"), imports: { auth: "a", database: "d", databaseDefinition: "x", databaseSchema: "s", operations: "o", runtime: "r" } })).not.toContain("getAuth")
  })

  it("fails the build when the app has no Database", async () => {
    const root = await project(true)
    const plugin = hubComments()
    await configHook(plugin)({ root })
    const resolve = (plugins: Array<{ name: string }>) => (plugin.configResolved as unknown as (config: ResolvedConfig) => Promise<void>)({ plugins } as unknown as ResolvedConfig)
    await expect(resolve([])).rejects.toThrowError(/server\/comments.ts needs a Database/)
    try {
      await resolve([])
    }
    catch (error) {
      expect(error).toMatchObject({ code: "COMMENTS_B0001", fix: expect.stringContaining("database: false") })
    }
    await expect(resolve([{ name: "@vite-hub/database/vite" }])).resolves.toBeUndefined()
    // An app without the file needs nothing.
    const plain = hubComments()
    await configHook(plain)({ root: await project(false) })
    expect(() => (plain.configResolved as unknown as (config: ResolvedConfig) => void)({ plugins: [] } as unknown as ResolvedConfig)).not.toThrow()
  })

  const invalidModules = [
    "export const other = {}",
    "export default {}",
    "export default null",
    "export default () => ({})",
    "export const comments = defineComments()",
    "export default null; export const comments = defineComments()",
    "export default undefined; export const comments = defineComments()",
  ]

  it.each(invalidModules)("rejects an invalid comments module during configuration: %s", async (source) => {
    const root = await project(true)
    await writeFile(join(root, "server/comments.ts"), `import { defineComments } from ${JSON.stringify(new URL("../src/define.ts", import.meta.url).href)}\n${source}`)
    const plugin = hubComments()
    await configHook(plugin)({ root })
    // SAFETY: The hook only reads the Database plugin from this partial resolved config.
    const resolve = plugin.configResolved as unknown as (config: Pick<ResolvedConfig, "plugins">) => Promise<void>
    await expect(resolve({ plugins: [{ name: "@vite-hub/database/vite" }] })).rejects.toMatchObject({ code: "COMMENTS_B0002" })
  })

  it.each(invalidModules)("validates the generated module before installing the lazy runtime: %s", async (source) => {
    const root = await project(true)
    const entry = join(root, "server/comments.mjs")
    await writeFile(entry, `import { defineComments } from ${JSON.stringify(new URL("../src/define.ts", import.meta.url).href)}\n${source}`)
    const file = join(root, "plugin.mjs")
    await writeFile(file, renderCommentsNitroPlugin({
      auth: false,
      entry,
      imports: { auth: "unused", database: "data:text/javascript,export const databases = {}", databaseDefinition: "unused", databaseSchema: "unused", operations: "unused", runtime: new URL("../src/server.ts", import.meta.url).href },
    }))
    await expect(import(/* @vite-ignore */ pathToFileURL(file).href)).rejects.toMatchObject({ code: "COMMENTS_B0002" })
  })
})
