import { createConsoleReporter } from "nostics"

import type { Diagnostic } from "nostics"

const reportDiagnostic = createConsoleReporter()

/** Logs a diagnostic with `console.warn`: its message, fix and docs link, then its `cause` when it has one. */
export function warnDiagnostic(diagnostic: Diagnostic<unknown>): void {
  // nostics 1.4.0 types the options argument as required, but the reporter defaults it.
  reportDiagnostic(diagnostic, {})
}
