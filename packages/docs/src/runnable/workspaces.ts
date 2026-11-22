import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { docsErrorDiagnostics } from "../error-diagnostics.ts"
import { readTree } from "./build.ts"

import type { DocsLayout, DocsPageWorkspace } from "../types.ts"
import type { RunnableTutorialSource } from "./build.ts"
import type { PlaygroundTemplateSource } from "./playground.ts"
import type { DocsLearnData, DocsPlaygroundData, PlaygroundTemplate, TutorialFiles } from "./steps.ts"

/** A page of the docs site, with the fields that set up a workspace. */
export interface WorkspaceContentPage {
  path: string
  layout?: DocsLayout
  workspace?: DocsPageWorkspace
}

/** A `layout: playground` or `layout: learn` page, read from the docs content. */
export type WorkspacePage = WorkspaceContentPage & { layout: "playground" | "learn", workspace: DocsPageWorkspace }

/** The `playground` and `learn` pages of the site. */
export function workspacePages(pages: readonly WorkspaceContentPage[]): WorkspacePage[] {
  return pages.filter((page): page is WorkspacePage => (page.layout === "playground" || page.layout === "learn") && !!page.workspace)
}

/**
 * The paths that must be cross-origin isolated: each `learn` page, and each `playground` page without `render`. A
 * WebContainer runs only there. A `render` page runs in the page, so it stays a plain page.
 */
export function webContainerRoutes(pages: readonly WorkspaceContentPage[]): string[] {
  return workspacePages(pages).filter(page => page.layout === "learn" || !page.workspace.render).map(page => page.path)
}

/** The stable id of a page in file names and snapshot names. */
export function workspacePageSlug(path: string): string {
  return createHash("sha256").update(path).digest("hex")
}

/** The lesson of a `learn` page: its steps come from `lesson`, or from the page itself. */
export function learnLessonSource(page: WorkspacePage): RunnableTutorialSource {
  return { slug: workspacePageSlug(page.path), page: page.workspace.lesson ?? page.path, fixture: page.workspace.fixture ?? "" }
}

const exampleSeparator = "--"

/**
 * The examples of a `playground` page that runs a WebContainer, as playground sources. They share the snapshot of a
 * lesson or of another example with the same dependencies. The id names the page, so two pages can use one example id.
 */
export function playgroundExampleSources(page: WorkspacePage, rootDir: string): PlaygroundTemplateSource[] {
  return (page.workspace.examples ?? []).map(example => ({
    id: `${workspacePageSlug(page.path)}${exampleSeparator}${example.id}`,
    label: example.label,
    description: example.description,
    group: example.group,
    fixture: resolve(rootDir, example.dir),
    open: example.open,
    preview: example.preview,
  }))
}

/** Fails the build for a folder, a `render` module, or a tab component that a page names and that does not exist. */
export function checkWorkspacePage(page: WorkspacePage, input: { rootDir: string, srcDir: string, fixturesDir: string }): void {
  const { workspace } = page
  const dirs = page.layout === "learn" ? [resolve(input.fixturesDir, workspace.fixture ?? "")] : (workspace.examples ?? []).map(example => resolve(input.rootDir, example.dir))
  for (const dir of dirs) {
    if (!existsSync(dir)) throw docsErrorDiagnostics.DOCS_WORKSPACE_DIR_MISSING({ page: page.path, dir })
  }
  if (workspace.render && !existsSync(resolve(input.rootDir, workspace.render))) {
    throw docsErrorDiagnostics.DOCS_WORKSPACE_RENDER_MISSING({ page: page.path, file: workspace.render })
  }
  for (const tab of workspace.tabs ?? []) {
    const file = workspaceTabComponent(input.srcDir, tab.value)
    if (!existsSync(file)) throw docsErrorDiagnostics.DOCS_WORKSPACE_TAB_MISSING({ page: page.path, tab: tab.value, file })
  }
}

/** The component of a tab: `messages` is `<srcDir>/components/playground/PlaygroundTabMessages.vue`. */
export function workspaceTabComponent(srcDir: string, value: string): string {
  const name = value.split(/[-_]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("")
  return resolve(srcDir, "components/playground", `PlaygroundTab${name}.vue`)
}

/** The examples of a `render` page, with their files. They need no snapshot. */
export async function renderExamples(page: WorkspacePage, rootDir: string): Promise<DocsPlaygroundData["examples"]> {
  return Promise.all((page.workspace.examples ?? []).map(async (example) => {
    const files: TutorialFiles = await readTree(resolve(rootDir, example.dir))
    const { id, label, description, group, open, preview } = example
    return { id, label, description, group, open, preview, files }
  }))
}

/** The examples of a WebContainer page from the built templates, with their own ids again. */
export function pageExamples(page: WorkspacePage, templates: readonly PlaygroundTemplate[]): DocsPlaygroundData["examples"] {
  const prefix = `${workspacePageSlug(page.path)}${exampleSeparator}`
  return templates.filter(template => template.id.startsWith(prefix)).map(template => ({ ...template, id: template.id.slice(prefix.length) }))
}

/**
 * The JavaScript of a page module. `render` and the tab components are imports, so the page loads them with its data
 * and Vite bundles them with the app.
 */
export function workspacePageModule(data: DocsPlaygroundData | DocsLearnData, loaders: { render?: string, tabs?: ReadonlyArray<{ value: string, label: string, file: string }> } = {}): string {
  const lines = [`const data = ${JSON.stringify(data)}`]
  if (loaders.render) lines.push(`data.render = () => import(${JSON.stringify(loaders.render)})`)
  if (loaders.tabs?.length) {
    lines.push(`data.tabs = [`, ...loaders.tabs.map(tab => `  { value: ${JSON.stringify(tab.value)}, label: ${JSON.stringify(tab.label)}, component: () => import(${JSON.stringify(tab.file)}) },`), `]`)
  }
  lines.push("export default data", "")
  return lines.join("\n")
}
