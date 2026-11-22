import { glob, readFile, readdir } from "node:fs/promises"
import { join, matchesGlob, relative, resolve } from "node:path"
import { parse } from "yaml"

import { docsErrorDiagnostics } from "../error-diagnostics.ts"

import type { RunnableTutorialData, TutorialAssets, TutorialFiles } from "./steps.ts"

/** A lesson that runs in the reader's browser. */
export interface RunnableTutorialSource {
  /** The id of the lesson and of its snapshot, such as `first-agent`. */
  slug: string
  /** The URL of the docs page, such as `/docs/getting-started/first-agent`. */
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
    if (!title) throw docsErrorDiagnostics.DOCS_RUNNABLE_TITLE_MISSING({ block: `::tutorial-step{${match[1]}}` })
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

/** Whether `entry`, a name in a fixture folder, is a generated or installed file that the workspace makes itself. */
export function isIgnoredEntry(entry: string): boolean {
  return ignoredEntries.has(entry)
}

/** The text of a file, with its BOM, or `undefined` when its bytes are not valid UTF-8, such as model weights. */
export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  catch {
    return undefined
  }
}

/**
 * The files of a fixture folder, without generated or installed files: the text files in `files`, and the files
 * that are not valid UTF-8, such as model weights, in `assets`.
 */
export async function readTree(root: string): Promise<{ files: TutorialFiles, assets: TutorialAssets }> {
  const files: TutorialFiles = {}
  const assets: TutorialAssets = {}
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignoredEntries.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const name = relative(root, path).replaceAll("\\", "/")
        const bytes = new Uint8Array(await readFile(path))
        const text = decodeText(bytes)
        if (text === undefined) assets[name] = bytes
        else files[name] = text
      }
    }
  }
  await walk(root)
  return { files, assets }
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

const isNodeModules = (path: string) => path.split(/[\\/]/).includes("node_modules")

/**
 * The folders of the workspace packages, sorted, as pnpm finds them: the root and each folder with a `package.json`
 * that a `packages` pattern of `pnpm-workspace.yaml` matches and no `!` pattern excludes.
 */
export async function workspacePackageDirs(root: string): Promise<string[]> {
  const { packages } = await readPnpmWorkspace(root)
  const patterns = Array.isArray(packages) ? packages.filter((pattern): pattern is string => typeof pattern === "string").map(pattern => pattern.replace(/\/+$/, "")) : []
  const excluded = patterns.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1))
  const included = patterns.filter(pattern => !pattern.startsWith("!")).map(pattern => `${pattern}/package.json`)
  const dirs = new Set<string>()
  for await (const file of glob(["package.json", ...included], { cwd: root, exclude: isNodeModules })) {
    const dir = file.replaceAll("\\", "/").replace(/\/?package\.json$/, "")
    if (!excluded.some(pattern => matchesGlob(dir, pattern))) dirs.add(resolve(root, dir))
  }
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

const isStringRecord = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string")

/**
 * Rewrites `catalog:` and `workspace:` specifiers to npm versions, so `npm install` works outside the pnpm workspace.
 * A workspace package resolves to the published range of its current version.
 */
export function resolveDependencies(dependencies: Record<string, string>, versions: WorkspaceVersions): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (specifier.startsWith("catalog:")) {
      const catalog = specifier.slice("catalog:".length) || "default"
      const version = versions.catalogs[catalog]?.[name]
      if (!version) throw docsErrorDiagnostics.DOCS_RUNNABLE_CATALOG_VERSION_MISSING({ catalog, name })
      resolved[name] = version
    }
    else if (specifier.startsWith("workspace:")) {
      const version = versions.packages[name]
      if (!version) throw docsErrorDiagnostics.DOCS_RUNNABLE_WORKSPACE_PACKAGE_MISSING({ name })
      resolved[name] = `^${version}`
    }
    else {
      resolved[name] = specifier
    }
  }
  return resolved
}

/** A `package.json` with the `dependencies` and `devDependencies` of `resolveDependencies()`. Other JSON stays as it is. */
export function resolveManifest(source: string, versions: WorkspaceVersions): string {
  const manifest: unknown = JSON.parse(source)
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return source
  const resolved: Record<string, unknown> = { ...manifest }
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies = resolved[field]
    if (isStringRecord(dependencies)) resolved[field] = resolveDependencies(dependencies, versions)
  }
  return `${JSON.stringify(resolved, null, 2)}\n`
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
  /** The Markdown of the docs page at a URL, or nothing when the site has no page there. */
  readPage: (path: string) => string | undefined
  fixturesDir: string
  versions: WorkspaceVersions
  /** A docs page, such as `/docs/getting-started/installation`, whose code blocks are the files before step 1. */
  start?: string
}): Promise<RunnableTutorialData> {
  const { source, fixturesDir, versions } = input
  const readPage = (page: string) => {
    const markdown = input.readPage(page)
    if (markdown === undefined) throw docsErrorDiagnostics.DOCS_RUNNABLE_PAGE_MISSING({ page })
    return markdown.replaceAll("\r\n", "\n")
  }
  const lesson = readPage(source.page)
  const start = input.start ? readPage(input.start) : ""
  const { files: fixture } = await readTree(resolve(fixturesDir, source.fixture))
  if (fixture["package.json"]) fixture["package.json"] = resolveManifest(fixture["package.json"], versions)

  const parsed = parseTutorialSteps(lesson)
  if (parsed.length === 0) throw docsErrorDiagnostics.DOCS_RUNNABLE_STEPS_MISSING({ page: source.page })

  const files: TutorialFiles = { ...fixture }
  const steps = parsed.map(({ title, labels }) => {
    const stepFiles: TutorialFiles = {}
    for (const label of labels) {
      const contents = fixture[label]
      if (contents === undefined) throw docsErrorDiagnostics.DOCS_RUNNABLE_FIXTURE_FILE_MISSING({ fixture: source.fixture, label, page: source.page })
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
