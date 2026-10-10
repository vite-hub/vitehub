import { expect, it } from "vitest";
import type { GitHubInboxSummary } from "../src/server/github-inbox.ts";
import { babysitterQueueHealth } from "../src/presets/babysitter/queue-health.ts";

it("distinguishes runnable work, scheduled preparation, suppression, and external blockers", () => {
  const summary: GitHubInboxSummary = { repository: "acme/app", number: 1, head: "a", generation: 2, handled: 1, status: "ready", reasons: [], dirty: true, attempts: 0, nextAt: 0, dirtyAt: 100 };
  const wait = { headSha: "a", reason: "waiting", evidenceKey: "evidence" };
  expect(babysitterQueueHealth([
    summary,
    { ...summary, nextAt: 2000 },
    { ...summary, stackBlocked: true },
    { ...summary, status: "terminal", state: "open" },
    { ...summary, status: "terminal", state: "closed" },
    { ...summary, status: "waiting", wait },
    { ...summary, status: "waiting", wait: { ...wait, kind: "external", reasonCode: "install-capacity", retryAt: 2000 } },
    { ...summary, status: "waiting", wait: { ...wait, kind: "external" } },
  ], 1000)).toEqual({ working: 0, ready: 1, scheduled: 1, stackBlocked: 1, waiting: 3, suppressed: 1, oldestReadyAgeMs: 900, blockers: { checks: 1, dependency: 0, manual: 1, timed: 1, installCapacity: 1, noProgress: 0 } });
});

it("reads summaries from older releases without inventing an age or suppression reason", () => {
  const summary: GitHubInboxSummary = { repository: "acme/app", number: 1, generation: 1, handled: 0, status: "ready", reasons: [], dirty: true, attempts: 0, nextAt: 0 };
  expect(babysitterQueueHealth([summary], 1000)).toMatchObject({ ready: 1, oldestReadyAgeMs: 0, suppressed: 0 });
});
