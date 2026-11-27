import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { expect, it, vi } from "vitest"

it.each([false, true])("resolves Vue import fallbacks in Nuxt (standalone Auth: %s)", async (standaloneAuth) => {
  const cache = resolve(import.meta.dirname, "../../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "nuxt-vue-imports-"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const name = standaloneAuth ? "useUserSession" : "useChat"
  const configuredName = standaloneAuth ? "useAuthClient" : "useAgentInvocation"
  const fallbackName = standaloneAuth ? "useAbility" : "useAgent"
  try {
    for (const directory of ["app/composables", "layer/app/composables", "node_modules/@vite-hub"]) {
      await mkdir(join(root, directory), { recursive: true })
    }
    for (const dependency of ["@vite-hub/auth", "nuxt", "vite-hub", "vue"]) {
      const target = dependency === "vite-hub" ? resolve(import.meta.dirname, "..") : resolve(import.meta.dirname, "../node_modules", dependency)
      await symlink(target, join(root, "node_modules", dependency), "dir")
    }
    await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
    await writeFile(join(root, "layer/nuxt.config.ts"), "export default defineNuxtConfig({})")
    for (const directory of ["app", "layer/app"]) {
      await writeFile(join(root, directory, `composables/${name}.ts`), `export const ${name} = () => '${directory}'`)
    }
    await writeFile(join(root, "later.mjs"), "export const collection = () => 'later module'")
    await writeFile(join(root, "configured.mjs"), "export const replacement = () => 'configured'")
    await writeFile(join(root, "preset.mjs"), "export const replacement = () => 'preset'")
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({
      extends: ['./layer'],
      modules: [${JSON.stringify(standaloneAuth ? "@vite-hub/auth/nuxt" : "vite-hub/nuxt")}, (_options, nuxt) => {
        nuxt.hook('imports:extend', imports => {
          imports.push({ name: 'collection', as: 'useCollection', from: ${JSON.stringify(join(root, "later.mjs"))}, priority: -100 })
        })
      }],
      vitehub: { agent: true, host: 'node', console: false },
      imports: {
        imports: [
          { name: ${JSON.stringify(fallbackName)}, from: './disabled.mjs', disabled: true },
          { name: 'replacement', as: ${JSON.stringify(configuredName)}, from: './configured.mjs' },
        ],
        presets: [{ from: './preset.mjs', imports: [['replacement', 'useChoices']] }],
      },
    })`)
    const { loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, ready: false, overrides: { dev: false, logLevel: "silent" } })
    try {
      let readImports = async () => new Map<string, { from: string }>()
      nuxt.hook("imports:context", (context) => {
        readImports = () => context.getImportMap()
      })
      await nuxt.ready()
      const imports = await readImports()
      expect.soft(imports.get(name)?.from).toBe(join(root, `app/composables/${name}.ts`))
      expect.soft(imports.get(fallbackName)?.from).toBe(standaloneAuth ? "@vite-hub/auth/vue" : "vite-hub/agent/vue")
      expect.soft(imports.get(configuredName)?.from).toBe("./configured.mjs")
      if (!standaloneAuth) {
        expect.soft(imports.get("useCollection")?.from).toBe(join(root, "later.mjs"))
        expect.soft(imports.get("useChoices")?.from).toBe("./preset.mjs")
      }
      const warnings = warn.mock.calls.map(([message]) => String(message)).filter(message => message.startsWith("[vitehub]") && message.includes("already auto-imports"))
      expect(warnings.map(message => message.split(" already auto-imports")[0]).sort()).toEqual([
        "[vitehub] ./configured.mjs",
        ...standaloneAuth ? [] : ["[vitehub] ./preset.mjs"],
        `[vitehub] app/composables/${name}.ts`,
        ...standaloneAuth ? [] : ["[vitehub] later.mjs"],
      ])
    }
    finally {
      await nuxt.close()
    }
  }
  finally {
    warn.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
