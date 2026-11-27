import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { defineRelations, defineRelationsPart, sql } from "drizzle-orm"
import { integer as pgInteger, pgTable, serial, text as pgText } from "drizzle-orm/pg-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { defineDatabase } from "../src/definition.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"
import { createDefinitionRuntime } from "../src/runtime/definition-local.ts"
import { mergeDatabaseRelations } from "../src/runtime/relations.ts"

import type { AnyRelations } from "drizzle-orm"
import type { CollectedDatabaseContribution } from "../src/contributions.ts"
import type { MergeDatabaseRelations } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const users = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() })
const posts = sqliteTable("posts", { id: integer("id").primaryKey(), authorId: integer("author_id").notNull(), title: text("title").notNull() })
const schema = { posts, users }
const relations = defineRelations(schema, r => ({
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
  users: { posts: r.many.posts() },
}))

async function tempDatabaseUrl() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-relations-"))
  tempDirs.push(dir)
  return `file:${join(dir, "app.db")}`
}

async function seed(db: { run: (query: ReturnType<typeof sql>) => Promise<unknown> }) {
  await db.run(sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
  await db.run(sql`CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, title TEXT NOT NULL)`)
  await db.run(sql`INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Lin')`)
  await db.run(sql`INSERT INTO posts (id, author_id, title) VALUES (1, 1, 'First'), (2, 1, 'Second'), (3, 2, 'Third')`)
}

describe("mergeDatabaseRelations", () => {
  it("gives every table an entry and merges relation fields per table, a later part winning a field", () => {
    const comments = sqliteTable("comments", { id: integer("id").primaryKey(), postId: integer("post_id") })
    const merged = { comments, posts, users }
    const app = defineRelations(merged, r => ({
      posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
      users: { posts: r.many.posts() },
    }))
    const contributed = defineRelationsPart(merged, r => ({
      comments: { post: r.one.posts({ from: r.comments.postId, to: r.posts.id }) },
      posts: { comments: r.many.comments(), author: r.one.users({ from: r.posts.authorId, to: r.users.id, alias: "contributed" }) },
    }))

    const result = mergeDatabaseRelations("default", merged, [contributed, app])

    expect(Object.keys(result).toSorted()).toEqual(["comments", "posts", "users"])
    expect(Object.keys(result.posts!.relations).toSorted()).toEqual(["author", "comments"])
    // The application comes last, so its `posts.author` replaces the contributed one.
    expect(result.posts!.relations.author).toBe(app.posts.relations.author)
    expect(result.comments!.relations.post).toBe(contributed.comments.relations.post)
    expect(result.users!.table).toBe(users)
  })

  it("ignores an empty entry for a table that a later layer replaced", () => {
    const replacement = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull(), email: text("email") })
    const base = defineRelations({ users })

    const result = mergeDatabaseRelations("default", { users: replacement }, [base])

    expect(result.users!.table).toBe(replacement)
  })

  it("rejects relations of a table that a later layer replaced", () => {
    const replacement = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() })

    expect(() => mergeDatabaseRelations("default", { posts, users: replacement }, [relations])).toThrow(expect.objectContaining({
      code: "DATABASE_INVALID_RELATIONS",
      why: "The relation \"posts.author\" of the database \"default\" targets the table \"users\", but the merged schema holds another table object for that key. A later Nuxt layer replaced the table.",
    }))
  })

  it("allows replaced source and target tables when the app overrides every affected field", async () => {
    const replacement = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull(), email: text("email") })
    const base = defineDatabase({ relations, schema })
    const app = defineDatabase({
      relations: defineRelations({ posts, users: replacement }, r => ({
        posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
        users: { posts: r.many.posts() },
      })),
      schema: { users: replacement },
    })
    const mergedSchema = { ...base.schema, ...app.schema }
    const merged = mergeDatabaseRelations("default", mergedSchema, [base.relations, app.relations])
    expect(merged.users!.relations.posts).toBe(app.relations.users.relations.posts)
    expect(merged.posts!.relations.author).toBe(app.relations.posts.relations.author)

    // All surviving fields come from the app; retain its concrete graph type after the dynamic merge.
    const db = createDefinitionRuntime({ connection: { url: await tempDatabaseUrl() }, name: "default", relations: merged as typeof app.relations, schema: mergedSchema })
    await seed(db)
    await db.run(sql`ALTER TABLE users ADD COLUMN email TEXT`)
    await db.run(sql`UPDATE users SET email = 'ada@example.com' WHERE id = 1`)
    await expect(db.query.posts!.findFirst({ where: { id: 1 }, with: { author: true } })).resolves.toMatchObject({
      author: { email: "ada@example.com", id: 1, name: "Ada" },
    })
    await expect(db.query.users!.findFirst({ where: { id: 1 }, with: { posts: true } })).resolves.toMatchObject({
      email: "ada@example.com",
      posts: [{ id: 1 }, { id: 2 }],
    })
  })

  it("rejects a stale source field even when another field of that table is overridden", () => {
    const replacement = sqliteTable("users", { id: integer("id").primaryKey() })
    const base = defineRelationsPart(schema, r => ({ users: {
      posts: r.many.posts({ from: r.users.id, to: r.posts.authorId }),
      oldPosts: r.many.posts({ from: r.users.id, to: r.posts.authorId }),
    } }))
    const app = defineRelationsPart({ posts, users: replacement }, r => ({ users: { posts: r.many.posts({ from: r.users.id, to: r.posts.authorId }) } }))

    expect(() => mergeDatabaseRelations("default", { posts, users: replacement }, [base, app])).toThrow(expect.objectContaining({
      code: "DATABASE_INVALID_RELATIONS",
      why: "The relations of the database \"default\" name the table \"users\", but the merged schema holds another table object for that key. A later Nuxt layer replaced the table.",
    }))
  })

  it("rejects a many-to-many relation whose junction table a later layer replaced", () => {
    const tags = sqliteTable("tags", { id: integer("id").primaryKey() })
    const postTags = sqliteTable("post_tags", { postId: integer("post_id").notNull(), tagId: integer("tag_id").notNull() })
    const part = defineRelationsPart({ postTags, posts, tags }, r => ({
      posts: { tags: r.many.tags({ from: r.posts.id.through(r.postTags.postId), to: r.tags.id.through(r.postTags.tagId) }) },
    }))
    const replacement = sqliteTable("post_tags", { postId: integer("post_id").notNull(), tagId: integer("tag_id").notNull(), position: integer("position") })

    expect(Object.keys(mergeDatabaseRelations("blog", { postTags, posts, tags }, [part]).posts!.relations)).toEqual(["tags"])
    expect(() => mergeDatabaseRelations("blog", { postTags: replacement, posts, tags }, [part])).toThrow(expect.objectContaining({
      code: "DATABASE_INVALID_RELATIONS",
      why: "The relation \"posts.tags\" of the database \"blog\" targets the table \"postTags\", but the merged schema holds another table object for that key. A later Nuxt layer replaced the table.",
    }))
    const app = defineRelationsPart({ postTags: replacement, posts, tags }, r => ({
      posts: { tags: r.many.tags({ from: r.posts.id.through(r.postTags.postId), to: r.tags.id.through(r.postTags.tagId) }) },
    }))
    const merged = mergeDatabaseRelations("blog", { postTags: replacement, posts, tags }, [part, app])
    expect(merged.posts!.relations.tags).toBe(app.posts.relations.tags)
  })

  it("preserves an own __proto__ relation used by a relational filter", async () => {
    const part = defineRelationsPart(schema, r => ({ posts: { ["__proto__"]: r.one.users({ from: r.posts.authorId, to: r.users.id }) } }))
    const merged = mergeDatabaseRelations("default", schema, [part])
    expect(Object.hasOwn(merged.posts!.relations, "__proto__")).toBe(true)
    expect(merged.posts!.relations["__proto__"]).toBe(part.posts.relations["__proto__"])

    // The merged graph also includes the target table omitted by the partial graph.
    const db = createDefinitionRuntime({ connection: { url: await tempDatabaseUrl() }, name: "default", relations: merged as MergeDatabaseRelations<typeof schema, [typeof part]>, schema })
    await seed(db)
    await expect(db.query.posts!.findMany({ columns: { title: true }, orderBy: { id: "asc" }, where: { ["__proto__"]: { name: "Ada" } } })).resolves.toEqual([
      { title: "First" }, { title: "Second" },
    ])
  })

  it("rejects a relation to a table that is not in the merged schema", () => {
    const part = defineRelationsPart(schema, r => ({ posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) } }))

    expect(() => mergeDatabaseRelations("blog", { posts }, [part])).toThrow(expect.objectContaining({
      code: "DATABASE_INVALID_RELATIONS",
      why: "The relation \"posts.author\" of the database \"blog\" targets the table \"users\", which is not in the merged schema.",
    }))
  })
})

describe("defineDatabase relations on libSQL", () => {
  it("queries related rows with `with`", async () => {
    const definition = defineDatabase({ connection: { url: await tempDatabaseUrl() }, relations, schema })
    const db = createDefinitionRuntime(definition)
    await seed(db)

    expect(definition.relations).toBe(relations)
    await expect(db.query.users.findMany({ orderBy: { id: "asc" }, with: { posts: { orderBy: { id: "asc" }, columns: { title: true } } } })).resolves.toEqual([
      { id: 1, name: "Ada", posts: [{ title: "First" }, { title: "Second" }] },
      { id: 2, name: "Lin", posts: [{ title: "Third" }] },
    ])
    await expect(db.query.posts.findFirst({ where: { id: 3 }, with: { author: true } })).resolves.toEqual({
      author: { id: 2, name: "Lin" },
      authorId: 2,
      id: 3,
      title: "Third",
    })
  })

  it("defaults to every table of the schema without relations", async () => {
    const definition = defineDatabase({ connection: { url: await tempDatabaseUrl() }, schema })
    const db = createDefinitionRuntime(definition)
    await seed(db)

    expect(Object.keys(definition.relations).toSorted()).toEqual(["posts", "users"])
    expect(definition.relations.users.relations).toEqual({})
    await expect(db.query.users.findFirst({ where: { name: "Lin" } })).resolves.toEqual({ id: 2, name: "Lin" })
  })

  it("rejects relations that are not an object", () => {
    // @ts-expect-error Relations come from `defineRelations()`.
    expect(() => defineDatabase({ relations: "users", schema })).toThrow(expect.objectContaining({ code: "DATABASE_INVALID_OPTIONS" }))
  })
})

async function writeProjectFile(rootDir: string, path: string, contents: string[]) {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [...contents, ""].join("\n"))
  return file
}

describe("relations of contributed tables", () => {
  it("merges the relations of a contribution and of the app into the generated schema", async () => {
    // Inside the package so the fixture resolves this package's drizzle-orm.
    const rootDir = await mkdtemp(join(import.meta.dirname, ".relations-"))
    tempDirs.push(rootDir)
    const tags = await writeProjectFile(rootDir, "vendor/tags.ts", [
      "import { defineRelationsPart } from 'drizzle-orm'",
      "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "export const tags = sqliteTable('tags', { id: integer('id').primaryKey(), name: text('name').notNull() })",
      "export const postTags = sqliteTable('post_tags', { postId: integer('post_id').notNull(), tagId: integer('tag_id').notNull() })",
      "export const tagSchema = { postTags, tags }",
      "export const tagRelations = defineRelationsPart(tagSchema, r => ({",
      "  postTags: { tag: r.one.tags({ from: r.postTags.tagId, to: r.tags.id }) },",
      "  tags: { postTags: r.many.postTags() },",
      "}))",
    ])
    await writeProjectFile(rootDir, "server/databases/default.ts", [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { defineRelations } from 'drizzle-orm'",
      "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "import { postTags } from '../../vendor/tags.ts'",
      "export const posts = sqliteTable('posts', { id: integer('id').primaryKey(), title: text('title').notNull() })",
      "export default defineDatabase({",
      "  schema: { posts },",
      "  relations: defineRelations({ posts, postTags }, r => ({",
      "    posts: { postTags: r.many.postTags({ from: r.posts.id, to: r.postTags.postId }) },",
      "  })),",
      "})",
    ])
    const contribution: CollectedDatabaseContribution = { definition: { export: "tagSchema", module: tags }, name: "tags", plugin: "tags/vite", relations: "tagRelations" }
    const config = resolveDBViteConfig(undefined, rootDir, { contributions: { tables: [contribution] } })!
    await writeGeneratedDatabaseArtifacts(config)

    const generatedFile = config.generatedSchemaFilesByDatabase.default!
    const generated = await import(pathToFileURL(generatedFile).href) as { relations: AnyRelations, schema: Record<string, unknown> }
    expect(Object.keys(generated.relations).toSorted()).toEqual(["postTags", "posts", "tags"])
    expect(Object.keys(generated.relations.postTags!.relations)).toEqual(["tag"])

    const db = createDefinitionRuntime({ connection: { url: await tempDatabaseUrl() }, name: "default", relations: generated.relations, schema: generated.schema })
    await db.run(sql`CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`)
    await db.run(sql`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
    await db.run(sql`CREATE TABLE post_tags (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL)`)
    await db.run(sql`INSERT INTO posts VALUES (1, 'Hello')`)
    await db.run(sql`INSERT INTO tags VALUES (7, 'news')`)
    await db.run(sql`INSERT INTO post_tags VALUES (1, 7)`)
    const query = Reflect.get(db.query, "posts") as { findFirst: (config: unknown) => Promise<unknown> }
    await expect(query.findFirst({ columns: { title: true }, with: { postTags: { columns: {}, with: { tag: { columns: { name: true } } } } } })).resolves.toEqual({
      postTags: [{ tag: { name: "news" } }],
      title: "Hello",
    })
  }, 60_000)
})

const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL

describe.skipIf(!postgresUrl)("defineDatabase relations on Postgres", () => {
  it("queries related rows with `with`", async () => {
    const { createPostgresDatabase } = await import("../src/runtime/postgres.ts")
    const suffix = `${process.pid}_${Date.now()}`
    const authors = pgTable(`relation_authors_${suffix}`, { id: serial("id").primaryKey(), name: pgText("name").notNull() })
    const books = pgTable(`relation_books_${suffix}`, { id: serial("id").primaryKey(), authorId: pgInteger("author_id").notNull(), title: pgText("title").notNull() })
    const definition = defineDatabase({
      connection: { url: postgresUrl! },
      dialect: "postgresql",
      relations: defineRelations({ authors, books }, r => ({
        authors: { books: r.many.books() },
        books: { author: r.one.authors({ from: r.books.authorId, to: r.authors.id }) },
      })),
      schema: { authors, books },
    })
    const db = createPostgresDatabase(definition, { binding: "HYPERDRIVE" })
    try {
      await db.execute(sql.raw(`CREATE TABLE "relation_authors_${suffix}" (id serial PRIMARY KEY, name text NOT NULL)`))
      await db.execute(sql.raw(`CREATE TABLE "relation_books_${suffix}" (id serial PRIMARY KEY, author_id integer NOT NULL, title text NOT NULL)`))
      await db.insert(authors).values({ id: 1, name: "Ada" })
      await db.insert(books).values([{ authorId: 1, id: 1, title: "Notes" }, { authorId: 1, id: 2, title: "Letters" }])

      await expect(db.query.authors.findFirst({ with: { books: { columns: { title: true }, orderBy: { id: "asc" } } } })).resolves.toEqual({
        books: [{ title: "Notes" }, { title: "Letters" }],
        id: 1,
        name: "Ada",
      })
      await expect(db.query.books.findFirst({ columns: { title: true }, where: { id: 2 }, with: { author: { columns: { name: true } } } })).resolves.toEqual({
        author: { name: "Ada" },
        title: "Letters",
      })
    }
    finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "relation_books_${suffix}", "relation_authors_${suffix}"`))
      await (Reflect.get(db, "$client") as { end: () => Promise<void> }).end()
    }
  })
})
