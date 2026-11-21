import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const templates = vi.hoisted(() => new Map<string, () => string | Promise<string>>())
vi.mock("@nuxt/kit", () => ({
  addTemplate: (template: { filename: string, getContents: () => string | Promise<string> }) => { templates.set(template.filename, template.getContents) },
  addTypeTemplate: (template: { filename: string, getContents: () => string }) => { templates.set(template.filename, template.getContents) },
}))
const buildTutorialSnapshots = vi.hoisted(() => vi.fn())
vi.mock("../src/runnable/snapshots.ts", async importOriginal => ({ ...await importOriginal<typeof import("../src/runnable/snapshots.ts")>(), buildTutorialSnapshots }))

const { setupDocsRunnable } = await import("../src/runnable/nuxt.ts")

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "runnable-nuxt-"))
  templates.clear()
  buildTutorialSnapshots.mockReset()
  vi.stubEnv("TUTORIAL_SNAPSHOTS", undefined)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function write(path: string, contents: string) {
  await mkdir(dirname(resolve(dir, path)), { recursive: true })
  await writeFile(resolve(dir, path), contents)
}

type Hook = (...args: never[]) => unknown
function fakeNuxt(options: { dev?: boolean, prepare?: boolean } = {}) {
  const hooks = new Map<string, Hook>()
  const nuxt = {
    options: { rootDir: dir, dev: options.dev ?? false, _prepare: options.prepare ?? false, routeRules: {} },
    hook: (name: string, hook: Hook) => { hooks.set(name, hook) },
  }
  return { nuxt, hooks, options: nuxt.options }
}

const fence = "```"
async function app() {
  await write("content/docs/kv.md", `---\ntitle: KV\nlayout: tutorial\n---\n::tutorial-step{title="Add the route"}\n${fence}ts [server/api/kv.get.ts]\nexport default () => 1\n${fence}\n::\n`)
  await write("fixtures/kv/package.json", JSON.stringify({ name: "kv", dependencies: { "vite-hub": "^1.0.0" } }))
  await write("fixtures/kv/server/api/kv.get.ts", "export default () => 1\n")
}
const runnable = {
  lessons: [{ slug: "first-kv", page: "/docs/kv", fixture: "kv" }],
  examples: [{ id: "kv", label: "KV", description: "Store a value.", fixture: "kv", open: "server/api/kv.get.ts", preview: "/api/kv" }],
}
const snapshot = { parts: ["/_tutorials/snapshots/first-kv.abc.0.bin"], sha256: "abc" }

describe("docs.runnable", () => {
  it("reads fixtures from the app folder and writes the lessons, the examples, and their snapshots", async () => {
    await app()
    buildTutorialSnapshots.mockResolvedValue({ "first-kv": snapshot })
    const { nuxt, hooks, options } = fakeNuxt()
    await setupDocsRunnable(runnable, { nuxt, contentDir: resolve(dir, "content") })

    await hooks.get("app:templates")!()
    expect(buildTutorialSnapshots).toHaveBeenCalledOnce()
    expect(buildTutorialSnapshots.mock.calls[0]![0]).toMatchObject({ workspaceRoot: undefined, fixturesDir: resolve(dir, "fixtures"), baseURL: "/_tutorials" })

    const lessons = await templates.get("runnable-tutorials.mjs")!()
    expect(lessons).toContain("\"slug\":\"first-kv\"")
    expect(lessons).toContain(JSON.stringify(snapshot))
    const examples = await templates.get("playground-templates.mjs")!()
    expect(examples).toContain("\"snapshotOf\":\"first-kv\"")
    expect(examples).toContain(JSON.stringify(snapshot))
    expect(await templates.get("learn-facts.mjs")!()).toBe("export const learnFacts = {\"/docs/kv\":{\"steps\":1,\"minutes\":5}}\n")
    expect(templates.get("types/runnable-tutorials.d.ts")!()).toContain("import(\"@vite-hub/docs/runnable\").RunnableTutorialData[]")

    expect(options.routeRules).toEqual({ "/_tutorials/snapshots/**": { headers: { "cache-control": "public, max-age=31536000, immutable" } } })
    const nitro: { publicAssets?: Array<{ baseURL?: string, dir: string }> } = {}
    ;(hooks.get("nitro:config") as (config: typeof nitro) => void)(nitro)
    expect(nitro.publicAssets).toEqual([{ baseURL: "/_tutorials", dir: resolve(dir, "node_modules/.cache/runnable-tutorials") }])
  })

  it("never builds snapshots in nuxi prepare", async () => {
    await app()
    const { nuxt, hooks } = fakeNuxt({ prepare: true })
    await setupDocsRunnable(runnable, { nuxt, contentDir: resolve(dir, "content") })
    await hooks.get("app:templates")!()
    expect(buildTutorialSnapshots).not.toHaveBeenCalled()
    expect(await templates.get("runnable-tutorials.mjs")!()).not.toContain("\"snapshot\"")
  })

  it("builds snapshots in development only with TUTORIAL_SNAPSHOTS=1", async () => {
    await app()
    vi.spyOn(console, "info").mockImplementation(() => {})
    const dev = fakeNuxt({ dev: true })
    await setupDocsRunnable(runnable, { nuxt: dev.nuxt, contentDir: resolve(dir, "content") })
    await dev.hooks.get("app:templates")!()
    expect(buildTutorialSnapshots).not.toHaveBeenCalled()

    vi.stubEnv("TUTORIAL_SNAPSHOTS", "1")
    buildTutorialSnapshots.mockResolvedValue({})
    const opted = fakeNuxt({ dev: true })
    await setupDocsRunnable(runnable, { nuxt: opted.nuxt, contentDir: resolve(dir, "content") })
    await opted.hooks.get("app:templates")!()
    await opted.hooks.get("app:templates")!()
    // Dev calls the hook on each change, and the snapshots build once.
    expect(buildTutorialSnapshots).toHaveBeenCalledOnce()
  })

  it("asks for a pnpm workspace when a fixture uses one", async () => {
    await app()
    await write("fixtures/kv/package.json", JSON.stringify({ name: "kv", dependencies: { "vite-hub": "workspace:*" } }))
    const { nuxt } = fakeNuxt()
    await expect(setupDocsRunnable(runnable, { nuxt, contentDir: resolve(dir, "content") })).rejects.toThrow("docs.runnable.pnpmWorkspace")
  })
})
