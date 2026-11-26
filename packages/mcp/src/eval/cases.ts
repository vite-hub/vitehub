import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import type { McpEvalCase, McpEvalCaseKind, McpEvalExpect, McpEvalExpectedCall } from "./grade.ts"

export interface McpEvalTool {
  name: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
}

const kinds = new Set(["bad", "guard", "control"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

function isKind(value: unknown): value is McpEvalCaseKind {
  return typeof value === "string" && kinds.has(value)
}

function readCall(value: unknown): McpEvalExpectedCall | undefined {
  if (!isRecord(value) || typeof value.tool !== "string") return
  if (value.args === undefined) return { tool: value.tool }
  return isRecord(value.args) ? { tool: value.tool, args: value.args } : undefined
}

function parseExpect(value: unknown, id: string, problems: string[]): McpEvalExpect {
  if (!isRecord(value)) {
    problems.push(`${id}: "expect" must be an object.`)
    return {}
  }
  const expect: McpEvalExpect = {}
  if (value.calls !== undefined) {
    const calls = Array.isArray(value.calls) ? value.calls.map(readCall) : [undefined]
    if (calls.every(call => call !== undefined)) expect.calls = calls
    else problems.push(`${id}: "expect.calls" must be a list of { "tool": string, "args"?: object }.`)
  }
  for (const key of ["notCalls", "finalTextMust", "finalTextMustNot"] as const) {
    const list = value[key]
    if (list === undefined) continue
    if (isStringList(list)) expect[key] = list
    else problems.push(`${id}: "expect.${key}" must be a list of strings.`)
  }
  if (value.maxCalls !== undefined) {
    if (typeof value.maxCalls === "number" && Number.isInteger(value.maxCalls) && value.maxCalls >= 0) expect.maxCalls = value.maxCalls
    else problems.push(`${id}: "expect.maxCalls" must be an integer of 0 or more.`)
  }
  return expect
}

function parseCase(value: unknown, label: string, problems: string[]): McpEvalCase | undefined {
  if (!isRecord(value)) {
    problems.push(`${label}: a case must be an object.`)
    return
  }
  const before = problems.length
  const { id, kind, origin, prompt, maxSteps, notes } = value
  const name = typeof id === "string" && id ? id : label
  if (typeof id !== "string" || !id) problems.push(`${label}: "id" must be a non-empty string.`)
  if (!isKind(kind)) problems.push(`${name}: "kind" must be "bad", "guard", or "control".`)
  if (!isRecord(origin)) problems.push(`${name}: "origin" must be an object, such as { "type": "issue", "url": "..." }.`)
  if (typeof prompt !== "string" || !prompt) problems.push(`${name}: "prompt" must be a non-empty string.`)
  const validSteps = maxSteps === undefined || (typeof maxSteps === "number" && Number.isInteger(maxSteps) && maxSteps >= 1)
  if (!validSteps) problems.push(`${name}: "maxSteps" must be a positive integer.`)
  if (notes !== undefined && typeof notes !== "string") problems.push(`${name}: "notes" must be a string.`)
  const expect = parseExpect(value.expect, name, problems)
  if (problems.length > before || typeof id !== "string" || !isKind(kind) || !isRecord(origin) || typeof prompt !== "string") return
  return {
    id,
    kind,
    origin,
    prompt,
    expect,
    ...(typeof maxSteps === "number" ? { maxSteps } : {}),
    ...(typeof notes === "string" ? { notes } : {}),
  }
}

async function readCasesText(source: string | URL): Promise<{ text: string } | { problem: string }> {
  const url = source instanceof URL ? source : /^(?:https?|file):/.test(source) && URL.canParse(source) ? new URL(source) : undefined
  try {
    if (!url || url.protocol === "file:") return { text: await readFile(url ? fileURLToPath(url) : source, "utf8") }
    const response = await fetch(url)
    return response.ok ? { text: await response.text() } : { problem: `GET ${url.href} answered ${response.status}.` }
  }
  catch (error) {
    return { problem: `Cannot read the cases: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function loadCases(source: string | URL | McpEvalCase[]): Promise<{ cases: McpEvalCase[], problems: string[] }> {
  const rows: Array<{ label: string, value: unknown }> = []
  const problems: string[] = []
  if (Array.isArray(source)) {
    source.forEach((value, index) => rows.push({ label: `case ${index + 1}`, value }))
  }
  else {
    const read = await readCasesText(source)
    if ("problem" in read) return { cases: [], problems: [read.problem] }
    read.text.split("\n").forEach((line, index) => {
      if (!line.trim()) return
      try {
        rows.push({ label: `line ${index + 1}`, value: JSON.parse(line) })
      }
      catch (error) {
        problems.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }
  const cases: McpEvalCase[] = []
  const ids = new Set<string>()
  for (const { label, value } of rows) {
    const parsed = parseCase(value, label, problems)
    if (!parsed) continue
    if (ids.has(parsed.id)) problems.push(`${parsed.id}: two cases have this id.`)
    ids.add(parsed.id)
    cases.push(parsed)
  }
  if (!rows.length && !problems.length) problems.push("No cases.")
  return { cases, problems }
}

function schemaHasPath(schema: unknown, path: string): boolean {
  let current = schema
  for (const key of path.split(".")) {
    if (current === false) return false
    if (!isRecord(current)) return true
    if (isRecord(current.properties) && Object.hasOwn(current.properties, key)) {
      current = current.properties[key]
    }
    else {
      if (isRecord(current.patternProperties) && Object.keys(current.patternProperties).length) return true
      current = current.additionalProperties
    }
  }
  return current !== false
}

export function validateCasesAgainstTools(cases: McpEvalCase[], tools: McpEvalTool[]): string[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const problems: string[] = []
  for (const testCase of cases) {
    for (const call of testCase.expect.calls ?? []) {
      const tool = byName.get(call.tool)
      if (!tool) {
        problems.push(`${testCase.id}: expect.calls names "${call.tool}", which is not in tools/list.`)
        continue
      }
      for (const key of Object.keys(call.args ?? {})) {
        if (!schemaHasPath(tool.inputSchema, key)) problems.push(`${testCase.id}: "${key}" is not in the input schema of "${call.tool}".`)
      }
    }
    for (const name of testCase.expect.notCalls ?? []) {
      if (!byName.has(name)) problems.push(`${testCase.id}: expect.notCalls names "${name}", which is not in tools/list.`)
    }
  }
  return problems
}
