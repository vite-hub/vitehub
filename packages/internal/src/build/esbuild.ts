import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build as bundle, type Plugin } from "esbuild"

import { isPlainObject } from "../object.ts"

interface BundleEsmEntryOptions {
  alias?: Record<string, string> | ViteAlias[]
  banner?: string
  conditions?: string[]
  extensions?: string[]
  external?: string[]
  format?: "esm" | "cjs"
  mainFields?: string[]
  minifyIdentifiers?: boolean
  minifyWhitespace?: boolean
  packages?: "bundle" | "external"
  platform?: "browser" | "node" | "neutral"
  plugins?: Plugin[]
  preserveSymlinks?: boolean
  rootDir?: string
  signal?: AbortSignal
  workingDir?: string
}

export interface ViteAlias {
  customResolver?: boolean
  find: string | RegExp
  replacement: string
}

const viteRawNamespace = "vitehub-vite-raw"
const skipResolvedAlias = "vitehubSkipResolvedAlias"
const encodedAliasPrefixMarker = "\0vitehub-prefix:"
const encodedAliasExactMarker = "\0vitehub-exact:"

interface StringAlias {
  find: string | RegExp
  replacement: string
}

export function encodeProviderOutputAliases(configAliases: readonly StringAlias[]): Record<string, string> {
  const aliases: Record<string, string> = Object.create(null)
  for (const [index, alias] of configAliases.entries()) {
    if (alias.find instanceof RegExp) continue
    const exactSpecifier = Object.hasOwn(aliases, alias.find) ? `${alias.find}${encodedAliasExactMarker}${index}` : alias.find
    aliases[exactSpecifier] = alias.replacement
    if (alias.find.endsWith("/")) {
      const prefixSpecifier = `${alias.find}/${encodedAliasPrefixMarker}${index}`
      aliases[prefixSpecifier] = `${alias.replacement.replace(/\/$/, "")}/`
    }
    else {
      aliases[`${alias.find}/${encodedAliasPrefixMarker}${index}`] = `${alias.replacement.replace(/\/$/, "")}/`
    }
  }
  return aliases
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function collectPackageExportCandidates(packageName: string, exportsValue: unknown, packageRelativePath: string): string[] {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Package exports are untrusted JSON and string targets are the domain values consumed here.
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Package exports are untrusted JSON and string targets are the domain values consumed here.
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

function createResolvedAliasPlugin(aliases: Record<string, string> | undefined, aliasResolveDir: string): Plugin | undefined {
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
  return {
    name: "vitehub-resolved-alias",
    setup(build) {
      const resolvedBareAliasPaths = new Map<string, Promise<{ canonical: string, normalized: string, publicSpecifier?: string } | undefined>>()
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[skipResolvedAlias]) return
        const aliases = await resolvedEntries
        let match = aliases.find(({ prefix, specifier }) => /^\.\.?[\\/]/.test(specifier) && (prefix
          ? args.path.startsWith(specifier)
          : args.path === specifier))
        let matchedAlias = match?.specifier
        let matchedSpecifier = match ? args.path : undefined
        let specifier = args.resolveDir && /^\.\.?[\\/]/.test(args.path)
          ? resolve(args.resolveDir, args.path)
          : args.path
        let normalizedSpecifier = isAbsolute(specifier) ? normalizePathSeparators(resolve(specifier)) : specifier
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
        if (!match && isAbsolute(args.path)) {
          for (const alias of aliases) {
            if (isAbsolute(alias.specifier)) continue
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
              args.importer,
              args.resolveDir,
              args.kind,
              args.namespace,
              JSON.stringify(args.with),
            ].join("\0")
            // pluginData is opaque resolver-owned state, so it cannot be represented
            // safely in a stable cache key.
            let resolution = args.pluginData ? undefined : resolvedBareAliasPaths.get(cacheKey)
            if (!resolution) {
              resolution = (async () => {
                let resolvedAliasPath: string
                if (alias.prefix && /^\.\.?[\\/]/.test(alias.specifier)) {
                  resolvedAliasPath = normalizePathSeparators(resolve(aliasResolveDir, alias.specifier))
                }
                else if (resolutionScope) {
                  const packageRelativePath = normalizedSpecifier.slice(resolutionScope.length)
                  const parsedPackageJson: unknown = JSON.parse(await readFile(resolve(resolutionScope, "package.json"), "utf8"))
                  if (!isPlainObject(parsedPackageJson)) return
                  const packageJson = parsedPackageJson
                  if (packageJson.exports === undefined && !alias.prefix) {
                    const resolvedCandidate = await build.resolve(alias.specifier, {
                      importer: args.importer,
                      kind: args.kind,
                      namespace: args.namespace,
                      pluginData: { ...args.pluginData, [skipResolvedAlias]: true },
                      resolveDir: args.resolveDir,
                      with: args.with,
                    })
                    if (!resolvedCandidate.errors.length && !resolvedCandidate.external && resolvedCandidate.namespace === "file"
                      && normalizePathSeparators(resolve(resolvedCandidate.path)) === normalizedSpecifier) {
                      return { canonical: alias.specifier, normalized: alias.specifier, publicSpecifier: alias.specifier }
                    }
                    return
                  }
                  const matchingPublicSpecifiers = new Set<string>()
                  for (const publicSpecifier of collectPackageExportCandidates(packageName, packageJson.exports, packageRelativePath)) {
                    const resolvedCandidate = await build.resolve(publicSpecifier, {
                      importer: args.importer,
                      kind: args.kind,
                      namespace: args.namespace,
                      pluginData: { ...args.pluginData, [skipResolvedAlias]: true },
                      resolveDir: args.resolveDir,
                      with: args.with,
                    })
                    if (resolvedCandidate.errors.length || resolvedCandidate.external || resolvedCandidate.namespace !== "file") continue
                    const candidatePath = normalizePathSeparators(resolve(resolvedCandidate.path))
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
                  const resolvedAlias = await build.resolve(alias.specifier, {
                    importer: args.importer,
                    kind: args.kind,
                    namespace: args.namespace,
                    pluginData: { ...args.pluginData, [skipResolvedAlias]: true },
                    resolveDir: args.resolveDir,
                    with: args.with,
                  })
                  if (resolvedAlias.errors.length || resolvedAlias.external || resolvedAlias.namespace !== "file") return
                  resolvedAliasPath = normalizePathSeparators(resolve(resolvedAlias.path))
                }
                const canonicalAliasPath = normalizePathSeparators(await realpath(resolvedAliasPath).catch(() => resolvedAliasPath))
                return {
                  canonical: `${canonicalAliasPath}${alias.prefix && !canonicalAliasPath.endsWith("/") ? "/" : ""}`,
                  normalized: `${resolvedAliasPath}${alias.prefix && !resolvedAliasPath.endsWith("/") ? "/" : ""}`,
                }
              })()
              if (!args.pluginData) resolvedBareAliasPaths.set(cacheKey, resolution)
            }
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
        const target = match?.prefix
          ? matchedSpecifier.replace(matchedAlias!.slice(0, -1), match.replacement.slice(0, -1))
          : matchedSpecifier.replace(matchedAlias!, match?.replacement ?? "")
        if (!target) return
        const resolvedTarget = /^\.\.?[\\/]/.test(target) ? resolve(aliasResolveDir, target) : target
        return build.resolve(resolvedTarget, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: { ...args.pluginData, [skipResolvedAlias]: true },
          resolveDir: args.resolveDir,
          with: args.with,
        })
      })
    },
  }
}

function createViteAliasPlugin(aliases: BundleEsmEntryOptions["alias"]): Plugin | undefined {
  if (!Array.isArray(aliases)) return
  const resolvingAlias = "vitehubResolvingAlias"
  return {
    name: "vitehub-vite-alias",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[resolvingAlias]) return
        const alias = aliases.find(({ find }) => {
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- ViteAlias.find is an untagged string-or-RegExp union at this adapter boundary.
          if (typeof find === "string") return args.path === find || args.path.startsWith(`${find}/`)
          find.lastIndex = 0
          return find.test(args.path)
        })
        if (!alias) return
        if (alias.customResolver) {
          return {
            errors: [{ text: `[vitehub] Deno Schedule output cannot stage the Vite alias ${JSON.stringify(args.path)} because it uses customResolver.` }],
          }
        }
        if (alias.find instanceof RegExp) alias.find.lastIndex = 0
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- ViteAlias.find is an untagged string-or-RegExp union at this adapter boundary.
        const replacement = typeof alias.find === "string"
          ? `${alias.replacement}${args.path.slice(alias.find.length)}`
          : args.path.replace(alias.find, alias.replacement)
        const result = await build.resolve(replacement, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: Object.assign(
            {},
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- esbuild exposes pluginData as unknown, and this boundary preserves only object-shaped metadata.
            args.pluginData && typeof args.pluginData === "object" ? args.pluginData : {},
            { [resolvingAlias]: true },
          ),
          resolveDir: args.resolveDir,
          with: args.with,
        })
        const pluginData = Object.assign({}, result.pluginData)
        Reflect.deleteProperty(pluginData, resolvingAlias)
        return { ...result, pluginData }
      })
    },
  }
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

function createViteRawPlugin(rootDir: string | undefined): Plugin {
  return {
    name: "vitehub-vite-raw",
    setup(build) {
      build.onResolve({ filter: /\?/ }, async (args) => {
        if (!hasViteRawQuery(args.path)) return
        const path = args.path.slice(0, args.path.indexOf("?"))
        const specifier = await resolveViteRawSpecifier(path, rootDir)
        const resolved = await build.resolve(specifier, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: args.pluginData,
          resolveDir: args.resolveDir,
          with: args.with,
        })
        if (resolved.errors.length) return { errors: resolved.errors, warnings: resolved.warnings }
        if (resolved.external) {
          return {
            external: true,
            namespace: resolved.namespace,
            path: resolved.path,
            pluginData: resolved.pluginData,
            sideEffects: resolved.sideEffects,
            suffix: resolved.suffix,
            warnings: resolved.warnings,
          }
        }
        if (resolved.namespace !== "file") {
          return {
            errors: [{ text: `[vitehub] Vite raw fallback cannot load ${JSON.stringify(args.path)} from the ${JSON.stringify(resolved.namespace)} namespace. Handle this raw import in a caller plugin.` }],
            warnings: resolved.warnings,
          }
        }
        return {
          namespace: viteRawNamespace,
          path: resolved.path,
          pluginData: resolved.pluginData,
          sideEffects: resolved.sideEffects,
          suffix: resolved.suffix,
          warnings: resolved.warnings,
        }
      })
      build.onLoad({ filter: /.*/, namespace: viteRawNamespace }, async args => ({
        contents: await readFile(args.path),
        loader: "text",
      }))
    },
  }
}

function createFileUrlPlugin(): Plugin {
  return {
    name: "vitehub-file-url",
    setup(build) {
      build.onResolve({ filter: /^file:/ }, args => ({ path: fileURLToPath(args.path) }))
    },
  }
}

export async function bundleEsmEntry(
  entryFile: string,
  outfile: string,
  options: BundleEsmEntryOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted()
  const format = options.format || "esm"
  const platform = options.platform || "neutral"
  const viteAliasPlugin = createViteAliasPlugin(options.alias)
  const plugins: Plugin[] = []
  const resolvedAliasPlugin = createResolvedAliasPlugin(
    Array.isArray(options.alias) ? undefined : options.alias,
    options.workingDir ?? options.rootDir ?? process.cwd(),
  )
  if (resolvedAliasPlugin) plugins.push(resolvedAliasPlugin)
  plugins.push(...(options.plugins ?? []), createFileUrlPlugin())
  if (viteAliasPlugin) plugins.push(viteAliasPlugin)
  plugins.push(createViteRawPlugin(options.rootDir))

  const result = await bundle({
    absWorkingDir: options.workingDir,
    banner: options.banner || (format === "esm" && platform === "node")
      ? {
          js: [
            options.banner,
            ...(format === "esm" && platform === "node" ? [
              "if (globalThis.process?.getBuiltinModule && import.meta.url) {",
              '  globalThis.require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);',
              '  globalThis.__filename = globalThis.process.getBuiltinModule("node:url").fileURLToPath(import.meta.url);',
              '  globalThis.__dirname = globalThis.process.getBuiltinModule("node:path").dirname(globalThis.__filename);',
              "}",
            ] : []),
          ].filter(Boolean).join("\n"),
        }
      : undefined,
    bundle: true,
    conditions: options.conditions ?? (platform === "node" ? ["node"] : undefined),
    entryPoints: [entryFile],
    external: options.external,
    format,
    logLevel: "silent",
    mainFields: options.mainFields ?? (platform === "neutral" ? ["module", "main"] : undefined),
    resolveExtensions: options.extensions,
    minifyIdentifiers: options.minifyIdentifiers,
    minifyWhitespace: options.minifyWhitespace,
    outfile,
    packages: options.packages,
    platform,
    preserveSymlinks: options.preserveSymlinks,
    plugins,
    sourcemap: false,
    target: "es2022",
    write: options.signal ? false : true,
  })
  options.signal?.throwIfAborted()
  if (options.signal) {
    await Promise.all((result.outputFiles ?? []).map(async (output) => {
      await mkdir(dirname(output.path), { recursive: true })
      options.signal!.throwIfAborted()
      await writeFile(output.path, output.contents, { signal: options.signal })
    }))
    options.signal.throwIfAborted()
  }
}
