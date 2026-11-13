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

  it("blocks forge requests for five minutes and doubles only while blocks repeat", async () => {
    // A flat hour after every GitHub limit, including secondary limits that lift within minutes,
    // left the scheduler idle from 06:18 to 07:18 UTC with 4834 of 5000 core requests left.
    const meta = store();
    const minute = 60_000;
    let now = 1000 * minute;
    const forge = createForgeQuota(meta, () => now);
    const blocks: number[] = [];
    for (let strike = 0; strike < 6; strike++) {
      const until = await forge.block();
      blocks.push(until - now);
      now = until;
    }
    expect(blocks).toEqual([5, 10, 20, 40, 60, 60].map(minutes => minutes * minute));
    // An error while a block holds keeps it.
    const until = await forge.block();
    now += minute;
    expect(await forge.block()).toBe(until);
    expect(await forge.blockedUntil()).toBe(until);
    // Two quiet hours after the last block, the next one starts at five minutes again.
    now = until + 2 * 60 * minute;
    expect(await forge.block() - now).toBe(5 * minute);
  });

  it("blocks forge requests until GitHub's reset time", async () => {
    const meta = store();
    const forge = createForgeQuota(meta, () => 1000);
    expect(await forge.block(1000 + 7 * 60_000)).toBe(1000 + 7 * 60_000);
    // An unusable reset time falls back to the initial five-minute cooldown.
    expect(await createForgeQuota(store(), () => 1000).block(500)).toBe(1000 + 5 * 60_000);
    expect(await createForgeQuota(store(), () => 1000).block(1000 + 3 * 60 * 60_000)).toBe(1000 + 5 * 60_000);
  });

  it("does not spend a strike on an error during an active forge block", async () => {
    let now = 1000;
    const forge = createForgeQuota(store(), () => now);
    const until = await forge.block();
    now += 60_000;
    expect(await forge.block()).toBe(until);
    now = until;
    expect(await forge.block() - now).toBe(10 * 60_000);
  });
});
