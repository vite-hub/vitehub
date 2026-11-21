import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildRunnableTutorial, frameworkView, noWorkspaceVersions, readWorkspaceVersions, resolveManifest, workspacePackageDirs } from "../src/runnable/build.ts"
import { tutorialStepFiles } from "../src/runnable/steps.ts"

let dir: string
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), "runnable-build-")) })
afterEach(() => rm(dir, { recursive: true, force: true }))

async function write(path: string, contents: string) {
  await mkdir(dirname(resolve(dir, path)), { recursive: true })
  await writeFile(resolve(dir, path), contents)
}

const fence = "```"
const lesson = `---
title: Hello route
description: Add a route.
---

::tutorial-step{title="Add the route"}
${fence}ts [server/api/hello.get.ts]
export default () => "hello"
${fence}
::

::tutorial-step{title="Configure Vite"}
${fence}bash [commands/dev]
pnpm dev
${fence}
${fence}ts [vite.config.ts]
export default { server: true }
${fence}
::
`

async function app() {
  await write("content/docs/lesson.md", lesson)
  await write("content/docs/start.md", `${fence}ts [vite.config.ts]\nexport default {}\n${fence}\n`)
  await write("fixtures/hello/package.json", JSON.stringify({ name: "hello", dependencies: { "vite-hub": "^1.0.0" } }))
  await write("fixtures/hello/server/api/hello.get.ts", "export default () => \"hello\"\n")
  await write("fixtures/hello/vite.config.ts", "export default { server: true }\n")
  await write("fixtures/hello/node_modules/ignored/index.js", "ignored\n")
}

const source = { slug: "hello", page: "/docs/lesson", fixture: "hello" }
/** Reads a page by URL, as the docs module does: `/docs/lesson` is `docs/lesson.md` or `docs/lesson/index.md`. */
function readPage(path: string): string | undefined {
  for (const file of [`content${path}.md`, `content${path}/index.md`]) {
    try {
      return readFileSync(resolve(dir, file), "utf8")
    }
    catch {}
  }
}
const build = (start?: string) => buildRunnableTutorial({ source, readPage, fixturesDir: resolve(dir, "fixtures"), versions: noWorkspaceVersions, start })

describe("runnable lessons", () => {
  it("builds the steps of a lesson from its page and its fixture, outside a pnpm workspace", async () => {
    await app()
    const tutorial = await build()
    expect(tutorial).toMatchObject({ slug: "hello", page: "/docs/lesson", title: "Hello route", description: "Add a route." })
    expect(tutorial.steps).toEqual([
      { title: "Add the route", files: { "server/api/hello.get.ts": "export default () => \"hello\"\n" } },
      { title: "Configure Vite", files: { "vite.config.ts": "export default { server: true }\n" } },
    ])
    // Without a start page, a file that a step writes does not exist before that step. Installed files stay out.
    expect(Object.keys(tutorial.files).sort()).toEqual(["package.json"])
    expect(Object.keys(tutorialStepFiles(tutorial, 1, "solution")).sort()).toEqual(["package.json", "server/api/hello.get.ts", "vite.config.ts"])
  })

  it("starts a file at its version on the start page", async () => {
    await app()
    const tutorial = await build("/docs/start")
    expect(tutorial.files["vite.config.ts"]).toBe("export default {}\n")
    expect(tutorial.files["server/api/hello.get.ts"]).toBeUndefined()
  })

  it("builds the same lesson from LF and CRLF Markdown", async () => {
    await app()
    const lf = await build("/docs/start")
    await write("content/docs/lesson.md", lesson.replaceAll("\n", "\r\n"))
    await write("content/docs/start.md", `${fence}ts [vite.config.ts]\r\nexport default {}\r\n${fence}\r\n`)
    expect(await build("/docs/start")).toEqual(lf)
  })

  it("reads a lesson page that is the index of its folder", async () => {
    await app()
    await rm(resolve(dir, "content/docs/lesson.md"))
    await write("content/docs/lesson/index.md", lesson)
    expect((await build()).steps).toHaveLength(2)
  })

  it("reads lesson pages from any source of the docs site", async () => {
    await app()
    const pages: Record<string, string> = { "/guide/lesson": lesson }
    const tutorial = await buildRunnableTutorial({ source: { ...source, page: "/guide/lesson" }, readPage: path => pages[path], fixturesDir: resolve(dir, "fixtures"), versions: noWorkspaceVersions })
    expect(tutorial.steps).toHaveLength(2)
  })

  it("names the page when the site has no page at its URL", async () => {
    await app()
    await expect(build("/docs/missing")).rejects.toThrow("docs.runnable names the page /docs/missing, but the docs site has no page at that URL.")
  })

  it("names the fixture when the lesson shows a file that the fixture lacks", async () => {
    await app()
    await rm(resolve(dir, "fixtures/hello/vite.config.ts"))
    await expect(build()).rejects.toThrow("/docs/lesson shows vite.config.ts, but the fixture hello has no such file.")
  })

  it("rejects a page without steps", async () => {
    await app()
    await write("content/docs/lesson.md", "---\ntitle: Empty\n---\n")
    await expect(build()).rejects.toThrow("/docs/lesson has no ::tutorial-step blocks, so docs.runnable cannot build its lesson.")
  })

  it("reads the Vite tab of framework tabs", () => {
    const page = [
      "::tabs{sync=\"framework\"}",
      ":::tabs-item{label=\"Nuxt\"}",
      "nuxt",
      ":::",
      ":::tabs-item{label=\"Vite\"}",
      "vite",
      ":::",
      "::",
    ].join("\n")
    expect(frameworkView(page, "Vite")).toBe("vite")
    expect(frameworkView(page, "Nuxt")).toBe("nuxt")
  })
})

describe("pnpm workspace versions", () => {
  async function workspace() {
    await write("pnpm-workspace.yaml", [
      "packages:",
      "  - \"packages/*\"",
      "  - \"integrations/**\"",
      "  - \"docs/\"",
      "  - \"!packages/private\"",
      "  - \"!integrations/**/test\"",
      "catalog:",
      "  zod: 4.6.5",
      "catalogs:",
      "  ui:",
      "    vue: 3.6.0",
    ].join("\n"))
    await write("packages/kv/package.json", JSON.stringify({ name: "@vite-hub/kv", version: "0.4.0" }))
    await write("packages/vite-hub/package.json", JSON.stringify({ name: "vite-hub", version: "0.1.0" }))
    await write("packages/notes/README.md", "no manifest\n")
    await write("packages/private/package.json", JSON.stringify({ name: "private", version: "9.9.9" }))
    await write("integrations/nuxt/app/package.json", JSON.stringify({ name: "@vite-hub/nuxt-app", version: "0.2.0" }))
    await write("integrations/nuxt/test/package.json", JSON.stringify({ name: "nuxt-test", version: "0.0.1" }))
    await write("docs/package.json", JSON.stringify({ name: "docs", private: true }))
    await write("packages/node_modules/.keep", "")
    await write("packages/kv/node_modules/dep/package.json", JSON.stringify({ name: "dep", version: "1.0.0" }))
    await write("package.json", JSON.stringify({ name: "root", version: "1.2.3" }))
  }

  it("lists the package folders of pnpm-workspace.yaml as pnpm does", async () => {
    await workspace()
    // The root is a package, `**` matches nested folders, a folder without package.json and `!` matches are not packages.
    expect(await workspacePackageDirs(dir)).toEqual([
      dir,
      resolve(dir, "docs"),
      resolve(dir, "integrations/nuxt/app"),
      resolve(dir, "packages/kv"),
      resolve(dir, "packages/vite-hub"),
    ])
  })

  it("rewrites catalog and workspace specifiers to npm versions", async () => {
    await workspace()
    const versions = await readWorkspaceVersions(dir)
    expect(versions).toEqual({
      catalogs: { default: { zod: "4.6.5" }, ui: { vue: "3.6.0" } },
      packages: { "root": "1.2.3", "@vite-hub/kv": "0.4.0", "@vite-hub/nuxt-app": "0.2.0", "vite-hub": "0.1.0" },
    })
    const manifest = JSON.stringify({ dependencies: { "vite-hub": "workspace:*", "zod": "catalog:", "vue": "catalog:ui", "h3": "^2.0.0" } })
    expect(JSON.parse(resolveManifest(manifest, versions)).dependencies).toEqual({ "vite-hub": "^0.1.0", "zod": "4.6.5", "vue": "3.6.0", "h3": "^2.0.0" })
  })

  it("names the option when a fixture needs a pnpm workspace", () => {
    expect(() => resolveManifest(JSON.stringify({ dependencies: { zod: "catalog:" } }), noWorkspaceVersions)).toThrow(expect.objectContaining({ code: "DOCS_RUNNABLE_CATALOG_VERSION_MISSING", fix: expect.stringContaining("docs.runnable.pnpmWorkspace") }))
    expect(() => resolveManifest(JSON.stringify({ devDependencies: { "vite-hub": "workspace:*" } }), noWorkspaceVersions)).toThrow(expect.objectContaining({ code: "DOCS_RUNNABLE_WORKSPACE_PACKAGE_MISSING", fix: expect.stringContaining("docs.runnable.pnpmWorkspace") }))
  })
})
