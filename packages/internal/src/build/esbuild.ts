import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { Plugin } from "esbuild"

interface BundleEsbuildEntryOptions {
  define?: Record<string, string>
  extensions?: string[]
  external?: string[]
  format?: "esm" | "cjs"
  keepNames?: boolean
  platform?: "browser" | "node" | "neutral"
  plugins?: Plugin[]
  rootDir?: string
  tsconfig?: string
  tsconfigRaw?: string
  workingDir?: string
}

const viteRawNamespace = "vitehub-vite-raw"
const viteMarkdownTemplateNamespace = "vitehub-markdown-template"
const markdownTemplateFileSuffix = ".template.md"
const markdownTemplateModuleQuery = "markdown-template"
const skipMarkdownTemplateResolve = "vitehubSkipMarkdownTemplateResolve"
const markdownTemplateRuntimeSpecifier = "@vite-hub/markdown-template"

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

function createViteRawPlugin(rootDir: string | undefined): Plugin {
  return {
    name: "vitehub-vite-raw",
    setup(build) {
      build.onResolve({ filter: /^@vite-hub\/markdown-template$/, namespace: viteMarkdownTemplateNamespace }, () => {
        return { path: fileURLToPath(import.meta.resolve(markdownTemplateRuntimeSpecifier)) }
      })
      build.onResolve({ filter: /\?|\.template\.md$/ }, async (args) => {
        if (args.pluginData?.[skipMarkdownTemplateResolve]) return
        const markdownTemplate = parseMarkdownTemplateRequest(args.path)
        const raw = hasViteRawQuery(args.path)
        if (!markdownTemplate && !raw) return
        const path = markdownTemplate?.path ?? args.path.slice(0, args.path.indexOf("?"))
        const specifier = await resolveViteRawSpecifier(path, rootDir)
        let pluginData = args.pluginData
        if (markdownTemplate) {
          pluginData = {
            ...args.pluginData,
            [skipMarkdownTemplateResolve]: true,
          }
        }
        const resolved = await build.resolve(specifier, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          pluginData,
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
        contents: renderMarkdownTemplateModule(await readFile(args.path, "utf8")),
        loader: "js",
        resolveDir: dirname(args.path),
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

/**
 * Bundles with esbuild. Only the Workflow DevKit steps bundle uses it: Workflow DevKit ships its transforms as esbuild
 * plugins and installs esbuild itself. Every other bundle goes through `bundleEsmEntry` of `./rolldown.ts`.
 */
export async function bundleEsbuildEntry(
  entryFile: string,
  outfile: string,
  options: BundleEsbuildEntryOptions = {},
): Promise<void> {
  // Load esbuild when an entry is bundled, so code that only imports these helpers does not load it.
  const { build: bundle } = await import("esbuild")
  const format = options.format || "esm"
  const platform = options.platform || "neutral"
  await bundle({
    absWorkingDir: options.workingDir,
    banner: format === "esm" && platform === "node"
      ? {
          js: [
            "if (globalThis.process?.getBuiltinModule && import.meta.url) {",
            '  globalThis.require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);',
            '  globalThis.__filename = globalThis.process.getBuiltinModule("node:url").fileURLToPath(import.meta.url);',
            '  globalThis.__dirname = globalThis.process.getBuiltinModule("node:path").dirname(globalThis.__filename);',
            "}",
          ].join("\n"),
        }
      : undefined,
    bundle: true,
    conditions: platform === "node" ? ["node"] : undefined,
    define: options.define,
    entryPoints: [entryFile],
    external: options.external,
    format,
    keepNames: options.keepNames,
    // On Node.js, a WASM import becomes its bytes, and packages such as @vite-hub/shell compile them.
    loader: platform === "node" ? { ".wasm": "binary" } : undefined,
    logLevel: "silent",
    mainFields: platform === "neutral" ? ["module", "main"] : undefined,
    resolveExtensions: options.extensions,
    outfile,
    platform,
    plugins: [...(options.plugins ?? []), createFileUrlPlugin(), createViteRawPlugin(options.rootDir)],
    sourcemap: false,
    target: "es2022",
    tsconfig: options.tsconfig,
    tsconfigRaw: options.tsconfigRaw,
  })
}
