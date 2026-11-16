import type { GitHubAppDelivery } from "@vite-hub/forge";

/** The GitHub App calls that list failed webhook deliveries and send them again. */
export interface WebhookRedeliverySource {
  failedDeliveries(since: number, signal?: AbortSignal): Promise<GitHubAppDelivery[]>;
  redeliver(id: string, signal?: AbortSignal): Promise<void>;
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
 * after 10 seconds or failed. On 2026-11-16 about a third of deliveries timed out while the disk was
 * busy, so `check_suite.completed` events got lost and green pull requests waited 30 minutes or more
 * for the change detection to find them. The inbox deduplicates by delivery ID, so an event that the
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
  let lastStart: number | undefined;
  let running = false;
  return {
    /** Redelivers the failed deliveries since the last sweep. Returns how many it sent. */
    async sweep(signal?: AbortSignal): Promise<number> {
      if (running) return 0;
      running = true;
      const start = now();
      try {
        const since = Math.max(start - windowMs, lastStart === undefined ? -Infinity : lastStart - overlapMs);
        const failed = await options.source.failedDeliveries(since, signal);
        lastStart = start;
        let redelivered = 0, abandoned = 0, errors = 0;
        const events: Record<string, number> = {};
        for (const delivery of failed) {
          if (redelivered >= limit) break;
          const attempts = sent.get(delivery.guid) ?? 0;
          if (attempts >= maxAttempts) { abandoned++; continue; }
          signal?.throwIfAborted();
          try {
            await options.source.redeliver(delivery.id, signal);
            sent.set(delivery.guid, attempts + 1);
            redelivered++;
            const name = delivery.action ? `${delivery.event}.${delivery.action}` : delivery.event;
            events[name] = (events[name] ?? 0) + 1;
          } catch (error) {
            if (signal?.aborted) throw error;
            errors++;
            options.error("babysitter.webhook.redeliver_failed", error, { delivery: delivery.id, event: delivery.event });
          }
          if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
        }
        // Forget old guids; they are outside every later window.
        if (sent.size > 20_000) for (const guid of [...sent.keys()].slice(0, sent.size - 10_000)) sent.delete(guid);
        if (failed.length) options.event("babysitter.webhook.redelivered", { failed: failed.length, redelivered, abandoned, errors, events });
        return redelivered;
      } finally {
        running = false;
      }
    },
  };
}
