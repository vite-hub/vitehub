import { makeConfig } from "@lingui/conf"
import { formatter as poFormatter } from "@lingui/format-po"

import type { LinguiConfigNormalized } from "@lingui/conf"
import type { I18nLocaleConfig } from "./locales.ts"

/** Message macros of `vite-hub/i18n`. Other imports from it are runtime functions. */
export const macroNames: ReadonlySet<string> = new Set(["t", "plural", "select", "selectOrdinal", "msg", "defineMessage"])

export interface LinguiSetup {
  rootDir: string
  locale: I18nLocaleConfig
  /** Package path that the app imports ViteHub from, such as `vite-hub/i18n` or `@vite-hub/i18n`. */
  importBase: string
}

/** Folders that never hold app messages. */
const excluded = ["**/node_modules/**", "**/.output/**", "**/.nuxt/**", "**/.vitehub/**", "**/.data/**", "**/dist/**", "**/.git/**"]

/** The folder of the translation records: `locales/<locale>/segments/<hh>/<hash>.json` in the project, as in a Diglot repository. */
export function recordsRoot(rootDir: string): string {
  return `${rootDir}/locales`
}

/** Lingui config built from the ViteHub options, so apps do not keep a `lingui.config` file. */
export function createLinguiConfig(setup: LinguiSetup, extractors: LinguiConfigNormalized["extractors"] = []): LinguiConfigNormalized {
  const macroPackages = [...new Set([setup.importBase, "vite-hub/i18n", "@vite-hub/i18n"])]
  return makeConfig({
    rootDir: setup.rootDir,
    locales: [...setup.locale.locales],
    sourceLocale: setup.locale.sourceLocale,
    fallbackLocales: { default: setup.locale.sourceLocale },
    // Lingui only reads the code with this catalog. ViteHub keeps translations as records, never in this path.
    catalogs: [{ path: "<rootDir>/.vitehub/i18n/lingui/{locale}", include: ["<rootDir>"], exclude: excluded }],
    format: poFormatter({ lineNumbers: true }),
    orderBy: "message",
    extractors,
    macro: {
      corePackage: macroPackages,
      jsxPackage: ["@vite-hub/i18n/vue-macro"],
      jsxRuntime: "vue",
    },
    runtimeConfigModule: {
      i18n: [`${setup.importBase}/runtime`, "i18n"],
      Trans: ["@lingui/vue", "Trans"],
      useLingui: ["@lingui/vue", "useLingui"],
    },
  }, { skipValidation: true })
}
