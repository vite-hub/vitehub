import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { afterEach, expect, it } from "vitest"

import { consoleContributedSections } from "../src/console/contributions.ts"
import { resolveCmsPresetFeatures, withCmsPresetPlugins } from "../src/internal/cms-preset-features.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

it.each(["github", "blob-database"] as const)("resolves %s services for Nuxt and Vite", async store => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cms-features-"))
  roots.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server/content.ts"), `import { defineContent } from '@vite-hub/content'
import { cms } from '@vite-hub/cms'
export const content = defineContent({ extends: [cms, { store: '${store}' }] })`)
  const expected = { blob: store === "github" ? undefined : true, database: true, workspace: true }
  expect(resolveCmsPresetFeatures({}, { projectRoot: root })).toEqual(expected)
  expect(resolveCmsPresetFeatures({ blob: false }, { projectRoot: root })).toEqual({ ...expected, blob: false })
  const options = { blob: undefined, database: undefined, workspace: undefined }
  let selected: typeof options | undefined
  const config = await resolveConfig({
    root,
    configFile: false,
    plugins: withCmsPresetPlugins(options, resolved => [
      { name: "selected-services", config: () => { selected = resolved } },
      ...(resolved.blob ? [{ name: "blob-service" }] : []),
    ]),
  }, "build")
  expect(selected).toEqual(expected)
  expect(config.plugins.some(plugin => plugin.name === "blob-service")).toBe(store !== "github")
})

it.each([undefined, "github", "blob-database"] as const)("enables comments with the %s CMS store", async store => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-comments-features-"))
  roots.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server/comments.ts"), "export default defineComments({})")
  if (store) await writeFile(join(root, "server/content.ts"), `import { defineContent } from '@vite-hub/content'
import { cms } from '@vite-hub/cms'
export const content = defineContent({ extends: [cms, { store: '${store}' }] })`)
  const expected = { blob: store === "blob-database" ? true : undefined, database: true, workspace: store ? true : undefined }
  expect(resolveCmsPresetFeatures({}, { projectRoot: root })).toEqual(expected)
  expect(resolveCmsPresetFeatures({ database: false }, { projectRoot: root })).toEqual({ ...expected, database: false })
  const options = { blob: undefined, database: undefined, workspace: undefined }
  let selected: typeof options | undefined
  const config = await resolveConfig({
    root,
    configFile: false,
    plugins: withCmsPresetPlugins(options, resolved => [
      { name: "selected-services", config: () => { selected = resolved } },
      ...(resolved.database ? [{ name: "database-service" }] : []),
      ...(resolved.blob ? [{ name: "blob-service" }] : []),
      ...(resolved.workspace ? [{ name: "workspace-service" }] : []),
    ]),
  }, "build")
  expect(selected).toEqual(expected)
  expect(config.plugins.some(plugin => plugin.name === "database-service")).toBe(true)
  expect(config.plugins.some(plugin => plugin.name === "blob-service")).toBe(store === "blob-database")
  expect(config.plugins.some(plugin => plugin.name === "workspace-service")).toBe(Boolean(store))
})

it.each([
  ["github", {}],
  ["blob-database", { schedule: { docs: "https://vitehub.dev/docs/content/scheduling#run-due-schedules", message: "Nothing publishes scheduled documents. Add a Schedule Definition that calls `content.publishDue()`." } }],
] as const)("asks the %s CMS store for a publishDue() runner only when it can schedule", async (store, setup) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cms-console-"))
  roots.push(root)
  await mkdir(join(root, "server"))
  const file = join(root, "server/content.ts")
  await writeFile(file, `import { defineContent } from 'vite-hub/content'
import cms from 'vite-hub/cms'
export const content = defineContent({ extends: [cms, { store: '${store}' }] })`)
  const inspect = consoleContributedSections.get("content")!.documents!.inspect!
  await expect(inspect({ discoveryRoot: root, projectRoot: root, scheduleDefinitions: [] }, file)).resolves.toEqual(setup)
})
