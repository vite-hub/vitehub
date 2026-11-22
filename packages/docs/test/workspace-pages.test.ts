import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { docsPageOf } from "../src/page.ts"
import { checkWorkspacePage, learnLessonSource, pageExamples, webContainerRoutes, workspacePageModule, workspacePages, workspacePageSlug, workspaceTabComponent } from "../src/runnable/workspaces.ts"
import { docsPageSchema } from "../src/schema.ts"
import { docsLearnGuideNodes, docsLearnStepNodes } from "../runtime/app/utils/docs-learn.ts"
import { docsPlaygroundExampleQuery } from "../runtime/app/utils/docs-playground.ts"

import type { Node as ComarkNode } from "comark"
import type { DocsPageFrontmatter } from "../src/schema.ts"
import type { WorkspaceContentPage, WorkspacePage } from "../src/runnable/workspaces.ts"

const issues = (frontmatter: Record<string, unknown>) => {
  const result = docsPageSchema.safeParse(frontmatter)
  return result.success ? [] : result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`)
}
const hello = { id: "hello", label: "Hello", dir: "examples/hello" }

describe("workspace frontmatter", () => {
  it("accepts a playground page and a learn page", () => {
    expect(issues({ title: "Try", layout: "playground", examples: [hello], tabs: [{ value: "messages", label: "Messages" }], port: 4000 })).toEqual([])
    expect(issues({ title: "Try", layout: "playground", render: "app/playground/render.ts", examples: [hello] })).toEqual([])
    expect(issues({ title: "Learn", layout: "learn", fixture: "kv", guide: "top", lesson: "/docs/kv/get-started", preview: "/api/kv" })).toEqual([])
  })

  it("rejects a workspace field on a layout that does not read it", () => {
    expect(issues({ title: "Guide", examples: [hello] })).toEqual(["examples: Only a page with `layout: playground` reads `examples`"])
    expect(issues({ title: "Try", layout: "playground", examples: [hello], fixture: "kv" })).toEqual(["fixture: Only a page with `layout: learn` reads `fixture`"])
    expect(issues({ title: "Learn", layout: "learn", fixture: "kv", render: "app/render.ts" })).toEqual(["render: Only a page with `layout: playground` reads `render`"])
  })

  it("asks a playground for unique examples, a learn page for its fixture, and a render page for no port", () => {
    expect(issues({ title: "Try", layout: "playground" })).toEqual(["examples: A playground page needs at least one example"])
    expect(issues({ title: "Try", layout: "playground", examples: [hello, hello] })).toEqual(["examples.1.id: Two examples have the id `hello`"])
    expect(issues({ title: "Learn", layout: "learn" })).toEqual(["fixture: A learn page needs the `fixture` folder of its app"])
    expect(issues({ title: "Try", layout: "playground", render: "app/render.ts", port: 3000, examples: [hello] })).toEqual(["port: A `render` page runs in the browser page and has no dev server port"])
  })

  it("rejects a tab value that cannot name a component", () => {
    expect(issues({ title: "Try", layout: "playground", examples: [hello], tabs: [{ value: "1st", label: "First" }] })).toHaveLength(1)
  })
})

describe("docsPageOf with a workspace", () => {
  const at = { id: "try", path: "/docs/try", file: "docs/try.md" }

  it("keeps the workspace fields, starts the sidebar collapsed, and hides the outline", () => {
    const page = docsPageOf({ title: "Try", layout: "playground", examples: [hello], render: "app/render.ts" } satisfies DocsPageFrontmatter, at)
    expect(page).toMatchObject({ layout: "playground", sidebar: "collapsed", toc: false, workspace: { examples: [hello], render: "app/render.ts" } })
    expect(docsPageOf({ title: "Learn", layout: "learn", fixture: "kv", sidebar: true }, at)).toMatchObject({ sidebar: true, workspace: { fixture: "kv" } })
  })

  it("gives other layouts no workspace", () => {
    expect(docsPageOf({ title: "Guide" }, at)).not.toHaveProperty("workspace")
  })
})

describe("workspace pages", () => {
  const pages: WorkspaceContentPage[] = [
    { path: "/docs/guide", layout: "article" },
    { path: "/docs/try/lesson", layout: "learn", workspace: { fixture: "kv" } },
    { path: "/docs/try/playground", layout: "playground", workspace: { examples: [hello] } },
    { path: "/docs/try/render", layout: "playground", workspace: { examples: [hello], render: "app/render.ts" } },
  ]

  it("isolates every learn page and every playground page without render", () => {
    expect(workspacePages(pages).map(page => page.path)).toEqual(["/docs/try/lesson", "/docs/try/playground", "/docs/try/render"])
    expect(webContainerRoutes(pages)).toEqual(["/docs/try/lesson", "/docs/try/playground"])
  })

  it("gives every page path a stable distinct id and reads its lesson from `lesson`, else from the page", () => {
    const lessonSlug = "531852c7af276cde7a7d01bea4fb5dd86608a6168cab77c4b475bf06ecb52f93"
    expect(workspacePageSlug("/docs/try/lesson")).toBe(lessonSlug)
    expect(workspacePageSlug("/docs/a/b")).not.toBe(workspacePageSlug("/docs/a-b"))
    expect(workspacePageSlug("/docs/A")).not.toBe(workspacePageSlug("/docs/a"))
    const learn = workspacePages(pages)[0]!
    expect(learnLessonSource(learn)).toEqual({ slug: lessonSlug, page: "/docs/try/lesson", fixture: "kv" })
    expect(learnLessonSource({ ...learn, workspace: { fixture: "kv", lesson: "/docs/kv/get-started" } })).toMatchObject({ page: "/docs/kv/get-started" })
  })

  it("maps a tab value to its component", () => {
    expect(workspaceTabComponent("/app", "messages")).toBe(resolve("/app", "components/playground/PlaygroundTabMessages.vue"))
    expect(workspaceTabComponent("/app", "web-vitals")).toBe(resolve("/app", "components/playground/PlaygroundTabWebVitals.vue"))
  })

  it("gives the examples of a page their own ids back", () => {
    const page = workspacePages(pages)[1]!
    const prefix = workspacePageSlug(page.path)
    const template = { label: "Hello", files: {}, snapshotOf: `${prefix}--hello` }
    expect(pageExamples(workspacePages(pages)[1]!, [
      { ...template, id: `${prefix}--hello` },
      { ...template, id: `${workspacePageSlug("/docs/try/other")}--hello` },
    ]).map(example => example.id)).toEqual(["hello"])
  })

  it("loads render and the tabs with dynamic imports", () => {
    const module = workspacePageModule({ layout: "playground", examples: [], port: 3000 }, { render: "/app/render.ts", tabs: [{ value: "messages", label: "Messages", file: "/app/Tab.vue" }] })
    expect(module).toContain(`data.render = () => import("/app/render.ts")`)
    expect(module).toContain(`{ value: "messages", label: "Messages", component: () => import("/app/Tab.vue") },`)
    expect(module).toContain("export default data")
  })
})

describe("playground example query", () => {
  it("names every example on a page with a chooser, and none on a page with one example", () => {
    const two = [hello, { id: "clock", label: "Clock", dir: "examples/clock" }]
    expect(docsPlaygroundExampleQuery(two, "hello")).toBe("hello")
    expect(docsPlaygroundExampleQuery(two, "clock")).toBe("clock")
    expect(docsPlaygroundExampleQuery([hello], "hello")).toBeUndefined()
  })
})

describe("checkWorkspacePage", () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), "workspace-pages-")) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const write = async (path: string) => {
    await mkdir(dirname(resolve(dir, path)), { recursive: true })
    await writeFile(resolve(dir, path), "")
  }
  const check = (page: WorkspacePage) => checkWorkspacePage(page, { rootDir: dir, srcDir: resolve(dir, "app"), fixturesDir: resolve(dir, "fixtures") })
  const code = (run: () => void) => {
    try {
      run()
    }
    catch (error) {
      return (error as { code?: string }).code
    }
  }

  it("fails the build for a missing folder, render module, or tab component", async () => {
    const playground: WorkspacePage = { path: "/docs/try", layout: "playground", workspace: { examples: [hello], render: "app/render.ts", tabs: [{ value: "messages", label: "Messages" }] } }
    expect(code(() => check(playground))).toBe("DOCS_WORKSPACE_DIR_MISSING")
    await write("examples/hello/package.json")
    expect(code(() => check(playground))).toBe("DOCS_WORKSPACE_RENDER_MISSING")
    await write("app/render.ts")
    expect(code(() => check(playground))).toBe("DOCS_WORKSPACE_TAB_MISSING")
    await write("app/components/playground/PlaygroundTabMessages.vue")
    expect(code(() => check(playground))).toBeUndefined()

    const learn: WorkspacePage = { path: "/docs/learn", layout: "learn", workspace: { fixture: "kv" } }
    expect(code(() => check(learn))).toBe("DOCS_WORKSPACE_DIR_MISSING")
    await write("fixtures/kv/package.json")
    expect(code(() => check(learn))).toBeUndefined()
  })
})

describe("learn guide nodes", () => {
  const step: ComarkNode = ["tutorial-step", { title: "Add a route" }, ["h2", { id: "add-a-route" }, "Add a route"], ["p", {}, "Edit ", ["code", {}, "server/api/kv.ts"], " and ", ["code", {}, "pnpm dev"], "."], ["pre", { filename: "server/api/kv.ts" }, ["code", {}, "server/api/kv.ts"]]]

  it("drops the heading of a step, which the workspace shows over the text", () => {
    expect(docsLearnStepNodes(step).map(node => typeof node === "string" ? node : node[0])).toEqual(["p", "pre"])
    expect(docsLearnStepNodes(undefined)).toEqual([])
  })

  it("links inline code that names a file of the lesson, and leaves code blocks alone", () => {
    const [paragraph, block] = docsLearnGuideNodes(docsLearnStepNodes(step), new Set(["server/api/kv.ts"]))
    expect(paragraph).toEqual(["p", {}, "Edit ", ["docs-learn-file", { path: "server/api/kv.ts" }, ["code", {}, "server/api/kv.ts"]], " and ", ["code", {}, "pnpm dev"], "."])
    expect(block).toEqual(step[4])
  })
})
