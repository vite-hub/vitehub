import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import type {
  BabysitterPassResult,
  BabysitterPassWait,
  BabysitterPassWake,
} from "../babysitter.ts";

export interface BabysitterResultDiagnostic {
  code: "invalid-wait" | "invalid-wake" | "invalid-reviewed-head" | "invalid-check-head";
  field: string;
}

const babysitterSha = /^[a-f0-9]{40,64}$/;
const validSha = (value: unknown): value is string =>
  hasRuntimeType(value, "string") && babysitterSha.test(value);

function parseWake(value: unknown): BabysitterPassWake | undefined {
  if (
    !isRuntimeRecord(value) ||
    !hasRuntimeType(value.kind, "string") ||
    !hasRuntimeType(value.repository, "string") ||
    !/^[\w.-]+\/[\w.-]+$/.test(value.repository)
  )
    return undefined;
  if (value.kind === "checks" && validSha(value.headSha))
    return { kind: "checks", repository: value.repository, headSha: value.headSha };
  if (
    value.kind === "pull-request" &&
    hasRuntimeType(value.number, "number") &&
    Number.isSafeInteger(value.number) &&
    value.number > 0
  )
    return { kind: "pull-request", repository: value.repository, number: value.number };
  return undefined;
}

function parseWait(value: unknown): BabysitterPassWait | undefined {
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.kind, "string")) return undefined;
  if (value.kind === "checks" && validSha(value.headSha))
    return { kind: "checks", headSha: value.headSha };
  if (value.kind === "external" && hasRuntimeType(value.reason, "string") && value.reason.trim()) {
    const wake = parseWake(value.wake);
    const wait = { kind: "external" as const, reason: value.reason.trim() };
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional wake metadata is omitted when no dependency can unblock the wait.
    if (wake) Object.assign(wait, { wake });
    return wait;
  }
  return undefined;
}

/**
 * Provider output is an untrusted boundary. Keep the required disposition, but
 * normalize optional coordination fields so an invalid wait hint cannot discard
 * an otherwise useful park/retry result (older models frequently omit `kind`).
 */
export function createBabysitterPassResultSchema(
  report?: (diagnostic: BabysitterResultDiagnostic) => void,
) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "vitehub.babysitter",
      validate(
        value: unknown,
      ): { value: BabysitterPassResult } | { issues: Array<{ message: string }> } {
        if (
          !isRuntimeRecord(value) ||
          (value.disposition !== "park" && value.disposition !== "retry")
        ) {
          return { issues: [{ message: "Expected a park/retry disposition." }] };
        }
        const text =
          hasRuntimeType(value.text, "string") && value.text.trim()
            ? value.text.trim()
            : "Babysitter pass completed.";
        const wait = parseWait(value.wait);
        if (value.wait !== undefined && !wait) report?.({ code: "invalid-wait", field: "wait" });
        if (
          wait?.kind === "external" &&
          isRuntimeRecord(value.wait) &&
          value.wait.wake !== undefined &&
          !wait.wake
        )
          report?.({ code: "invalid-wake", field: "wait.wake" });
        const reviewedHead = validSha(value.reviewedHead) ? value.reviewedHead : undefined;
        const waitForChecksHead = validSha(value.waitForChecksHead)
          ? value.waitForChecksHead
          : undefined;
        if (value.reviewedHead !== undefined && !reviewedHead)
          report?.({ code: "invalid-reviewed-head", field: "reviewedHead" });
        if (value.waitForChecksHead !== undefined && !waitForChecksHead)
          report?.({ code: "invalid-check-head", field: "waitForChecksHead" });
        const normalized: BabysitterPassResult = { disposition: value.disposition, text };
        // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional provider metadata is omitted when invalid or absent.
        if (wait) normalized.wait = wait;
        if (reviewedHead) normalized.reviewedHead = reviewedHead;
        if (waitForChecksHead) normalized.waitForChecksHead = waitForChecksHead;
        return { value: normalized };
      },
    },
  };
}
