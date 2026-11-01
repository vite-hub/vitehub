import { defineDoctorDiagnostics } from "vite-doctor/extension"
import type { DoctorDiagnosticRegistry } from "vite-doctor/extension"

/** Every ViteHub Diagnostic Code. Never reuse a code; the docs anchor is the lowercase code. */
const entries = [
  { code: "VHUB0001", ruleId: "vitehub/no-internal-imports" },
  { code: "VHUB0002", ruleId: "vitehub/no-server-imports-in-client" },
  { code: "VHUB0003", ruleId: "vitehub/destructure-result-tuples" },
  { code: "VHUB0004", ruleId: "vitehub/unseal-secret-env" },
  { code: "VHUB0005", ruleId: "vitehub/no-literal-credentials" },
  { code: "VHUB0006", ruleId: "vitehub/await-async-helpers" },
  { code: "VHUB0007", ruleId: "vitehub/load-provider-env" },
  { code: "VHUB0008", ruleId: "vitehub/check-rate-limit-decision" },
  { code: "VHUB0009", ruleId: "vitehub/rate-limiter-at-module-scope" },
  { code: "VHUB0010", ruleId: "vitehub/auth-runtime-options" },
  { code: "VHUB0011", ruleId: "vitehub/no-agent-connection-actor" },
  { code: "VHUB0012", ruleId: "vitehub/no-nested-blob-reference-schema" },
  { code: "VHUB0013", ruleId: "vitehub/known-definition-names" },
  { code: "VHUB0014", ruleId: "vitehub/definition-default-export" },
  { code: "VHUB0015", ruleId: "vitehub/definition-location" },
  { code: "VHUB0016", ruleId: "vitehub/queue-payload-options" },
  { code: "VHUB0017", ruleId: "vitehub/no-module-scope-dispatch" },
  { code: "VHUB0018", ruleId: "vitehub/no-destructure-non-tuples" },
  { code: "VHUB0019", ruleId: "vitehub/check-response-results" },
  { code: "VHUB0020", ruleId: "vitehub/workflow-step-names" },
  { code: "VHUB0021", ruleId: "vitehub/valid-schedule-cron" },
  { code: "VHUB0022", ruleId: "vitehub/manual-schedule-run" },
  { code: "VHUB0023", ruleId: "vitehub/valid-outbound-channel" },
  { code: "VHUB0024", ruleId: "vitehub/realtime-carets" },
  { code: "VHUB0025", ruleId: "vitehub/realtime-persistence" },
  { code: "VHUB0026", ruleId: "vitehub/forge-error-imports" },
  { code: "VHUB0027", ruleId: "vitehub/sandbox-runtime-options" },
  { code: "VHUB0028", ruleId: "vitehub/define-agent-from-vite-hub" },
  { code: "VHUB0029", ruleId: "vitehub/rate-limit-capability-limiter" },
  { code: "VHUB0030", ruleId: "vitehub/no-vitehub-plugin-in-nuxt" },
  { code: "VHUB0031", ruleId: "vitehub/valid-vitehub-options" },
  { code: "VHUB0032", ruleId: "vitehub/no-nuxthub-leftovers" },
  { code: "VHUB0033", ruleId: "vitehub/no-removed-apis" },
  { code: "VHUB0034", ruleId: "vitehub/markdown-file-path" },
  { code: "VHUB0035", ruleId: "vitehub/comments-entry" },
] as const

type Entry = typeof entries[number]

export const viteHubDoctorDiagnostics: DoctorDiagnosticRegistry<Entry["code"], Entry["ruleId"]> = defineDoctorDiagnostics(
  entries,
  { docsBase: code => `https://vitehub.dev/docs/reference/doctor-rules#${code.toLowerCase()}` },
)

export const diagnostics: typeof viteHubDoctorDiagnostics.diagnostics = viteHubDoctorDiagnostics.diagnostics
