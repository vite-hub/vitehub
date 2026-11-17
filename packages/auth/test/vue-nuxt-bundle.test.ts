import { fileURLToPath } from "node:url"

import { build } from "vite"
import { expect, it } from "vitest"

import type { Rolldown } from "vite"

const plugin = fileURLToPath(new URL("../src/runtime/vue-nuxt.ts", import.meta.url))

// joyandmaxi removed the Nuxt plugin by hand, because every public page downloaded the Auth composables with it.
it("keeps the composables out of the Nuxt plugin's chunk, so a page without Auth does not download them", async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      lib: { entry: plugin, formats: ["es"], fileName: "plugin" },
      rollupOptions: { external: ["#app", "#vitehub/auth/abilities", "#vitehub/auth/client", "vue", /^better-auth/] },
    },
  }) as Rolldown.RolldownOutput[]
  const chunks = output.flatMap(result => result.output).filter((item): item is Rolldown.OutputChunk => item.type === "chunk")
  const entry = chunks.find(chunk => chunk.isEntry)!
  const composables = chunks.find(chunk => chunk.facadeModuleId?.endsWith("/src/vue.ts"))

  expect(composables, "the guard loads the composables with a dynamic import").toBeDefined()
  expect(entry.dynamicImports).toContain(composables!.fileName)
  expect(entry.imports).not.toContain(composables!.fileName)
  // The app's ability rules and Vue come only with the composables.
  expect(entry.code).not.toContain("#vitehub/auth/abilities")
  expect(entry.code).not.toMatch(/from\s*"vue"/)
  expect(entry.code.length).toBeLessThan(8_000)
})
