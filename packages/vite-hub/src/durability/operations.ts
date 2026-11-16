import { defineOperation } from "@vite-hub/internal/operations"
import { formatDurabilityTable, getDurabilityReport } from "@vite-hub/runtime/durability"
import * as v from "valibot"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"
import type { DurabilityReport } from "@vite-hub/runtime/durability"

function format(report: DurabilityReport): string {
  const lines = [`${report.instances} instance${report.instances === 1 ? "" : "s"} (${report.instancesSource})`]
  if (report.primitives.length) lines.push(formatDurabilityTable(report.primitives))
  for (const problem of report.problems) lines.push(`${problem.primitive}${problem.name ? ` (${problem.name})` : ""} splits its state across instances.${problem.fix ? ` Fix: ${problem.fix}` : ""}`)
  return `${lines.join("\n")}\n`
}

const list = defineOperation<Record<string, never>, DurabilityReport>({
  cli: { format },
  description: "Show where each primitive of this Node server keeps its state: shared, on this host, or in this process.",
  input: v.strictObject({}),
  kind: "read",
  name: "durability.list",
  run: () => {
    const report = getDurabilityReport()
    if (!report) throw viteHubErrorDiagnostics.VITE_HUB_R0143()
    return report
  },
  section: "durability",
  user: false,
})

/** The `durability.*` operations. `vitehub durability list`, the Console, and agents run them. */
export const durabilityOperations: readonly AnyOperation[] = [list]
