import { describe, expect, it } from "vitest";
import { createForgeQuota, createProviderQuota, providerBlockedKey, providerStrikesKey, type QuotaStore } from "../src/babysitter/provider-quota.ts";

function store(): QuotaStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async metaNumber(key) { const value = values.get(key); return typeof value === "number" ? value : undefined; },
    async setMeta(key, value) { values.set(key, value); },
  };
}

describe("Babysitter provider quota", () => {
  it("doubles each cooldown from the base up to one hour", async () => {
    const meta = store();
    let now = 0;
    const quota = createProviderQuota(meta, 5 * 60_000, () => now);
    const cooldowns: number[] = [];
    for (let strike = 0; strike < 6; strike++) {
      await quota.block();
      const until = await quota.blockedUntil();
      cooldowns.push((until - now) / 60_000);
      now = until + 1;
    }
    expect(cooldowns).toEqual([5, 10, 20, 40, 60, 60]);
    expect(await quota.strikes()).toBe(5);
  });

  it("escalates once for passes that fail together", async () => {
    const meta = store();
    const quota = createProviderQuota(meta, 60_000, () => 1000);
    await quota.block();
    await quota.block();
    await quota.block();
    expect(meta.values.get(providerStrikesKey)).toBe(1);
    expect(meta.values.get(providerBlockedKey)).toBe(61_000);
  });

  it("removes a strike only for a success 30 minutes after the last cooldown", async () => {
    const meta = store();
    let now = 0;
    const quota = createProviderQuota(meta, 5 * 60_000, () => now);
    await quota.block();
    now = await quota.blockedUntil();
    await quota.block();
    const ended = await quota.blockedUntil();
    expect(await quota.strikes()).toBe(2);
    now = ended + 10 * 60_000;
    await quota.succeeded();
    expect(await quota.strikes()).toBe(2);
    now = ended + 31 * 60_000;
    await quota.succeeded();
    await quota.succeeded();
    await quota.succeeded();
    expect(await quota.strikes()).toBe(0);
  });

  it("halves model concurrency per strike within the configured cap", async () => {
    const meta = store();
    const quota = createProviderQuota(meta, 60_000, () => 0);
    expect(await quota.modelLimit(16, Number.POSITIVE_INFINITY)).toBe(16);
    expect(await quota.modelLimit(16, 6)).toBe(6);
    meta.values.set(providerStrikesKey, 2);
    expect(await quota.modelLimit(16, Number.POSITIVE_INFINITY)).toBe(4);
    meta.values.set(providerStrikesKey, 5);
    expect(await quota.modelLimit(16, Number.POSITIVE_INFINITY)).toBe(2);
    expect(await quota.modelLimit(1, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("blocks forge requests for an hour and never shortens a longer block", async () => {
    const meta = store();
    let now = 0;
    const forge = createForgeQuota(meta, () => now);
    expect(await forge.block()).toBe(60 * 60_000);
    now = 10;
    expect(await forge.block()).toBe(60 * 60_000 + 10);
    expect(await forge.blockedUntil()).toBe(60 * 60_000 + 10);
  });
});
