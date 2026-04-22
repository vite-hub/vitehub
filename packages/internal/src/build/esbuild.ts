import { build as bundle } from "esbuild"

export interface BundleEsmEntryOptions {
  alias?: Record<string, string>
  conditions?: string[]
  external?: string[]
  format?: "esm" | "cjs"
  platform?: "browser" | "node" | "neutral"
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
          js: 'import { createRequire as __createRequire } from "node:module";\nvar require = __createRequire(import.meta.url);\n',
        }
      : undefined,
    bundle: true,
    conditions: options.conditions,
    entryPoints: [entryFile],
    external: options.external,
    format,
    logLevel: "silent",
    outfile,
    platform,
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}
