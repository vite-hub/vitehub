import type { RuntimeConfigDiagnosticEntry, RuntimeConfigDiagnostics } from "../types.ts"

export function shouldTraceDiagnostics(option: RuntimeConfigDiagnostics | undefined): boolean {
  return option === "trace" || process.env.VITEHUB_RUNTIME_CONFIG_TRACE === "true"
}

export function formatDiagnostics(entries: RuntimeConfigDiagnosticEntry[], option: RuntimeConfigDiagnostics | undefined = "summary"): string | undefined {
  if (option === "off") {
    return undefined
  }
  if (!entries.length) {
    return undefined
  }

  if (!shouldTraceDiagnostics(option)) {
    return `@vitehub/runtime-config validated ${entries.length} declaration${entries.length === 1 ? "" : "s"}.`
  }

  return [
    "@vitehub/runtime-config",
    ...entries.flatMap(entry => [
      entry.key,
      `  source: ${entry.source}`,
      `  timing: ${entry.timing}`,
      `  exposed: ${entry.exposed}`,
      `  status: ${entry.status}`,
      entry.type ? `  type: ${entry.type}` : undefined,
      entry.masked ? "  value: ********" : undefined,
    ].filter(Boolean) as string[]),
  ].join("\n")
}
