import { defineDoctorExtension, defineRulePack } from "vite-doctor/extension"
import type { DoctorExtension } from "vite-doctor/extension"

import { viteHubDoctorDiagnostics } from "./doctor/diagnostics.ts"
import { viteHubInventoryContributor } from "./doctor/inventory.ts"
import { rules as builtInRules } from "./doctor/rules/built-ins.ts"
import { rules as definitionRules } from "./doctor/rules/definitions.ts"
import { rules as envAndGuardRules } from "./doctor/rules/env-and-guards.ts"
import { rules as importRules } from "./doctor/rules/imports.ts"
import { rules as integrationRules } from "./doctor/rules/integrations.ts"
import { rules as resultRules } from "./doctor/rules/results.ts"
import { readViteHubVersion } from "./version.ts"

export { noInternalImports, noServerImportsInClient, preferViteHubImports } from "./doctor/rules/imports.ts"
export { destructureResultTuples } from "./doctor/rules/results.ts"

const rules = [...importRules, ...resultRules, ...envAndGuardRules, ...definitionRules, ...integrationRules, ...builtInRules]

const vitehubDoctorExtension: DoctorExtension = defineDoctorExtension({
  name: "vite-hub",
  rulePacks: [
    defineRulePack({
      name: "vitehub",
      version: readViteHubVersion(),
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
