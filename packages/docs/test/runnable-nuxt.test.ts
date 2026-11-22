import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceContentPage } from "../src/runnable/workspaces.ts"

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
function fakeNuxt(options: { dev?: boolean, prepare?: boolean, baseURL?: string } = {}) {
  const hooks = new Map<string, Hook>()
  const nuxt = {
    options: { rootDir: dir, srcDir: resolve(dir, "app"), dev: options.dev ?? false, _prepare: options.prepare ?? false, app: { baseURL: options.baseURL ?? "/" }, routeRules: {} },
    hook: (name: string, hook: Hook) => { hooks.set(name, hook) },
  }
  return { nuxt, hooks, options: nuxt.options }
}

const fence = "```"
async function app() {
  await write("content/docs/kv.md", `---\ntitle: KV\nlayout: tutorial\n---\n::tutorial-step{title="Add the route"}\n${fence}ts [server/api/kv.get.ts]\nexport default () => 1\n${fence}\n::\n`)
  await write("content/docs/guide.md", `---\ntitle: Guide\n---\n::tutorial-step{title="Not a lesson"}\n::\n`)
  await write("fixtures/kv/package.json", JSON.stringify({ name: "kv", dependencies: { "vite-hub": "^1.0.0" } }))
  await write("fixtures/kv/server/api/kv.get.ts", "export default () => 1\n")
}
const runnable = {
  lessons: [{ slug: "first-kv", page: "/docs/kv", fixture: "kv" }],
  examples: [{ id: "kv", label: "KV", description: "Store a value.", fixture: "kv", open: "server/api/kv.get.ts", preview: "/api/kv" }],
}
const snapshot = { parts: ["first-kv.abc.0.bin"], sha256: "abc" }
const served = { parts: ["/_tutorials/snapshots/first-kv.abc.0.bin"], sha256: "abc" }
/** The pages of the docs site, as the docs module lists them from the manifest. */
const pages: WorkspaceContentPage[] = [{ path: "/docs/kv", layout: "tutorial" }, { path: "/docs/guide", layout: "article" }]
const content = {
  pages: () => pages,
  read: (path: string) => pages.some(page => page.path === path) ? readFileSync(resolve(dir, `content${path}.md`), "utf8") : undefined,
}

describe("docs.runnable", () => {
  it("reads fixtures from the app folder and writes the lessons, the examples, and their snapshots", async () => {
    await app()
    buildTutorialSnapshots.mockResolvedValue({ "first-kv": snapshot })
    const { nuxt, hooks, options } = fakeNuxt()
    await setupDocsRunnable(runnable, { nuxt, content })

    await hooks.get("app:templates")!()
    expect(buildTutorialSnapshots).toHaveBeenCalledOnce()
    expect(buildTutorialSnapshots.mock.calls[0]![0]).toMatchObject({ workspaceRoot: undefined, fixturesDir: resolve(dir, "fixtures") })

    const lessons = await templates.get("runnable-tutorials.mjs")!()
    expect(lessons).toContain("\"slug\":\"first-kv\"")
    expect(lessons).toContain(JSON.stringify(served))
    const examples = await templates.get("playground-templates.mjs")!()
    expect(examples).toContain("\"snapshotOf\":\"first-kv\"")
    expect(examples).toContain(JSON.stringify(served))
    expect(await templates.get("learn-facts.mjs")!()).toBe("export const learnFacts = {\"/docs/kv\":{\"steps\":1,\"minutes\":5}}\n")
    // The types import this package by path, because the app may list only `vite-hub`.
    const types = templates.get("types/runnable-tutorials.d.ts")!()
    expect(types).toMatch(/import\("\/[^"]+\/packages\/docs\/(src\/runnable\.ts|dist\/runnable\.js)"\)\.RunnableTutorialData\[\]/)
    expect(types).not.toContain("@vite-hub/docs")

    expect(options.routeRules).toEqual({ "/_tutorials/snapshots/**": { headers: { "cache-control": "public, max-age=31536000, immutable" } } })
    const nitro: { publicAssets?: Array<{ baseURL?: string, dir: string }> } = {}
    ;(hooks.get("nitro:config") as (config: typeof nitro) => void)(nitro)
    expect(nitro.publicAssets).toEqual([{ baseURL: "/_tutorials", dir: resolve(dir, "node_modules/.cache/runnable-tutorials") }])
  })

  it("serves the snapshot parts under the app base", async () => {
    await app()
    buildTutorialSnapshots.mockResolvedValue({ "first-kv": snapshot })
    const { nuxt, hooks } = fakeNuxt({ baseURL: "/portal/" })
    await setupDocsRunnable(runnable, { nuxt, content })
    await hooks.get("app:templates")!()
    const parts = JSON.stringify(["/portal/_tutorials/snapshots/first-kv.abc.0.bin"])
    expect(await templates.get("runnable-tutorials.mjs")!()).toContain(parts)
    expect(await templates.get("playground-templates.mjs")!()).toContain(parts)
  })

  it("never builds snapshots in nuxi prepare", async () => {
    await app()
    const { nuxt, hooks } = fakeNuxt({ prepare: true })
    await setupDocsRunnable(runnable, { nuxt, content })
    await hooks.get("app:templates")!()
    expect(buildTutorialSnapshots).not.toHaveBeenCalled()
    expect(await templates.get("runnable-tutorials.mjs")!()).not.toContain("\"snapshot\"")
  })

  it("builds snapshots in development only with TUTORIAL_SNAPSHOTS=1", async () => {
    await app()
    vi.spyOn(console, "info").mockImplementation(() => {})
    const dev = fakeNuxt({ dev: true })
    await setupDocsRunnable(runnable, { nuxt: dev.nuxt, content })
    await dev.hooks.get("app:templates")!()
    expect(buildTutorialSnapshots).not.toHaveBeenCalled()

    vi.stubEnv("TUTORIAL_SNAPSHOTS", "1")
    buildTutorialSnapshots.mockResolvedValue({})
    const opted = fakeNuxt({ dev: true })
    await setupDocsRunnable(runnable, { nuxt: opted.nuxt, content })
    await opted.hooks.get("app:templates")!()
    await opted.hooks.get("app:templates")!()
    // Dev calls the hook on each change, and the snapshots build once.
    expect(buildTutorialSnapshots).toHaveBeenCalledOnce()
  })

  it("writes one module per learn and playground page, and their loaders", async () => {
    await write("content/docs/try/lesson.md", `---\ntitle: Lesson\nlayout: learn\nfixture: kv\n---\n::tutorial-step{title="Add the route"}\n${fence}ts [server/api/kv.get.ts]\nexport default () => 1\n${fence}\n::\n`)
    await write("fixtures/kv/package.json", JSON.stringify({ name: "kv", dependencies: { "vite-hub": "^1.0.0" } }))
    await write("fixtures/kv/server/api/kv.get.ts", "export default () => 1\n")
    await write("examples/hello/package.json", JSON.stringify({ name: "hello", dependencies: { "vite-hub": "^1.0.0" } }))
    await write("examples/page/index.html", "<h1>Hi</h1>\n")
    await write("app/render.ts", "export default files => ({ html: files['index.html'] })\n")
    await write("app/components/playground/PlaygroundTabMessages.vue", "<template><p /></template>\n")
    const hello = { id: "hello", label: "Hello", dir: "examples/hello" }
    const sitePages: WorkspaceContentPage[] = [
      { path: "/docs/try/lesson", layout: "learn", workspace: { fixture: "kv", guide: "top" } },
      { path: "/docs/try/playground", layout: "playground", workspace: { examples: [hello], tabs: [{ value: "messages", label: "Messages" }], port: 4000 } },
      { path: "/docs/try/render", layout: "playground", workspace: { examples: [{ id: "page", label: "Page", dir: "examples/page" }], render: "app/render.ts" } },
    ]
    const siteContent = { pages: () => sitePages, read: (path: string) => readFileSync(resolve(dir, `content${path}.md`), "utf8") }
    buildTutorialSnapshots.mockResolvedValue({ "docs-try-lesson": snapshot })
    const { nuxt, hooks } = fakeNuxt()
    const { workspaces } = await setupDocsRunnable({}, { nuxt, content: siteContent })
    await hooks.get("app:templates")!()

    expect(workspaces).toContain(`"/docs/try/lesson": () => import("./workspaces/docs-try-lesson.mjs"),`)
    expect(workspaces).toContain(`"/docs/try/render": () => import("./workspaces/docs-try-render.mjs"),`)
    const lesson = await templates.get("docs/workspaces/docs-try-lesson.mjs")!()
    expect(lesson).toContain(`"layout":"learn"`)
    expect(lesson).toContain(`"guide":"top"`)
    expect(lesson).toContain(`"title":"Add the route"`)
    expect(await templates.get("runnable-tutorials.mjs")!()).toBe("export const runnableTutorials = []\n")
    const playground = await templates.get("docs/workspaces/docs-try-playground.mjs")!()
    expect(playground).toContain(`"id":"hello"`)
    expect(playground).toContain(`"snapshotOf":"docs-try-lesson"`)
    expect(playground).toContain(JSON.stringify(served))
    expect(playground).toContain(`"port":4000`)
    expect(playground).toContain(`component: () => import(${JSON.stringify(resolve(dir, "app/components/playground/PlaygroundTabMessages.vue"))})`)
    const render = await templates.get("docs/workspaces/docs-try-render.mjs")!()
    expect(render).toContain(`"files":{"index.html":"<h1>Hi</h1>\\n"}`)
    expect(render).toContain(`data.render = () => import(${JSON.stringify(resolve(dir, "app/render.ts"))})`)
    expect(await templates.get("learn-facts.mjs")!()).toContain(`"/docs/try/lesson":{"steps":1`)
  })

  it("asks for a pnpm workspace when a fixture uses one", async () => {
    await app()
    await write("fixtures/kv/package.json", JSON.stringify({ name: "kv", dependencies: { "vite-hub": "workspace:*" } }))
    const { nuxt } = fakeNuxt()
    await expect(setupDocsRunnable(runnable, { nuxt, content })).rejects.toThrow(expect.objectContaining({ fix: expect.stringContaining("docs.runnable.pnpmWorkspace") }))
  })
})
