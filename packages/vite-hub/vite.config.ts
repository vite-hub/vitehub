import { defineConfig } from "vite-plus"

import frameworkPackageManifest from "./package.json" with { type: "json" }

function manifestStringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(manifestStringLeaves)
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(manifestStringLeaves)
}

export function distributionEntriesFromManifest(value: unknown): string[] {
  return [...new Set(
    manifestStringLeaves(value)
      .filter(target => target.startsWith("./dist/") && target.endsWith(".js"))
      .map(target => target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")),
  )].sort()
}

export const distributionBinEntries = Object.fromEntries(
  Object.entries(frameworkPackageManifest.bin).map(([name, target]) => {
    const [entry] = distributionEntriesFromManifest(target)
    if (!entry) throw new TypeError(`Unsupported ViteHub binary target: ${target}`)
    return [name, entry]
  }),
)

const distributionEntries = distributionEntriesFromManifest([
  frameworkPackageManifest.exports,
  frameworkPackageManifest.bin,
])

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [
      { from: "src/cloudflare-prerender.mjs", to: "dist" },
      { from: "templates/cloudflare-types.d.ts", to: "dist" },
    ],
    deps: {
      neverBundle: ["vite", /^@vite-hub\/(?!internal(?:\/|$))/],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    plugins: [{
      name: "vite-hub-env-config-declarations",
      generateBundle(_options, bundle) {
        for (const file of ["index.d.ts", "env.d.ts"]) {
          const chunk = bundle[file]
          if (chunk?.type === "chunk") chunk.code = `import "@vite-hub/env/vite";\n${chunk.code}`
        }
      },
    }],
    entry: distributionEntries,
    exports: {
      exclude: ["bin"],
      bin: distributionBinEntries,
      customExports: {
        "./tsconfig": "./tsconfig.json",
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
