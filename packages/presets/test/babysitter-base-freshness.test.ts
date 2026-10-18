import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/babysitter/inbox/store.ts";
import { baseFixedSinceFailure, staleBaseOverlap, type BaseFreshnessReader } from "../src/babysitter/base-freshness.ts";
import { failedConclusions } from "../src/babysitter/wait.ts";

const head = "a".repeat(40);
const tested = "c".repeat(40);
const signal = new AbortController().signal;

function snapshot(conclusion = "success"): Snapshot {
  return {
    repository: "acme/app", number: 12,
    pr: { number: 12, state: "open", draft: false, head: { sha: head, ref: "fix" }, base: { sha: "d".repeat(40), ref: "main" } },
    generation: 1, handled: 0, dirtyAt: 1, nextAt: 0, status: "ready", lease: null, leaseUntil: 0,
    attempts: 0, hydrated: true, refresh: false, feedbackRefresh: false, comments: {}, reviews: {}, reviewComments: {}, statuses: {}, threads: [], reasons: [],
    checks: { "check_run:1": { id: 1, name: "test", head_sha: head, status: "completed", conclusion, app: { id: 5 }, html_url: "https://github.com/acme/app/actions/runs/77/job/1" } },
  };
}

function reader(responses: { files?: string[][]; compare?: unknown; activity?: unknown; baseFailures?: number }): BaseFreshnessReader & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async rest(path) {
      paths.push(path);
      if (path.endsWith("/actions/runs/77")) return ["2026-10-18T10:00:00Z"];
      if (path.includes("/files?")) return responses.files ?? [];
      return [];
    },
    async page(path, projection) {
      paths.push(path);
      if (path.includes("/activity?")) {
        // The push must be at least two minutes older than the run start.
        expect(projection).toContain(String(Math.floor((Date.parse("2026-10-18T10:00:00Z") - 120_000) / 1000)));
        return responses.activity ?? tested;
      }
      if (path.includes("/compare/")) return responses.compare;
      if (path.includes("/check-runs?")) return responses.baseFailures ?? 0;
      return undefined;
    },
  };
}

const live = { head: { sha: head }, base: { ref: "main" } };

describe("Babysitter base freshness", () => {
  it("returns the files that both the PR and the base changed after the checks ran", async () => {
    const read = reader({ files: [["src/a.ts", null as unknown as string], ["src/b.ts", "src/old-b.ts"]], compare: { ahead: 2, files: ["src/old-b.ts", "README.md", null] } });
    expect(await staleBaseOverlap(read, snapshot(), live, signal)).toEqual(["src/old-b.ts"]);
    expect(read.paths).toContain(`repos/acme/app/compare/${tested}...main?per_page=300`);
  });

  it("finds no overlap when the base did not move", async () => {
    expect(await staleBaseOverlap(reader({ files: [["src/a.ts"]], compare: { ahead: 0, files: [] } }), snapshot(), live, signal)).toEqual([]);
  });

  it("treats a missing run or a truncated comparison as overlap", async () => {
    const noRun = snapshot();
    noRun.checks["check_run:1"]!.html_url = "https://example.test/external";
    expect(await staleBaseOverlap(reader({ files: [["src/a.ts"]] }), noRun, live, signal)).toEqual(["src/a.ts"]);
    const truncated = Array.from({ length: 300 }, (_, index) => `file-${index}`);
    expect(await staleBaseOverlap(reader({ files: [["src/a.ts"]], compare: { ahead: 1, files: truncated } }), snapshot(), live, signal)).toEqual(["src/a.ts"]);
  });

  it("treats an empty pull-request metadata array as ambiguous", async () => {
    const read = reader({ files: [["src/a.ts"]] });
    const originalRest = read.rest;
    read.rest = async (path, projection, requestSignal) => {
      if (path.endsWith("/actions/runs/77")) return [{ created_at: "2026-10-18T10:00:00Z", pull_requests: [] }];
      return originalRest(path, projection, requestSignal);
    };
    expect(await staleBaseOverlap(read, snapshot(), live, signal)).toEqual(["src/a.ts"]);
    expect(read.paths.some((path) => path.includes("/activity?"))).toBe(false);
  });

  it("retests failed checks only after the base moved and passes again", async () => {
    expect(await baseFixedSinceFailure(reader({ compare: { ahead: 3 } }), snapshot("failure"), failedConclusions, signal)).toBe(3);
    expect(await baseFixedSinceFailure(reader({ compare: { ahead: 0 } }), snapshot("failure"), failedConclusions, signal)).toBeUndefined();
    expect(await baseFixedSinceFailure(reader({ compare: { ahead: 3 }, baseFailures: 1 }), snapshot("failure"), failedConclusions, signal)).toBeUndefined();
    // Passing checks are not the failures this retest is for.
    expect(await baseFixedSinceFailure(reader({ compare: { ahead: 3 } }), snapshot("success"), failedConclusions, signal)).toBeUndefined();
  });
});
