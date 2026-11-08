import { readEnvironmentReports } from "./files.ts"
import { createBundleReport, explainBundle } from "./report.ts"

import type { BundleExplanation, BundleReport } from "./types.ts"

export { bundleReportDir, readEnvironmentReports } from "./files.ts"
export { moduleGroup } from "./groups.ts"
export { createBundleReport, explainBundle } from "./report.ts"
export type * from "./types.ts"

/** The report of the last build with `bundle` on, or `undefined` when there is none. */
export function readBundleReport(root: string): BundleReport | undefined {
  return createBundleReport(readEnvironmentReports(root))
}

/** Why `target` (a package, a file, or a group) is in the last build. Empty when the build does not contain it. */
export function explainBundleTarget(root: string, target: string): BundleExplanation[] {
  return explainBundle(readEnvironmentReports(root), target)
}
