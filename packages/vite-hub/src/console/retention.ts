import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

/** D1 reports the size of the whole app database, not of the journal, so the D1 Console journal cannot apply maxSize. */
export function consoleD1MaxSizeError(): Error {
  return viteHubErrorDiagnostics.VITE_HUB_B0016({ message: "[vitehub] console.retention.maxSize is not supported by the D1 Console journal, because D1 reports the size of the whole app database. Use maxAge or maxRecords, or set console.databaseUrl to a SQLite file." })
}
