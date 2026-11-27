import { rmSync } from "node:fs"
import { resolve } from "node:path"

import { browserTarget } from "@vite-hub/internal/package-exports"
import { defineConfig } from "vite"

import { overlayAliases, standaloneStyles, standaloneUI } from "./overlay.aliases.ts"

const root = import.meta.dirname
const outDir = resolve(root, "dist/hosted")

export const hostedEntry = "hosted-comments.js"
export const hostedFrame = "hosted-comments/frame.js"
export const hostedTools = "hosted-comments/tools.js"

const selfContainedParts = {
  host: { input: "src/embed/host.ts", file: hostedEntry },
  frame: { input: "src/embed/frame.ts", file: hostedFrame },
  tools: { input: "src/embed/tools.ts", file: hostedTools },
}

export default defineConfig({
  base: "./",
  configFile: false,
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [standaloneUI(), standaloneStyles()],
  resolve: { alias: overlayAliases, dedupe: ["vue"] },
  environments: Object.fromEntries(Object.entries(selfContainedParts).map(([name, { input, file }]) => [name, {
    consumer: "client",
    build: {
      emptyOutDir: false,
      minify: true,
      outDir,
      rolldownOptions: {
        input: resolve(root, input),
        preserveEntrySignatures: "exports-only",
        output: { codeSplitting: false, entryFileNames: file },
      },
      target: browserTarget,
    },
  }])),
  builder: {
    async buildApp(builder) {
      rmSync(outDir, { force: true, recursive: true })
      for (const name of Object.keys(selfContainedParts)) await builder.build(builder.environments[name]!)
    },
  },
})
