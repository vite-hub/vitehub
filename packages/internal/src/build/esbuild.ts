import { readFile } from "node:fs/promises"

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
}

const viteRawNamespace = "vitehub-vite-raw"

function hasViteRawQuery(path: string): boolean {
  const queryIndex = path.indexOf("?")
  return queryIndex !== -1 && /(?:^|&)raw(?:&|$)/.test(path.slice(queryIndex + 1))
}

function createViteRawPlugin(): Plugin {
  return {
    name: "vitehub-vite-raw",
    setup(build) {
      build.onResolve({ filter: /\?/ }, async (args) => {
        if (!hasViteRawQuery(args.path)) return
        const path = args.path.slice(0, args.path.indexOf("?"))
        const resolved = await build.resolve(path, {
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
    plugins: [...(options.plugins ?? []), createViteRawPlugin()],
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}
