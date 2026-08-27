import { readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build as bundle, type Plugin } from "esbuild"

interface BundleEsmEntryOptions {
  alias?: Record<string, string>
  banner?: string
  conditions?: string[]
  external?: string[]
  format?: "esm" | "cjs"
  mainFields?: string[]
  minifyIdentifiers?: boolean
  minifyWhitespace?: boolean
  platform?: "browser" | "node" | "neutral"
  plugins?: Plugin[]
  rootDir?: string
  signal?: AbortSignal
  workingDir?: string
}

const viteRawNamespace = "vitehub-vite-raw"
const viteMarkdownTemplateNamespace = "vitehub-markdown-template"
const markdownTemplateFileSuffix = ".template.md"
const markdownTemplateModuleQuery = "markdown-template"
const skipMarkdownTemplateResolve = "vitehubSkipMarkdownTemplateResolve"
const markdownTemplateRuntimeSpecifier = "@vite-hub/markdown-template"

function resolveEsbuildAliases(aliases: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!aliases) return
  return Object.fromEntries(Object.entries(aliases).filter(([specifier]) => !specifier.endsWith("/")))
}

function stripMarkdownCode(template: string): string {
  let fence: { marker: string, length: number, listIndented: boolean } | undefined
  let inList = false
  let previousLineBlank = true
  return template.split("\n").map((line) => {
    const content = line.replace(/^(?: {0,3}> ?)+/, "")
    if (!fence) {
      const listIndented = inList && /^ {4}(?:`{3,}|~{3,})/.test(content)
      const opening = (listIndented ? content.slice(4) : content).match(/^ {0,3}(`{3,}|~{3,})/)
      if (!opening) {
        if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(content)) inList = true
        else if (content.trim() && !/^ {2,}/.test(content)) inList = false
        const indentedCode = (!inList && previousLineBlank && /^(?: {4}|\t)/.test(content))
          || (inList && previousLineBlank && /^(?: {8}| {4}\t|\t{2})/.test(content))
        previousLineBlank = content.trim() === ""
        return indentedCode ? "" : line
      }
      fence = { marker: opening[1]![0]!, length: opening[1]!.length, listIndented }
      previousLineBlank = false
      return ""
    }
    const closing = (fence.listIndented ? content.replace(/^ {4}/, "") : content).match(/^ {0,3}(`+|~+)\s*$/)?.[1]
    if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined
    previousLineBlank = false
    return ""
  }).join("\n")
}

function extractMarkdownTemplateImportSpecifiers(template: string): string[] {
  const visible = stripMarkdownCode(template)
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/(!?\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/^ {0,3}\[[^\]]+\]:\s*\S+/gm, "")
    .replace(/<[^>]*>/g, "")
  const specifiers = new Set<string>()
  for (const match of visible.matchAll(/@(\.\.?\/[^\s<>{}[\]]+)/g)) {
    const token = match[1]!
    const trailing = token.match(/[.,;:!?)]*$/)?.[0] || ""
    specifiers.add(token.slice(0, token.length - trailing.length))
  }
  return [...specifiers]
}

function parseMarkdownTemplateRequest(id: string): { path: string } | undefined {
  const queryIndex = id.indexOf("?")
  const path = id.split(/[?#]/, 1)[0]!
  if (queryIndex === -1) return path.endsWith(markdownTemplateFileSuffix) ? { path } : undefined
  const query = id.slice(queryIndex + 1).split("#", 1)[0]!
  if (!new URLSearchParams(query).has(markdownTemplateModuleQuery)) return
  return { path }
}

function renderMarkdownTemplateModule(template: string, sourceId?: string, imports: Record<string, { id: string, template: string }> = {}): string {
  return [
    `import { renderMarkdownTemplate as vitehubRenderMarkdownTemplate } from ${JSON.stringify(markdownTemplateRuntimeSpecifier)}`,
    `const vitehubMarkdownTemplate = ${JSON.stringify(template)}`,
    `const vitehubMarkdownTemplateSourceId = ${JSON.stringify(sourceId)}`,
    `const vitehubMarkdownTemplateImports = ${JSON.stringify(imports)}`,
    "export default function render(data = {}) {",
    "  return vitehubRenderMarkdownTemplate(vitehubMarkdownTemplate, { data, sourceId: vitehubMarkdownTemplateSourceId, resolveImport: (specifier, importer) => vitehubMarkdownTemplateImports[`${importer}\\0${specifier}`] })",
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return resolve(rootDir, rootRelativePath)
  }
}

function createViteRawPlugin(rootDir: string | undefined, frameworkRuntime: boolean): Plugin {
  return {
    name: "vitehub-vite-raw",
    setup(build) {
      build.onResolve({ filter: /^@vite-hub\/markdown-template$/, namespace: viteMarkdownTemplateNamespace }, async (args) => {
        if (!frameworkRuntime) return { path: fileURLToPath(import.meta.resolve(markdownTemplateRuntimeSpecifier)) }
        return build.resolve("vite-hub/_internal/markdown-template", {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
        })
      })
      build.onResolve({ filter: /\?|\.template\.md$/ }, async (args) => {
        if (args.pluginData?.[skipMarkdownTemplateResolve]) return
        const markdownTemplate = parseMarkdownTemplateRequest(args.path)
        const raw = hasViteRawQuery(args.path)
        if (!markdownTemplate && !raw) return
        const path = markdownTemplate?.path ?? args.path.slice(0, args.path.indexOf("?"))
        const specifier = await resolveViteRawSpecifier(path, rootDir)
        const resolved = await build.resolve(specifier, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: markdownTemplate
            ? {
                ...(args.pluginData && typeof args.pluginData === "object" ? args.pluginData : {}),
                [skipMarkdownTemplateResolve]: true,
              }
            : args.pluginData,
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
            errors: [{ text: markdownTemplate
              ? `[vitehub] Markdown template fallback cannot load ${JSON.stringify(args.path)} from the ${JSON.stringify(resolved.namespace)} namespace. Handle this template import in a caller plugin.`
              : `[vitehub] Vite raw fallback cannot load ${JSON.stringify(args.path)} from the ${JSON.stringify(resolved.namespace)} namespace. Handle this raw import in a caller plugin.` }],
            warnings: resolved.warnings,
          }
        }
        return {
          namespace: markdownTemplate ? viteMarkdownTemplateNamespace : viteRawNamespace,
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
      build.onLoad({ filter: /.*/, namespace: viteMarkdownTemplateNamespace }, async args => ({
        contents: await (async () => {
          const template = await readFile(args.path, "utf8")
          const imports: Record<string, { id: string, template: string }> = {}
          const visited = new Set([args.path])
          const visit = async (source: string, importer: string): Promise<void> => {
            for (const specifier of extractMarkdownTemplateImportSpecifiers(source)) {
              const key = `${importer}\0${specifier}`
              if (imports[key]) continue
              const resolved = await build.resolve(specifier, {
                importer,
                kind: "import-statement",
                pluginData: {
                  ...(args.pluginData && typeof args.pluginData === "object" ? args.pluginData : {}),
                  [skipMarkdownTemplateResolve]: true,
                },
                resolveDir: dirname(importer),
              })
              if (resolved.errors.length) return Promise.reject(new Error(resolved.errors.map(error => error.text).join("\n")))
              if (resolved.external || resolved.namespace !== "file") {
                throw new Error(`[vitehub] Could not resolve Markdown template import ${JSON.stringify(specifier)} from ${JSON.stringify(importer)} to a file.`)
              }
              const imported = { id: resolved.path, template: await readFile(resolved.path, "utf8") }
              imports[key] = imported
              if (!visited.has(imported.id)) {
                visited.add(imported.id)
                await visit(imported.template, imported.id)
              }
            }
          }
          await visit(template, args.path)
          return renderMarkdownTemplateModule(template, args.path, imports)
        })(),
        loader: "js",
        resolveDir: dirname(args.path),
      }))
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
  const aliases = resolveEsbuildAliases(options.alias)
  const frameworkRuntime = Object.keys(aliases || {}).some(specifier => specifier === "vite-hub" || specifier.startsWith("vite-hub/"))

  const result = await bundle({
    absWorkingDir: options.workingDir,
    alias: aliases,
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
    minifyIdentifiers: options.minifyIdentifiers,
    minifyWhitespace: options.minifyWhitespace,
    outfile,
    platform,
    plugins: [...(options.plugins ?? []), createViteRawPlugin(options.rootDir, frameworkRuntime)],
    sourcemap: false,
    target: "es2022",
    write: options.signal ? false : true,
  })
  options.signal?.throwIfAborted()
  if (options.signal) {
    await Promise.all((result.outputFiles ?? []).map(output => writeFile(output.path, output.contents, { signal: options.signal })))
    options.signal.throwIfAborted()
  }
}
