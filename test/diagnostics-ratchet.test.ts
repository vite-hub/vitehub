import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { expect, it } from "vitest"

import { readDiagnosticCodes } from "../docs/modules/diagnostics/catalog.ts"

const repoRoot = resolve(import.meta.dirname, "..")
const baselineFile = join(import.meta.dirname, "fixtures/diagnostics-ratchet.json")
// Lower the baseline after you remove plain errors or add fixes:
// VITEHUB_UPDATE_DIAGNOSTICS_BASELINE=1 vp test --config vitest.config.ts test/diagnostics-ratchet.test.ts
// A lower count never fails, so a PR that removes errors can merge before the baseline changes.
const update = process.env.VITEHUB_UPDATE_DIAGNOSTICS_BASELINE === "1"

/** A plain error that the reader of an app sees has no code, fix, or docs link. */
const rawError = /\bthrow new (?:Error|TypeError|RangeError|SyntaxError)\(|\bclass \w+ extends (?:Error|TypeError)\b/
/** The comment that marks a plain error as an internal invariant. It must say why. */
const internalMarker = /\/\/ Internal invariant: \S/

interface Baseline {
  /** Plain errors by source file. */
  rawErrors: Record<string, number>
  /** Diagnostic codes without a `fix`, by package. */
  codesWithoutFix: Record<string, number>
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:[cm]?ts|vue)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
    .map(entry => join(entry.parentPath, entry.name))
}

function countRawErrors(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const pkg of readdirSync(join(repoRoot, "packages"))) {
    for (const file of sourceFiles(join(repoRoot, "packages", pkg, "src"))) {
      const lines = readFileSync(file, "utf8").split("\n")
      const count = lines.filter((line, index) => rawError.test(line) && !internalMarker.test(line) && !internalMarker.test(lines[index - 1] ?? "")).length
      if (count) counts[relative(repoRoot, file)] = count
    }
  }
  return sortKeys(counts)
}

function countCodesWithoutFix(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const code of readDiagnosticCodes(repoRoot)) {
    if (!code.fix) counts[code.pkg] = (counts[code.pkg] ?? 0) + 1
  }
  return sortKeys(counts)
}

function sortKeys(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

/** Each key whose count differs from the baseline, with both counts. */
function changes(current: Record<string, number>, baseline: Record<string, number>) {
  return [...new Set([...Object.keys(current), ...Object.keys(baseline)])]
    .filter(key => (current[key] ?? 0) !== (baseline[key] ?? 0))
    .map(key => ({ key, baseline: baseline[key] ?? 0, current: current[key] ?? 0 }))
}

const current: Baseline = { rawErrors: countRawErrors(), codesWithoutFix: countCodesWithoutFix() }
if (update) writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`)
const baseline: Baseline = JSON.parse(readFileSync(baselineFile, "utf8"))

it("adds no plain errors to package sources", () => {
  const added = changes(current.rawErrors, baseline.rawErrors).filter(change => change.current > change.baseline)
  expect(added, [
    "These files throw more plain errors than test/fixtures/diagnostics-ratchet.json allows.",
    "Throw a code from the package catalog (src/error-diagnostics.ts) with a `why`, a `fix`, and its docs page.",
    "Keep a plain error only for a ViteHub bug or a value caught in the same module, and put `// Internal invariant: <reason>` on the line above it.",
  ].join(" ")).toEqual([])
})

it("adds no diagnostic codes without a fix", () => {
  const added = changes(current.codesWithoutFix, baseline.codesWithoutFix).filter(change => change.current > change.baseline)
  expect(added, "These packages have more diagnostic codes without a `fix` than test/fixtures/diagnostics-ratchet.json allows. Give each new code a `fix` that tells the reader what to change with `{ why, fix }` in its catalog entry.").toEqual([])
})

