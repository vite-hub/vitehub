import { invariant } from "@vite-hub/internal/invariant";
import { presetsErrorDiagnostics } from "../error-diagnostics.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import type { AgentInvocations } from "@vite-hub/agent";
import type { Snapshot } from "./inbox/store.ts";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sharedBabysitterRead } from "./shared-read.ts";
/** A reason to stop model passes, returned by `admission.check`. */
export interface BabysitterAdmissionPause {
  /** Short machine-readable reason, such as `"provider-quota"`. */
  reason: string;
  detail?: string;
  /** Epoch milliseconds when the pause ends, if it ends at a known time. */
  retryAt?: number;
}

/**
 * Shared-resource limits that the host checks before it claims a PR. A spent limit stops model
 * passes. Direct merges and recorded waits continue.
 */
export interface BabysitterAdmissionOptions {
  /**
   * Input tokens that this Agent's passes may use per local clock hour and per local day. Leave a
   * window out for no limit. Defaults to no limit.
   */
  inputTokens?: { hourly?: number; daily?: number };
  /** Free space, in MiB, that the temporary directory needs before a pass. `false` disables the check. Defaults to 4096. */
  minFreeTmpMb?: number | false;
  /** Stop every claim, including direct merges, for example during a smoke boot. Defaults to `false`. */
  paused?: boolean;
  /**
   * Extra check before each claim, for example a provider quota. Return a pause to stop model
   * passes, or `undefined` to continue. An error is reported in health and does not pause.
   */
  check?: (signal?: AbortSignal) => BabysitterAdmissionPause | undefined | Promise<BabysitterAdmissionPause | undefined>;
}

/** Token limits are best-effort retained-journal thresholds, not billing caps. */
export interface BabysitterAdmissionLimits {
  minFreeTmpBytes?: number;
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  paused: boolean;
}

export interface BabysitterBudgetWindows {
  hourStart: number;
  hourEnd: number;
  dayStart: number;
  dayEnd: number;
}

export interface BabysitterAdmissionState {
  windows: BabysitterBudgetWindows;
  tmpDir: string;
  freeTmpBytes?: number;
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  pause?: BabysitterAdmissionPause;
  errors?: string[];
}

export interface BabysitterAdmissionResult {
  accepting: boolean;
  hostOnly?: boolean;
  reason?: string;
  detail?: string;
  retryAt?: number;
  accounting: "best-effort-retained-journal";
  state: BabysitterAdmissionState;
  limits: BabysitterAdmissionLimits;
}

const tokenLimit = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);

/** Whether `value` is a valid `admission` option. */
export function validBabysitterAdmission(value: unknown): value is BabysitterAdmissionOptions {
  if (!isRuntimeRecord(value)) return false;
  const { inputTokens, minFreeTmpMb, paused, check } = value;
  if (inputTokens !== undefined && !(isRuntimeRecord(inputTokens) && tokenLimit(inputTokens.hourly) && tokenLimit(inputTokens.daily))) return false;
  if (minFreeTmpMb !== undefined && minFreeTmpMb !== false && !(hasRuntimeType(minFreeTmpMb, "number") && Number.isFinite(minFreeTmpMb) && minFreeTmpMb >= 0)) return false;
  return (paused === undefined || hasRuntimeType(paused, "boolean")) && (check === undefined || hasRuntimeType(check, "function"));
}

/** Resolves only the documented admission options. */
export function resolveBabysitterAdmissionLimits(options: BabysitterAdmissionOptions = {}): BabysitterAdmissionLimits {
  const minFreeTmpMb = options.minFreeTmpMb ?? 4096;
  return {
    hourlyInputTokens: options.inputTokens?.hourly,
    dailyInputTokens: options.inputTokens?.daily,
    minFreeTmpBytes: minFreeTmpMb === false ? undefined : minFreeTmpMb * 1024 * 1024,
    paused: options.paused === true,
  };
}

/** Returns the local clock windows used by the hourly and daily budgets. */
export function babysitterBudgetWindows(now: number): BabysitterBudgetWindows {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);
  return { hourStart: hour.getTime(), hourEnd: hour.getTime() + 3_600_000, dayStart: day.getTime(), dayEnd: nextDay.getTime() };
}

/** Decides whether another model pass may start on the shared host. */
export function babysitterAdmissionDecision(state: BabysitterAdmissionState, limits: BabysitterAdmissionLimits): Omit<BabysitterAdmissionResult, "state" | "limits" | "accounting"> {
  const { windows } = state;
  if (limits.paused) return { accepting: false, hostOnly: false, reason: "paused", detail: "Admission is paused by the admission.paused option" };
  if (limits.hourlyInputTokens === 0 || limits.dailyInputTokens === 0) return {
    accepting: false,
    hostOnly: true,
    reason: limits.hourlyInputTokens === 0 ? "token-budget-hourly" : "token-budget-daily",
    detail: "Admission is paused by a zero token budget",
  };
  if (limits.minFreeTmpBytes !== undefined && state.freeTmpBytes !== undefined && state.freeTmpBytes < limits.minFreeTmpBytes) return {
    accepting: false,
    hostOnly: true,
    reason: "tmp-space-low",
    detail: `${Math.floor(state.freeTmpBytes / 1048576)} MiB free in ${state.tmpDir}; passes need ${Math.floor(limits.minFreeTmpBytes / 1048576)} MiB`,
  };
  if (limits.dailyInputTokens !== undefined && state.dailyInputTokens !== undefined && state.dailyInputTokens >= limits.dailyInputTokens) return { accepting: false, hostOnly: true, reason: "token-budget-daily", retryAt: windows.dayEnd, detail: `${state.dailyInputTokens} of ${limits.dailyInputTokens} daily input tokens used` };
  if (limits.hourlyInputTokens !== undefined && state.hourlyInputTokens !== undefined && state.hourlyInputTokens >= limits.hourlyInputTokens) return { accepting: false, hostOnly: true, reason: "token-budget-hourly", retryAt: windows.hourEnd, detail: `${state.hourlyInputTokens} of ${limits.hourlyInputTokens} hourly input tokens used` };
  if (state.pause) return { accepting: false, hostOnly: true, reason: state.pause.reason, detail: state.pause.detail, retryAt: state.pause.retryAt };
  return { accepting: true };
}

async function readInvocationInputTokens(invocations: Pick<AgentInvocations, "list" | "get"> | undefined, since: number, signal?: AbortSignal) {
  invariant(invocations, "the admission controller reads token usage only after the runtime assigns the invocation journal");
  const usage: Array<{ id: string; updatedAt: string; tokens: number }> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    signal?.throwIfAborted();
    const page = await invocations.list({ cursor, limit: 100, status: ["pending", "running", "completed", "failed", "cancelled"], updatedSince: new Date(since).toISOString() });
    invariant(!page.cursor || !seenCursors.has(page.cursor), "the Agent Invocation store returns a new pagination cursor for each page");
    if (page.cursor) seenCursors.add(page.cursor);
    for (const summary of page.invocations) {
      signal?.throwIfAborted();
      if (Date.parse(summary.updatedAt) < since) continue;
      const record = await invocations.get(summary.id);
      if (!record) continue;
      let tokens = 0;
      for (const observation of record.observations) {
        const value = observation.attributes?.["usage.inputTokens"];
        if (hasRuntimeType(value, "number") && Number.isFinite(value)) tokens = Math.max(tokens, value);
      }
      usage.push({ id: record.id, updatedAt: record.updatedAt, tokens });
    }
    cursor = page.cursor;
  } while (cursor);
  return usage;
}

/** Host reconciliation may bypass a progress block, but model dispatch may not. */
export function babysitterModelAdmission(accepting: boolean, snapshot: Pick<Snapshot, "pr" | "progressBudget">): boolean {
  return accepting && !(snapshot.progressBudget?.exhausted && snapshot.progressBudget.head === snapshot.pr?.head?.sha);
}

/** Sums the cached per-invocation maxima for a budget window. */
function sumInvocationInputTokens(usage: Map<string, { updatedAt: number; tokens: number }>, since: number): number {
  let total = 0;
  for (const entry of usage.values()) if (entry.updatedAt >= since) total += entry.tokens;
  return total;
}

function normalizeAdmissionPause(value: unknown): BabysitterAdmissionPause | undefined {
  if (value === undefined) return;
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.reason, "string") || !value.reason.trim()
    || value.detail !== undefined && !hasRuntimeType(value.detail, "string")
    || value.retryAt !== undefined && !(hasRuntimeType(value.retryAt, "number") && Number.isFinite(value.retryAt) && value.retryAt >= 0)) {
    throw presetsErrorDiagnostics.PRESETS_BABYSITTER_ADMISSION_CHECK_INVALID();
  }
  const pause: BabysitterAdmissionPause = { reason: value.reason };
  if (value.detail !== undefined) pause.detail = value.detail;
  if (value.retryAt !== undefined) pause.retryAt = value.retryAt;
  return pause;
}

/** Dispatch shares fresh accounting; health may reuse a bounded, timestamped result. */
export interface CoalescedBabysitterAdmission<T extends object> {
  (now?: number, signal?: AbortSignal): Promise<T & { observedAt: number }>;
  health(): Promise<T & { observedAt: number }>;
  invalidate(): void;
}

export function coalesceBabysitterAdmission<T extends object>(read: (now?: number, signal?: AbortSignal) => Promise<T>, clock: () => number = Date.now): CoalescedBabysitterAdmission<T> {
  let latest: T & { observedAt: number } | undefined;
  const sample = sharedBabysitterRead(async (signal, now?: number) => {
    const result = await read(now, signal);
    signal.throwIfAborted();
    latest = { ...result, observedAt: clock() };
    return latest;
  });
  const check = (now?: number, signal?: AbortSignal) => sample(signal, now);
  return Object.assign(check, {
    health: () => latest && clock() - latest.observedAt <= 120_000 ? Promise.resolve(latest) : check(),
    invalidate: () => { latest = undefined; },
  });
}

export function createBabysitterAdmission(options: { invocations?: Pick<AgentInvocations, "list" | "get">; limits: BabysitterAdmissionLimits; check?: BabysitterAdmissionOptions["check"] }): CoalescedBabysitterAdmission<BabysitterAdmissionResult> {
  const usage = new Map<string, { updatedAt: number; tokens: number }>();
  let readAt: number | undefined;
  let cursor: number | undefined;
  return coalesceBabysitterAdmission(async function check(now = Date.now(), signal?: AbortSignal): Promise<BabysitterAdmissionResult> {

    const windows = babysitterBudgetWindows(now);
    const state: BabysitterAdmissionState = { windows, tmpDir: tmpdir() };
    try { const stats = await statfs(state.tmpDir); state.freeTmpBytes = stats.bavail * stats.bsize; }
    catch (error) { state.errors = [`tmp: ${error instanceof Error ? error.message : String(error)}`]; }
    signal?.throwIfAborted();
    const budgeted = options.limits.hourlyInputTokens !== undefined || options.limits.dailyInputTokens !== undefined;
    if (budgeted && (readAt === undefined || now - readAt >= 60_000)) try {
      const since = cursor === undefined ? windows.dayStart : Math.max(windows.dayStart, cursor - 60_000);
      const entries = await readInvocationInputTokens(options.invocations, since, signal);
      signal?.throwIfAborted();
      for (const entry of entries) usage.set(entry.id, { updatedAt: Date.parse(entry.updatedAt), tokens: Number(entry.tokens) || 0 });
      for (const [id, entry] of usage) if (entry.updatedAt < windows.dayStart) usage.delete(id);
      readAt = now;
      cursor = now;
    } catch (error) { state.errors = [...state.errors ?? [], `tokens: ${error instanceof Error ? error.message : String(error)}`]; }
    signal?.throwIfAborted();
    if (readAt !== undefined) {
      state.hourlyInputTokens = sumInvocationInputTokens(usage, windows.hourStart);
      state.dailyInputTokens = sumInvocationInputTokens(usage, windows.dayStart);
    }
    if (options.check && !options.limits.paused) try {
      const pause = normalizeAdmissionPause(await options.check(signal));
      if (pause) state.pause = pause;
    } catch (error) { state.errors = [...state.errors ?? [], `check: ${error instanceof Error ? error.message : String(error)}`]; }
    return { ...babysitterAdmissionDecision(state, options.limits), accounting: "best-effort-retained-journal", state, limits: options.limits };
  });
}
