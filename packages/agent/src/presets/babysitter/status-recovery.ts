import { createHash } from "node:crypto";
import type { PullRequestInbox, Snapshot } from "../../server/github-inbox.ts";
import { isStatusDeliveryCurrent, type StatusDelivery } from "../../server/github-inbox/status-delivery.ts";

export function isWorkerBlocker(snapshot: Pick<Snapshot, "wait" | "lastResult">): boolean {
  if (snapshot.wait?.kind !== "external" || snapshot.wait.wake || snapshot.wait.retryAt !== undefined) return false;
  const text = `${snapshot.wait.reason}\n${snapshot.lastResult ?? ""}`;
  return /MCP tool call requires approval|approval policy is never|read.only[^\n]{0,80}\.git|\.git[^\n]{0,80}read.only|writable (?:\.git|Git (?:metadata|checkout))|restore frozen-lockfile dependency installation|host must prepare (?:the )?exact.base merge|host must restore (?:the )?prepared merge metadata\/index|prepared merge metadata or index changed outside the host repair tools/i.test(text)
    || /commitRepair[^\n]{0,40}(?:rejects|rejected) dependency state[^\n]{0,80}(?:successful|refreshDependencies)/i.test(text)
    || /host commitRepair cannot stage restored [^\n]{0,100}(?:skip-worktree|outside sparse checkout)/i.test(text)
    || /commitRepair[^\n]{0,40}reports[^\n]{0,10}Dependency inputs changed or installation failed[^\n]{0,50}successful refreshDependencies/i.test(text)
    || /host (?:commitRepair|commit gate)[^\n]{0,80}rejects dependency state[^\n]{0,80}(?:successful|refreshDependencies)/i.test(text);
}

export interface BabysitterStatusRecovery {
  flush(): Promise<void>;
  recover(): Promise<void>;
  recordWorkerBlocker(snapshot: Snapshot, reason: string): Promise<void>;
}

/** Publish durable results and retry host failures once per worker release and PR head. */
export function createBabysitterStatusRecovery(options: {
  inbox: PullRequestInbox;
  revision: string;
  publish?: (pending: StatusDelivery, signal: AbortSignal) => Promise<unknown>;
  publishTimeoutMs?: number;
  deliveryLeaseMs?: number;
  event?: (name: string, properties: Record<string, unknown>) => void;
  error?: (name: string, error: unknown, properties: Record<string, unknown>) => void;
}): BabysitterStatusRecovery {
  const { inbox, revision, publish } = options;
  const publishTimeoutMs = options.publishTimeoutMs ?? 20_000;
  if (!Number.isFinite(publishTimeoutMs) || publishTimeoutMs <= 0) throw new Error("Status publication timeout must be positive.");
  const deliveryLeaseMs = options.deliveryLeaseMs ?? 300_000;
  if (!Number.isFinite(deliveryLeaseMs) || deliveryLeaseMs < 3 || deliveryLeaseMs > 2_147_483_647) throw new Error("Status delivery lease must be between 3 and 2,147,483,647 milliseconds.");
  let selecting = Promise.resolve();
  const active = new Set<Promise<void>>();

  async function deliver(pending: StatusDelivery): Promise<void> {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing: Promise<void> | undefined;
    const stopTimers = async () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      await renewing;
    };
    try {
      const snapshot = await inbox.get(pending.repository, pending.number);
      if (!isStatusDeliveryCurrent(pending, snapshot)) {
        await inbox.finishStatusDelivery(pending, "discarded");
        return;
      }
      deadline = setTimeout(() => {
        controller.abort(new DOMException("Status publication timed out.", "TimeoutError"));
      }, publishTimeoutMs);
      heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = inbox.renewStatusDelivery(pending, deliveryLeaseMs).then(owned => {
          if (!owned) controller.abort(new DOMException("Status delivery ownership lost.", "AbortError"));
        }).catch(failure => { controller.abort(failure); }).finally(() => { renewing = undefined; });
      }, Math.floor(deliveryLeaseMs / 3));
      // Abort requests cancellation. Ownership stays held until the real external
      // write settles, because a timeout cannot prove that its side effect stopped.
      await publish!(pending, controller.signal);
      await stopTimers();
      controller.signal.throwIfAborted();
      if (await inbox.finishStatusDelivery(pending, "delivered")) {
        options.event?.("babysitter.status.delivered", { repository: pending.repository, pull_request: pending.number });
      } else {
        await inbox.reconcileSettledStatusWriter(pending);
      }
    } catch (failure) {
      await stopTimers();
      if (!await inbox.retryStatusDelivery(pending, failure)) await inbox.reconcileSettledStatusWriter(pending);
      options.error?.("babysitter.status.delivery.failed", failure, { repository: pending.repository, pull_request: pending.number });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
  }

  return {
    async flush(): Promise<void> {
      if (!publish) return;
      // Serialize selection only. A stalled publisher occupies one slot while
      // unrelated saved statuses can use the other four.
      const batch = selecting.then(async () => {
        const available = 5 - active.size;
        if (available > 0) {
          for (const pending of await inbox.claimStatusDeliveries(available, deliveryLeaseMs)) {
            const work = deliver(pending).finally(() => { active.delete(work); });
            active.add(work);
          }
        }
        return [...active];
      });
      selecting = batch.then(() => {}, () => {});
      // Drain must wait for every actual write, even if another delivery failed.
      const outcomes = await Promise.allSettled(await batch);
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    },
    async recordWorkerBlocker(snapshot: Snapshot, reason: string): Promise<void> {
      if (isWorkerBlocker({ lastResult: snapshot.lastResult, wait: { kind: "external", headSha: snapshot.pr?.head?.sha ?? "", reason, evidenceKey: "worker-blocker" } })) {
        await inbox.recordWorkerBlocker(snapshot, revision);
      }
    },
    async recover(): Promise<void> {
      // A legacy host can finish its claim after this host's first scan.
      // The durable acknowledgement prevents repeat publication.
      await inbox.backfillStatusDeliveries();
      for (const snapshot of await inbox.waitsToEvaluate(true, true)) {
        if (!isWorkerBlocker(snapshot)) continue;
        const head = snapshot.pr?.head?.sha;
        const evidence = createHash("sha256").update(JSON.stringify(["worker-release", revision, head])).digest("hex");
        if (await inbox.wakeForWorkerRelease(snapshot, revision, evidence)) {
          options.event?.("babysitter.worker.recovery.woken", { repository: snapshot.repository, pull_request: snapshot.number, head_sha: head, revision });
        }
      }
    },
  };
}
