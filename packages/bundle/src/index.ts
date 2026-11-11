import { readEnvironmentReports } from "./files.ts"
import { createBundleReport, explainBundle, explainBundleRoute } from "./report.ts"

import type { BundleExplanation, BundleReport, BundleRouteExplanation } from "./types.ts"

export { compareBundleReports, readSavedBundleReport } from "./compare.ts"
export { bundleReportDir, readEnvironmentReports } from "./files.ts"
export { moduleGroup } from "./groups.ts"
export { createBundleReport, explainBundle, explainBundleRoute } from "./report.ts"
export type * from "./types.ts"

/** The report of the last build with `bundle` on, or `undefined` when there is none. */
export function readBundleReport(root: string): BundleReport | undefined {
  return createBundleReport(readEnvironmentReports(root))
}

/** Why `target` (a package, a file, or a group) is in the last build. Empty when the build does not contain it. */
export function explainBundleTarget(root: string, target: string): BundleExplanation[] {
  return explainBundle(readEnvironmentReports(root), target)
}

/** What the browser loads on a first visit to the page route that renders `path`, such as `/docs/kv`. */
export function explainBundleRouteTarget(root: string, path: string): BundleRouteExplanation | undefined {
  return explainBundleRoute(readEnvironmentReports(root), path)
}
