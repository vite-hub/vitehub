import { defineErrors } from "@vite-hub/runtime"

// Keep published codes stable. Each code has a heading on the docs page.
export const i18nErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/i18n/diagnostics",
  codes: {
    // Config errors. ViteHub throws them when the build starts.
    I18N_INVALID_LOCALES: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Set `i18n.locales` to a list of BCP 47 tags with the source language first, for example `{ i18n: { locales: [\"en\", \"es\"] } }`.",
    },
    I18N_UNSUPPORTED_HOST: {
      why: "i18n needs Nitro 3, which runs each request in an async context. Nuxt 4 builds the server with Nitro 2.",
      fix: "Upgrade to Nuxt 5, or use `vitehub()` with Nitro 3 in a Vite app.",
    },
    I18N_UNKNOWN_WORKSPACE: {
      why: ({ workspace, workspaces }: { workspace: string, workspaces: readonly string[] | undefined }) => workspaces === undefined
        ? `\`i18n.workspace\` is ${JSON.stringify(workspace)}, and Workspace is not enabled.`
        : `\`i18n.workspace\` is ${JSON.stringify(workspace)}, and the app defines ${workspaces.length ? `only these Workspaces: ${workspaces.map(name => JSON.stringify(name)).join(", ")}` : "no Workspace"}.`,
      fix: "Set `i18n.workspace` to the name of a Workspace, or define it, such as `server/workspaces/translations/config.ts` for `\"translations\"`.",
    },
    // Thrown when code calls a message macro that the ViteHub build did not compile.
    I18N_MACRO_NOT_COMPILED: {
      why: ({ name }: { name: string }) => `\`${name}\` from \`vite-hub/i18n\` ran without the ViteHub build, so it has no message ID.`,
      fix: "Enable `i18n` in `vitehub()` or `vite-hub/nuxt`, and import the macro from `vite-hub/i18n` in a file that Vite builds.",
    },
    // Thrown when server code calls `useTranslations()` in an app without `i18n.workspace`.
    I18N_NO_WORKSPACE: {
      why: "`useTranslations()` saves and publishes translations in a Workspace, and `i18n.workspace` is not set.",
      fix: "Define a Workspace with retained history, such as `server/workspaces/translations/config.ts`, and set `i18n: { workspace: \"translations\" }`. Without a Workspace, translations are records in `locales/<locale>/`.",
    },
    // Runtime errors. `setLocale()` and `useTranslations()` return them as `[error, undefined]`.
    I18N_INVALID_TRANSLATION: {
      why: ({ problem }: { problem: string }) => `The translation was not saved. ${problem}`,
      fix: "Write the translation in ICU MessageFormat, and keep every `{placeholder}` and `<0>` tag of the source text.",
    },
    I18N_UNKNOWN_LOCALE: {
      why: ({ locale, locales }: { locale: string, locales: readonly string[] }) => `\`${locale}\` is not one of the configured locales: ${locales.join(", ")}.`,
      fix: "Pass one of `i18n.locales`, or add the locale to `i18n.locales`.",
    },
    I18N_LOCALE_SUPERSEDED: {
      why: ({ locale }: { locale: string }) => `A newer \`setLocale()\` call superseded the selection of \`${locale}\` before its catalog loaded.`,
      fix: "Use the result of the latest `setLocale()` call.",
    },
  },
})
