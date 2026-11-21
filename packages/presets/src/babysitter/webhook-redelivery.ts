import type { GitHubAppDelivery } from "@vite-hub/forge";

/** The GitHub App calls that list failed webhook deliveries and send them again. */
export interface WebhookRedeliverySource {
  failedDeliveries(since: number, signal?: AbortSignal): Promise<GitHubAppDelivery[]>;
  redeliver(id: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Progress events that a later event of the same run replaces. A lost `check_run.created` or
 * `workflow_run.in_progress` changes nothing once its `completed` event arrives, and change detection
 * reads running checks anyway. They are most of the failed deliveries, and sending them first delays
 * the `completed` events that let a green PR merge.
 */
const superseded = new Set(["check_run.created", "check_run.rerequested", "check_suite.requested", "check_suite.rerequested", "workflow_run.requested", "workflow_run.in_progress", "workflow_job.queued", "workflow_job.in_progress", "workflow_job.waiting"]);

/** Lower sends first: results and PR state before comments and the rest. */
function priority(name: string): number {
  if (name.endsWith(".completed") || name === "status") return 0;
  if (name.startsWith("pull_request.") || name.startsWith("pull_request_review") || name === "push") return 1;
  return 2;
}

export interface WebhookRedeliveryOptions {
  source: WebhookRedeliverySource;
  event: (name: string, properties: Record<string, unknown>) => void;
  error: (name: string, error: unknown, properties?: Record<string, unknown>) => void;
  /** How far back the first sweep looks. Default 2 hours. */
  windowMs?: number;
  /** Each later sweep looks back to its previous start minus this overlap. Default 20 minutes. */
  overlapMs?: number;
  /** Redeliveries of one event before the sweep gives up on it. Default 3. */
  maxAttempts?: number;
  /** Redeliveries per sweep. Default 200. */
  limit?: number;
  /** Pause between redeliveries, so a busy receiver is not flooded. Default 250 ms. */
  pauseMs?: number;
  now?: () => number;
}

/**
 * Sends failed GitHub App webhook deliveries again. GitHub does not retry a delivery that timed out
 * after 10 seconds or failed. When the receiver is slow, `check_suite.completed` events get lost and
 * green pull requests wait for the change detection to find them. The inbox deduplicates by delivery ID, so an event that the
 * receiver stored after GitHub stopped waiting is not processed twice.
 */
export function createWebhookRedelivery(options: WebhookRedeliveryOptions) {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 2 * 3_600_000;
  const overlapMs = options.overlapMs ?? 20 * 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const limit = options.limit ?? 200;
  const pauseMs = options.pauseMs ?? 250;
  const sent = new Map<string, number>();
  // The oldest delivery time the next sweep must still read. It moves forward only after a sweep
  // handled every failed delivery it listed, so a limit or a failed request never drops a delivery.
  let watermark: number | undefined;
  let running = false;
  return {
    /** Redelivers the failed deliveries since the last sweep. Returns how many it sent. */
    async sweep(signal?: AbortSignal): Promise<number> {
      if (running) return 0;
      running = true;
      const start = now();
      try {
        const since = Math.max(start - windowMs, watermark ?? -Infinity);
        const failed = await options.source.failedDeliveries(since, signal);
        let redelivered = 0, abandoned = 0, errors = 0, skipped = 0;
        const events: Record<string, number> = {};
        const name = (delivery: GitHubAppDelivery) => delivery.action ? `${delivery.event}.${delivery.action}` : delivery.event;
        const ordered = failed.filter(delivery => !superseded.has(name(delivery)) || (skipped++, false))
          .sort((a, b) => priority(name(a)) - priority(name(b)) || a.deliveredAt - b.deliveredAt);
        for (const delivery of ordered) {
          if (redelivered + errors >= limit) break;
          const attempts = sent.get(delivery.guid) ?? 0;
          if (attempts >= maxAttempts) { abandoned++; continue; }
          signal?.throwIfAborted();
          try {
            await options.source.redeliver(delivery.id, signal);
            sent.set(delivery.guid, attempts + 1);
            redelivered++;
            events[name(delivery)] = (events[name(delivery)] ?? 0) + 1;
          } catch (error) {
            if (signal?.aborted) throw error;
            errors++;
            options.error("babysitter.webhook.redeliver_failed", error, { delivery: delivery.id, event: delivery.event });
          }
          if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
        }
        // Forget old guids; they are outside every later window.
        if (sent.size > 20_000) for (const guid of [...sent.keys()].slice(0, sent.size - 10_000)) sent.delete(guid);
        const remaining = failed.length - redelivered - abandoned - skipped;
        watermark = remaining > 0 ? since : start - overlapMs;
        if (failed.length) options.event("babysitter.webhook.redelivered", { failed: failed.length, redelivered, abandoned, skipped, errors, remaining, events });
        return redelivered;
      } finally {
        running = false;
      }
    },
  };
}
