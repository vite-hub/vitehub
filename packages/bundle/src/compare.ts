import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { bundleReportDir, readEnvironmentReportFolder } from "./files.ts"
import { createBundleReport } from "./report.ts"
import { isRecord } from "@vite-hub/internal/object"

import type { BundleComparison, BundleGroup, BundleGroupChange, BundleGroupSize, BundleReport, BundleSide, BundleSideComparison, BundleTotals } from "./types.ts"

function totals(side: BundleSide | undefined): BundleTotals {
  return side
    ? { bytes: side.bytes, gzip: side.gzip, startupBytes: side.startup.bytes, startupGzip: side.startup.gzip }
    : { bytes: 0, gzip: 0, startupBytes: 0, startupGzip: 0 }
}

function size(group: BundleGroup | undefined): BundleGroupSize {
  return { bytes: group?.bytes ?? 0, startupBytes: group?.startupBytes ?? 0 }
}

function groupChanges(before: readonly BundleGroup[], after: readonly BundleGroup[]): BundleGroupChange[] {
  const old = new Map(before.map(group => [group.name, group]))
  const current = new Map(after.map(group => [group.name, group]))
  const changes: BundleGroupChange[] = []
  for (const name of new Set([...old.keys(), ...current.keys()])) {
    const from = old.get(name)
    const to = current.get(name)
    const delta = { bytes: size(to).bytes - size(from).bytes, startupBytes: size(to).startupBytes - size(from).startupBytes }
    if (from && to && !delta.bytes && !delta.startupBytes) continue
    const change = !from ? "added" : !to ? "removed" : (delta.bytes || delta.startupBytes) > 0 ? "grew" : "shrank"
    changes.push({ name, kind: (to ?? from)!.kind, change, before: size(from), after: size(to), delta })
  }
  return changes.sort((left, right) => Math.abs(right.delta.bytes) - Math.abs(left.delta.bytes)
    || Math.abs(right.delta.startupBytes) - Math.abs(left.delta.startupBytes) || left.name.localeCompare(right.name))
}

function compareSide(before: BundleSide | undefined, after: BundleSide | undefined): BundleSideComparison | undefined {
  if (!before && !after) return undefined
  const from = totals(before)
  const to = totals(after)
  return {
    before: from,
    after: to,
    delta: { bytes: to.bytes - from.bytes, gzip: to.gzip - from.gzip, startupBytes: to.startupBytes - from.startupBytes, startupGzip: to.startupGzip - from.startupGzip },
    groups: groupChanges(before?.groups ?? [], after?.groups ?? []),
  }
}

/** What changed from `before` to `after`: the bytes of each side and of its startup code, and each group that changed. */
export function compareBundleReports(before: BundleReport, after: BundleReport): BundleComparison {
  const client = compareSide(before.client, after.client)
  const server = compareSide(before.server, after.server)
  return { schemaVersion: 1, builds: { before: before.build, after: after.build }, ...(client ? { client } : {}), ...(server ? { server } : {}) }
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isBundleGroup(value: unknown): value is BundleGroup {
  return isRecord(value) && typeof value.name === "string"
    && typeof value.kind === "string" && ["app", "dependency", "framework", "generated", "vitehub"].includes(value.kind)
    && isSize(value.bytes) && isSize(value.startupBytes) && isSize(value.modules)
}

function isBundleSide(value: unknown): value is BundleSide {
  return isRecord(value)
    && Array.isArray(value.environments) && value.environments.every(environment => typeof environment === "string")
    && isSize(value.bytes) && isSize(value.gzip) && isSize(value.chunks)
    && isRecord(value.startup) && isSize(value.startup.bytes) && isSize(value.startup.gzip) && isSize(value.startup.chunks)
    && Array.isArray(value.groups) && value.groups.every(isBundleGroup)
}

function isBundleReport(value: unknown): value is BundleReport {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.build === "string" && !("chunks" in value)
    && (value.client === undefined || isBundleSide(value.client))
    && (value.server === undefined || isBundleSide(value.server))
}

/**
 * Reads a report to compare with. `path` is the output of `vitehub bundle --json`, a copy of `.vitehub/bundle/`, or a
 * project root that has `.vitehub/bundle/`. Returns `undefined` when `path` holds no report.
 */
export function readSavedBundleReport(path: string): BundleReport | undefined {
  if (!existsSync(path)) return undefined
  if (statSync(path).isDirectory()) {
    const folder = existsSync(join(path, bundleReportDir)) ? join(path, bundleReportDir) : path
    return createBundleReport(readEnvironmentReportFolder(folder))
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isBundleReport(value) ? value : undefined
  }
  catch {
    return undefined
  }
}
