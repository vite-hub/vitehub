import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { createMCPClient, type ListToolsResult } from "@ai-sdk/mcp"
import { generateText, isStepCount, type LanguageModel, type LanguageModelUsage, type StopCondition, type ToolSet } from "ai"

import { loadCases, validateCasesAgainstTools, type McpEvalTool } from "./eval/cases.ts"
import { caseVerdict, gradeSample, needsAnotherSample, type McpEvalCall, type McpEvalCase, type McpEvalCaseStatus, type McpEvalCheck } from "./eval/grade.ts"

export type { McpEvalCall, McpEvalCase, McpEvalCaseKind, McpEvalCaseStatus, McpEvalCheck, McpEvalExpect, McpEvalExpectedCall } from "./eval/grade.ts"

/** The `tools/list` result of the server, as the server sent it. */
export interface McpEvalToolList {
  tools: Array<McpEvalTool & { description?: string, [key: string]: unknown }>
  [key: string]: unknown
}

/** One problem that `check` found in the tool list. */
export interface McpEvalFinding {
  message: string
  tool?: string
}

export interface McpEvalUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface McpEvalStep {
  calls: McpEvalCall[]
  usage: McpEvalUsage
}

/** One row of `results.jsonl`. */
export interface McpEvalSample {
  id: string
  kind: McpEvalCase["kind"]
  model: string
  sample: number
  pass: boolean
  checks: McpEvalCheck[]
  calls: McpEvalCall[]
  finalText: string
  usage: McpEvalUsage
  steps: McpEvalStep[]
  error?: string
}

export interface McpEvalCaseResult {
  id: string
  kind: McpEvalCase["kind"]
  passRate: number | undefined
  status: McpEvalCaseStatus
  samples: McpEvalSample[]
}

export interface McpEvalReport {
  exitCode: 0 | 1
  outDir?: string
  problems: string[]
  findings: McpEvalFinding[]
  cases: McpEvalCaseResult[]
}

export interface McpEvalOptions<MODELS extends Record<string, LanguageModel>> {
  /** The remote MCP server. `headers` go with every request, such as `Authorization`. */
  server: { url: string | URL, headers?: Record<string, string> }
  /** An ndjson file path or URL with one case per line, or the cases. */
  cases: string | URL | McpEvalCase[]
  /** The models that can run the cases. `--model <key>` picks one. The first key is the default. */
  models: MODELS
  /** The system prompt. The `instructions` of the server's `initialize` answer follow it. */
  system?: string
  /** Checks the live `tools/list`. The findings are in the summary and in the dry run. */
  check?: (tools: McpEvalToolList) => McpEvalFinding[] | Promise<McpEvalFinding[]>
  /** The command line flags. Defaults to `process.argv.slice(2)`. */
  argv?: string[]
  /** The model steps of a case, when the case sets no `maxSteps`. Defaults to 8. */
  maxSteps?: number
}

const notExecuted = { content: [{ type: "text", text: "not executed: tool is not read-only" }], isError: true }
const largeResultChars = 50_000

function sumUsage(items: McpEvalUsage[]): McpEvalUsage {
  const total: McpEvalUsage = { input: 0, output: 0 }
  for (const item of items) {
    total.input += item.input
    total.output += item.output
    if (item.cacheRead !== undefined) total.cacheRead = (total.cacheRead ?? 0) + item.cacheRead
    if (item.cacheWrite !== undefined) total.cacheWrite = (total.cacheWrite ?? 0) + item.cacheWrite
  }
  return total
}

function toUsage(usage: LanguageModelUsage): McpEvalUsage {
  const { cacheReadTokens, cacheWriteTokens } = usage.inputTokenDetails
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    ...(cacheReadTokens !== undefined ? { cacheRead: cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWrite: cacheWriteTokens } : {}),
  }
}

function resultChars(output: unknown): number {
  if (typeof output === "string") return output.length
  if (typeof output !== "object" || output === null || !("content" in output) || !Array.isArray(output.content)) return JSON.stringify(output ?? null).length
  return output.content.reduce((total: number, part: unknown) => {
    const text = typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : JSON.stringify(part)
    return total + text.length
  }, 0)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function gitCommit(): string | undefined {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  }
  catch {
    return undefined
  }
}

function readFlags(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "case": { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      "max-tokens": { type: "string" },
      "model": { type: "string" },
      "out": { type: "string" },
      "samples": { type: "string" },
    },
  })
  const problems: string[] = []
  const count = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
    problems.push(`--${flag} must be a positive integer.`)
  }
  return {
    caseIds: values.case,
    dryRun: values["dry-run"] === true,
    maxTokens: count("max-tokens", values["max-tokens"]),
    model: values.model,
    out: values.out,
    problems,
    samples: count("samples", values.samples),
  }
}

async function listAllTools(client: Awaited<ReturnType<typeof createMCPClient>>): Promise<ListToolsResult> {
  const first = await client.listTools()
  const tools = [...first.tools]
  let cursor = first.nextCursor
  while (cursor) {
    const page = await client.listTools({ params: { cursor } })
    tools.push(...page.tools)
    cursor = page.nextCursor
  }
  return { ...first, tools }
}

function printList(title: string, lines: string[]) {
  if (!lines.length) return
  console.log(`\n${title}:`)
  for (const line of lines) console.log(`  - ${line}`)
}

function formatFinding(finding: McpEvalFinding): string {
  return finding.tool ? `${finding.tool}: ${finding.message}` : finding.message
}

function summarize(input: { url: string, model: string, toolList: McpEvalToolList, instructions: boolean, findings: McpEvalFinding[], results: McpEvalCaseResult[], stopped?: string }): string {
  const samples = input.results.flatMap(result => result.samples)
  const usage = sumUsage(samples.map(sample => sample.usage))
  const calls = samples.flatMap(sample => sample.calls.map(call => ({ call, sample })))
  const large = calls.filter(({ call }) => (call.resultChars ?? 0) > largeResultChars)
  const readOnly = input.toolList.tools.filter(tool => tool.annotations?.readOnlyHint === true).length
  const percent = (rate: number | undefined) => rate === undefined ? "n/a" : `${Math.round(rate * 100)}%`
  const lines = [
    "# MCP eval",
    "",
    `- Server: ${input.url}`,
    `- Commit: ${gitCommit() ?? "unknown"}`,
    `- Model: ${input.model}`,
    `- Tools: ${input.toolList.tools.length} (${readOnly} read-only)`,
    `- Server instructions: ${input.instructions ? "yes" : "no"}`,
    ...(input.stopped ? [`- Stopped: ${input.stopped}`] : []),
    "",
    "## Cases",
    "",
    "| Case | Kind | Samples | Pass rate | Status |",
    "| --- | --- | --- | --- | --- |",
    ...input.results.map(result => `| ${result.id} | ${result.kind} | ${result.samples.length} | ${percent(result.passRate)} | ${result.status} |`),
    "",
    "## By kind",
    "",
    "| Kind | Pass | Fail | Error |",
    "| --- | --- | --- | --- |",
    ...(["bad", "guard", "control"] as const).flatMap((kind) => {
      const ofKind = input.results.filter(result => result.kind === kind)
      if (!ofKind.length) return []
      const count = (status: McpEvalCaseStatus) => ofKind.filter(result => result.status === status).length
      return [`| ${kind} | ${count("pass")} | ${count("fail")} | ${count("error")} |`]
    }),
    "",
    "## Usage",
    "",
    `- Tokens: ${usage.input + usage.output} (input ${usage.input}, output ${usage.output}${usage.cacheRead !== undefined ? `, cache read ${usage.cacheRead}` : ""}${usage.cacheWrite !== undefined ? `, cache write ${usage.cacheWrite}` : ""})`,
    `- Tool calls: ${calls.length}`,
    `- Model steps: ${samples.reduce((total, sample) => total + sample.steps.length, 0)}`,
  ]
  if (large.length) {
    lines.push("", "## Large tool results", "")
    for (const { call, sample } of large) lines.push(`- ${sample.id} sample ${sample.sample}, ${call.tool}: ${call.resultChars} characters. Claude Code would move this result to a file.`)
  }
  if (input.findings.length) {
    lines.push("", "## Tool list findings", "")
    for (const finding of input.findings) lines.push(`- ${formatFinding(finding)}`)
  }
  lines.push("", "The model sees each input schema with `additionalProperties: false`, which `@ai-sdk/mcp` adds. Claude Code sends the schema as the server lists it.", "")
  return lines.join("\n")
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

/**
 * Runs tool-use evals against a remote MCP server. It reads the live `tools/list`, gives every tool to the model,
 * runs only the tools with `readOnlyHint: true`, and grades the calls and the final text of each case.
 * It writes `results.jsonl`, `tools.json`, and `summary.md` to `--out`, and sets `process.exitCode` to 1 when a case fails.
 * `--dry-run` checks the cases against the tool list without a model call.
 */
export async function runMcpEval<MODELS extends Record<string, LanguageModel>>(options: McpEvalOptions<MODELS>): Promise<McpEvalReport> {
  const report: McpEvalReport = { exitCode: 0, problems: [], findings: [], cases: [] }
  const done = (exitCode: 0 | 1) => {
    report.exitCode = exitCode
    if (exitCode) process.exitCode = 1
    return report
  }
  const flags = readFlags(options.argv ?? process.argv.slice(2))
  const modelKey = flags.model ?? Object.keys(options.models)[0]
  const model = modelKey === undefined ? undefined : options.models[modelKey]
  const loaded = await loadCases(options.cases)
  const cases = flags.caseIds ? loaded.cases.filter(testCase => flags.caseIds?.includes(testCase.id)) : loaded.cases
  report.problems.push(...flags.problems, ...loaded.problems)
  for (const id of flags.caseIds ?? []) {
    if (!loaded.cases.some(testCase => testCase.id === id)) report.problems.push(`--case ${id}: no case has this id.`)
  }
  if (!flags.dryRun && !model) report.problems.push(`--model ${modelKey ?? ""}: the models are ${Object.keys(options.models).join(", ") || "empty"}.`)

  const url = String(options.server.url)
  let client: Awaited<ReturnType<typeof createMCPClient>>
  try {
    client = await createMCPClient({ transport: { type: "http", url, headers: options.server.headers, redirect: "follow" } })
  }
  catch (error) {
    report.problems.push(`Cannot connect to ${url}: ${message(error)}`)
    printList("Problems", report.problems)
    return done(1)
  }

  try {
    const toolList = await listAllTools(client)
    report.findings = options.check ? await options.check(toolList) : []
    report.problems.push(...validateCasesAgainstTools(cases, toolList.tools))
    console.log(`${url}: ${count(toolList.tools.length, "tool")}, ${count(cases.length, "case")}${client.instructions ? ", server instructions" : ""}.`)
    printList("Tool list findings", report.findings.map(formatFinding))
    printList("Problems", report.problems)
    if (flags.dryRun || report.problems.length || !model || modelKey === undefined) return done(report.problems.length ? 1 : 0)

    const readOnly = new Set(toolList.tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name))
    const mcpTools = client.toolsFromDefinitions(toolList)
    const system = [options.system, client.instructions].filter(Boolean).join("\n\n") || undefined
    const outDir = resolve(flags.out ?? join(".data/mcp-eval", new Date().toISOString().replace(/[:.]/g, "-")))
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, "tools.json"), `${JSON.stringify(toolList, null, 2)}\n`)
    await writeFile(join(outDir, "results.jsonl"), "")
    report.outDir = outDir

    let spent = 0
    let stopped: string | undefined
    const overBudget = () => flags.maxTokens !== undefined && spent > flags.maxTokens

    const runSample = async (testCase: McpEvalCase, sample: number): Promise<McpEvalSample> => {
      const chars = new Map<string, number>()
      const tools: ToolSet = {}
      for (const [name, tool] of Object.entries(mcpTools)) {
        tools[name] = {
          ...tool,
          execute: async (args, callOptions) => {
            const output = readOnly.has(name) ? await tool.execute(args, callOptions) : notExecuted
            chars.set(callOptions.toolCallId, resultChars(output))
            return output
          },
        }
      }
      const budget: StopCondition<ToolSet> = ({ steps }) => flags.maxTokens !== undefined
        && spent + steps.reduce((total, step) => total + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0), 0) > flags.maxTokens
      const row: McpEvalSample = { id: testCase.id, kind: testCase.kind, model: modelKey, sample, pass: false, checks: [], calls: [], finalText: "", usage: { input: 0, output: 0 }, steps: [] }
      try {
        const result = await generateText({ model, system, prompt: testCase.prompt, tools, stopWhen: [isStepCount(testCase.maxSteps ?? options.maxSteps ?? 8), budget] })
        row.steps = result.steps.map(step => ({
          calls: step.toolCalls.map(call => ({
            tool: call.toolName,
            args: call.input,
            executed: readOnly.has(call.toolName) && chars.has(call.toolCallId),
            ...(chars.has(call.toolCallId) ? { resultChars: chars.get(call.toolCallId) } : {}),
          })),
          usage: toUsage(step.usage),
        }))
        row.calls = row.steps.flatMap(step => step.calls)
        row.usage = sumUsage(row.steps.map(step => step.usage))
        row.finalText = result.text
        row.checks = gradeSample(testCase.expect, row.calls, row.finalText)
        row.pass = row.checks.every(check => check.pass)
      }
      catch (error) {
        row.error = message(error)
      }
      spent += row.usage.input + row.usage.output
      return row
    }

    for (const testCase of cases) {
      const samples: McpEvalSample[] = []
      while (!stopped && needsAnotherSample(samples, flags.samples)) {
        if (overBudget()) {
          stopped = `--max-tokens ${flags.maxTokens} reached after ${spent} tokens.`
          break
        }
        const row = await runSample(testCase, samples.length + 1)
        samples.push(row)
        await writeFile(join(outDir, "results.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" })
        const outcome = row.error ? `error: ${row.error}` : row.pass ? "pass" : `fail: ${row.checks.filter(check => !check.pass).map(check => check.reason).join(" ")}`
        console.log(`${testCase.id} #${row.sample}: ${outcome} (${row.calls.length} calls, ${row.usage.input + row.usage.output} tokens)`)
      }
      if (!samples.length) break
      report.cases.push({ id: testCase.id, kind: testCase.kind, samples, ...caseVerdict(samples) })
    }

    const summary = summarize({ url, model: modelKey, toolList, instructions: Boolean(client.instructions), findings: report.findings, results: report.cases, stopped })
    await writeFile(join(outDir, "summary.md"), summary)
    console.log(`\n${summary}\nWrote ${outDir}`)
    const failed = report.cases.some(result => result.status !== "pass") || report.cases.length < cases.length
    return done(failed ? 1 : 0)
  }
  finally {
    await client.close()
  }
}
