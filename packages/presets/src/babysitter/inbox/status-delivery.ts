import * as v from "valibot";
import type { Snapshot } from "./store.ts";

export const statusOutboxPrefix = "status-outbox:v1:";
export const statusWriterPrefix = "status-writers:v1:";
export const statusSentPrefix = "status-sent:v1:";
export const workerBlockerPrefix = "worker-blocker:v1:";
export const statusTargetKey = (snapshot: { repository: string; number: number }): string => `${snapshot.repository}#${snapshot.number}`;

export interface StatusDelivery {
  version: string;
  contentKey: string;
  repository: string;
  number: number;
  head: string;
  precedingHead?: string;
  projection?: true;
  workerLease?: string;
  generation: number;
  text: string;
  attempts: number;
  nextAt: number;
  lease?: string;
  leaseUntil?: number;
  lastError?: string;
  activity: {
    runId: string;
    status: "queued" | "running" | "failed" | "completed" | "waiting";
    startedAt?: string;
    updatedAt: string;
    links: Array<{ label: string; url: string }>;
    tasks: never[];
    summary: string;
  };
}

export const statusDeliverySchema: v.GenericSchema<unknown, StatusDelivery> = v.object({
  version: v.string(), contentKey: v.string(), repository: v.string(), number: v.number(),
  head: v.string(), precedingHead: v.optional(v.string()), generation: v.number(), text: v.string(), attempts: v.number(), nextAt: v.number(),
  projection: v.optional(v.literal(true)),
  workerLease: v.optional(v.string()),
  lease: v.optional(v.string()), leaseUntil: v.optional(v.number()),
  lastError: v.optional(v.string()),
  activity: v.object({
    runId: v.string(), status: v.picklist(["queued", "running", "failed", "completed", "waiting"]), startedAt: v.optional(v.string()),
    updatedAt: v.string(), links: v.array(v.object({ label: v.string(), url: v.string() })),
    tasks: v.array(v.never()), summary: v.string(),
  }),
});

export const statusAcknowledgementSchema: v.GenericSchema<unknown, { contentKey: string; runId: string; status?: StatusDelivery["activity"]["status"] }> = v.object({ contentKey: v.string(), runId: v.string(), status: v.optional(v.picklist(["queued", "running", "failed", "completed", "waiting"])) });

/** Describe current work without replacing the saved result or handling evidence. */
export function statusProjectionText(snapshot: Snapshot): string {
  if (snapshot.pr?.state === "closed") return snapshot.pr.merged === true ? "Pull request merged." : "Pull request closed.";
  if (snapshot.status === "terminal") return "Pull request is outside the configured filter.";
  if (snapshot.status === "working" && snapshot.lease) return "Pull request repair is claimed.";
  return "New pull request evidence is queued.";
}

/** The publisher and acknowledgement transaction use the same snapshot fence. */
export function isStatusDeliveryCurrent(pending: StatusDelivery, snapshot: Snapshot | undefined): boolean {
  if (!snapshot || snapshot.pr?.head?.sha !== pending.head
    || snapshot.lease && (!pending.projection || snapshot.status !== "terminal" && pending.workerLease !== snapshot.lease)) return false;
  if (pending.projection) return snapshot.generation === pending.generation && pending.text === statusProjectionText(snapshot);
  if (snapshot.status === "terminal" && pending.activity.status !== "completed") return false;
  const repairHeadObserved = pending.precedingHead
    && snapshot.status === "waiting" && snapshot.wait?.headSha === pending.head
    && snapshot.generation === pending.generation + 1
    && snapshot.reasons.every(reason => reason === "bootstrap" || reason === "pull_request:synchronize");
  const terminalResult = snapshot.status === "terminal" && pending.activity.status === "completed";
  return snapshot.lastResult === pending.text
    && (snapshot.generation === pending.generation || Boolean(repairHeadObserved) || terminalResult);
}
