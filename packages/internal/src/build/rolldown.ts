import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createRequire, isBuiltin } from "node:module"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { Rolldown } from "vite"

import { isPlainObject } from "../object.ts"
import { encodedAliasExactMarker, encodedAliasPrefixMarker, type ViteAlias } from "./bundle-options.ts"
import type { Node } from "./scan-module.ts"

type Plugin = Rolldown.Plugin
type PluginContext = Rolldown.PluginContext
type ResolvedId = Rolldown.ResolvedId
type ImportKind = Rolldown.ImportKind

export interface BundleEsmEntryOptions {
  alias?: Record<string, string> | ViteAlias[]
  banner?: string
  conditions?: string[]
  define?: Record<string, string>
  extensions?: string[]
  /** Import paths to leave as imports. `*` matches any text, and a package name also matches its subpaths. */
  external?: string[]
  format?: "esm" | "cjs"
  /** Keeps function and class names. Defaults to true when syntax or identifiers are minified. */
  keepNames?: boolean
  mainFields?: string[]
  minifyIdentifiers?: boolean
  minifySyntax?: boolean
  minifyWhitespace?: boolean
  packages?: "bundle" | "external"
  platform?: "browser" | "node" | "neutral"
  plugins?: Plugin[]
  preserveSymlinks?: boolean
  rootDir?: string
  /** Reverse package aliases for the entry itself, in addition to its imports. Defaults to true. */
  resolveEntryPackageAliases?: boolean
  signal?: AbortSignal
  workingDir?: string
}

const viteRawPrefix = "\0vitehub-vite-raw:"
const markdownTemplatePrefix = "\0vitehub-markdown-template:"
const markdownTemplateFileSuffix = ".template.md"
const markdownTemplateModuleQuery = "markdown-template"
const skipMarkdownTemplateResolve = "vitehubSkipMarkdownTemplateResolve"
const skipResolvedAlias = "vitehubSkipResolvedAlias"
const resolvingViteAlias = "vitehubResolvingAlias"
const markdownTemplateRuntimeSpecifier = "@vite-hub/markdown-template"

/**
 * Vite 8 bundles with Rolldown, so the app already has it. Load the copy next to `vite`, or `vite/rolldown` with
 * Vite+, instead of installing a second bundler.
 */
export async function importRolldown(): Promise<typeof Rolldown> {
  let entry: string
  try {
    entry = createRequire(import.meta.resolve("vite")).resolve("rolldown")
  }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error
    entry = createRequire(import.meta.url).resolve("vite/rolldown")
  }
  return await import(pathToFileURL(entry).href)
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isRelativeSpecifier(path: string): boolean {
  return /^\.\.?[\\/]/.test(path)
}

function isBareSpecifier(id: string): boolean {
  return !/^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/]|\0|#|[a-z][a-z0-9+.-]*:)/i.test(id)
}

/** The folder that a relative import of `importer` resolves from, as esbuild's `resolveDir`. */
function importerDir(importer: string | undefined, workingDir: string): string {
  return importer && isAbsolute(importer) ? dirname(importer) : workingDir
}

/** Rolldown resolves a specifier from an importer file. A bundle entry has none, so use a file in the working folder. */
function importerFor(importer: string | undefined, workingDir: string): string {
  return importer ?? join(workingDir, "__vitehub_entry__.js")
}

function isFileResolution(resolved: ResolvedId | null): resolved is ResolvedId {
  return Boolean(resolved && !resolved.external && isAbsolute(resolved.id) && !resolved.id.startsWith("\0"))
}

function collectPackageExportCandidates(packageName: string, exportsValue: unknown, packageRelativePath: string): string[] {
  if (typeof exportsValue === "string") {
    return normalizePathSeparators(exportsValue).replace(/^\.\//, "") === packageRelativePath ? [packageName] : []
  }
  if (!Array.isArray(exportsValue) && !isPlainObject(exportsValue)) return []
  const candidates: string[] = []
  const exportEntries = isPlainObject(exportsValue) && Object.keys(exportsValue).some(exportKey => exportKey.startsWith("."))
    ? Object.entries(exportsValue)
    : [[".", exportsValue] as const]
  for (const [exportKey, target] of exportEntries) {
    const targets: unknown[] = [target]
    while (targets.length) {
      const value = targets.shift()
      if (typeof value === "string") {
        const normalizedTarget = normalizePathSeparators(value).replace(/^\.\//, "")
        const targetParts = normalizedTarget.split("*")
        if (targetParts.length === 1) {
          if (normalizedTarget === packageRelativePath) candidates.push(`${packageName}${exportKey.slice(1)}`)
          continue
        }
        const targetPattern = `${escapeRegExp(targetParts[0]!)}(.*?)${targetParts.slice(1)
          .map((part, index) => `${index ? "\\1" : ""}${escapeRegExp(part)}`)
          .join("")}`
        const wildcardMatch = new RegExp(`^${targetPattern}$`).exec(packageRelativePath)
        const wildcard = wildcardMatch?.[1]
        if (wildcard === undefined) continue
        candidates.push(`${packageName}${exportKey.slice(1).replace("*", wildcard)}`)
      }
      else if (Array.isArray(value)) {
        targets.push(...value)
      }
      else if (isPlainObject(value)) {
        targets.push(...Object.values(value))
      }
    }
  }
  return candidates
}

interface ResolvedBareAliasPaths {
  canonical: string
  normalized: string
  publicSpecifier?: string
}

interface ResolveRequest {
  custom: Rolldown.CustomPluginOptions | undefined
  importer: string | undefined
  isEntry: boolean
  kind: ImportKind | undefined
}

function resolveFrom(context: PluginContext, specifier: string, request: ResolveRequest, workingDir: string, flag: string): Promise<ResolvedId | null> {
  return context.resolve(specifier, importerFor(request.importer, workingDir), {
    custom: { ...request.custom, [flag]: true },
    isEntry: request.isEntry,
    kind: request.kind,
    skipSelf: false,
  })
}

function createResolvedAliasPlugin(aliases: Record<string, string> | undefined, aliasResolveDir: string, workingDir: string, resolveEntryPackageAliases = true): Plugin | undefined {
  const entries = Object.entries(aliases || {})
  if (!entries.length) return
  const resolvedEntries = Promise.all(entries.map(async ([encodedSpecifier, replacement]) => {
    const prefixMarkerIndex = encodedSpecifier.lastIndexOf(encodedAliasPrefixMarker)
    const exactMarkerIndex = encodedSpecifier.lastIndexOf(encodedAliasExactMarker)
    const explicitlyEncodedPrefix = prefixMarkerIndex !== -1
    const markerIndex = Math.max(prefixMarkerIndex, exactMarkerIndex)
    const specifier = markerIndex === -1 ? encodedSpecifier : encodedSpecifier.slice(0, markerIndex)
    const prefix = explicitlyEncodedPrefix || (specifier.endsWith("/") && !Object.hasOwn(aliases!, `${specifier}/`))
    const resolvedSpecifier = isAbsolute(specifier) ? normalizePathSeparators(resolve(specifier)) : specifier
    const canonicalSpecifier = isAbsolute(resolvedSpecifier)
      ? normalizePathSeparators(await realpath(resolvedSpecifier).catch(() => resolvedSpecifier))
      : resolvedSpecifier
    const resolvedReplacement = isAbsolute(replacement)
      ? normalizePathSeparators(resolve(replacement))
      : replacement
    return {
      canonicalSpecifier: `${canonicalSpecifier}${prefix && !canonicalSpecifier.endsWith("/") ? "/" : ""}`,
      prefix,
      replacement: `${resolvedReplacement}${prefix && !/[\\/]$/.test(resolvedReplacement) ? "/" : ""}`,
      specifier: `${resolvedSpecifier}${prefix && !resolvedSpecifier.endsWith("/") ? "/" : ""}`,
    }
  }))
  const resolvedBareAliasPaths = new Map<string, Promise<ResolvedBareAliasPaths | undefined>>()
  return {
    name: "vitehub-resolved-alias",
    async resolveId(source, importer, extra) {
      if (extra.custom?.[skipResolvedAlias]) return
      const request: ResolveRequest = { custom: extra.custom, importer, isEntry: extra.isEntry, kind: extra.kind }
      const resolveWithContext = (specifier: string) => resolveFrom(this, specifier, request, workingDir, skipResolvedAlias)
      const resolveDir = importerDir(importer, workingDir)
      const aliases = await resolvedEntries
      let match = aliases.find(({ prefix, specifier }) => isRelativeSpecifier(specifier) && (prefix
        ? source.startsWith(specifier)
        : source === specifier))
      let matchedAlias = match?.specifier
      let matchedSpecifier = match ? source : undefined
      const specifier = isRelativeSpecifier(source) ? resolve(resolveDir, source) : source
      const normalizedSpecifier = isAbsolute(specifier) ? normalizePathSeparators(resolve(specifier)) : specifier
      let canonicalSpecifier = normalizedSpecifier
      const canonicalizeSpecifier = async () => {
        canonicalSpecifier = normalizePathSeparators(await realpath(normalizedSpecifier).catch(() => normalizedSpecifier))
        return canonicalSpecifier
      }
      match ||= aliases.find(({ prefix, specifier }) => prefix
        ? normalizedSpecifier.startsWith(specifier)
        : normalizedSpecifier === specifier)
      if (!match && isAbsolute(normalizedSpecifier) && aliases.some(alias => isAbsolute(alias.specifier))) {
        await canonicalizeSpecifier()
        match = aliases.find(({ canonicalSpecifier: canonicalAlias, prefix }) => prefix
          ? canonicalSpecifier.startsWith(canonicalAlias)
          : canonicalSpecifier === canonicalAlias)
      }
      if (!match && (resolveEntryPackageAliases || !extra.isEntry) && isAbsolute(source)) {
        // Start every alias resolution at once. Awaiting them one by one costs one resolver round trip per alias.
        const candidates: Array<{ alias: typeof aliases[number], resolution: Promise<ResolvedBareAliasPaths | undefined> }> = []
        for (const alias of aliases) {
          if (isAbsolute(alias.specifier) || (alias.prefix && alias.specifier.startsWith("#"))) continue
          const packageAlias = alias.prefix ? alias.specifier.replace(/\/$/, "") : alias.specifier
          const aliasSegments = packageAlias.split("/")
          if (!alias.prefix && aliasSegments.length === 1 && packageAlias.startsWith("@")) continue
          let packageName = packageAlias.startsWith("@") ? aliasSegments.slice(0, 2).join("/") : aliasSegments[0]!
          if (alias.prefix && aliasSegments.length === 1 && alias.specifier.startsWith("@")) {
            const scopeMarker = `/node_modules/${packageAlias}/`
            const scopeMarkerIndex = normalizedSpecifier.lastIndexOf(scopeMarker)
            const scopedPackage = scopeMarkerIndex === -1
              ? undefined
              : normalizedSpecifier.slice(scopeMarkerIndex + scopeMarker.length).split("/")[0]
            if (scopedPackage) packageName = `${packageAlias}/${scopedPackage}`
          }
          const packageMarker = `/node_modules/${packageName}/`
          const packageMarkerIndex = normalizedSpecifier.lastIndexOf(packageMarker)
          const resolutionScope = packageMarkerIndex === -1
            ? ""
            : normalizedSpecifier.slice(0, packageMarkerIndex + packageMarker.length)
          const cacheKey = [
            alias.specifier,
            alias.prefix,
            resolutionScope,
            // An exports match depends on the path inside the package, so two files of one package need two entries.
            normalizedSpecifier,
            importer,
            extra.kind,
            extra.isEntry,
          ].join("\0")
          // Custom resolver options are opaque state of other plugins, so they cannot be part of a stable cache key.
          const cacheable = !extra.custom || !Object.keys(extra.custom).length
          let resolution = cacheable ? resolvedBareAliasPaths.get(cacheKey) : undefined
          if (!resolution) {
            resolution = (async () => {
              let resolvedAliasPath: string
              if (alias.prefix && isRelativeSpecifier(alias.specifier)) {
                resolvedAliasPath = normalizePathSeparators(resolve(aliasResolveDir, alias.specifier))
              }
              else if (resolutionScope) {
                const packageRelativePath = normalizedSpecifier.slice(resolutionScope.length)
                const parsedPackageJson: unknown = JSON.parse(await readFile(resolve(resolutionScope, "package.json"), "utf8"))
                if (!isPlainObject(parsedPackageJson)) return
                const packageJson = parsedPackageJson
                if (packageJson.exports === undefined && !alias.prefix) {
                  const resolvedCandidate = await resolveWithContext(alias.specifier)
                  if (isFileResolution(resolvedCandidate) && normalizePathSeparators(resolve(resolvedCandidate.id)) === normalizedSpecifier) {
                    return { canonical: alias.specifier, normalized: alias.specifier, publicSpecifier: alias.specifier }
                  }
                  return
                }
                const matchingPublicSpecifiers = new Set<string>()
                for (const publicSpecifier of collectPackageExportCandidates(packageName, packageJson.exports, packageRelativePath)) {
                  const resolvedCandidate = await resolveWithContext(publicSpecifier)
                  if (!isFileResolution(resolvedCandidate)) continue
                  const candidatePath = normalizePathSeparators(resolve(resolvedCandidate.id))
                  if (candidatePath !== normalizedSpecifier) continue
                  matchingPublicSpecifiers.add(publicSpecifier)
                }
                if (matchingPublicSpecifiers.size === 1) {
                  const publicSpecifier = [...matchingPublicSpecifiers][0]!
                  if (alias.prefix ? publicSpecifier.startsWith(alias.specifier) : publicSpecifier === alias.specifier) {
                    return { canonical: publicSpecifier, normalized: publicSpecifier, publicSpecifier }
                  }
                }
                return
              }
              else {
                const resolvedAlias = await resolveWithContext(alias.specifier)
                if (!isFileResolution(resolvedAlias)) return
                resolvedAliasPath = normalizePathSeparators(resolve(resolvedAlias.id))
              }
              const canonicalAliasPath = normalizePathSeparators(await realpath(resolvedAliasPath).catch(() => resolvedAliasPath))
              return {
                canonical: `${canonicalAliasPath}${alias.prefix && !canonicalAliasPath.endsWith("/") ? "/" : ""}`,
                normalized: `${resolvedAliasPath}${alias.prefix && !resolvedAliasPath.endsWith("/") ? "/" : ""}`,
              }
            })()
            if (cacheable) resolvedBareAliasPaths.set(cacheKey, resolution)
          }
          candidates.push({ alias, resolution })
        }
        // The loop below stops at the first match, so settle every resolution before it reads them in order.
        await Promise.allSettled(candidates.map(candidate => candidate.resolution))
        for (const { alias, resolution } of candidates) {
          const paths = await resolution
          if (!paths) continue
          if (paths.publicSpecifier) {
            match = alias
            matchedAlias = alias.specifier
            matchedSpecifier = paths.publicSpecifier
            break
          }
          const normalizedMatch = alias.prefix
            ? normalizedSpecifier.startsWith(paths.normalized)
            : normalizedSpecifier === paths.normalized
          let canonicalMatch = false
          if (!normalizedMatch && paths.canonical !== paths.normalized) {
            await canonicalizeSpecifier()
            canonicalMatch = alias.prefix
              ? canonicalSpecifier.startsWith(paths.canonical)
              : canonicalSpecifier === paths.canonical
          }
          if (normalizedMatch || canonicalMatch) {
            match = alias
            matchedAlias = alias.prefix ? (canonicalMatch ? paths.canonical : paths.normalized) : alias.specifier
            matchedSpecifier = alias.prefix ? (canonicalMatch ? canonicalSpecifier : normalizedSpecifier) : alias.specifier
            break
          }
        }
      }
      matchedAlias ||= match && canonicalSpecifier.startsWith(match.canonicalSpecifier)
        ? match.canonicalSpecifier
        : match?.specifier
      matchedSpecifier ||= matchedAlias === match?.canonicalSpecifier ? canonicalSpecifier : normalizedSpecifier
      if (!match) return
      const target = match.prefix
        ? matchedSpecifier.replace(matchedAlias!.slice(0, -1), match.replacement.slice(0, -1))
        : matchedSpecifier.replace(matchedAlias!, match.replacement)
      if (!target) return
      const resolvedTarget = isRelativeSpecifier(target) ? resolve(aliasResolveDir, target) : target
      const resolved = await resolveWithContext(resolvedTarget)
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(resolvedTarget)}, the alias of ${JSON.stringify(source)}.`)
      return resolved
    },
  }
}

function createViteAliasPlugin(aliases: BundleEsmEntryOptions["alias"], workingDir: string): Plugin | undefined {
  if (!Array.isArray(aliases)) return
  return {
    name: "vitehub-vite-alias",
    async resolveId(source, importer, extra) {
      if (extra.custom?.[resolvingViteAlias]) return
      const alias = aliases.find(({ find }) => {
        if (typeof find === "string") return source === find || source.startsWith(`${find}/`)
        find.lastIndex = 0
        return find.test(source)
      })
      if (!alias) return
      if (alias.customResolver) {
        this.error(`[vitehub] Deno Schedule output cannot stage the Vite alias ${JSON.stringify(source)} because it uses customResolver.`)
      }
      if (alias.find instanceof RegExp) alias.find.lastIndex = 0
      const replacement = typeof alias.find === "string"
        ? `${alias.replacement}${source.slice(alias.find.length)}`
        : source.replace(alias.find, alias.replacement)
      const resolved = await resolveFrom(this, replacement, { custom: extra.custom, importer, isEntry: extra.isEntry, kind: extra.kind }, workingDir, resolvingViteAlias)
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(replacement)}, the alias of ${JSON.stringify(source)}.`)
      return resolved
    },
  }
}

function parseMarkdownTemplateRequest(id: string): { path: string } | undefined {
  if (id.includes("#")) return
  const queryIndex = id.indexOf("?")
  const path = id.split("?", 1)[0]!
  if (queryIndex === -1) return path.endsWith(markdownTemplateFileSuffix) ? { path } : undefined
  const query = id.slice(queryIndex + 1)
  if (query !== markdownTemplateModuleQuery) return
  return { path }
}

function renderMarkdownTemplateModule(template: string): string {
  return [
    `import { renderMarkdownTemplate as vitehubRenderMarkdownTemplate } from ${JSON.stringify(markdownTemplateRuntimeSpecifier)}`,
    `const vitehubMarkdownTemplate = ${JSON.stringify(template)}`,
    "export default function render(data = {}) {",
    "  return vitehubRenderMarkdownTemplate(vitehubMarkdownTemplate, { data })",
    "}",
    "",
  ].join("\n")
}

function hasViteRawQuery(path: string): boolean {
  const queryIndex = path.indexOf("?")
  return queryIndex !== -1 && /(?:^|&)raw(?:&|$)/.test(path.slice(queryIndex + 1))
}

async function resolveViteRawSpecifier(path: string, rootDir: string | undefined): Promise<string> {
  if (path.startsWith("/@fs/")) return path.slice("/@fs/".length)
  if (!rootDir || !path.startsWith("/")) return path

  const rootRelativePath = path.slice(1)
  const publicPath = resolve(rootDir, "public", rootRelativePath)
  try {
    await stat(publicPath)
    return publicPath
  }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    return resolve(rootDir, rootRelativePath)
  }
}

function createViteRawPlugin(rootDir: string | undefined, frameworkRuntime: boolean, workingDir: string): Plugin {
  return {
    name: "vitehub-vite-raw",
    async resolveId(source, importer, extra) {
      if (source === markdownTemplateRuntimeSpecifier && importer?.startsWith(markdownTemplatePrefix)) {
        if (!frameworkRuntime) return fileURLToPath(import.meta.resolve(markdownTemplateRuntimeSpecifier))
        return await this.resolve("vite-hub/markdown-template", importer.slice(markdownTemplatePrefix.length), { kind: extra.kind })
      }
      if (extra.custom?.[skipMarkdownTemplateResolve]) return
      const markdownTemplate = parseMarkdownTemplateRequest(source)
      const raw = hasViteRawQuery(source)
      if (!markdownTemplate && !raw) return
      const path = markdownTemplate?.path ?? source.slice(0, source.indexOf("?"))
      const specifier = await resolveViteRawSpecifier(path, rootDir)
      const resolved = await resolveFrom(this, specifier, { custom: extra.custom, importer, isEntry: extra.isEntry, kind: extra.kind }, workingDir, skipMarkdownTemplateResolve)
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(specifier)}, imported as ${JSON.stringify(source)}.`)
      if (resolved.external) return { id: resolved.id, external: resolved.external }
      const resolvedId = resolved.id
      if (!isFileResolution(resolved)) {
        this.error(markdownTemplate
          ? `[vitehub] Markdown template fallback cannot load ${JSON.stringify(source)} from the virtual module ${JSON.stringify(resolvedId)}. Handle this template import in a caller plugin.`
          : `[vitehub] Vite raw fallback cannot load ${JSON.stringify(source)} from the virtual module ${JSON.stringify(resolvedId)}. Handle this raw import in a caller plugin.`)
      }
      return `${markdownTemplate ? markdownTemplatePrefix : viteRawPrefix}${resolvedId}`
    },
    async load(id) {
      if (id.startsWith(viteRawPrefix)) return { code: await readFile(id.slice(viteRawPrefix.length), "utf8"), moduleType: "text" }
      if (id.startsWith(markdownTemplatePrefix)) {
        return { code: renderMarkdownTemplateModule(await readFile(id.slice(markdownTemplatePrefix.length), "utf8")), moduleType: "js" }
      }
    },
  }
}

function createFileUrlPlugin(): Plugin {
  return {
    name: "vitehub-file-url",
    resolveId(source) {
      if (source.startsWith("file:")) return fileURLToPath(source)
    },
  }
}

/**
 * Copies a `.wasm?module` import next to the bundle and keeps it as a relative `.wasm` import. Wrangler and Nitro load
 * such an import as a compiled WebAssembly module, which Workers need because they can't compile WebAssembly bytes.
 * Node.js compiles WebAssembly bytes, so there the import becomes the bytes of the file.
 */
function createWasmModulePlugin(outdir: string, workingDir: string, copy: boolean): Plugin {
  return {
    name: "vitehub-wasm-module",
    async resolveId(source, importer, extra) {
      if (!source.endsWith(".wasm?module")) return
      const resolved = await this.resolve(source.slice(0, -"?module".length), importerFor(importer, workingDir), { custom: extra.custom, kind: extra.kind })
      if (!isFileResolution(resolved)) this.error(`[vitehub] Could not resolve ${JSON.stringify(source)}.`)
      if (!copy) return resolved.id
      const bytes = await readFile(resolved.id)
      const name = `${basename(resolved.id, ".wasm")}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.wasm`
      await mkdir(outdir, { recursive: true })
      await copyFile(resolved.id, join(outdir, name))
      return { id: `./${name}`, external: true }
    },
  }
}

/**
 * Leaves package imports external. Resolve package.json import mappings first, and preserve unmapped host imports.
 */
function createExternalPackagesPlugin(): Plugin {
  return {
    name: "vitehub-external-packages",
    async resolveId(source, importer, extra) {
      if (source.startsWith("npm:") || source.startsWith("jsr:")) return { id: source, external: true }
      if (source.startsWith("#")) {
        return await this.resolve(source, importer, { custom: extra.custom, kind: extra.kind }) ?? { id: source, external: true }
      }
      if (isBareSpecifier(source) && !isBuiltin(source)) return { id: source, external: true }
    },
  }
}

function hasImportRejectionHandler(importNode: Node, parents: WeakMap<Node, Node>): boolean {
  let expression = importNode
  let parent = parents.get(expression)
  while (parent?.type === "MemberExpression" && parent.object === expression) {
    const call = parents.get(parent)
    if (call?.type !== "CallExpression" || call.callee !== parent) break
    const method = parent.property.type === "Identifier" && !parent.computed ? parent.property.name
      : parent.property.type === "Literal" ? parent.property.value : undefined
    const handler = call.arguments[method === "then" ? 1 : 0]
    if ((method === "then" || method === "catch") && handler && handler.type !== "SpreadElement") {
      if (handler.type !== "Literal" && !(handler.type === "Identifier" && handler.name === "undefined")) return true
    }
    if (method !== "then" && method !== "finally") break
    expression = call
    parent = parents.get(expression)
  }
  if (parent?.type !== "AwaitExpression") return false
  for (let child: Node = parent, ancestor = parents.get(child); ancestor; ancestor = parents.get(child)) {
    if (ancestor.type === "TryStatement" && ancestor.block === child && ancestor.handler) return true
    if (ancestor.type === "ArrowFunctionExpression" || ancestor.type === "FunctionExpression" || ancestor.type === "FunctionDeclaration") break
    child = ancestor
  }
  return false
}

function createOptionalImportPlugin(): Plugin {
  const prefix = "\0vitehub-optional-import:"
  return {
    name: "vitehub-optional-import",
    resolveId(source) {
      if (source.startsWith(prefix)) return { id: source.slice(prefix.length), external: "absolute" }
    },
    transform: {
      order: "post",
      filter: { code: /\bimport\s*(?:\(|\/)/ },
      async handler(code, id) {
        const { scanModule, walk } = await import("./scan-module.ts")
        const module = scanModule(code, id)
        if (module.errors.length) return
        const parents = new WeakMap<Node, Node>()
        const handled: { source: string, start: number, end: number }[] = []
        walk(module.program, (node, parent) => {
          if (parent) parents.set(node, parent)
          if (node.type !== "ImportExpression" || node.source.type !== "Literal" || typeof node.source.value !== "string") return
          if (hasImportRejectionHandler(node, parents)) handled.push({ source: node.source.value, start: node.source.start, end: node.source.end })
        })
        if (!handled.length) return
        const resolved = await Promise.all(handled.map(({ source }) => this.resolve(source, id, { kind: "dynamic-import" })))
        for (const [index, { source, start, end }] of [...handled.entries()].reverse()) {
          if (!resolved[index]) code = code.slice(0, start) + JSON.stringify(prefix + source) + code.slice(end)
        }
        return code
      },
    },
  }
}

/** Matches import paths as esbuild's `external` does: `*` is a wildcard, and a package name also matches its subpaths. */
function createExternalMatcher(patterns: string[] | undefined): ((id: string) => boolean) | undefined {
  if (!patterns?.length) return
  const matchers = patterns.map((pattern) => {
    if (pattern.includes("*")) {
      const expression = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`)
      return (id: string) => expression.test(id)
    }
    return isBareSpecifier(pattern)
      ? (id: string) => id === pattern || id.startsWith(`${pattern}/`)
      : (id: string) => id === pattern
  })
  return id => matchers.some(matches => matches(id))
}

export async function bundleEsmEntry(
  entryFile: string,
  outfile: string,
  options: BundleEsmEntryOptions = {},
): Promise<void> {
  // Load Rolldown when an entry is bundled, so code that only imports these helpers does not load it.
  const { rolldown } = await importRolldown()
  options.signal?.throwIfAborted()
  const format = options.format || "esm"
  const platform = options.platform || "neutral"
  const workingDir = options.workingDir ?? process.cwd()
  const aliasSpecifiers = Array.isArray(options.alias)
    ? options.alias.flatMap(alias => typeof alias.find === "string" ? [alias.find] : [])
    : Object.keys(options.alias || {})
  const frameworkRuntime = aliasSpecifiers.some(specifier => specifier === "vite-hub" || specifier.startsWith("vite-hub/"))
  const plugins: Plugin[] = []
  plugins.push(createWasmModulePlugin(dirname(outfile), workingDir, platform !== "node"))
  const resolvedAliasPlugin = createResolvedAliasPlugin(
    Array.isArray(options.alias) ? undefined : options.alias,
    options.workingDir ?? options.rootDir ?? process.cwd(),
    workingDir,
    options.resolveEntryPackageAliases,
  )
  if (resolvedAliasPlugin) plugins.push(resolvedAliasPlugin)
  plugins.push(...(options.plugins ?? []), createFileUrlPlugin())
  const viteAliasPlugin = createViteAliasPlugin(options.alias, workingDir)
  if (viteAliasPlugin) plugins.push(viteAliasPlugin)
  plugins.push(createViteRawPlugin(options.rootDir, frameworkRuntime, workingDir))
  if (options.packages === "external") plugins.push(createExternalPackagesPlugin())
  plugins.push(createOptionalImportPlugin())
  const isExternal = createExternalMatcher(options.external)
  const minify = options.minifyIdentifiers || options.minifySyntax || options.minifyWhitespace
    ? {
        compress: options.minifySyntax ?? false,
        mangle: options.minifyIdentifiers ? { toplevel: true } : false,
        codegen: { removeWhitespace: options.minifyWhitespace ?? false },
      }
    : false
  const banner = [
    options.banner,
    ...(format === "esm" && platform === "node" ? [
      "if (globalThis.process?.getBuiltinModule && import.meta.url) {",
      '  globalThis.require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      '  globalThis.__filename = globalThis.process.getBuiltinModule("node:url").fileURLToPath(import.meta.url);',
      '  globalThis.__dirname = globalThis.process.getBuiltinModule("node:path").dirname(globalThis.__filename);',
      "}",
    ] : []),
  ].filter(Boolean).join("\n")

  const bundle = await rolldown({
    cwd: workingDir,
    external: isExternal ? id => isExternal(id) : undefined,
    input: entryFile,
    // Rolldown keeps an import that it cannot resolve as an import and only warns. The bundle would fail when it runs,
    // so stop the build, as esbuild did. Other warnings stay silent.
    onLog(level, log) {
      if (log.code === "UNRESOLVED_IMPORT") throw Object.assign(new Error(log.message), { code: log.code })
    },
    // On Node.js, a WASM import becomes its bytes, and packages such as @vite-hub/shell compile them.
    moduleTypes: platform === "node" ? { ".wasm": "binary" } : undefined,
    platform,
    plugins,
    resolve: {
      conditionNames: options.conditions ?? (platform === "node" ? ["node"] : undefined),
      extensions: options.extensions,
      mainFields: options.mainFields ?? (platform === "neutral" ? ["module", "main"] : undefined),
      symlinks: !options.preserveSymlinks,
    },
    transform: { define: options.define, target: "es2022" },
  })
  let output: Rolldown.RolldownOutput["output"]
  try {
    output = (await bundle.generate({
      banner: banner || undefined,
      codeSplitting: false,
      format,
      // Syntax and identifier minification can change function and class names.
      keepNames: options.keepNames ?? Boolean(options.minifySyntax || options.minifyIdentifiers),
      minify,
      // The banner defines `require` for Node.js, as esbuild did, so the bundle needs no `createRequire` import.
      polyfillRequire: !(format === "esm" && platform === "node"),
      sourcemap: false,
    })).output
  }
  finally {
    await bundle.close()
  }
  options.signal?.throwIfAborted()
  // Code splitting is off, so the entry is the only chunk.
  const chunk = output.find(file => file.type === "chunk")!
  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, chunk.code, { signal: options.signal })
  options.signal?.throwIfAborted()
}
