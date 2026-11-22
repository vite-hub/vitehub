import { Buffer } from "node:buffer"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { docsErrorDiagnostics } from "../error-diagnostics.ts"
import { decodeText, isIgnoredEntry, isPrivateFile, readTree } from "./build.ts"

import type { DocsLayout, DocsPageWorkspace } from "../types.ts"
import type { RunnableTutorialSource } from "./build.ts"
import type { PlaygroundTemplateSource } from "./playground.ts"
import type { DocsLearnData, DocsPlaygroundData, PlaygroundTemplate } from "./steps.ts"

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

/**
 * The id of a page in file names, snapshot names, and zip names: `/learn/first-kv` is `learn-first-kv`. It has no
 * `--`, so the ids of a page's examples, `<page id>--<example id>`, never start with the id of another page.
 */
export function workspacePageSlug(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "index"
}

/** Fails the build when two pages get one id, such as `/docs/a/b` and `/docs/a-b`. */
export function checkWorkspacePageIds(pages: readonly WorkspacePage[]): void {
  const seen = new Map<string, string>()
  for (const page of pages) {
    const id = workspacePageSlug(page.path)
    const other = seen.get(id)
    if (other !== undefined) throw docsErrorDiagnostics.DOCS_WORKSPACE_ID_COLLISION({ id, pages: [other, page.path] })
    seen.set(id, page.path)
  }
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
    readonly: example.readonly,
  }))
}

function isTextFileOf(dir: string, path: string): boolean {
  const parts = path.split("/")
  if (isAbsolute(path) || path.includes("\\") || parts.some(part => part === "" || part === "." || part === ".." || isIgnoredEntry(part)) || isPrivateFile(parts.at(-1)!)) return false
  const stats = parts.map((_, index) => lstatSync(resolve(dir, ...parts.slice(0, index + 1)), { throwIfNoEntry: false }))
  if (stats.some((stat, index) => !(index === parts.length - 1 ? stat?.isFile() : stat?.isDirectory()))) return false
  return decodeText(readFileSync(resolve(dir, path))) !== undefined
}

/**
 * Fails the build for a folder, a `render` module, or a tab component that a page names and that does not exist, and
 * for a `readonly` path that is not a text file of its example.
 */
export function checkWorkspacePage(page: WorkspacePage, input: { rootDir: string, srcDir: string, fixturesDir: string }): void {
  const { workspace } = page
  const dirs = page.layout === "learn" ? [resolve(input.fixturesDir, workspace.fixture ?? "")] : (workspace.examples ?? []).map(example => resolve(input.rootDir, example.dir))
  for (const dir of dirs) {
    if (!existsSync(dir)) throw docsErrorDiagnostics.DOCS_WORKSPACE_DIR_MISSING({ page: page.path, dir })
  }
  for (const example of workspace.examples ?? []) {
    const dir = resolve(input.rootDir, example.dir)
    for (const path of example.readonly ?? []) {
      if (!isTextFileOf(dir, path)) throw docsErrorDiagnostics.DOCS_WORKSPACE_READONLY_MISSING({ page: page.path, example: example.id, path, dir: example.dir })
    }
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

/** The examples of a `render` page, with their files and binary files. They need no snapshot. */
export async function renderExamples(page: WorkspacePage, rootDir: string): Promise<DocsPlaygroundData["examples"]> {
  return Promise.all((page.workspace.examples ?? []).map(async (example) => {
    const { files, assets } = await readTree(resolve(rootDir, example.dir))
    const { id, label, description, group, open, preview, readonly } = example
    return { id, label, description, group, open, preview, readonly, files, ...Object.keys(assets).length ? { assets } : {} }
  }))
}

/** The examples of a WebContainer page from the built templates, with their own ids again. */
export function pageExamples(page: WorkspacePage, templates: readonly PlaygroundTemplate[]): DocsPlaygroundData["examples"] {
  const prefix = `${workspacePageSlug(page.path)}${exampleSeparator}`
  return templates.filter(template => template.id.startsWith(prefix)).map(template => ({ ...template, id: template.id.slice(prefix.length) }))
}

const decodeAssets = [
  `const bytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0))`,
  `for (const example of data.examples) {`,
  `  const encoded = assets[example.id]`,
  `  if (encoded) example.assets = Object.fromEntries(Object.entries(encoded).map(([path, text]) => [path, bytes(text)]))`,
  `}`,
]

/**
 * The JavaScript of a page module. `render` and the tab components are imports, so the page loads them with its data
 * and Vite bundles them with the app. JSON has no bytes, so the binary files of the examples are base64 in the module,
 * and the module decodes them when it loads.
 */
export function workspacePageModule(data: DocsPlaygroundData | DocsLearnData, loaders: { render?: string, tabs?: ReadonlyArray<{ value: string, label: string, file: string }> } = {}): string {
  if (data.layout === "learn") return pageModule(data, loaders)
  const assets: Record<string, Record<string, string>> = {}
  const examples = data.examples.map(({ assets: bytes, ...example }) => {
    if (bytes) assets[example.id] = Object.fromEntries(Object.entries(bytes).map(([path, contents]) => [path, Buffer.from(contents).toString("base64")]))
    return example
  })
  return pageModule({ ...data, examples }, loaders, Object.keys(assets).length ? [`const assets = ${JSON.stringify(assets)}`, ...decodeAssets] : [])
}

function pageModule(data: DocsPlaygroundData | DocsLearnData, loaders: { render?: string, tabs?: ReadonlyArray<{ value: string, label: string, file: string }> }, decode: string[] = []): string {
  const lines = [`const data = ${JSON.stringify(data)}`, ...decode]
  if (loaders.render) lines.push(`data.render = () => import(${JSON.stringify(loaders.render)})`)
  if (loaders.tabs?.length) {
    lines.push(`data.tabs = [`, ...loaders.tabs.map(tab => `  { value: ${JSON.stringify(tab.value)}, label: ${JSON.stringify(tab.label)}, component: () => import(${JSON.stringify(tab.file)}) },`), `]`)
  }
  lines.push("export default data", "")
  return lines.join("\n")
}
