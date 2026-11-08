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
    // Thrown when code calls a message macro that the ViteHub build did not compile.
    I18N_MACRO_NOT_COMPILED: {
      why: ({ name }: { name: string }) => `\`${name}\` from \`vite-hub/i18n\` ran without the ViteHub build, so it has no message ID.`,
      fix: "Enable `i18n` in `vitehub()` or `vite-hub/nuxt`, and import the macro from `vite-hub/i18n` in a file that Vite builds.",
    },
    // Runtime errors. `setLocale()` returns them as `[error, undefined]`.
    I18N_UNKNOWN_LOCALE: {
      why: ({ locale, locales }: { locale: string, locales: readonly string[] }) => `\`${locale}\` is not one of the configured locales: ${locales.join(", ")}.`,
      fix: "Pass one of `i18n.locales`, or add the locale to `i18n.locales` and run `vitehub i18n extract`.",
    },
    I18N_LOCALE_SUPERSEDED: {
      why: ({ locale }: { locale: string }) => `A newer \`setLocale()\` call superseded the selection of \`${locale}\` before its catalog loaded.`,
      fix: "Use the result of the latest `setLocale()` call.",
    },
  },
})
