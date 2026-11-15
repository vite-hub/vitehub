import { defineDiagnostics } from "nostics"

// The one code for a state that only a ViteHub bug can reach. Its own catalog keeps browser bundles small.
const invariantDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    INTERNAL_INVARIANT_FAILED: {
      why: ({ what }: { what: string }) => `ViteHub reached a state that it does not expect: ${what}`,
      fix: "This is a ViteHub bug. Open an issue at https://github.com/vite-hub/vitehub/issues with this error message and its stack trace.",
    },
  },
})

/**
 * The error for a state that only a ViteHub bug can reach, such as an impossible branch. `what` says which rule broke.
 * Use a code from the package catalog when a developer can cause the error or fix it.
 */
export function invariantError(what: string) {
  return invariantDiagnostics.INTERNAL_INVARIANT_FAILED({ what })
}

/** Throws `INTERNAL_INVARIANT_FAILED` when `condition` is falsy. */
export function invariant(condition: unknown, what: string): asserts condition {
  if (!condition) throw invariantError(what)
}
