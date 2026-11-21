import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { parse } from "yaml"

import type { RunnableTutorialData, TutorialFiles } from "./steps.ts"

/** A lesson that runs in the reader's browser. */
export interface RunnableTutorialSource {
  /** The id of the lesson and of its snapshot, such as `first-agent`. */
  slug: string
  /** The docs page, such as `/docs/getting-started/first-agent`. Its file is `<content folder>/<page>.md`. */
  page: string
  /** The folder of the app after the last step, in the fixtures folder. */
  fixture: string
}

// Generated or installed files. A fixture that was built or run locally has them, and the workspace makes its own.
const ignoredEntries = new Set(["node_modules", ".output", ".vitehub", ".nitro", ".data", "dist"])

/** Labels of code blocks that are not files of the app, such as `commands/dev` and `output/response.json`. */
export function isTutorialFileLabel(label: string): boolean {
  return !label.startsWith("commands/") && !label.startsWith("output/")
}

function codeBlockLabels(markdown: string): string[] {
  return [...markdown.matchAll(/^```[^\n[]*\[([^\]]+)\]/gm)].map(match => match[1]!)
}

function frontmatterField(markdown: string, field: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? ""
  const value: unknown = parse(frontmatter)?.[field]
  return typeof value === "string" ? value : ""
}

/** The frameworks of `::tabs{sync="framework"}`, in tab order. */
export const frameworks = ["Nuxt", "Nitro", "Vite"] as const
export type Framework = typeof frameworks[number]

/**
 * A page as a reader of one framework sees it: the content of that framework's tab stays, and the other tabs of every
 * `::tabs{sync="framework"}` block go away. Runnable lessons run a Vite fixture, so they read the Vite view. A page
 * without framework tabs stays as it is.
 */
export function frameworkView(markdown: string, framework: Framework): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const panel = /^(:{2,})framework\{name="([^"]+)"\}\s*$/.exec(lines[index]!)
    if (panel) {
      for (index++; index < lines.length && lines[index]!.trim() !== panel[1]; index++) {
        if (panel[2] === framework) out.push(lines[index]!)
      }
      continue
    }
    const tabs = /^(:{2,})tabs\{[^}]*sync="framework"[^}]*\}\s*$/.exec(lines[index]!)
    if (!tabs) {
      out.push(lines[index]!)
      continue
    }
    const colons = tabs[1]!
    let keep = false
    for (index++; index < lines.length && lines[index]!.trim() !== colons; index++) {
      const line = lines[index]!
      const item = new RegExp(`^${colons}:tabs-item\\{[^}]*label="([^"]*)"`).exec(line)
      if (item) keep = item[1] === framework
      else if (line.trim() === `${colons}:`) keep = false
      else if (keep) out.push(line)
    }
  }
  return out.join("\n")
}

/** The `::tutorial-step` blocks of a page, in order, with the file labels of their code blocks. */
export function parseTutorialSteps(markdown: string): { title: string, labels: string[] }[] {
  const steps: { title: string, labels: string[] }[] = []
  markdown = frameworkView(markdown, "Vite")
  for (const match of markdown.matchAll(/^::tutorial-step\{([^}]*)\}\n([\s\S]*?)^::$/gm)) {
    const title = /title="([^"]*)"/.exec(match[1]!)?.[1]
    if (!title) throw new Error(`A ::tutorial-step block has no title: ::tutorial-step{${match[1]}}`)
    steps.push({ title, labels: codeBlockLabels(match[2]!).filter(isTutorialFileLabel) })
  }
  return steps
}

/** The code block of `label` in a page, without its fences. */
export function codeBlock(markdown: string, label: string): string | undefined {
  markdown = frameworkView(markdown, "Vite")
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp("^```[^\\n]*\\[" + escaped + "\\]\\n([\\s\\S]*?)\\n```", "m").exec(markdown)
  return match ? `${match[1]}\n` : undefined
}

/** The text files of a fixture folder, without generated or installed files. */
export async function readTree(root: string, directory: string = root): Promise<TutorialFiles> {
  const files: TutorialFiles = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredEntries.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, await readTree(root, path))
    else if (entry.isFile()) files[relative(root, path).replaceAll("\\", "/")] = await readFile(path, "utf8")
  }
  return files
}

export interface WorkspaceVersions {
  /** `catalog` and `catalogs` from `pnpm-workspace.yaml`. */
  catalogs: Record<string, Record<string, string>>
  /** The version of each workspace package, by name. */
  packages: Record<string, string>
}

/** No pnpm workspace: `catalog:` and `workspace:` specifiers fail, and every dependency installs from npm. */
export const noWorkspaceVersions: WorkspaceVersions = { catalogs: {}, packages: {} }

async function readPnpmWorkspace(root: string): Promise<Record<string, unknown>> {
  const workspace: unknown = parse(await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8"))
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : {}
}

/** Expands one `packages` pattern of `pnpm-workspace.yaml`. A `*` matches one folder name. `**` and `!` patterns match nothing. */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  if (pattern.startsWith("!") || pattern.includes("**")) return []
  let dirs = [root]
  for (const segment of pattern.replace(/\/+$/, "").split("/")) {
    const next: string[] = []
    for (const dir of dirs) {
      if (segment !== "*") {
        next.push(join(dir, segment))
        continue
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) if (entry.isDirectory() && entry.name !== "node_modules") next.push(join(dir, entry.name))
    }
    dirs = next
  }
  return dirs
}

/** The folders of the packages that `pnpm-workspace.yaml` lists, sorted. */
export async function workspacePackageDirs(root: string): Promise<string[]> {
  const { packages } = await readPnpmWorkspace(root)
  const patterns = Array.isArray(packages) ? packages.filter((pattern): pattern is string => typeof pattern === "string") : []
  const dirs = new Set<string>()
  for (const pattern of patterns) for (const dir of await expandPattern(root, pattern)) dirs.add(dir)
  return [...dirs].sort()
}

/** Reads the pnpm catalogs and the versions of the workspace packages that fixtures depend on. */
export async function readWorkspaceVersions(root: string): Promise<WorkspaceVersions> {
  const record = await readPnpmWorkspace(root)
  const catalogs: Record<string, Record<string, string>> = {}
  if (record.catalog && typeof record.catalog === "object") catalogs.default = record.catalog as Record<string, string>
  if (record.catalogs && typeof record.catalogs === "object") Object.assign(catalogs, record.catalogs)

  const packages: Record<string, string> = {}
  for (const dir of await workspacePackageDirs(root)) {
    const manifest: unknown = await readFile(resolve(dir, "package.json"), "utf8").then(JSON.parse, () => undefined)
    if (!manifest || typeof manifest !== "object") continue
    const { name, version } = manifest as { name?: unknown, version?: unknown }
    if (typeof name === "string" && typeof version === "string") packages[name] = version
  }
  return { catalogs, packages }
}

/**
 * Rewrites `catalog:` and `workspace:` specifiers to npm versions, so `npm install` works outside the pnpm workspace.
 * A workspace package resolves to the published range of its current version.
 */
export function resolveManifest(source: string, versions: WorkspaceVersions): string {
  const manifest = JSON.parse(source)
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies: Record<string, string> | undefined = manifest[field]
    if (!dependencies) continue
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (specifier.startsWith("catalog:")) {
        const catalog = specifier.slice("catalog:".length) || "default"
        const version = versions.catalogs[catalog]?.[name]
        if (!version) throw new Error(`No version of ${name} in the pnpm catalog "${catalog}". Set \`docs.runnable.pnpmWorkspace\` to the folder of pnpm-workspace.yaml.`)
        dependencies[name] = version
      }
      else if (specifier.startsWith("workspace:")) {
        const version = versions.packages[name]
        if (!version) throw new Error(`No workspace package named ${name}. Set \`docs.runnable.pnpmWorkspace\` to the folder of pnpm-workspace.yaml.`)
        dependencies[name] = `^${version}`
      }
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Builds the workspace files of one lesson.
 *
 * The fixture is the app after the last step, and every file code block in the lesson equals a fixture file. So step N
 * writes the fixture version of the files that its code blocks name. Before step 1 the app is the fixture without those
 * files, except where the `start` page already shows a version, such as `vite.config.ts`.
 */
export async function buildRunnableTutorial(input: {
  source: RunnableTutorialSource
  contentDir: string
  fixturesDir: string
  versions: WorkspaceVersions
  /** A docs page, such as `/docs/getting-started/installation`, whose code blocks are the files before step 1. */
  start?: string
}): Promise<RunnableTutorialData> {
  const { source, contentDir, fixturesDir, versions } = input
  const readPage = async (page: string) => (await readFile(resolve(contentDir, `${page.replace(/^\//, "")}.md`), "utf8")).replaceAll("\r\n", "\n")
  const lesson = await readPage(source.page)
  const start = input.start ? await readPage(input.start) : ""
  const fixture = await readTree(resolve(fixturesDir, source.fixture))
  if (fixture["package.json"]) fixture["package.json"] = resolveManifest(fixture["package.json"], versions)

  const parsed = parseTutorialSteps(lesson)
  if (parsed.length === 0) throw new Error(`${source.page} has no ::tutorial-step blocks.`)

  const files: TutorialFiles = { ...fixture }
  const steps = parsed.map(({ title, labels }) => {
    const stepFiles: TutorialFiles = {}
    for (const label of labels) {
      const contents = fixture[label]
      if (contents === undefined) throw new Error(`${source.page} shows ${label}, but the fixture ${source.fixture} has no such file.`)
      stepFiles[label] = contents
    }
    return { title, files: stepFiles }
  })
  // Files that a step writes start in their version on the start page, or do not exist yet.
  for (const step of steps) {
    for (const path of Object.keys(step.files)) {
      const before = codeBlock(start, path)
      if (before === undefined) delete files[path]
      else files[path] = before
    }
  }

  return {
    slug: source.slug,
    page: source.page,
    title: frontmatterField(lesson, "title"),
    description: frontmatterField(lesson, "description"),
    files,
    steps,
  }
}
