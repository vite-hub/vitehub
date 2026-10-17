import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runViteHubCli } from "@vite-hub/cli"
import { resolveConfig, type InlineConfig, type PluginOption } from "vite"
import { afterEach, vi } from "vitest"

const roots: string[] = []
export const path = process.env.PATH
const cwd = process.cwd()

afterEach(async () => {
  process.env.PATH = path
  process.chdir(cwd)
  vi.unstubAllGlobals()
  // Vite runs configResolved hooks concurrently, so other plugins can still write after a rejected resolveConfig().
  await Promise.all(roots.splice(0).flatMap(root => [root, `${root}.vite-cache`]).map(root => rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })))
})

export async function createProject(files: Record<string, string>): Promise<string> {
  // Inside the package so the app resolves `vite-hub` and its dependencies like an installed app.
  const root = await mkdtemp(join(import.meta.dirname, "..", ".content-cms-"))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), content.replaceAll("<root>", root))
  }
  return root
}

export const contentDefinition = [
  "import { defineContent, documents } from 'vite-hub/content'",
  "import cms from 'vite-hub/content/presets/cms'",
  "import * as v from 'valibot'",
  "",
  "export const content = defineContent({",
  "  extends: cms,",
  "  collections: { posts: documents({ path: 'posts/**/*.md', fields: { title: v.string() } }) },",
  "  logger: false,",
  "})",
  "",
].join("\n")

export const server = [
  "import { content } from '../server/content'",
  "",
  "export async function run(id: string) {",
  "  const posts = content.collection('posts')",
  "  await posts.save(id, { data: { title: `Post ${id}` }, body: `# ${id}\\n` })",
  "  const before = await posts.get(id)",
  "  const published = await content.publish({ collection: 'posts', ids: [id] })",
  "  const after = await posts.get(id)",
  "  const listed = await posts.list()",
  "  return { before, published: published.documents, after: after && { data: after.data, body: after.body }, ids: listed.items.map(item => item.id) }",
  "}",
  "",
].join("\n")

export function serverBuild(root: string, pluginOptions: PluginOption[]): InlineConfig {
  return {
    appType: "custom",
    // Outside the app, so the build's copy of the app root does not race the dev server cleaning its dep cache.
    cacheDir: `${root}.vite-cache`,
    build: { outDir: "dist", rolldownOptions: { input: join(root, "src/server.ts") }, ssr: true },
    configFile: false,
    logLevel: "silent",
    plugins: pluginOptions,
    root,
  }
}

export async function runCli(root: string, pluginOptions: PluginOption[], args: string[]) {
  let stderr = ""
  let stdout = ""
  const exitCode = await runViteHubCli({
    args,
    cwd: root,
    loadConfig: async (directory, command) => ({
      ...await resolveConfig(serverBuild(directory, pluginOptions), command),
      vitehubConfigResolved: true,
    }),
    stderr: { write: chunk => (stderr += String(chunk), true) },
    stdout: { write: chunk => (stdout += String(chunk), true) },
  })
  return { exitCode, stderr, stdout }
}

export type RunResult = {
  after: { body: string, data: { title: string } } | null
  before: { data: { title: string } } | null
  ids: string[]
  published: Array<{ change: string, collection: string, id: string }>
}

