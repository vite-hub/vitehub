import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it } from "vitest"
import { resolveConfig } from "vite"
import { hubDb } from "@vite-hub/database/vite"
import { hubComments, readCommentsDatabase } from "../src/vite.ts"
import { defineComments } from "../src/index.ts"
import { isCommentsDefinition } from "../src/operations-core/define.ts"

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([
  "export default defineComments()",
  "export const comments = defineComments()",
  "export const comments = defineComments(); export type { Options as default }",
  "export const comments = defineComments(); export default interface Options {}",
])("runs every surface from one definition, whatever its export: %s", async (source) => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server/comments.ts"), source)
  const plugin = hubComments({ database: "main" })
  const config = { root }
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new Error("Expected a config handler")
  await hook.handler.call({} as never, config, { command: "build", mode: "production" })
  const tables = await plugin.vitehub.databases({ plugins: [], projectRoot: root, rootDir: root, root })
  expect(tables).toEqual([expect.objectContaining({ database: "main", definition: { export: "commentsSchema", module: "@vite-hub/comments/database" } })])
  const contributions = plugin.vitehub.operations
  const operations = typeof contributions === "function" ? await contributions() : contributions
  expect(operations).toEqual([expect.objectContaining({ export: "commentsOperations" })])
  // The overlay API, presence, the page tool, and MCP share the runtime that the operations use.
  const pluginSource = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
  expect(pluginSource).toContain("commentsDefinitionOf(definitionModule,")
  expect(await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")).toContain("commentsDefinitionOf(definitionModule,")
})

it("reads the Database name of either export form", async () => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  const entry = join(root, "comments.ts")
  await writeFile(entry, "export default defineComments({ database: 'comments' })")
  expect(await readCommentsDatabase(entry)).toBe("comments")
  await writeFile(entry, "const c = defineComments({ database: 'named' }); export { c as comments }")
  expect(await readCommentsDatabase(entry)).toBe("named")
  await writeFile(entry, "const c = defineComments({ database: 'other' }); export default c")
  expect(await readCommentsDatabase(entry)).toBe("other")
})

it("lets in vetted people by default, and nobody anonymous outside development", async () => {
  const definition = defineComments()
  expect(isCommentsDefinition(definition)).toBe(true)
  expect(Object.isFrozen(definition)).toBe(true)
  expect(definition.options.authorize).toBeUndefined()
  expect(await definition.can({ user: { id: "ana" }, action: "read" })).toBe(false)
  expect(await definition.can({ user: { id: "ana" }, action: "read" }, { console: true })).toBe(true)
  expect(await definition.can({ user: null, action: "read" })).toBe(false)
  expect(await definition.can({ user: null, action: "read" }, { development: true })).toBe(true)
})

it("generates the live handler after Realtime contributes its presence room", async () => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server/comments.ts"), `import { defineComments } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href)}\nexport const comments = defineComments()`)
  const comments = hubComments()
  await resolveConfig({ configFile: false, root, logLevel: "silent", plugins: [
    // Comments needs a Database.
    { name: "@vite-hub/database/vite" },
    {
      name: "realtime-contribution",
      enforce: "pre",
      async config() {
        await comments.api.contributeRealtime({ authority: "memory", projectRoot: root, directory: join(root, ".vitehub/realtime") })
      },
    },
    comments,
  ] }, "build")
  const handler = await readFile(join(root, ".vitehub/nitro/comments/handler.mjs"), "utf8")
  expect(handler).toContain("realtime: true")
})

it("discovers the operations schema through the real Database plugin", async () => {
  const root = await mkdtemp(join(process.cwd(), ".comments-entry-"))
  projects.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "package.json"), '{ "type": "module" }')
  await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
  await symlink(process.cwd(), join(root, "node_modules/@vite-hub/comments"), "dir")
  const definition = pathToFileURL(join(process.cwd(), "src/index.ts")).href
  await writeFile(join(root, "server/comments.ts"), `import { defineComments } from ${JSON.stringify(definition)}; export default defineComments({ authorize: () => true })`)
  const comments = hubComments()
  const database = hubDb()
  await resolveConfig({ configFile: false, root, logLevel: "silent", plugins: [database, comments] }, "build")
  const schemaPath = database.api.getConfig()?.generatedSchemaFilesByDatabase.default
  if (!schemaPath) throw new Error("Comments did not contribute a default Database")
  const schema = await readFile(schemaPath, "utf8")
  expect(schema).toContain("commentsSchema")
})
