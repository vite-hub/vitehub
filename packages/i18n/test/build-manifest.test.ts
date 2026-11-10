import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { messageId, messageSegment } from "../src/records.ts"
import { hubI18n } from "../src/vite.ts"

import type { I18nManifest } from "../src/manifest.ts"
import type { Plugin } from "vite"

const manifestIO = vi.hoisted(() => ({
  files: new Map<string, string>(),
  enabled: false,
  beforeWrite: undefined as undefined | (() => Promise<void>),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const isManifest = (file: unknown) => manifestIO.enabled && String(file).includes("manifest.json")
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => manifestIO.enabled && String(args[0]).endsWith("/.vitehub/i18n")
      ? Promise.resolve(undefined)
      : actual.mkdir(...args),
    readFile: (...args: Parameters<typeof actual.readFile>) => isManifest(args[0])
      ? Promise.reject(new Error("No previous manifest"))
      : actual.readFile(...args),
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (!isManifest(args[0])) return actual.writeFile(...args)
      await manifestIO.beforeWrite?.()
      manifestIO.files.set(String(args[0]), String(args[1]))
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (!isManifest(args[0])) return actual.rename(...args)
      manifestIO.files.set(String(args[1]), manifestIO.files.get(String(args[0]))!)
      manifestIO.files.delete(String(args[0]))
    },
  }
})

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  manifestIO.enabled = false
  manifestIO.beforeWrite = undefined
  manifestIO.files.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project() {
  await mkdir(join(packageRoot, "test/.tmp"), { recursive: true })
  const root = await mkdtemp(join(packageRoot, "test/.tmp/manifest-"))
  roots.push(root)
  return root
}

function hook<T>(value: T | { handler: T }): T {
  return value && typeof value === "object" && "handler" in value ? value.handler : value as T
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

describe("build message snapshots", () => {
  it("collects query-suffixed source modules for browser catalogs", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const root = await project()
    await writeFile(join(root, "labels.ts"), "import { t } from '@vite-hub/i18n'; export default t({ message: 'Query message', comment: 'A browser label' })")
    await writeFile(join(root, "other.ts"), "import { t } from '@vite-hub/i18n'; export default t({ message: 'Query message', comment: 'Another use of the label' })")
    await writeFile(join(root, "main.ts"), [
      "import { createI18n } from '@vite-hub/i18n/vue'",
      "import label from './labels.ts?tenant=a'",
      "import other from './other.ts'",
      "console.log(createI18n, label, other)",
    ].join("\n"))
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: { alias: [{ find: /^@vite-hub\/i18n(\/.*)?$/, replacement: `${resolve(packageRoot, "dist")}$1` }] },
      plugins: [hubI18n({ locales: ["en", "es"], projectRoot: root })],
      build: { minify: false, rollupOptions: { input: join(root, "main.ts") } },
    })
    const manifest = JSON.parse(await readFile(join(root, ".vitehub/i18n/manifest.json"), "utf8")) as I18nManifest
    expect(manifest.environments.client![messageId("Query message")]).toEqual({
      message: "Query message",
      hash: messageSegment("Query message").hash,
      origins: expect.arrayContaining(["labels.ts:1", "other.ts:1"]),
      comments: expect.arrayContaining(["A browser label", "Another use of the label"]),
    })
    const outputs = Array.isArray(result) ? result : "output" in result ? [result] : []
    const chunks = outputs.flatMap(output => output.output).filter(chunk => chunk.type === "chunk")
    expect(chunks.find(chunk => chunk.code.includes("console.log"))!.code).not.toContain("Query message")
    expect(chunks.filter(chunk => chunk.code.includes("Query message"))).toHaveLength(2)
  }, 60_000)

  it("keeps every environment when an earlier manifest write finishes last", async () => {
    const root = await project()
    const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
    await hook(plugin.config!).call({} as never, { root }, { command: "build", mode: "production" } as never)
    const collect = async (name: string, message: string) => {
      const id = join(root, `${name}.ts`)
      const code = `import { t } from '@vite-hub/i18n'; export const message = t\`${message}\``
      await writeFile(id, code)
      const context = { environment: { name, config: { consumer: name === "client" ? "client" : "server" } }, getModuleIds: () => [id] }
      await hook(plugin.transform!).call(context as never, code, id, {} as never)
      await hook(plugin.renderStart!)?.call(context as never, {} as never, {} as never)
      return context
    }
    const client = await collect("client", "Browser message")
    const entered = deferred()
    const release = deferred()
    manifestIO.enabled = true
    manifestIO.beforeWrite = async () => {
      manifestIO.beforeWrite = undefined
      entered.resolve()
      await release.promise
    }
    const first = hook(plugin.writeBundle!).call(client as never, {} as never, {})
    await entered.promise
    const server = await collect("ssr", "Server message")
    const second = hook(plugin.writeBundle!).call(server as never, {} as never, {})
    // Let the second writer run while the first writer is held at the filesystem boundary.
    await new Promise<void>(done => setImmediate(done))
    release.resolve()
    await Promise.all([first, second])
    const manifest = JSON.parse(manifestIO.files.get(join(root, ".vitehub/i18n/manifest.json"))!) as I18nManifest
    expect([...manifestIO.files.keys()]).toEqual([join(root, ".vitehub/i18n/manifest.json")])
    expect(Object.keys(manifest.environments).sort()).toEqual(["client", "ssr"])
    expect(manifest.environments.ssr![messageId("Server message")]?.message).toBe("Server message")
    const clientIds = await hook(plugin.renderChunk!).call(server as never, 'export const clientIds = "__VITEHUB_I18N_CLIENT_IDS__"', {} as never, {} as never, {} as never)
    expect(clientIds).toMatchObject({ code: `export const clientIds = ${JSON.stringify([messageId("Browser message")])}` })
  })

  it("replaces changed messages, retains cached modules, and removes modules that leave a watch build", async () => {
    const root = await project()
    const main = join(root, "main.ts")
    const removed = join(root, "removed.ts")
    const retained = join(root, "retained.ts")
    const source = (message: string) => `import { t } from '@vite-hub/i18n'; export default t\`${message}\``
    const entry = (message: string, includeRemoved: boolean) => [
      `import { createI18n } from '@vite-hub/i18n/vue'`,
      `import { t } from '@vite-hub/i18n'`,
      `import retained from './retained'`,
      ...(includeRemoved ? [`import removed from './removed'`] : []),
      `console.log(createI18n, retained, ${includeRemoved ? "removed, " : ""}t\`${message}\`)`,
    ].join("\n")
    await writeFile(main, entry("Old message", true))
    await writeFile(removed, source("Removed module"))
    await writeFile(retained, source("Cached message"))
    let complete = deferred()
    const observer: Plugin = { name: "watch-build-complete", writeBundle: { order: "post", sequential: true, handler() { complete.resolve() } } }
    const watcher = await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: { alias: [{ find: /^@vite-hub\/i18n(\/.*)?$/, replacement: `${resolve(packageRoot, "dist")}$1` }] },
      plugins: [hubI18n({ locales: ["en", "es"], projectRoot: root }), observer],
      build: { minify: false, watch: {}, rollupOptions: { input: main }, outDir: join(root, "dist") },
    })
    if (!("close" in watcher)) throw new Error("Expected a build watcher")
    try {
      await complete.promise
      const snapshot = async () => JSON.parse(await readFile(join(root, ".vitehub/i18n/manifest.json"), "utf8")) as I18nManifest
      expect(Object.keys((await snapshot()).environments.client!)).toHaveLength(3)
      complete = deferred()
      await writeFile(main, entry("New message", true))
      await complete.promise
      expect(Object.values((await snapshot()).environments.client!).map(message => message.message).sort()).toEqual(["Cached message", "New message", "Removed module"])
      complete = deferred()
      await writeFile(main, entry("New message", false))
      await complete.promise
      const manifest = await snapshot()
      expect(Object.values(manifest.environments.client!).map(message => message.message).sort()).toEqual(["Cached message", "New message"])
      const assets = await import("node:fs/promises").then(fs => fs.readdir(join(root, "dist/assets")))
      const chunks = await Promise.all(assets.map(file => readFile(join(root, "dist/assets", file), "utf8")))
      // Check the current catalog chunks, using their imports from the current entry (old hashed assets may remain).
      const app = chunks.find(code => code.includes("console.log"))!
      const currentCatalogs = assets.filter(file => app.includes(file))
      const catalogs = await Promise.all(currentCatalogs.map(file => readFile(join(root, "dist/assets", file), "utf8")))
      expect(catalogs.join("\n")).toContain("Cached message")
      expect(catalogs.join("\n")).not.toContain("Old message")
      expect(catalogs.join("\n")).not.toContain("Removed module")
    }
    finally {
      await watcher.close()
    }
  }, 30_000)
})
