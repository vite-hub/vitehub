import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { createMCPClient, MCPClientError, type ListToolsResult } from "@ai-sdk/mcp"
import { generateText, type LanguageModel, type LanguageModelUsage, type StopCondition, type ToolSet } from "ai"

import { caseHash, isRegression, readBaseline, staleCases, surfaceHash, type McpEvalRun, type McpEvalRunCase } from "./eval/baseline.ts"
import { loadCases, validateCasesAgainstTools, type McpEvalTool } from "./eval/cases.ts"
import { caseVerdict, gradeSample, needsAnotherSample, type McpEvalCall, type McpEvalCase, type McpEvalCaseStatus, type McpEvalCheck } from "./eval/grade.ts"

export type { McpEvalRun, McpEvalRunCase, McpEvalRunUsage } from "./eval/baseline.ts"
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
  /** The sha256 of the live `tools/list` tools and the server instructions. */
  surface?: string
  problems: string[]
  findings: McpEvalFinding[]
  cases: McpEvalCaseResult[]
  /** What `--baseline` found: the cases that regressed, and why a dry run is stale. */
  baseline?: { stale: string[], regressions: string[], warnings: string[] }
  run?: McpEvalRun
}

export interface McpEvalOptions<MODELS extends Record<string, LanguageModel>> {
  /** The final MCP endpoint URL. Redirects are not followed. `headers` go with every request. */
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
      "baseline": { type: "string" },
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
    baseline: values.baseline,
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

async function connect(url: string, headers?: Record<string, string>) {
  const transport = { type: "http", url, headers, redirect: "error" } as const
  try {
    return await createMCPClient({ transport })
  }
  catch (error) {
    if (!MCPClientError.isInstance(error) || error.code !== -32022) throw error
    const data = error.data
    if (!data || typeof data !== "object" || !("supported" in data) || !Array.isArray(data.supported)
      || !data.supported.some(version => version === "2025-11-25" || version === "2025-06-18")) throw error
    return createMCPClient({ transport, protocolVersionDiscovery: false })
  }
}

function printList(title: string, lines: string[]) {
  if (!lines.length) return
  console.log(`\n${title}:`)
  for (const line of lines) console.log(`  - ${line}`)
}

function formatFinding(finding: McpEvalFinding): string {
  return finding.tool ? `${finding.tool}: ${finding.message}` : finding.message
}

interface SummaryInput {
  url: string
  commit: string | undefined
  model: string
  surface: string
  toolList: McpEvalToolList
  instructions: boolean
  findings: McpEvalFinding[]
  results: McpEvalCaseResult[]
  stopped?: string
  baseline?: { path: string, run: McpEvalRun, regressions: string[], warnings: string[] }
}

function points(rate: number | undefined, before: number | undefined): string {
  if (rate === undefined || before === undefined) return "n/a"
  const delta = Math.round((rate - before) * 100)
  return delta > 0 ? `+${delta}` : String(delta)
}

function summarize(input: SummaryInput): string {
  const samples = input.results.flatMap(result => result.samples)
  const usage = sumUsage(samples.map(sample => sample.usage))
  const calls = samples.flatMap(sample => sample.calls.map(call => ({ call, sample })))
  const large = calls.filter(({ call }) => (call.resultChars ?? 0) > largeResultChars)
  const readOnly = input.toolList.tools.filter(tool => tool.annotations?.readOnlyHint === true).length
  const percent = (rate: number | undefined) => rate === undefined ? "n/a" : `${Math.round(rate * 100)}%`
  const baseline = input.baseline
  const before = new Map(baseline?.run.cases.map(testCase => [testCase.id, testCase]))
  const caseRow = (result: McpEvalCaseResult) => {
    const status = baseline?.regressions.includes(result.id) ? `${result.status}, regression` : result.status
    if (!baseline) return `| ${result.id} | ${result.kind} | ${result.samples.length} | ${percent(result.passRate)} | ${status} |`
    const old = before.get(result.id)
    return `| ${result.id} | ${result.kind} | ${result.samples.length} | ${percent(result.passRate)} | ${percent(old?.passRate)} | ${points(result.passRate, old?.passRate)} | ${status} |`
  }
  const lines = [
    "# MCP eval",
    "",
    `- Server: ${input.url}`,
    `- Commit: ${input.commit ?? "unknown"}`,
    `- Model: ${input.model}`,
    `- Tools: ${input.toolList.tools.length} (${readOnly} read-only)`,
    `- Server instructions: ${input.instructions ? "yes" : "no"}`,
    `- Surface: ${input.surface}`,
    ...(baseline ? [`- Baseline: ${baseline.path} (${baseline.run.model}, ${baseline.run.commit ?? "unknown commit"}, ${baseline.run.date})`] : []),
    ...(input.stopped ? [`- Stopped: ${input.stopped}`] : []),
    ...(baseline?.warnings.length ? ["", ...baseline.warnings.map(warning => `> [!WARNING]\n> ${warning}`)] : []),
    "",
    "## Cases",
    "",
    baseline ? "| Case | Kind | Samples | Pass rate | Baseline | Delta | Status |" : "| Case | Kind | Samples | Pass rate | Status |",
    baseline ? "| --- | --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- |",
    ...input.results.map(caseRow),
    "",
    "## By kind",
    "",
    "| Kind | Pass | Fail | Error | Incomplete |",
    "| --- | --- | --- | --- | --- |",
    ...(["bad", "guard", "control"] as const).flatMap((kind) => {
      const ofKind = input.results.filter(result => result.kind === kind)
      if (!ofKind.length) return []
      const count = (status: McpEvalCaseStatus) => ofKind.filter(result => result.status === status).length
      return [`| ${kind} | ${count("pass")} | ${count("fail")} | ${count("error")} | ${count("incomplete")} |`]
    }),
    "",
    "## Usage",
    "",
    `- Tokens: ${usage.input + usage.output} (input ${usage.input}, output ${usage.output}${usage.cacheRead !== undefined ? `, cache read ${usage.cacheRead}` : ""}${usage.cacheWrite !== undefined ? `, cache write ${usage.cacheWrite}` : ""})`,
    `- Tool calls: ${calls.length}`,
    `- Model steps: ${samples.reduce((total, sample) => total + sample.steps.length, 0)}`,
  ]
  if (baseline?.regressions.length) {
    lines.push("", "## Regressions", "")
    for (const id of baseline.regressions) lines.push(`- ${id} passed every baseline sample and fails now.`)
  }
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
 * It writes `results.jsonl`, `tools.json`, and `summary.md` to `--out`, and sets `process.exitCode` to 1 when a case does not pass.
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

  const baseline = flags.baseline === undefined ? undefined : await readBaseline(flags.baseline)
  if (baseline && "problem" in baseline) report.problems.push(baseline.problem)

  const url = String(options.server.url)
  let client: Awaited<ReturnType<typeof createMCPClient>>
  try {
    client = await connect(url, options.server.headers)
  }
  catch (error) {
    report.problems.push(`Cannot connect to ${url}: ${message(error)}`)
    printList("Problems", report.problems)
    return done(1)
  }

  try {
    const toolList = await listAllTools(client)
    const surface = surfaceHash(toolList.tools, client.instructions)
    report.surface = surface
    report.findings = options.check ? await options.check(toolList) : []
    report.problems.push(...validateCasesAgainstTools(cases, toolList.tools))
    console.log(`${url}: ${count(toolList.tools.length, "tool")}, ${count(cases.length, "case")}${client.instructions ? ", server instructions" : ""}, surface ${surface.slice(0, 12)}.`)
    printList("Tool list findings", report.findings.map(formatFinding))
    printList("Problems", report.problems)
    if (report.problems.length) return done(1)

    const base = baseline && "run" in baseline ? { path: flags.baseline ?? "", run: baseline.run } : undefined
    const surfaceChanged = base !== undefined && base.run.surface !== surface
    if (flags.dryRun) {
      if (!base) return done(0)
      const stale = [
        ...(surfaceChanged ? [`The tool list or the server instructions changed: surface ${surface.slice(0, 12)}, the baseline has ${base.run.surface.slice(0, 12)}.`] : []),
        ...staleCases(loaded.cases, base.run),
      ]
      report.baseline = { stale, regressions: [], warnings: [] }
      if (!stale.length) {
        console.log(`\nThe baseline ${base.path} matches the tool list and the cases.`)
        return done(0)
      }
      printList(`The baseline ${base.path} is stale. Run the eval with a model and commit the new run.json`, stale)
      return done(1)
    }
    if (!model || modelKey === undefined) return done(1)

    const warnings = [
      ...(base && base.run.model !== modelKey ? [`The baseline used the model "${base.run.model}", and this run uses "${modelKey}". Compare runs of the same model.`] : []),
      ...(surfaceChanged ? ["The tool list or the server instructions changed since the baseline."] : []),
    ]
    printList("Baseline warnings", warnings)

    const readOnly = new Set(toolList.tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name))
    const mcpTools = client.toolsFromDefinitions(toolList)
    const system = [options.system, client.instructions].filter(Boolean).join("\n\n") || undefined
    const outDir = resolve(flags.out ?? join(".data/mcp-eval", new Date().toISOString().replace(/[:.]/g, "-")))
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, "tools.json"), `${JSON.stringify(toolList, null, 2)}\n`)
    await writeFile(join(outDir, "results.jsonl"), "")
    report.outDir = outDir

    let spent = 0
    const runCases: McpEvalRunCase[] = []
    let stopped: string | undefined
    const overBudget = (tokens: number) => flags.maxTokens !== undefined && tokens > flags.maxTokens
    const stopForBudget = (tokens: number) => {
      stopped = `--max-tokens ${flags.maxTokens} reached after ${tokens} tokens.`
    }

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
      const row: McpEvalSample = { id: testCase.id, kind: testCase.kind, model: modelKey, sample, pass: false, checks: [], calls: [], finalText: "", usage: { input: 0, output: 0 }, steps: [] }
      const stepLimit = testCase.maxSteps ?? options.maxSteps ?? 8
      const stopWhen: StopCondition<ToolSet> = ({ steps }) => {
        if (steps.length === stepLimit) return true
        const tokens = spent + steps.reduce((total, step) => total + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0), 0)
        if (!overBudget(tokens)) return false
        stopForBudget(tokens)
        return true
      }
      try {
        const result = await generateText({
          model, system, prompt: testCase.prompt, tools, stopWhen,
          onStepEnd: (step) => {
            const calls = step.toolCalls.map(call => ({
              tool: call.toolName,
              args: call.input,
              executed: readOnly.has(call.toolName) && chars.has(call.toolCallId),
              ...(chars.has(call.toolCallId) ? { resultChars: chars.get(call.toolCallId) } : {}),
            }))
            row.steps.push({ calls, usage: toUsage(step.usage) })
            row.calls.push(...calls)
          },
        })
        row.finalText = result.text
        row.checks = gradeSample(testCase.expect, row.calls, row.finalText)
        row.pass = row.checks.every(check => check.pass)
      }
      catch (error) {
        row.error = message(error)
      }
      row.usage = sumUsage(row.steps.map(step => step.usage))
      spent += row.usage.input + row.usage.output
      return row
    }

    for (const testCase of cases) {
      if (stopped) break
      const samples: McpEvalSample[] = []
      while (!stopped && needsAnotherSample(samples, flags.samples)) {
        if (overBudget(spent)) {
          stopForBudget(spent)
          break
        }
        const row = await runSample(testCase, samples.length + 1)
        samples.push(row)
        await writeFile(join(outDir, "results.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" })
        const outcome = row.error ? `error: ${row.error}` : row.pass ? "pass" : `fail: ${row.checks.filter(check => !check.pass).map(check => check.reason).join(" ")}`
        console.log(`${testCase.id} #${row.sample}: ${outcome} (${row.calls.length} calls, ${row.usage.input + row.usage.output} tokens)`)
      }
      if (!samples.length) break
      const verdict = caseVerdict(samples)
      const status = stopped ? "incomplete" : verdict.status
      const graded = samples.filter(sample => !sample.error)
      report.cases.push({ id: testCase.id, kind: testCase.kind, samples, ...verdict, status })
      runCases.push({
        id: testCase.id,
        kind: testCase.kind,
        hash: caseHash(testCase),
        samples: graded.length,
        passed: graded.filter(sample => sample.pass).length,
        ...(verdict.passRate !== undefined ? { passRate: verdict.passRate } : {}),
        status,
      })
    }

    const commit = gitCommit()
    const regressions = base ? runCases.filter(result => isRegression(base.run.cases.find(old => old.id === result.id), result.passRate)).map(result => result.id) : []
    if (base) report.baseline = { stale: [], regressions, warnings }
    const samples = report.cases.flatMap(result => result.samples)
    const run: McpEvalRun = {
      version: 1,
      server: url,
      surface,
      model: modelKey,
      ...(typeof model === "string" ? { modelId: model } : { modelId: model.modelId }),
      ...(commit ? { commit } : {}),
      date: new Date().toISOString(),
      cases: runCases,
      usage: sumUsage(samples.map(sample => sample.usage)),
      toolCalls: samples.reduce((total, sample) => total + sample.calls.length, 0),
    }
    report.run = run
    await writeFile(join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
    const summary = summarize({
      url,
      commit,
      model: modelKey,
      surface,
      toolList,
      instructions: Boolean(client.instructions),
      findings: report.findings,
      results: report.cases,
      stopped,
      ...(base ? { baseline: { ...base, regressions, warnings } } : {}),
    })
    await writeFile(join(outDir, "summary.md"), summary)
    console.log(`\n${summary}\nWrote ${outDir}`)
    const failed = report.cases.some(result => result.status !== "pass") || report.cases.length < cases.length
    return done(failed ? 1 : 0)
  }
  finally {
    await client.close()
  }
}
