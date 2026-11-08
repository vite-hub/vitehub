import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { BundleEnvironmentReport } from "./types.ts"

/** Folder of the environment reports, relative to the project root. */
export const bundleReportDir = ".vitehub/bundle"

function isReport(value: unknown): value is BundleEnvironmentReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "schemaVersion") === 1
    && typeof Reflect.get(value, "build") === "string" && typeof Reflect.get(value, "environment") === "string"
    && Array.isArray(Reflect.get(value, "chunks"))
}

/** Reads every environment report in `.vitehub/bundle/`. A file that is not a report is skipped. */
export function readEnvironmentReports(root: string): BundleEnvironmentReport[] {
  const dir = join(root, bundleReportDir)
  let files: string[]
  try {
    files = readdirSync(dir).filter(file => file.endsWith(".json"))
  }
  catch {
    return []
  }
  return files.flatMap((file) => {
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"))
      return isReport(value) ? [value] : []
    }
    catch {
      return []
    }
  })
}

/** Writes the report of one environment and removes the reports of older builds. */
export function writeEnvironmentReport(root: string, report: BundleEnvironmentReport): void {
  const dir = join(root, bundleReportDir)
  mkdirSync(dir, { recursive: true })
  for (const old of readEnvironmentReports(root)) {
    if (old.build !== report.build) rmSync(join(dir, `${old.environment}.json`), { force: true })
  }
  writeFileSync(join(dir, `${report.environment}.json`), `${JSON.stringify(report)}\n`)
}
