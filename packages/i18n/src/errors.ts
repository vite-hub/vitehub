import { defineErrors } from "@vite-hub/runtime"

export const i18nErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/i18n/diagnostics",
  codes: {
    // Config errors.
    I18N_INVALID_BUILD_INVENTORY: {
      why: ({ file }: { file: string }) => `Invalid Vue i18n message inventory at ${file}.`,
      fix: "Clear the Nuxt build cache and generated build outputs, then rebuild the app so Vue regenerates the i18n message inventory before Nitro runs.",
    },
    I18N_INVALID_LOCALES: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Set `i18n.locales` to a list of BCP 47 tags with the source language first, for example `{ i18n: { locales: [\"en\", \"es\"] } }`.",
    },
    I18N_UNSUPPORTED_HOST: {
      why: "i18n needs Nitro 3, which runs each request in an async context. This app builds the server with Nitro 2.",
      fix: "Use Nuxt 4.7 or newer with the `nitro` package (`pnpm add nuxt@^4.7.0 nitro`), Nuxt 5, or `vitehub()` with Nitro 3 in a Vite app. On Nuxt 4, use i18n without `i18n.workspace`.",
    },
    I18N_UNKNOWN_WORKSPACE: {
      why: ({ workspace, workspaces }: { workspace: string, workspaces: readonly string[] | undefined }) => workspaces === undefined
        ? `\`i18n.workspace\` is ${JSON.stringify(workspace)}, and Workspace is not enabled.`
        : `\`i18n.workspace\` is ${JSON.stringify(workspace)}, and the app defines ${workspaces.length ? `only these Workspaces: ${workspaces.map(name => JSON.stringify(name)).join(", ")}` : "no Workspace"}.`,
      fix: "Set `i18n.workspace` to the name of a Workspace, or define it, such as `server/workspaces/translations/config.ts` for `\"translations\"`.",
    },
    I18N_MACRO_NOT_COMPILED: {
      why: ({ name }: { name: string }) => `\`${name}\` from \`vite-hub/i18n\` ran without the ViteHub build, so it has no message ID.`,
      fix: "Enable `i18n` in `vitehub()` or `vite-hub/nuxt`, and import the macro from `vite-hub/i18n` in a file that Vite builds.",
    },
    I18N_NO_WORKSPACE: {
      why: "`useTranslations()` saves and publishes translations in a Workspace, and `i18n.workspace` is not set.",
      fix: "Define a Workspace with retained history, such as `server/workspaces/translations/config.ts`, and set `i18n: { workspace: \"translations\" }`. Without a Workspace, translations are records in `locales/<locale>/`.",
    },
    // Browser diagnostics.
    I18N_LIVE_CATALOG_INVALID: {
      why: ({ locale, route }: { locale: string, route: string }) => `The live catalog \`${route}/${locale}.json\` answered with a body that is not \`{ revision, messages }\` with compiled messages, so the page uses the catalog of the build.`,
      fix: "ViteHub serves this route when `i18n.workspace` is set. Open the URL and check that no proxy, middleware, or route of the app answers the same path with another body.",
    },
    I18N_LIVE_CATALOG_UNAVAILABLE: {
      why: ({ locale, route, status }: { locale: string, route: string, status?: number }) => `The live catalog \`${route}/${locale}.json\` ${status === undefined ? "did not answer" : `answered with status ${status}`}, so the page uses the catalog of the build.`,
      fix: "ViteHub serves this route when `i18n.workspace` is set. Open the URL, and check the server log and the network. `error.cause` has the fetch error.",
    },
    // Runtime errors.
    I18N_INVALID_TRANSLATION: {
      why: ({ problem }: { problem: string }) => `The translation was not saved. ${problem}`,
      fix: "Write the translation in ICU MessageFormat, and keep every `{placeholder}` and `<0>` tag of the source text.",
      status: 400,
    },
    I18N_SAVE_CONFLICT: {
      why: ({ id, locale }: { id: string, locale: string }) => `Another save changed the \`draft\` ref while \`save()\` wrote message ${id} in \`${locale}\`. This translation was not saved.`,
      fix: "Call `save()` again. It reads the new draft first. `error.cause` has the Workspace conflict.",
      status: 409,
    },
    I18N_UNKNOWN_LOCALE: {
      why: ({ locale, locales }: { locale: string, locales: readonly string[] }) => `\`${locale}\` is not one of the configured locales: ${locales.join(", ")}.`,
      fix: "Pass one of `i18n.locales`, or add the locale to `i18n.locales`.",
      status: 400,
    },
    I18N_LOCALE_SUPERSEDED: {
      why: ({ locale }: { locale: string }) => `A newer \`setLocale()\` call superseded the selection of \`${locale}\` before its catalog loaded.`,
      fix: "Use the result of the latest `setLocale()` call.",
    },
  },
})
