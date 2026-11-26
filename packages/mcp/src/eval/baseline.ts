import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import type { McpEvalCase, McpEvalCaseKind, McpEvalCaseStatus } from "./grade.ts"

export interface McpEvalRunCase {
  id: string
  kind: McpEvalCaseKind
  hash: string
  samples: number
  passed: number
  passRate?: number
  status: McpEvalCaseStatus
}

export interface McpEvalRunUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** The `run.json` of a model run. Commit it, then pass it to `--baseline`. */
export interface McpEvalRun {
  version: 1
  server: string
  surface: string
  model: string
  modelId?: string
  commit?: string
  date: string
  cases: McpEvalRunCase[]
  usage: McpEvalRunUsage
  toolCalls: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sorted(value[key])]))
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sorted(value)) ?? "null").digest("hex")
}

export function surfaceHash(tools: unknown[], instructions: string | undefined): string {
  return sha256({ instructions: instructions ?? null, tools })
}

export function caseHash(testCase: McpEvalCase): string {
  return sha256({ id: testCase.id, kind: testCase.kind, prompt: testCase.prompt, expect: testCase.expect, maxSteps: testCase.maxSteps })
}

function isRunCase(value: unknown): value is McpEvalRunCase {
  return isRecord(value) && typeof value.id === "string" && typeof value.hash === "string"
    && typeof value.samples === "number" && typeof value.passed === "number" && typeof value.status === "string"
    && (value.passRate === undefined || typeof value.passRate === "number")
}

function isRun(value: unknown): value is McpEvalRun {
  return isRecord(value) && value.version === 1 && typeof value.surface === "string" && typeof value.model === "string"
    && Array.isArray(value.cases) && value.cases.every(isRunCase)
}

export async function readBaseline(path: string): Promise<{ run: McpEvalRun } | { problem: string }> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return isRun(value) ? { run: value } : { problem: `--baseline ${path}: the file is not the run.json of an MCP eval run (version 1).` }
  }
  catch (error) {
    return { problem: `--baseline ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function staleCases(cases: McpEvalCase[], baseline: McpEvalRun): string[] {
  const before = new Map(baseline.cases.map(testCase => [testCase.id, testCase.hash]))
  const now = new Set(cases.map(testCase => testCase.id))
  const stale: string[] = []
  for (const testCase of cases) {
    const hash = before.get(testCase.id)
    if (hash === undefined) stale.push(`${testCase.id}: the case is not in the baseline.`)
    else if (hash !== caseHash(testCase)) stale.push(`${testCase.id}: the case changed since the baseline.`)
  }
  for (const testCase of baseline.cases) {
    if (!now.has(testCase.id)) stale.push(`${testCase.id}: the baseline has this case, but the cases do not.`)
  }
  return stale
}

export function isRegression(baseline: McpEvalRunCase | undefined, passRate: number | undefined): boolean {
  return baseline !== undefined && baseline.samples > 0 && baseline.passed === baseline.samples && passRate !== undefined && passRate <= 0.5
}
