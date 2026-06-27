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
    plugins: options.plugins,
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}
