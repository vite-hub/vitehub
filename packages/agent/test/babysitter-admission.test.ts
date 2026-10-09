import { createClient } from "@libsql/client";
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts";
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { babysitterModelAdmission, createBabysitterAdmission, babysitterAdmissionDecision, babysitterBudgetWindows, resolveBabysitterAdmissionLimits } from "../src/presets/babysitter/admission.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Babysitter admission", () => {
  it("keeps undocumented host environment controls out of the generic policy", async () => {
    for (const name of ["BABYSITTER_HOURLY_INPUT_TOKENS", "BABYSITTER_DAILY_INPUT_TOKENS", "BABYSITTER_PROXY_MAX_WEEKLY_PERCENT"]) vi.stubEnv(name, "0");
    vi.stubEnv("BABYSITTER_MIN_FREE_TMP_MB", "999999999999");
    vi.stubEnv("BABYSITTER_PROXY_STATUS_FILE", "/nonexistent/provider-status.json");
    const limits = resolveBabysitterAdmissionLimits();
    expect(limits).toEqual({ minFreeTmpBytes: 4096 * 1024 * 1024, hourlyInputTokens: undefined, dailyInputTokens: undefined, paused: false });
    const result = await createBabysitterAdmission({ limits })();
    expect(result.accepting).toBe(true);
    expect(result.state.errors).toBeUndefined();
    expect(result.state).not.toHaveProperty("proxy");
  });
  it("defaults to unlimited tokens and accepts a healthy host", () => {
    const limits = resolveBabysitterAdmissionLimits();
    expect(limits.hourlyInputTokens).toBeUndefined();
    expect(limits.dailyInputTokens).toBeUndefined();
    expect(babysitterAdmissionDecision({ windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp", freeTmpBytes: 64 * 2 ** 30 }, limits)).toEqual({ accepting: true });
  });

  it.each(["hourly", "daily"] as const)("enforces a zero %s limit when journal reads fail", async window => {
    const limits = resolveBabysitterAdmissionLimits({ inputTokens: { [window]: 0 } });
    const check = createBabysitterAdmission({ limits });
    const result = await check();
    expect(result).toMatchObject({ accepting: false, hostOnly: true, reason: `token-budget-${window}` });
    expect(result.state.hourlyInputTokens).toBeUndefined();
    expect(result.state.errors).toContain("tokens: No invocation journal is assigned.");
  });

  it("keeps callback fields from overriding scheduler authority", async () => {
    const limits = resolveBabysitterAdmissionLimits();
    const check = createBabysitterAdmission({
      limits,
      check: () => ({ reason: "provider-quota", detail: "Quota exhausted", accepting: true, hostOnly: false }),
    });
    const result = await check();
    expect(result).toMatchObject({ accepting: false, hostOnly: true, reason: "provider-quota" });
    expect(result.state.pause).toEqual({ reason: "provider-quota", detail: "Quota exhausted" });
    expect(babysitterAdmissionDecision({ windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp",
      // SAFETY: Deliberately emulate a JavaScript caller passing undocumented control fields.
      pause: { reason: "provider-quota", accepting: true, hostOnly: false } as never,
    }, limits)).toMatchObject({ accepting: false, hostOnly: true });
  });

  it.each([null, {}, { reason: "" }, { reason: "quota", detail: 7 }, { reason: "quota", retryAt: Number.NaN }])("reports malformed custom pause %j", async pause => {
    const limits = resolveBabysitterAdmissionLimits();
    const check = createBabysitterAdmission({ limits,
      // SAFETY: Deliberately test callback returns from JavaScript consumers.
      check: () => pause as never,
    });
    const result = await check();
    expect(result.accepting).toBe(true);
    expect(result.state.pause).toBeUndefined();
    expect(result.state.errors).toEqual([expect.stringContaining("check: Invalid admission.check result")]);
  });

  it("parks model passes when temporary storage is low", () => {
    const limits = resolveBabysitterAdmissionLimits();
    const result = babysitterAdmissionDecision({ windows: babysitterBudgetWindows(Date.now()), tmpDir: "/scratch", freeTmpBytes: 3 * 2 ** 30 }, limits);
    expect(result).toMatchObject({ accepting: false, hostOnly: true, reason: "tmp-space-low" });
  });

  it("pauses at the hourly budget until the next hour", () => {
    const now = new Date(2026, 9, 5, 19, 13).getTime();
    const limits = resolveBabysitterAdmissionLimits({ inputTokens: { hourly: 1 } });
    const result = babysitterAdmissionDecision({ windows: babysitterBudgetWindows(now), tmpDir: "/tmp", hourlyInputTokens: 1 }, limits);
    expect(result).toMatchObject({ accepting: false, reason: "token-budget-hourly", retryAt: new Date(2026, 9, 5, 20).getTime() });
  });
});

it("reads paginated usage from the assigned journal", async () => {
  const store = createMemoryAgentInvocationStore();
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  for (let index = 0; index < 101; index++) {
    await store.create({ id: String(index), traceId: String(index), createdAt: timestamp, updatedAt: timestamp, status: "completed", observations: [
      { name: "usage", type: "run", sequence: 1, timestamp, attributes: { "usage.inputTokens": 2 } },
      { name: "usage", type: "run", sequence: 2, timestamp, attributes: { "usage.inputTokens": 3 } },
    ] });
  }
  const check = createBabysitterAdmission({ invocations: defineAgentInvocations({ store }), limits: resolveBabysitterAdmissionLimits({ minFreeTmpMb: false, inputTokens: { hourly: 300 } }) });
  expect(await check(now)).toMatchObject({ accepting: false, reason: "token-budget-hourly", state: { hourlyInputTokens: 303, dailyInputTokens: 303 } });
});

it("gates recovery model work on host admission and the same-head progress budget", () => {
  const snapshot = { pr: { number: 1, head: { sha: "a" } }, progressBudget: { head: "a", exhausted: true, count: 3, limit: 3, creditedEvidence: [] } };
  expect(babysitterModelAdmission(true, snapshot)).toBe(false);
  expect(babysitterModelAdmission(false, { ...snapshot, progressBudget: undefined })).toBe(false);
  expect(babysitterModelAdmission(true, { ...snapshot, pr: { number: 1, head: { sha: "b" } } })).toBe(true);
  expect(babysitterModelAdmission(true, { ...snapshot, progressBudget: undefined })).toBe(true);
});

it("includes live SQLite observations and exposes retained-journal accounting after pruning", async () => {
  const client = createClient({ url: ":memory:" });
  const store = createLibsqlAgentInvocationStore({ client, maxRecords: 1, maxAgeMs: false });
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const invocations = defineAgentInvocations({ store });
  const limits = resolveBabysitterAdmissionLimits({ minFreeTmpMb: false, inputTokens: { hourly: 5 } });
  try {
    await store.create({ id: "live", traceId: "live", createdAt: timestamp, updatedAt: timestamp, status: "running", observations: [] });
    await store.update("live", { timestamp, appendObservation: { name: "usage", type: "run", timestamp, attributes: { "usage.inputTokens": 6, "vitehub.observation.id": "usage-1" } } });
    expect(await createBabysitterAdmission({ invocations, limits })(now)).toMatchObject({ accepting: false, state: { hourlyInputTokens: 6 } });
    await store.update("live", { timestamp, status: "completed" });
    await store.create({ id: "next", traceId: "next", createdAt: timestamp, updatedAt: timestamp, status: "running", observations: [] });
    await store.update("next", { timestamp, status: "completed" });
    expect(await store.get("live")).toBeUndefined();
    expect(await createBabysitterAdmission({ invocations, limits })(now)).toMatchObject({ accounting: "best-effort-retained-journal", accepting: true, state: { hourlyInputTokens: 0 } });
  } finally { client.close(); }
});
