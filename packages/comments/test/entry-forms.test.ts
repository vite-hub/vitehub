import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it } from "vitest"
import { resolveConfig } from "vite"
import { hubDb } from "@vite-hub/database/vite"
import { commentsEntryMode, hubComments } from "../src/vite.ts"
import { defineComments } from "../src/index.ts"
import { isCommentsDefinition } from "../src/operations-core/define.ts"

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([
  { form: "default", source: "export default defineComments()" },
  { form: "named", source: "export const comments = defineComments()" },
  { form: "named", source: "export const comments = defineComments(); export type { Options as default }" },
  { form: "named", source: "export const comments = defineComments(); export { type Options as default }" },
  { form: "named", source: "export const comments = defineComments(); export default interface Options {}" },
])("installs only the $form entry's runtime and tables: $source", async ({ form, source }) => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  await mkdir(join(root, "server"))
  const entry = join(root, "server/comments.ts")
  await writeFile(entry, source)
  expect(commentsEntryMode(entry)).toBe(form === "default" ? "operations" : "live")
  const plugin = hubComments({ database: "main" })
  const config = { root }
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new Error("Expected a config handler")
  await hook.handler.call({} as never, config, { command: "build", mode: "production" })
  const tables = await plugin.vitehub.databases({ plugins: [], projectRoot: root, rootDir: root, root })
  expect(tables).toHaveLength(1)
  expect(tables[0]?.definition).toMatchObject({ export: form === "default" ? "commentsOperationsSchema" : "commentsSchema" })
  const contributions = plugin.vitehub.operations
  const operations = typeof contributions === "function" ? await contributions() : contributions
  expect(operations).toHaveLength(form === "default" ? 1 : 0)
  const pluginSource = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
  expect(pluginSource).toContain(form === "default" ? "validateCommentsDefinition(app.default" : "defineCommentsPlugin({ comments,")
})

it.each([
  "export type { Options as comments }",
  "export { type Options as comments }",
  "export declare const comments: Options",
])("does not select the live runtime for a type-only comments export: %s", async (source) => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  const entry = join(root, "comments.ts")
  await writeFile(entry, source)
  expect(commentsEntryMode(entry)).toBe("operations")
})

it("recognizes renamed exports and gives default exports precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  const entry = join(root, "comments.ts")
  await writeFile(entry, "const site = {}; export { site as comments }")
  expect(commentsEntryMode(entry)).toBe("live")
  await writeFile(entry, "const site = {}; export { site as comments, site as default }")
  expect(commentsEntryMode(entry)).toBe("operations")
  await writeFile(entry, "export const unrelated = {}")
  expect(commentsEntryMode(entry)).toBe("operations")
})

it("keeps the factory's live default and the operations' deny-by-default policy", async () => {
  const definition = defineComments()
  expect(isCommentsDefinition(definition)).toBe(true)
  expect(Object.isFrozen(definition)).toBe(true)
  expect(definition.authorize).toBeUndefined()
  expect(await definition.can({ user: { id: "ana" }, action: "read" })).toBe(true)
  expect(await definition.can({ user: null, action: "read" })).toBe(false)
})

it("generates the live handler after Realtime contributes its presence room", async () => {
  const root = await mkdtemp(join(tmpdir(), "comments-entry-"))
  projects.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server/comments.ts"), "export const comments = defineComments()")
  const comments = hubComments()
  await resolveConfig({ configFile: false, root, logLevel: "silent", plugins: [
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
  expect(schema).toContain("commentsOperationsSchema")
})
