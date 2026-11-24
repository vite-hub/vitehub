import { defineDiagnostics } from "nostics"

import type { Diagnostic, Diagnostics } from "nostics"

// Each code identifies one codemod failure. Keep published codes stable.
const codes = {
  // Named errors. Keep these codes in alphabetical order.
  CODEMODS_BLOCKED: {
    why: ({ problem }: { problem: string }): string => problem,
    fix: "Change the file, the option, or the argument that the message names, then run the codemod again. Add `--dry-run` to see the edits before it writes them.",
  },
  CODEMODS_NITRO_UNSUPPORTED: {
    why: ({ codemod, config, nitropack }: { codemod: string, config: string, nitropack: string }): string => `${config} belongs to a Nitro 2 app: package.json requires nitropack "${nitropack}". ${codemod} moves an app to ViteHub, which supports Nitro 3 only, so the migrated app would not build. No file was written.`,
    fix: "Keep nuxt-safe-runtime-config/nitro while the app runs on Nitro 2. To move to ViteHub Env, upgrade the app to Nitro 3 (the `nitro` package) first, then run the codemod again.",
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
  return code === "CODEMODS_BLOCKED" || code === "CODEMODS_NITRO_UNSUPPORTED" || code === "CODEMODS_UNKNOWN"
}
