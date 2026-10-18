import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { createProgram, flattenDiagnosticMessageText, getPreEmitDiagnostics, ModuleKind, ModuleResolutionKind, ScriptTarget } from "typescript"
import { afterEach, describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function writeModule(file: string, lines: string[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [...lines, ""].join("\n"))
}

// Inside the repository, so that the app resolves `@vite-hub/database` and Drizzle.
async function createApp() {
  const baseDir = join(import.meta.dirname, "../../../.vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, "nuxt-types-"))
  tempDirs.push(root)
  // The config marks the project root, so ViteHub does not climb to the repository.
  await writeModule(join(root, "nuxt.config.ts"), ["export default {}"])
  await writeModule(join(root, "server/databases/config.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "export default defineDatabase({",
    "  connection: { url: 'libsql://database.example.turso.io' },",
    "  schema: { notes: sqliteTable('notes', { id: integer('id').primaryKey(), title: text('title').notNull() }) },",
    "})",
  ])
  return root
}

// Reads tables through `schema` and through the registry. A `@ts-expect-error` fails when the types are `any`.
const tableChecks = [
  "import type { schema, useDatabase } from '@vite-hub/database/drizzle'",
  "export type Note = typeof schema.notes.$inferSelect",
  "export const noteId = (note: Note): number => note.id",
  "export const noteTitle = (note: Note): string => note.title",
  "export type RegisteredNote = ReturnType<typeof useDatabase<'default'>>['schema']['notes']['$inferSelect']",
  "// @ts-expect-error The schema has no comments table.",
  "export type Comment = typeof schema.comments.$inferSelect",
]

describe("Database types in a Nuxt app", () => {
  it("creates the referenced types file without a Database Definition", async () => {
    const baseDir = join(import.meta.dirname, "../../../.vitest-tmp")
    const root = await mkdtemp(join(baseDir, "nuxt-types-empty-"))
    tempDirs.push(root)
    const buildDir = join(root, ".nuxt")
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    await hubDb()(undefined, {
      hook: (name: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
        if (name === "nitro:config") hooks.push(callback)
      },
      options: { buildDir, dev: false, rootDir: root, serverDir: join(root, "server"), srcDir: join(root, "app"), vite: {} },
    })
    for (const hook of hooks) await hook({ alias: {}, preset: "node" })
    await expect(readFile(join(root, ".vitehub/types/database.d.ts"), "utf8")).resolves.toContain("interface DatabaseRegistry")
  })

  it.each(["node", "vercel", "cloudflare-module"])("types schema tables in server/ and shared/ after nuxt prepare on %s", async (preset) => {
    const root = await createApp()
    const buildDir = join(root, ".nuxt")
    const options: Record<string, unknown> = { buildDir, dev: false, rootDir: root, serverDir: join(root, "server"), srcDir: join(root, "app"), vite: {} }
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    const prepareTypesHooks: Array<(context: { references: { path: string }[], sharedTsConfig: { include?: string[] }, serverTsConfig: { include?: string[] } }) => void> = []
    await hubDb()(undefined, {
      hook: (name: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
        if (name === "nitro:config") hooks.push(callback)
        if (name === "prepare:types") prepareTypesHooks.push(callback as (context: { references: { path: string }[], sharedTsConfig: { include?: string[] }, serverTsConfig: { include?: string[] } }) => void)
      },
      options,
    })
    // `nuxt prepare` resolves the Nitro config and runs no Vite build.
    for (const hook of hooks) await hook({ alias: {}, preset })

    const generatedTypes = join(root, ".vitehub/types/database.d.ts")
    await expect(readFile(generatedTypes, "utf8")).resolves.toContain("interface DatabaseRegistry")
    // Nuxt resolves tsconfig includes from the build directory.
    const typeContext: {
      references: { path: string }[]
      sharedTsConfig: { include?: string[] }
      serverTsConfig: { include?: string[] }
    } = { references: [], sharedTsConfig: {}, serverTsConfig: {} }
    for (const prepareTypes of prepareTypesHooks) prepareTypes(typeContext)
    expect(typeContext.references.map(reference => reference.path)).toContain(generatedTypes)
    expect(typeContext.sharedTsConfig.include?.map(path => resolve(buildDir, path))).toContain(generatedTypes)
    expect(typeContext.serverTsConfig.include?.map(path => resolve(buildDir, path))).toContain(generatedTypes)

    const serverFile = join(root, "server/utils/note.ts")
    const sharedFile = join(root, "shared/types/note.ts")
    await writeModule(serverFile, tableChecks)
    await writeModule(sharedFile, tableChecks)
    const program = createProgram({
      options: {
        allowImportingTsExtensions: true,
        module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ScriptTarget.ES2022,
        types: [],
      },
      rootNames: [serverFile, sharedFile, generatedTypes],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }, 60_000)
})
