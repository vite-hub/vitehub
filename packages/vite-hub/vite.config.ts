import { defineConfig } from "vite-plus"

import frameworkPackageManifest from "./package.json" with { type: "json" }

const distributionEntries = [...new Set(
  [
    ...Object.values(frameworkPackageManifest.exports),
    ...Object.values(frameworkPackageManifest.bin),
  ]
    .filter(target => target.startsWith("./dist/"))
    .map(target => target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")),
)].sort()

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["vite", /^@vite-hub\//],
      onlyBundle: false,
    },
    plugins: [{
      name: "vite-hub-env-config-declarations",
      generateBundle(_options, bundle) {
        const chunk = bundle["index.d.ts"]
        if (chunk?.type === "chunk") chunk.code = `import "@vite-hub/env/vite";\n${chunk.code}`
      },
    }],
    entry: distributionEntries,
    exports: {
      exclude: ["bin"],
      bin: {
        "vite-hub": "src/bin.ts",
        vitehub: "src/bin.ts",
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
