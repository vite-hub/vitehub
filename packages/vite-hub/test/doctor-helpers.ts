import { runProjectFixture, runRuleFixture } from "vite-doctor/testkit"
import type { DoctorRule } from "vite-doctor/extension"

import vitehubDoctorExtension from "../src/doctor.ts"

type Framework = "nuxt" | "vite"

/** Each Doctor Run writes a fixture project, and the first inventory imports discovery from every owner package. */
export const doctorTestTimeout = 60_000

/** Runs one rule on fixture files and returns the Diagnostic Codes it reports, in order. */
export async function codes(rule: DoctorRule, files: Record<string, string>, framework: Framework = "vite") {
  const result = await runRuleFixture({ rule, framework, files })
  return result.diagnostics.map(diagnostic => diagnostic.code)
}

/** Runs one rule through the published extension, so rules can read the ViteHub Project Inventory. */
export async function projectCodes(rule: DoctorRule, files: Record<string, string>, framework: Framework = "vite") {
  const result = await runProjectFixture({
    framework,
    files,
    dependencies: { "vite-hub": "*" },
    extensions: [vitehubDoctorExtension],
    run: { rules: rule.meta.id },
  })
  return result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("VHUB")).map(diagnostic => diagnostic.code)
}
