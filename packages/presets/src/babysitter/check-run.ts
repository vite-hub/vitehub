import { forgeErrorStatus, RateLimitedError } from "@vite-hub/forge";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import type { StatusDelivery } from "./inbox/status-delivery.ts";

/** The name of the check run that mirrors the Babysitter's state on the PR head. */
export const babysitterCheckName = "babysitter";

/**
 * The Babysitter's own check run. Every reader of head or base checks leaves it out: it reports the
 * Babysitter's state, so counting it would make the Babysitter wait on itself or block its own merge.
 */
export function isBabysitterCheckRun(check: unknown): boolean {
  return isRuntimeRecord(check) && check.name === babysitterCheckName;
}

/** What a check run shows for one state of the status outbox. */
export function babysitterCheckRunBody(activity: StatusDelivery["activity"]): Record<string, unknown> {
  const summary = activity.summary.trim();
  const firstLine = summary.split("\n", 1)[0]!.trim();
  const titled = (label: string) => firstLine ? `${label}: ${firstLine}`.slice(0, 200) : label;
  // A waiting PR is parked on a durable wake condition, sometimes for days. A spinning check would
  // claim that the Babysitter is still working, so a wait ends the run as neutral and says why.
  const state = {
    queued: { status: "queued", title: titled("Queued") },
    running: { status: "in_progress", title: titled("Running") },
    waiting: { status: "completed", conclusion: "neutral", title: titled("Waiting") },
    completed: { status: "completed", conclusion: "success", title: titled("Done") },
    failed: { status: "completed", conclusion: "failure", title: titled("Failed") },
  }[activity.status];
  const detailsUrl = activity.links[0]?.url;
  return {
    status: state.status,
    ...state.conclusion ? { conclusion: state.conclusion, completed_at: activity.updatedAt } : {},
    ...activity.startedAt && state.status !== "queued" ? { started_at: activity.startedAt } : {},
    ...detailsUrl ? { details_url: detailsUrl } : {},
    output: { title: state.title, summary: (summary || state.title).slice(0, 65_000) },
  };
}

interface CheckRunRequester {
  request<T>(method: string, path: string, options?: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal }): Promise<{ data: T }>;
}

export interface BabysitterCheckRuns {
  /** Create or update the `babysitter` check run on the delivery's head. Throws to retry the delivery. */
  publish(pending: StatusDelivery, signal: AbortSignal): Promise<void>;
}

/**
 * Mirrors status deliveries as one check run per head. A repository whose App lacks `checks: write`
 * answers 403; it is reported once and skipped until the process restarts.
 */
export function createBabysitterCheckRuns(options: {
  forge: (repository: string, signal: AbortSignal) => Promise<CheckRunRequester>;
  /** The App that writes the runs, so a same-named check of another app is never updated. */
  appId?: number;
  error?: (name: string, error: unknown, properties: Record<string, unknown>) => void;
}): BabysitterCheckRuns {
  const forbidden = new Set<string>();
  // The run of each recent head, so an update skips the lookup. A restart finds it by name and head.
  const known = new Map<string, { id: number; completed: boolean }>();

  async function find(provider: CheckRunRequester, repository: string, head: string, signal: AbortSignal) {
    const response = await provider.request<unknown>("GET", `/repos/${repository}/commits/${head}/check-runs`, {
      query: { check_name: babysitterCheckName, filter: "latest", per_page: 1, ...options.appId === undefined ? {} : { app_id: options.appId } }, signal,
    });
    const run = isRuntimeRecord(response.data) && Array.isArray(response.data.check_runs) ? response.data.check_runs[0] : undefined;
    return isRuntimeRecord(run) && hasRuntimeType(run.id, "number") ? { id: run.id, completed: run.status === "completed" } : undefined;
  }

  return {
    async publish(pending, signal) {
      const repository = pending.repository.toLowerCase();
      if (forbidden.has(repository)) return;
      const key = `${repository}@${pending.head}`;
      const body = babysitterCheckRunBody(pending.activity);
      const completed = body.status === "completed";
      try {
        const provider = await options.forge(pending.repository, signal);
        const current = known.get(key) ?? await find(provider, pending.repository, pending.head, signal);
        // New work after a completed run starts a new run rather than reopening it.
        // The checks box shows the latest run of each name.
        const response = current && (!current.completed || completed)
          ? await provider.request<unknown>("PATCH", `/repos/${pending.repository}/check-runs/${current.id}`, { body, signal })
          : await provider.request<unknown>("POST", `/repos/${pending.repository}/check-runs`, { body: { name: babysitterCheckName, head_sha: pending.head, ...body }, signal });
        const id = isRuntimeRecord(response.data) && hasRuntimeType(response.data.id, "number") ? response.data.id : current?.id;
        known.delete(key);
        if (id !== undefined) known.set(key, { id, completed });
        if (known.size > 1_000) known.delete(known.keys().next().value!);
      } catch (error) {
        known.delete(key);
        // GitHub also answers 403 to a secondary rate limit, which is retried like any other failure.
        if (forgeErrorStatus(error) !== 403 || error instanceof RateLimitedError || /rate limit/i.test(error instanceof Error ? error.message : "")) throw error;
        forbidden.add(repository);
        options.error?.("babysitter.status.check_run.forbidden", error, { repository: pending.repository, permission: "checks: write" });
      }
    },
  };
}
