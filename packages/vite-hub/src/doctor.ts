import { defineDoctorExtension, defineRulePack } from "vite-doctor/extension"
import type { DoctorExtension } from "vite-doctor/extension"

import frameworkPackageManifest from "../package.json" with { type: "json" }
import { viteHubDoctorDiagnostics } from "./doctor/diagnostics.ts"
import { viteHubInventoryContributor } from "./doctor/inventory.ts"
import { rules as definitionRules } from "./doctor/rules/definitions.ts"
import { rules as envAndGuardRules } from "./doctor/rules/env-and-guards.ts"
import { rules as importRules } from "./doctor/rules/imports.ts"
import { rules as integrationRules } from "./doctor/rules/integrations.ts"
import { rules as resultRules } from "./doctor/rules/results.ts"

export { noInternalImports, noServerImportsInClient } from "./doctor/rules/imports.ts"
export { destructureResultTuples } from "./doctor/rules/results.ts"

const rules = [...importRules, ...resultRules, ...envAndGuardRules, ...definitionRules, ...integrationRules]

const vitehubDoctorExtension: DoctorExtension = defineDoctorExtension({
  name: "vite-hub",
  rulePacks: [
    defineRulePack({
      name: "vitehub",
      version: frameworkPackageManifest.version,
      rules,
      diagnostics: viteHubDoctorDiagnostics,
      presets: { recommended: rules.map(rule => rule.meta.id) },
    }),
  ],
  setup(api) {
    api.registerProjectInventoryContributor(viteHubInventoryContributor)
  },
})

export default vitehubDoctorExtension
