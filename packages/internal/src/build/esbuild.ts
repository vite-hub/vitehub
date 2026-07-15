import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseMarkdownTemplateRequest, renderMarkdownTemplateModule } from "@vite-hub/markdown-template/internal/vite"
import { build as bundle, type Plugin } from "esbuild"

interface BundleEsmEntryOptions {
  alias?: Record<string, string>
  conditions?: string[]
  external?: string[]
  format?: "esm" | "cjs"
  mainFields?: string[]
  minifyIdentifiers?: boolean
  platform?: "browser" | "node" | "neutral"
  plugins?: Plugin[]
  rootDir?: string
}

const viteRawNamespace = "vitehub-vite-raw"
const viteMarkdownTemplateNamespace = "vitehub-markdown-template"
const markdownTemplateRuntime = fileURLToPath(import.meta.resolve("@vite-hub/markdown-template"))

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

function createViteRawPlugin(rootDir: string | undefined): Plugin {
  return {
    name: "vitehub-vite-raw",
    setup(build) {
      build.onResolve({ filter: /\?/ }, async (args) => {
        const markdownTemplate = parseMarkdownTemplateRequest(args.path)
        const raw = hasViteRawQuery(args.path)
        if (!markdownTemplate && !raw) return
        const path = markdownTemplate?.path ?? args.path.slice(0, args.path.indexOf("?"))
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
      build.onResolve({ filter: /.*/, namespace: viteMarkdownTemplateNamespace }, (args) => {
        if (args.path === markdownTemplateRuntime) return { namespace: "file", path: args.path }
      })
      build.onLoad({ filter: /.*/, namespace: viteMarkdownTemplateNamespace }, async args => ({
        contents: renderMarkdownTemplateModule(await readFile(args.path, "utf8"), markdownTemplateRuntime),
        loader: "js",
      }))
    },
  }
}

export async function bundleEsmEntry(
  entryFile: string,
  outfile: string,
  options: BundleEsmEntryOptions = {},
): Promise<void> {
  const format = options.format || "esm"
  const platform = options.platform || "neutral"

  await bundle({
    alias: options.alias,
    banner: format === "esm" && platform === "node"
      ? {
          js: [
            'import { createRequire as __createRequire } from "node:module";',
            'import { dirname as __vitehubDirname } from "node:path";',
            'import { fileURLToPath as __vitehubFileURLToPath } from "node:url";',
            "globalThis.require = __createRequire(import.meta.url);",
            "globalThis.__filename = __vitehubFileURLToPath(import.meta.url);",
            "globalThis.__dirname = __vitehubDirname(globalThis.__filename);",
          ].join("\n"),
        }
      : undefined,
    bundle: true,
    conditions: options.conditions,
    entryPoints: [entryFile],
    external: options.external,
    format,
    logLevel: "silent",
    mainFields: options.mainFields ?? (platform === "neutral" ? ["module", "main"] : undefined),
    minifyIdentifiers: options.minifyIdentifiers,
    outfile,
    platform,
    plugins: [...(options.plugins ?? []), createViteRawPlugin(options.rootDir)],
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}
