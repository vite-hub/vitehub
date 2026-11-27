import { existsSync } from "node:fs"
import { glob, readFile, writeFile } from "node:fs/promises"

import { dirname, join, relative } from "pathe"
import semver from "semver"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { setupDiff } from "./add.ts"
import { setupExitCodes, setupFailure, writeSetupError, writeSetupJson } from "./envelope.ts"
import { detectPackageManager, setupLockfiles } from "./project.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { SetupChange } from "./add.ts"
import type { SetupPackageManager } from "./project.ts"

const usage = "vitehub update [--preview <commit>] [--dry-run] [--no-install] [--json]"

export interface SetupUpdateArgs {
  dryRun: boolean
  help: boolean
  install: boolean
  json: boolean
  /** A commit of vite-hub/vitehub. Its pkg.pr.new build replaces the npm release. */
  preview?: string
}

export interface SetupUpdatePlan {
  /** `planned` for a dry run, `applied` when done, `unchanged` when every package is already on the target. */
  status: "planned" | "applied" | "unchanged"
  /** The npm version, such as `0.2.0`, or the pkg.pr.new commit of `--preview`. */
  target: { version: string } | { preview: string }
  /** The root of the workspace that the command updated. */
  root: string
  /** Each ViteHub package that the project names, with the specifier it now uses. */
  packages: Readonly<Record<string, string>>
  changes: readonly Pick<SetupChange, "diff" | "kind" | "path">[]
  install: { command: string }
}

const previewBase = "https://pkg.pr.new/vite-hub/vitehub"
const defaultRegistry = "https://registry.npmjs.org/"
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"] as const

function isViteHubPackage(name: string): boolean {
  return name === "vite-hub" || /^@vite-hub\/[a-z0-9][\w.-]*$/u.test(name)
}

function overrideTarget(key: string): string | undefined {
  let part = key.split(">").at(-1)!.replace(/^\*\*\//u, "")
  const scoped = part.lastIndexOf("/@")
  if (scoped >= 0) part = part.slice(scoped + 1)
  else if (!part.startsWith("@") && part.includes("/")) part = part.slice(part.lastIndexOf("/") + 1)
  const name = part.replace(/(?<=.)@.*$/u, "")
  return isViteHubPackage(name) ? name : undefined
}

function isReplaceable(specifier: string): boolean {
  return specifier.startsWith(`${previewBase}/`) || specifier === "latest" || specifier === "next" || semver.validRange(specifier) !== null
}

type Place = "dependency" | "override"

interface Found {
  name: string
  place: Place
}

function nextSpecifier(name: string, current: string, place: Place, target: Resolved): string {
  if ("preview" in target) return target.url(name)
  const version = target.versions.get(name)!
  if (place === "override") return version
  const prefix = /^[\^~]/u.exec(current)?.[0] ?? (semver.valid(current) ? "" : "^")
  return `${prefix}${version}`
}

interface Resolved {
  preview?: string
  url: (name: string) => string
  versions: Map<string, string>
}

type JsonObject = { [key: string]: unknown }

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function visitManifest(manifest: JsonObject, visit: (holder: JsonObject, key: string, found: Found) => void): void {
  const entries = (holder: unknown, place: Place, nameOf: (key: string) => string | undefined) => {
    if (!isObject(holder)) return
    for (const [key, value] of Object.entries(holder)) {
      const name = nameOf(key)
      if (typeof value === "string") {
        if (name && isReplaceable(value)) visit(holder, key, { name, place })
      }
      else if (place === "override" && isObject(value)) {
        if (name && typeof value["."] === "string" && isReplaceable(value["."])) visit(value, ".", { name, place })
        entries(value, place, overrideTarget)
      }
    }
  }
  const plainName = (key: string) => isViteHubPackage(key) ? key : undefined
  for (const field of dependencyFields) entries(manifest[field], "dependency", plainName)
  entries(manifest.overrides, "override", overrideTarget)
  entries(manifest.resolutions, "override", overrideTarget)
  if (isObject(manifest.pnpm)) entries(manifest.pnpm.overrides, "override", overrideTarget)
  if (isObject(manifest.workspaces)) {
    entries(manifest.workspaces.catalog, "dependency", plainName)
    if (isObject(manifest.workspaces.catalogs)) for (const catalog of Object.values(manifest.workspaces.catalogs)) entries(catalog, "dependency", plainName)
  }
}

interface YamlEntry {
  key: string
  value: string
  line: (value: string) => string
}

function unquote(text: string): { quote: string, value: string } {
  const quote = text[0] === "'" || text[0] === "\"" ? text[0] : ""
  return quote && text.endsWith(quote) && text.length > 1 ? { quote, value: text.slice(1, -1) } : { quote: "", value: text }
}

function readYamlEntry(line: string): YamlEntry | undefined {
  const match = /^(\s+)("[^"]+"|'[^']+'|[^\s#'"][^:#]*?):\s+(.+?)(\s+#.*)?$/u.exec(line)
  if (!match) return
  const [, indent, rawKey, rawValue, comment = ""] = match
  const key = unquote(rawKey!).value
  const { quote, value } = unquote(rawValue!)
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith("&") || value.startsWith("*")) return
  return { key, line: next => `${indent}${rawKey}: ${quote}${next}${quote}${comment}`, value }
}

function topLevelKey(line: string): string | undefined {
  if (!line || /^\s/u.test(line) || line.startsWith("#") || line.startsWith("-")) return
  return /^("[^"]+"|'[^']+'|[^:#\s]+):/u.exec(line)?.[1]?.replace(/^["']|["']$/gu, "")
}

function yamlBlocks(lines: readonly string[]): Map<string, { start: number, end: number }> {
  const blocks = new Map<string, { start: number, end: number }>()
  let current: string | undefined
  for (const [index, line] of lines.entries()) {
    const key = topLevelKey(line)
    if (key === undefined) continue
    if (current) blocks.get(current)!.end = index
    current = key
    blocks.set(key, { end: lines.length, start: index })
  }
  return blocks
}

function yamlList(lines: readonly string[], range: { start: number, end: number } | undefined): { index: number, value: string }[] {
  if (!range) return []
  const inline = /^[^:]+:\s*\[(.*)\]\s*(#.*)?$/u.exec(lines[range.start]!)
  if (inline) return inline[1]!.split(",").map(item => ({ index: range.start, value: unquote(item.trim()).value })).filter(item => item.value)
  return lines.slice(range.start + 1, range.end).flatMap((line, offset) => {
    const match = /^\s+-\s+(.+?)(\s+#.*)?$/u.exec(line)
    return match ? [{ index: range.start + 1 + offset, value: unquote(match[1]!).value }] : []
  })
}

function pinnedName(entry: string): string | undefined {
  const at = entry.indexOf("@", entry.startsWith("@") ? 1 : 0)
  return at > 0 ? entry.slice(0, at) : undefined
}

const releaseAgePatterns = ["vite-hub", "@vite-hub/*"]

interface WorkspaceFile {
  path: string
  before: string
  after: string
}

type Edit = (name: string, specifier: string, place: Place) => string | null | undefined

function editYamlEntries(lines: string[], edit: Edit): Set<number> {
  const blocks = yamlBlocks(lines)
  const removed = new Set<number>()
  for (const [block, place] of [["overrides", "override"], ["catalog", "dependency"], ["catalogs", "dependency"]] as const) {
    const range = blocks.get(block)
    if (!range) continue
    for (let index = range.start + 1; index < range.end; index++) {
      const entry = readYamlEntry(lines[index]!)
      const name = entry && (place === "override" ? overrideTarget(entry.key) : isViteHubPackage(entry.key) ? entry.key : undefined)
      if (!entry || !name || !isReplaceable(entry.value)) continue
      const next = edit(name, entry.value, place)
      if (next === null) removed.add(index)
      else if (next !== undefined) lines[index] = entry.line(next)
    }
  }
  return removed
}

function updateWorkspaceYaml(text: string, edit: Edit, options: { preview: boolean }): string {
  const lines = text.split("\n")
  const removed = editYamlEntries(lines, edit)
  const blocks = yamlBlocks(lines)
  if (!options.preview) {
    const range = blocks.get("minimumReleaseAgeExclude")
    const items = yamlList(lines, range)
    const isInline = range && /:\s*\[/u.test(lines[range.start]!)
    if (range && !isInline) {
      for (const item of items) {
        const name = pinnedName(item.value)
        if (name && isViteHubPackage(name)) removed.add(item.index)
      }
      const missing = releaseAgePatterns.filter(pattern => !items.some(item => item.value === pattern))
      const indent = /^(\s+)-/u.exec(lines[items[0]?.index ?? -1] ?? "")?.[1] ?? "  "
      if (missing.length) lines[range.start] = `${lines[range.start]}\n${missing.map(pattern => `${indent}- '${pattern}'`).join("\n")}`
    }
    else if (!range) {
      lines.splice(lines.at(-1) === "" ? -1 : lines.length, 0, ...(text.trim() ? [""] : []), "# Let new ViteHub releases install without waiting for minimumReleaseAge.", "minimumReleaseAgeExclude:", ...releaseAgePatterns.map(pattern => `  - '${pattern}'`))
    }
  }
  else {
    const range = blocks.get("blockExoticSubdeps")
    if (range) lines[range.start] = lines[range.start]!.replace(/^(blockExoticSubdeps:\s*)true\b/u, "$1false")
    else lines.splice(lines.at(-1) === "" ? -1 : lines.length, 0, ...(text.trim() ? [""] : []), "# pkg.pr.new builds depend on other pkg.pr.new builds.", "blockExoticSubdeps: false")
  }
  const after = lines.filter((_, index) => !removed.has(index)).join("\n")
  return after.endsWith("\n") || !after ? after : `${after}\n`
}

async function workspaceFolders(root: string, patterns: readonly string[]): Promise<string[]> {
  const find = async (selected: readonly string[]) => {
    if (!selected.length) return new Set<string>()
    const folders = new Set<string>()
    const files = glob(selected.map(pattern => `${pattern.replace(/\/+$/u, "")}/package.json`), {
      cwd: root,
      exclude: (path: string) => path.split(/[\\/]/u).includes("node_modules"),
    })
    for await (const file of files) folders.add(dirname(file.replaceAll("\\", "/")))
    return folders
  }
  const included = await find(patterns.filter(pattern => !pattern.startsWith("!")))
  const excluded = await find(patterns.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1)))
  return [...included].filter(folder => !excluded.has(folder)).sort()
}

function workspacePatterns(yaml: string | undefined, manifest: JsonObject): string[] {
  if (yaml !== undefined) {
    const lines = yaml.split("\n")
    return yamlList(lines, yamlBlocks(lines).get("packages")).map(item => item.value)
  }
  const workspaces = manifest.workspaces
  const list: unknown[] = Array.isArray(workspaces) ? workspaces : isObject(workspaces) && Array.isArray(workspaces.packages) ? workspaces.packages : []
  return list.filter(item => typeof item === "string")
}

async function workspaceRoot(start: string): Promise<string> {
  if (setupLockfiles.some(([file]) => existsSync(join(start, file)))) return start
  for (let folder = dirname(start), last = start; folder !== last; last = folder, folder = dirname(folder)) {
    if (existsSync(join(folder, "pnpm-workspace.yaml"))) return folder
    const manifest = join(folder, "package.json")
    if (!existsSync(manifest)) continue
    const patterns = workspacePatterns(undefined, await readJson(manifest))
    if (patterns.length && (await workspaceFolders(folder, patterns)).includes(relative(folder, start))) return folder
  }
  return start
}

async function readJson(file: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"))
  return isObject(value) ? value : {}
}

function stringifyLike(before: string, value: JsonObject): string {
  const indent = /^[ \t]+(?=")/mu.exec(before)?.[0] ?? "  "
  return `${JSON.stringify(value, null, indent)}${before.endsWith("\n") ? "\n" : ""}`
}

/** The command that installs the new specifiers. pnpm resolves ViteHub peers again only with `update`. */
export function updateInstallArgs(packageManager: SetupPackageManager, workspace: boolean): string[] {
  if (packageManager === "pnpm") return ["update", ...(workspace ? ["--recursive"] : []), "vite-hub", "@vite-hub/*"]
  return ["install"]
}

function invalid(message: string): Error {
  return cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${message} Usage: ${usage}` })
}

/** Reads the arguments. Throws `CLI_R0003` for an unknown flag or a value that is not a commit. */
export function readUpdateArgs(args: readonly string[]): SetupUpdateArgs {
  const parsed: SetupUpdateArgs = { dryRun: false, help: false, install: true, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--json") parsed.json = true
    else if (arg === "--dry-run") parsed.dryRun = true
    else if (arg === "--no-install") parsed.install = false
    else if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--preview" || arg.startsWith("--preview=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index]
      if (!value || !/^[0-9a-f]{7,40}$/u.test(value)) throw invalid(`--preview needs a commit SHA of vite-hub/vitehub, such as \`--preview 01898b8\`. Got ${JSON.stringify(value ?? "")}.`)
      parsed.preview = value
    }
    else throw invalid(`Unknown argument ${JSON.stringify(arg)}.`)
  }
  return parsed
}

async function resolvePackages(names: readonly string[], preview: string | undefined, context: Pick<ViteHubCliContext, "env" | "fetch">): Promise<{ resolved: Resolved, missing: string[] }> {
  const request = context.fetch ?? fetch
  const registry = (context.env.npm_config_registry || defaultRegistry).replace(/\/?$/u, "/")
  const url = (name: string) => `${previewBase}/${name}@${preview}`
  const versions = new Map<string, string>()
  const missing: string[] = []
  await Promise.all(names.map(async (name) => {
    const target = preview ? url(name) : `${registry}${name.replace("/", "%2f")}/latest`
    let response: Response
    try {
      response = await request(target, preview ? { method: "HEAD" } : { headers: { accept: "application/json" } })
    }
    catch (error) {
      throw cliErrorDiagnostics.CLI_UPDATE_REQUEST_FAILED({ status: error instanceof Error ? error.message : String(error), url: target })
    }
    if (response.status === 404) {
      missing.push(name)
      return
    }
    if (!response.ok) throw cliErrorDiagnostics.CLI_UPDATE_REQUEST_FAILED({ status: response.status, url: target })
    if (preview) return
    const body: unknown = await response.json()
    const version = isObject(body) && typeof body.version === "string" ? body.version : undefined
    if (!version) throw cliErrorDiagnostics.CLI_UPDATE_REQUEST_FAILED({ status: "a response without a version", url: target })
    versions.set(name, version)
  }))
  return { missing: missing.sort(), resolved: { ...(preview ? { preview } : {}), url, versions } }
}

interface PlannedUpdate {
  plan: SetupUpdatePlan
  files: readonly WorkspaceFile[]
  packageManager: SetupPackageManager
  installArgs: string[]
}

/** Plans the update: finds every ViteHub specifier, resolves the target, and computes the new files. Writes nothing. */
export async function planSetupUpdate(rootDir: string, args: Pick<SetupUpdateArgs, "preview">, context: Pick<ViteHubCliContext, "env" | "fetch">): Promise<PlannedUpdate> {
  const root = await workspaceRoot(rootDir)
  const rootManifestFile = join(root, "package.json")
  if (!existsSync(rootManifestFile)) throw cliErrorDiagnostics.SETUP_NOT_A_PROJECT({ root })
  const rootManifest = await readJson(rootManifestFile)
  const { packageManager } = detectPackageManager(root, rootManifest, context.env)
  const yamlFile = join(root, "pnpm-workspace.yaml")
  const yamlBefore = existsSync(yamlFile) ? await readFile(yamlFile, "utf8") : undefined
  const folders = [".", ...(await workspaceFolders(root, workspacePatterns(yamlBefore, rootManifest))).filter(folder => folder !== ".")]

  const manifests = await Promise.all(folders.map(async (folder) => {
    const path = join(root, folder, "package.json")
    const before = await readFile(path, "utf8")
    return { before, path, value: await readJson(path) }
  }))
  const places = new Map<string, Set<Place>>()
  const note = (name: string, place: Place) => places.set(name, (places.get(name) ?? new Set()).add(place))
  for (const manifest of manifests) visitManifest(manifest.value, (_, __, found) => note(found.name, found.place))
  if (yamlBefore !== undefined) {
    editYamlEntries(yamlBefore.split("\n"), (name, _, place) => {
      note(name, place)
      return undefined
    })
  }
  if (!places.size) throw cliErrorDiagnostics.CLI_UPDATE_NO_PACKAGES({ root })

  const { missing, resolved } = await resolvePackages([...places.keys()].sort(), args.preview, context)
  const blocking = missing.filter(name => places.get(name)!.has("dependency"))
  if (blocking.length) {
    throw setupFailure(cliErrorDiagnostics.CLI_UPDATE_PACKAGE_MISSING({ packages: blocking.join(", "), target: args.preview ? `the pkg.pr.new build of ${args.preview}` : "npm" }), setupExitCodes.error)
  }

  const packages: Record<string, string> = {}
  const next = (name: string, current: string, place: Place): string | null => {
    if (missing.includes(name)) return null
    const specifier = nextSpecifier(name, current, place, resolved)
    if (place === "dependency" || !(name in packages)) packages[name] = specifier
    return specifier
  }
  const files: WorkspaceFile[] = []
  for (const manifest of manifests) {
    const direct = new Map<string, string>()
    for (const field of dependencyFields) {
      const dependencies = manifest.value[field]
      if (!isObject(dependencies)) continue
      for (const [name, value] of Object.entries(dependencies)) {
        if (isViteHubPackage(name) && typeof value === "string" && isReplaceable(value) && !missing.includes(name)) direct.set(name, nextSpecifier(name, value, "dependency", resolved))
      }
    }
    let edited = false
    visitManifest(manifest.value, (holder, key, found) => {
      const current = String(holder[key])
      const specifier = found.place === "override" && direct.has(found.name) ? direct.get(found.name)! : next(found.name, current, found.place)
      if (specifier === current) return
      edited = true
      if (specifier === null) delete holder[key]
      else holder[key] = specifier
    })
    if (edited) files.push({ after: stringifyLike(manifest.before, manifest.value), before: manifest.before, path: manifest.path })
  }
  if (yamlBefore !== undefined || packageManager === "pnpm") {
    const after = updateWorkspaceYaml(yamlBefore ?? "", next, { preview: !!args.preview })
    files.push({ after, before: yamlBefore ?? "", path: yamlFile })
  }
  const changed = files.filter(file => file.after !== file.before)
  const installArgs = updateInstallArgs(packageManager, folders.length > 1)
  const plan: SetupUpdatePlan = {
    changes: changed.map((file) => {
      const path = relative(root, file.path)
      return { diff: setupDiff(path, file.before, file.after), kind: file.before ? "patch" : "create", path }
    }),
    install: { command: [packageManager, ...installArgs.map(arg => arg.includes("*") ? `"${arg}"` : arg)].join(" ") },
    packages: Object.fromEntries(Object.entries(packages).sort(([left], [right]) => left.localeCompare(right))),
    root,
    status: changed.length ? "planned" : "unchanged",
    target: args.preview ? { preview: args.preview } : { version: resolved.versions.get("vite-hub") ?? [...resolved.versions.values()].sort(semver.rcompare)[0]! },
  }
  return { files: changed, installArgs, packageManager, plan }
}

function targetLabel(target: SetupUpdatePlan["target"]): string {
  return "preview" in target ? `the pkg.pr.new build of ${target.preview}` : target.version
}

async function runUpdate(args: string[], context: ViteHubCliContext): Promise<number> {
  let parsed: SetupUpdateArgs | undefined
  try {
    parsed = readUpdateArgs(args)
    if (parsed.help) {
      context.stdout.write(`Usage: ${usage}\n\n${updateCommand.description}\n`)
      return setupExitCodes.done
    }
    const { files, installArgs, packageManager, plan } = await planSetupUpdate(context.rootDir, parsed, context)
    if (parsed.dryRun || plan.status === "unchanged") {
      if (parsed.json) writeSetupJson(context, plan)
      else if (plan.status === "unchanged") context.stdout.write(`ViteHub packages already use ${targetLabel(plan.target)}. Nothing to change.\n`)
      else {
        for (const change of plan.changes) context.stdout.write(change.diff.endsWith("\n") ? change.diff : `${change.diff}\n`)
        context.stdout.write(`${parsed.install ? "Install" : "Then install"}: ${plan.install.command}\n`)
      }
      return setupExitCodes.done
    }
    for (const file of files) await writeFile(file.path, file.after)
    if (parsed.install) {
      const result = await context.spawn(packageManager, installArgs, { cwd: plan.root, env: context.env, stdout: "stderr" })
      if (result.exitCode !== 0) {
        throw setupFailure(cliErrorDiagnostics.CLI_UPDATE_INSTALL_FAILED({ command: plan.install.command, exitCode: result.exitCode ?? result.signal }), setupExitCodes.error)
      }
    }
    const applied: SetupUpdatePlan = { ...plan, status: "applied" }
    if (parsed.json) writeSetupJson(context, applied)
    else {
      const names = Object.keys(plan.packages)
      context.stdout.write(`Moved ${names.length} ViteHub ${names.length === 1 ? "package" : "packages"} to ${targetLabel(plan.target)}. Changed ${plan.changes.map(change => change.path).join(", ")}.\n`)
      if (!parsed.install) context.stdout.write(`Install the packages: ${plan.install.command}\n`)
    }
    return setupExitCodes.done
  }
  catch (error: unknown) {
    return writeSetupError(context, parsed?.json ?? args.includes("--json"), error)
  }
}

export const updateCommand: ViteHubCliCommand = {
  description: "Move vite-hub and every @vite-hub/* package to the latest npm release, or to one pkg.pr.new build with --preview <commit>. Edits dependencies, overrides, and catalogs in every package of the workspace, then installs. Does not load the project config.",
  name: "update",
  run: runUpdate,
  usage,
}
