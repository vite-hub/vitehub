import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { loadCases, validateCasesAgainstTools } from "../src/eval/cases.ts"
import { caseVerdict, gradeSample, matchArgs, matchText, needsAnotherSample } from "../src/eval/grade.ts"

import type { McpEvalCall } from "../src/eval/grade.ts"

const call = (tool: string, args: unknown): McpEvalCall => ({ tool, args, executed: true })

describe("matchers", () => {
  it("matches text as a case-insensitive substring, with ~, or as a regex with re:", () => {
    expect(matchText("Queue", "the queue retries")).toBe(true)
    expect(matchText("~QUEUE", "the queue retries")).toBe(true)
    expect(matchText("re:^the q", "the queue retries")).toBe(true)
    expect(matchText("re:^Queue", "the queue retries")).toBe(false)
    expect(matchText("schedule", "the queue retries")).toBe(false)
  })

  it("matches arguments partially, by exact value, ~ substring, regex, and dotted path", () => {
    const args = { path: "/docs/Queue", limit: 5, filter: { section: "agents", tags: ["a", "b"] } }
    expect(matchArgs({ path: "~queue" }, args)).toBe(true)
    expect(matchArgs({ path: "/docs/queue" }, args)).toBe(false)
    expect(matchArgs({ limit: 5, "filter.section": "agents" }, args)).toBe(true)
    expect(matchArgs({ "filter.tags": ["a", "b"] }, args)).toBe(true)
    expect(matchArgs({ "filter.section": "re:^age" }, args)).toBe(true)
    expect(matchArgs({ "filter.missing": "~a" }, args)).toBe(false)
    expect(matchArgs({ limit: "5" }, args)).toBe(false)
    expect(matchArgs(undefined, args)).toBe(true)
  })
})

describe("gradeSample", () => {
  it("passes when every expected call appears and fails with a reason for each miss", () => {
    const calls = [call("list-pages", {}), call("get-page", { path: "/docs/queue" })]
    expect(gradeSample({ calls: [{ tool: "get-page", args: { path: "~queue" } }], notCalls: ["delete-page"], maxCalls: 2, finalTextMust: ["retries"], finalTextMustNot: ["re:I (?:do not|don't) know"] }, calls, "Retries are on.")
      .every(check => check.pass)).toBe(true)

    expect(gradeSample({ calls: [{ tool: "get-page", args: { path: "~schedule" } }, { tool: "search" }] }, calls, "")).toEqual([
      { name: "calls:get-page", pass: false, reason: "get-page was called 1 time(s), but never with {\"path\":\"~schedule\"}." },
      { name: "calls:search", pass: false, reason: "search was not called." },
    ])
  })

  it("fails a control case that calls a tool", () => {
    const checks = gradeSample({ notCalls: ["list-pages"], maxCalls: 0 }, [call("list-pages", {})], "Hello")
    expect(checks.map(check => [check.name, check.pass])).toEqual([["notCalls:list-pages", false], ["maxCalls", false]])
    expect(gradeSample({ notCalls: ["list-pages"], maxCalls: 0 }, [], "Hello").every(check => check.pass)).toBe(true)
  })

  it("fails on final text that must not appear", () => {
    expect(gradeSample({ finalTextMustNot: ["~nuxthub"] }, [], "Use NuxtHub.")[0]?.pass).toBe(false)
  })
})

describe("majority rule", () => {
  it("runs 2 samples, and a 3rd only when the first two disagree", () => {
    expect(needsAnotherSample([], undefined)).toBe(true)
    expect(needsAnotherSample([{ pass: true }], undefined)).toBe(true)
    expect(needsAnotherSample([{ pass: true }, { pass: true }], undefined)).toBe(false)
    expect(needsAnotherSample([{ pass: false }, { pass: false }], undefined)).toBe(false)
    expect(needsAnotherSample([{ pass: true }, { pass: false }], undefined)).toBe(true)
    expect(needsAnotherSample([{ pass: true }, { pass: false, error: "timeout" }], undefined)).toBe(true)
    expect(needsAnotherSample([{ pass: true }, { pass: false }, { pass: true }], undefined)).toBe(false)
    expect(needsAnotherSample([{ pass: true }, { pass: true }], 3)).toBe(true)
    expect(needsAnotherSample([{ pass: true }], 1)).toBe(false)
  })

  it("leaves errored samples out of the pass rate and fails at 0.5 or less", () => {
    expect(caseVerdict([{ pass: true }, { pass: false }, { pass: true }])).toEqual({ passRate: 2 / 3, status: "pass" })
    expect(caseVerdict([{ pass: true }, { pass: false }])).toEqual({ passRate: 0.5, status: "fail" })
    expect(caseVerdict([{ pass: true }, { pass: false, error: "timeout" }, { pass: true }])).toEqual({ passRate: 1, status: "pass" })
    expect(caseVerdict([{ pass: false, error: "timeout" }])).toEqual({ passRate: undefined, status: "error" })
  })
})

describe("cases", () => {
  it("reads ndjson and reports each invalid line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-eval-cases-"))
    const file = join(dir, "cases.ndjson")
    await writeFile(file, [
      JSON.stringify({ id: "a", kind: "guard", origin: { type: "docs" }, prompt: "Hi", expect: { maxCalls: 0 } }),
      "",
      JSON.stringify({ id: "b", kind: "odd", prompt: "", expect: { calls: [{ args: {} }] } }),
      "{ not json",
      JSON.stringify({ id: "a", kind: "bad", origin: {}, prompt: "Again", expect: {} }),
    ].join("\n"))
    const { cases, problems } = await loadCases(file)
    await rm(dir, { force: true, recursive: true })

    expect(cases.map(testCase => testCase.id)).toEqual(["a", "a"])
    expect(problems).toEqual([
      expect.stringMatching(/^line 4: /),
      "b: \"kind\" must be \"bad\", \"guard\", or \"control\".",
      "b: \"origin\" must be an object, such as { \"type\": \"issue\", \"url\": \"...\" }.",
      "b: \"prompt\" must be a non-empty string.",
      "b: \"expect.calls\" must be a list of { \"tool\": string, \"args\"?: object }.",
      "a: two cases have this id.",
    ])
  })

  it("names expected tools and argument keys that the tool list does not have", () => {
    const tools = [{ name: "get-page", inputSchema: { type: "object", properties: { path: { type: "string" }, options: { type: "object", properties: { lang: { type: "string" } } } } } }]
    const base = { kind: "bad" as const, origin: {}, prompt: "p" }
    expect(validateCasesAgainstTools([
      { ...base, id: "ok", expect: { calls: [{ tool: "get-page", args: { "path": "~q", "options.lang": "en" } }] } },
      { ...base, id: "bad", expect: { calls: [{ tool: "get-page", args: { slug: "q", "options.locale": "en" } }, { tool: "find" }], notCalls: ["drop"] } },
    ], tools)).toEqual([
      "bad: \"slug\" is not in the input schema of \"get-page\".",
      "bad: \"options.locale\" is not in the input schema of \"get-page\".",
      "bad: expect.calls names \"find\", which is not in tools/list.",
      "bad: expect.notCalls names \"drop\", which is not in tools/list.",
    ])
  })
})
