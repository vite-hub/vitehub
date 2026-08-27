import { defineConfig } from "vite-plus"
import * as v from "valibot"

import frameworkPackageManifest from "./package.json" with { type: "json" }

const manifestStringLeavesSchema: v.GenericSchema<unknown, string[]> = v.lazy(() => v.union([
  v.pipe(v.string(), v.transform(value => [value])),
  v.pipe(v.array(manifestStringLeavesSchema), v.transform(values => values.flat())),
  v.pipe(v.record(v.string(), manifestStringLeavesSchema), v.transform(value => Object.values(value).flat())),
]))

export function distributionEntriesFromManifest(value: unknown): string[] {
  return [...new Set(
    v.parse(manifestStringLeavesSchema, value)
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
      { from: ".vitehub/console", to: "dist/console/runtime/public" },
      {
        from: "src/console/runtime/components/console-back-button.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-app.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-frame.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-home.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-kv.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-mark.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-provider.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-search.vue",
        to: "dist/console/runtime/components",
      },
      { from: "src/console/runtime/pages/agents.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/index.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/kv.vue", to: "dist/console/runtime/pages" },
      { from: "../ui/styles.css", to: "dist/ui" },
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
    entry: [
      ...distributionEntries,
      "src/console/runtime/console-route.ts",
      "src/console/runtime/client/request.ts",
      "src/console/runtime/client/time.ts",
      "src/console/runtime/sections.ts",
      "src/console/runtime/server/agents.get.ts",
      "src/console/runtime/server/invocation.get.ts",
      "src/console/runtime/server/invocations.get.ts",
      "src/console/runtime/server/kv.get.ts",
      "src/console/runtime/server/page.get.ts",
      "src/console/runtime/server/search.get.ts",
      "src/console/runtime/server/sections.get.ts",
    ],
    exports: {
      exclude: ["bin"],
      bin: distributionBinEntries,
      customExports(exports) {
        delete exports["./console/runtime/console-route"]
        delete exports["./console/runtime/client/request"]
        delete exports["./console/runtime/client/time"]
        delete exports["./console/runtime/sections"]
        delete exports["./console/runtime/server/agents.get"]
        delete exports["./console/runtime/server/invocation.get"]
        delete exports["./console/runtime/server/invocations.get"]
        delete exports["./console/runtime/server/kv.get"]
        delete exports["./console/runtime/server/page.get"]
        delete exports["./console/runtime/server/search.get"]
        delete exports["./console/runtime/server/sections.get"]
        return {
          ...exports,
          "./ui/styles.css": "./dist/ui/styles.css",
          "./tsconfig": "./tsconfig.json",
        }
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
