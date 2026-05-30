import type { EnvDiagnosticEntry, EnvDiagnostics } from "../types.ts"

function shouldTraceDiagnostics(option: EnvDiagnostics | undefined): boolean {
  return option === "trace" || process.env.VITEHUB_ENV_TRACE === "true"
}

export function formatDiagnostics(entries: EnvDiagnosticEntry[], option: EnvDiagnostics | undefined = "summary"): string | undefined {
  if (option === "off" || entries.length === 0) {
    return undefined
  }

  if (!shouldTraceDiagnostics(option)) {
    return `@vite-hub/env validated ${entries.length} declaration${entries.length === 1 ? "" : "s"}.`
  }

  return [
    "@vite-hub/env",
    ...entries.flatMap(entry => [
      entry.key,
      `  source: ${entry.source}`,
      `  mode: ${entry.mode}`,
      `  timing: ${entry.timing}`,
      `  exposed: ${entry.exposed}`,
      `  status: ${entry.status}`,
      entry.type ? `  type: ${entry.type}` : undefined,
      entry.masked ? "  value: ********" : undefined,
    ].filter(Boolean) as string[]),
  ].join("\n")
}
