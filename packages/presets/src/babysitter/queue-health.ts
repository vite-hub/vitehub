import type { GitHubInboxSummary } from "./inbox/store.ts";

/** Derive bounded operational counters from the durable queue, including scheduled retries. */
export function babysitterQueueHealth(items: readonly GitHubInboxSummary[], now = Date.now()) {
  const mergedTerminal = (result: string | undefined) => result?.startsWith("Merged ")
    || result === "Asynchronous merge confirmed by GitHub."
    || result === "Direct merge outcome reconciled: GitHub reports the pull request merged.";
  const ready = items.filter(item => item.status === "ready" && item.dirty && !item.stackBlocked && item.nextAt <= now);
  const waiting = items.filter(item => item.status === "waiting");
  return {
    working: items.filter(item => item.status === "working").length,
    ready: ready.length,
    scheduled: items.filter(item => item.status === "ready" && item.dirty && !item.stackBlocked && item.nextAt > now).length,
    stackBlocked: items.filter(item => item.stackBlocked).length,
    waiting: waiting.length,
    suppressed: items.filter(item => item.status === "terminal" && item.state === "open" && !mergedTerminal(item.lastResult)).length,
    oldestReadyAgeMs: ready.reduce((age, item) => Math.max(age, item.dirtyAt === undefined ? 0 : now - item.dirtyAt), 0),
    blockers: {
      checks: waiting.filter(item => item.wait && item.wait.kind !== "external" && !item.wait.wake).length,
      dependency: waiting.filter(item => item.wait?.wake).length,
      manual: waiting.filter(item => item.wait?.kind === "external" && !item.wait.wake && item.wait.retryAt === undefined).length,
      timed: waiting.filter(item => item.wait?.retryAt !== undefined).length,
      installCapacity: waiting.filter(item => item.wait?.reasonCode === "install-capacity").length,
      noProgress: waiting.filter(item => item.progressBudget?.exhausted && item.progressBudget.head === item.head).length,
    },
  };
}
