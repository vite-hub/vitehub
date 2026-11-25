import { expect, it } from "vitest";
import { loadCases } from "../../packages/mcp/src/eval/cases.ts";
import { gradeSample, type McpEvalCall } from "../../packages/mcp/src/eval/grade.ts";

const { cases, problems } = await loadCases(new URL("../evals/mcp/cases.ndjson", import.meta.url));

function passed(id: string, finalText: string, calls: McpEvalCall[]) {
  expect(problems).toEqual([]);
  const testCase = cases.find((row) => row.id === id);
  if (!testCase) throw new Error(`Missing eval case: ${id}`);
  return gradeSample(testCase.expect, calls, finalText).every((check) => check.pass);
}

function page(path: string): McpEvalCall {
  return { tool: "get-page", args: { path }, executed: true };
}

it("accepts a direct Blob lookup by path or URL, but not a different page or list-pages", () => {
  const answer =
    "Enable Blob, add an upload route with blob.put(), and retrieve the file with blob.get().";
  const path = "/docs/blob/get-started";
  expect(passed("blob-known-path", answer, [page(path)])).toBe(true);
  expect(passed("blob-known-path", answer, [page(`https://vitehub.dev${path}`)])).toBe(true);
  expect(passed("blob-known-path", answer, [page(`${path}-extra`)])).toBe(false);
  expect(
    passed("blob-known-path", answer, [
      page(path),
      { tool: "list-pages", args: {}, executed: true },
    ]),
  ).toBe(false);
});

it.each([
  {
    id: "general-code-no-docs",
    calls: [],
    weak: "I cannot write a function.",
    answer: "function reverse(text: string) { return [...text].reverse().join('') }",
  },
  {
    id: "rate-limit-429",
    calls: [page("/docs/rate-limit/get-started")],
    weak: "I could not show the code to return HTTP 429.",
    answer: "await requireRateLimit(event, 'uploads', { limit: 2, window: '1m' })",
  },
  {
    id: "blob-known-path",
    calls: [page("/docs/blob/get-started")],
    weak: "",
    answer: "Enable Blob, upload with blob.put(), then retrieve with blob.get().",
  },
  {
    id: "webhooks-debounce",
    calls: [page("/docs/webhooks/configure")],
    weak: "The webhook uses debounce.",
    answer: "The window restarts on each send and delivers the latest payload once.",
  },
])("requires concrete answer details for $id", ({ id, calls, weak, answer }) => {
  expect(passed(id, weak, calls)).toBe(false);
  expect(passed(id, answer, calls)).toBe(true);
});
