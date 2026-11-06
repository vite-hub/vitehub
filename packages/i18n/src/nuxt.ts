import { join } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import { i18nErrorDiagnostics } from "./errors.ts"

/** The parts of a Nuxt instance that `installI18nNuxt()` uses. */
export interface I18nNuxt {
  options: { buildDir: string, plugins: Array<string | { src: string }> }
}

export interface I18nNuxtOptions {
  /** The Nitro major version of the app. Nuxt 4 builds with Nitro 2, which i18n does not support. */
  nitroMajorVersion: 2 | 3
  /** The public import path of the i18n re-exports, such as `vite-hub/i18n`. */
  importBase: string
}

/**
 * Add the Nuxt plugin that installs messages in each Vue app. On the server, the app uses the i18n instance of the
 * request. The server sends the locale in the payload, so the client hydrates in the same locale.
 */
export async function installI18nNuxt(nuxt: I18nNuxt, options: I18nNuxtOptions): Promise<void> {
  if (options.nitroMajorVersion === 2) throw i18nErrorDiagnostics.I18N_UNSUPPORTED_HOST()
  const plugin = join(nuxt.options.buildDir, "vitehub/i18n-plugin.mjs")
  await writeFileIfChanged(plugin, nuxtPluginSource(options.importBase))
  if (!nuxt.options.plugins.some(entry => (typeof entry === "string" ? entry : entry.src) === plugin)) nuxt.options.plugins.push(plugin)
}

function nuxtPluginSource(importBase: string): string {
  return [
    `import { defineNuxtPlugin, useHead } from "#imports"`,
    `import { activateLocale, getI18n, getI18nConfig, resolveBrowserLocale } from ${JSON.stringify(`${importBase}/runtime`)}`,
    `import { i18nPlugin } from ${JSON.stringify(`${importBase}/vue`)}`,
    ``,
    `export default defineNuxtPlugin({`,
    `  name: "vite-hub:i18n",`,
    `  async setup(nuxtApp) {`,
    `    const i18n = getI18n()`,
    `    if (import.meta.server) nuxtApp.payload.vitehubLocale = i18n.locale`,
    `    else {`,
    `      const config = getI18nConfig()`,
    `      if (config) await activateLocale(i18n, nuxtApp.payload.vitehubLocale ?? resolveBrowserLocale(config))`,
    `    }`,
    `    nuxtApp.vueApp.use(i18nPlugin({ i18n }))`,
    `    useHead({ htmlAttrs: { lang: () => i18n.locale } })`,
    `  },`,
    `})`,
    ``,
  ].join("\n")
}
