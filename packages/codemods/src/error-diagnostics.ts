import { defineDiagnostics } from "nostics"

import type { Diagnostic, Diagnostics } from "nostics"

// Each code identifies one codemod failure. Keep published codes stable.
const codes = {
  // Named errors. Keep these codes in alphabetical order.
  CODEMODS_BLOCKED: {
    why: ({ problem }: { problem: string }): string => problem,
    fix: "Change the file, the option, or the argument that the message names, then run the codemod again. Add `--dry-run` to see the edits before it writes them.",
  },
  CODEMODS_NUXT_UNSUPPORTED: {
    why: ({ codemods, nuxt, source }: { codemods: readonly string[], nuxt: string, source: string }): string => `${codemods.join(", ")} add${codemods.length === 1 ? "s" : ""} vite-hub/nuxt, which needs Nuxt 5, Nitro 3, and H3 2. package.json requires nuxt "${nuxt}"${source}, so the build of the migrated app would fail. No file was written.`,
    fix: "Move the app to Nuxt 5 first. Or run the command again with `--nuxt-nightly`: it sets `\"nuxt\": \"npm:nuxt-nightly@5x\"` in package.json and migrates the app.",
  },
  CODEMODS_UNKNOWN: {
    why: ({ available, name }: { available: readonly string[], name: string }): string => `Unknown codemod "${name}". Available: ${available.join(", ")}.`,
    fix: "Pass one of the codemod names that the message lists.",
  },
}

export const codemodsErrorDiagnostics: Diagnostics<typeof codes, []> = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/codemods/diagnostics",
  codes,
})

/** The error of a codemod that cannot migrate the project: `CODEMODS_BLOCKED`. */
export function codemodError(problem: string): Diagnostic {
  return codemodsErrorDiagnostics.CODEMODS_BLOCKED({ problem })
}

/** Whether a codemod refused to migrate the project, so the caller reports the message and the fix. */
export function isCodemodError(error: unknown): error is Error & { code: string, fix?: string } {
  if (!(error instanceof Error)) return false
  const code: unknown = Reflect.get(error, "code")
  return code === "CODEMODS_BLOCKED" || code === "CODEMODS_NUXT_UNSUPPORTED" || code === "CODEMODS_UNKNOWN"
}
