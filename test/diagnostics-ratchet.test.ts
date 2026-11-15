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
const rawErrors = /\bthrow\s+new\s+(?:Error|TypeError|RangeError|SyntaxError)\s*\(|\bclass\s+\w+\s+extends\s+(?:Error|TypeError|RangeError|SyntaxError)\b/g
/** The comment that marks a plain error as an internal invariant. It must say why. */
const internalMarker = /\/\/ Internal invariant: \S/
/** A call of `invariant()` or `invariantError()` from `@vite-hub/internal/invariant`: a state that only a ViteHub bug can reach. */
const invariantCalls = /\binvariant(?:Error)?\(/g

interface Baseline {
  /** Plain errors by source file. */
  rawErrors: Record<string, number>
  /** Diagnostic codes without a `fix`. A list, so a fix for one code does not allow a new code without a fix. */
  codesWithoutFix: string[]
  /** `INTERNAL_INVARIANT_FAILED` sites by source file, so each new one shows in review. */
  invariants: Record<string, number>
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    // A `*.injected.ts` file holds source text that runs elsewhere, such as a CDP script or generated app code, so its errors stay plain.
    .filter(entry => entry.isFile() && /\.(?:[cm]?ts|vue)$/.test(entry.name) && !/\.(?:d|injected)\.ts$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
}

function countRawErrors(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const pkg of readdirSync(join(repoRoot, "packages"))) {
    for (const file of sourceFiles(join(repoRoot, "packages", pkg, "src"))) {
      const lines = readFileSync(file, "utf8").split("\n")
      // Count each match, so a second throw on a line that already has one still counts.
      const count = lines.reduce((sum, line, index) => internalMarker.test(line) || internalMarker.test(lines[index - 1] ?? "")
        ? sum
        : sum + (line.match(rawErrors)?.length ?? 0), 0)
      if (count) counts[relative(repoRoot, file)] = count
    }
  }
  return sortKeys(counts)
}

function countInvariants(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const pkg of readdirSync(join(repoRoot, "packages"))) {
    for (const file of sourceFiles(join(repoRoot, "packages", pkg, "src"))) {
      const count = readFileSync(file, "utf8").match(invariantCalls)?.length ?? 0
      if (count && !file.endsWith(join("internal", "src", "invariant.ts"))) counts[relative(repoRoot, file)] = count
    }
  }
  return sortKeys(counts)
}

function codesWithoutFix(): string[] {
  return readDiagnosticCodes(repoRoot).filter(code => !code.fix).map(code => code.code).sort()
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

const current: Baseline = { rawErrors: countRawErrors(), codesWithoutFix: codesWithoutFix(), invariants: countInvariants() }
if (update) writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`)
const baseline: Baseline = JSON.parse(readFileSync(baselineFile, "utf8"))

it("adds no plain errors to package sources", () => {
  const added = changes(current.rawErrors, baseline.rawErrors).filter(change => change.current > change.baseline)
  expect(added, [
    "These files throw more plain errors than test/fixtures/diagnostics-ratchet.json allows.",
    "Throw a code from the package catalog (src/error-diagnostics.ts) with a `why`, a `fix`, and its docs page.",
    "For a state that only a ViteHub bug can reach, throw `invariantError(what)` or call `invariant(condition, what)` from `@vite-hub/internal/invariant`.",
  ].join(" ")).toEqual([])
})

it("adds no invariant without a baseline change", () => {
  const added = changes(current.invariants, baseline.invariants ?? {}).filter(change => change.current > change.baseline)
  expect(added, "These files raise INTERNAL_INVARIANT_FAILED more often than test/fixtures/diagnostics-ratchet.json lists. Use it only for a state that a developer cannot cause; otherwise throw a code from the package catalog. Then update the baseline with the command at the top of this test.").toEqual([])
})

it("adds no diagnostic codes without a fix", () => {
  const added = current.codesWithoutFix.filter(code => !baseline.codesWithoutFix.includes(code))
  expect(added, "These diagnostic codes have no `fix` and are not in test/fixtures/diagnostics-ratchet.json. Give each new code a `fix` that tells the reader what to change with `{ why, fix }` in its catalog entry.").toEqual([])
})

