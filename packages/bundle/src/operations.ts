import { defineOperation } from "@vite-hub/internal/operations"
import { defineDiagnostics } from "nostics"
import * as v from "valibot"

import type { AnyOperation, OperationContext, OperationDefinition } from "@vite-hub/internal/operations"
import type { BundleEnvironmentReport, BundleExplanation, BundleReport, BundleRouteExplanation } from "./types.ts"

/** What `bundle.why` returns. `vitehub bundle why --json` prints the same object. */
export type BundleWhyResult =
  | BundleRouteExplanation
  | { target: string, unavailable: string }
  /** One entry for each side that contains the target. Empty when the last build does not contain it. */
  | { target: string, explanations: BundleExplanation[] }

const bundleOperationDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/bundle/diagnostics",
  codes: {
    BUNDLE_DEV_SERVER_REQUIRED: {
      why: "The bundle report is a file of the build in `.vitehub/bundle/`. Only the dev server of the project can read it. A deployed server has no project files.",
      fix: "Call the operation on the dev server of the project (`vite dev` or `nuxt dev`), or run `vitehub bundle` in the project.",
    },
    BUNDLE_REPORT_MISSING: {
      why: "There is no bundle report in `.vitehub/bundle/`. No production build with `bundle: true` ran in this project.",
      fix: "Set `bundle: true` in `vitehub()` (vite.config.ts) or in `vitehub` (nuxt.config.ts), then run `vite build` or `nuxt build`.",
    },
  },
})

const reader = () => import("./index.ts")

async function reportsOf(context: OperationContext): Promise<BundleEnvironmentReport[]> {
  if (context.development !== true || !context.projectRoot) throw Object.assign(bundleOperationDiagnostics.BUNDLE_DEV_SERVER_REQUIRED(), { status: 409 })
  const reports = (await reader()).readEnvironmentReports(context.projectRoot)
  if (!reports.length) throw Object.assign(bundleOperationDiagnostics.BUNDLE_REPORT_MISSING(), { status: 404 })
  return reports
}

function defineBundleOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "kind" | "section" | "user">): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, kind: "read", section: "bundle", user: false })
}

const report = defineBundleOperation<Record<string, never>, BundleReport>({
  cli: { command: "report", default: true, namespace: "bundle" },
  description: "Read the bundle report of the last production build: client and server bytes, startup bytes, the largest groups, and the checks.",
  input: v.strictObject({}),
  mcp: { title: "Bundle report" },
  name: "bundle.report",
  run: async (_input, context) => (await reader()).createBundleReport(await reportsOf(context))!,
})

const why = defineBundleOperation<{ target: string }, BundleWhyResult>({
  cli: { command: "why", namespace: "bundle", positional: ["target"] },
  description: "Explain why a package, a file, or a group is in the last production build, with its bytes, whether it loads at startup, and the import chain from the entry. A page route such as /docs/kv shows what a first visit loads.",
  input: v.strictObject({ target: v.pipe(v.string(), v.trim(), v.minLength(1, "Name a package, a file, a group, or a page route.")) }),
  mcp: { title: "Why is it in the bundle" },
  name: "bundle.why",
  run: async ({ target }, context) => {
    const reports = await reportsOf(context)
    const { createBundleReport, explainBundle, explainBundleRoute } = await reader()
    const route = target.startsWith("/") ? explainBundleRoute(reports, target) : undefined
    if (route) return route
    const explanations = explainBundle(reports, target)
    const unavailable = !explanations.length && target.startsWith("/") ? createBundleReport(reports)?.client?.routesUnavailable : undefined
    return unavailable ? { target, unavailable } : { target, explanations }
  },
})

/** The `bundle.*` operations. The Console and the ViteHub MCP call them on a dev server. `vitehub bundle` reads the same files. */
export const bundleOperations: readonly AnyOperation[] = [report, why]
