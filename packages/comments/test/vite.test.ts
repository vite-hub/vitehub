// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  if (withComments) await writeFile(join(root, "server", "comments.ts"), "export default {}\n")
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
    expect(Object.keys(commentsSchema)).toEqual(["commentThreads", "commentMessages"])
    expect(Object.keys(commentsPostgresSchema)).toEqual(["commentThreads", "commentMessages"])
    for (const schema of [commentsSchema, commentsPostgresSchema]) {
      expect(getTableName(schema.commentThreads)).toBe("vitehub_comment_threads")
      expect(getTableName(schema.commentMessages)).toBe("vitehub_comment_messages")
    }
    expect(Object.keys(getTableColumns(commentsSchema.commentThreads)).sort()).toEqual(Object.keys(getTableColumns(commentsPostgresSchema.commentThreads)).sort())
    expect(Object.keys(getTableColumns(commentsSchema.commentMessages)).sort()).toEqual(Object.keys(getTableColumns(commentsPostgresSchema.commentMessages)).sort())
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

describe("hubComments", () => {
  it("finds server/comments.ts", async () => {
    const root = await project(true)
    expect(findCommentsEntry({ projectRoot: root })).toBe(join(root, "server", "comments.ts"))
    expect(usesComments({ projectRoot: root })).toBe(true)
    expect(usesComments({ projectRoot: await project(false) })).toBe(false)
  })

  it("contributes the tables and the operations only when the app has the file", async () => {
    const without = hubComments()
    await configHook(without)({ root: await project(false) })
    expect(await without.vitehub.databases({})).toEqual([])
    const noOperations = without.vitehub.operations
    expect(noOperations instanceof Function ? await noOperations() : noOperations).toEqual([])

    const plugin = hubComments({ database: "main" })
    await configHook(plugin)({ root: await project(true) })
    expect(await plugin.vitehub.databases({})).toEqual([{ database: "main", definition: { export: "commentsSchema", module: "@vite-hub/comments/database" }, name: "comments", reason: expect.stringContaining("comment threads") }])
    const operations = plugin.vitehub.operations
    const entries = operations instanceof Function ? await operations() : operations
    expect(entries).toEqual([expect.objectContaining({ export: "commentsOperations", module: "@vite-hub/comments/operations" })])
    expect(await entries[0]!.load!()).toBe(commentsOperations)
  })

  it("uses the Postgres tables for a Postgres Database", async () => {
    const plugin = hubComments({ dialect: "postgresql" })
    await configHook(plugin)({ root: await project(true) })
    expect(await plugin.vitehub.databases({})).toEqual([expect.objectContaining({ definition: { export: "commentsPostgresSchema", module: "@vite-hub/comments/database/postgres" }, dialect: "postgresql" })])
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
    expect(source).toContain('import { createAuthUsers, createCommentsStore, installComments } from "vite-hub/comments/server"')
    expect(source).toContain('import { getAuth } from "vite-hub/auth/server"')
    expect(source).toContain("users: createAuthUsers(() => getAuth())")
    expect(renderCommentsNitroPlugin({ auth: false, entry: join(root, "server/comments.ts"), imports: { auth: "a", database: "d", databaseSchema: "s", operations: "o", runtime: "r" } })).not.toContain("getAuth")
  })

  it("fails the build when the app has no Database", async () => {
    const root = await project(true)
    const plugin = hubComments()
    await configHook(plugin)({ root })
    const resolve = (plugins: Array<{ name: string }>) => (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({ plugins } as unknown as ResolvedConfig)
    expect(() => resolve([])).toThrowError(/server\/comments.ts needs a Database/)
    try {
      resolve([])
    }
    catch (error) {
      expect(error).toMatchObject({ code: "COMMENTS_B0001", fix: expect.stringContaining("database: true") })
    }
    expect(() => resolve([{ name: "@vite-hub/database/vite" }])).not.toThrow()
    // An app without the file needs nothing.
    const plain = hubComments()
    await configHook(plain)({ root: await project(false) })
    expect(() => (plain.configResolved as unknown as (config: ResolvedConfig) => void)({ plugins: [] } as unknown as ResolvedConfig)).not.toThrow()
  })
})
